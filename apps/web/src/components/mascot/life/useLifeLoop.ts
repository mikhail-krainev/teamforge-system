import { useEffect, useRef, useState, type RefObject } from 'react';
import { ACTOR_SIZE, LifeEngine, type LifeEvents } from './engine';
import { measureLedges, measureSlot } from './geometry';
import type { BodyFrame } from './sprites';
import type { Pose, PropDraw } from './types';
import type { PageSignals } from './usePageSignals';

/** Block positions are re-read this often (cheap, and enough for layout shifts). */
const MEASURE_EVERY_MS = 400;

/** The part of a pose React renders; position and tilt are written to the DOM directly. */
export interface Look {
  frame: BodyFrame;
  props: readonly PropDraw[];
  facing: 1 | -1;
  isHanging: boolean;
}

interface LoopDeps {
  engine: LifeEngine;
  refs: { anchor: RefObject<HTMLElement | null>; body: RefObject<HTMLElement | null> };
  signals: RefObject<PageSignals>;
  isChatBusy: () => boolean;
  onLook: (look: Look | null) => void;
}

const propKey = (p: PropDraw) => `${p.name}${p.className ?? ''}${p.dx ?? ''}/${p.dy ?? ''}`;
const lookKey = (look: Look | null) =>
  look ? `${look.frame}|${look.facing}|${look.isHanging}|${look.props.map(propKey).join(',')}` : '';

function applyPose(anchor: HTMLElement, body: HTMLElement, pose: Pose) {
  anchor.style.transform = `translate3d(${pose.x.toFixed(1)}px, ${pose.y.toFixed(1)}px, 0)`;
  const sx = (pose.scale * pose.sx).toFixed(3);
  const sy = (pose.scale * pose.sy).toFixed(3);
  body.style.transform = `rotate(${pose.rotate.toFixed(2)}deg) scale(${sx}, ${sy})`;
}

/** Starts the animation-frame loop; pauses while the tab is hidden. Returns the stop function. */
function startLoop({ engine, refs, signals, isChatBusy, onLook }: LoopDeps): () => void {
  let frameId = 0;
  let last = performance.now();
  let measuredAt = -Infinity;
  let cache = { ledges: measureLedges(window.scrollY), slot: measureSlot(window.scrollY) };
  let shownKey = '';
  const step = (now: number) => {
    const scrollY = window.scrollY;
    if (now - measuredAt > MEASURE_EVERY_MS) {
      cache = { ledges: measureLedges(scrollY), slot: measureSlot(scrollY) };
      measuredAt = now;
    }
    const view = { scrollY, height: window.innerHeight, width: window.innerWidth };
    const pose = engine.tick(
      { now, view, ...cache, ...signals.current, isChatBusy: isChatBusy() },
      now - last,
    );
    last = now;
    const look = pose && {
      frame: pose.frame,
      props: pose.props,
      facing: pose.facing,
      isHanging: pose.isHanging,
    };
    const key = lookKey(look);
    if (key !== shownKey) {
      shownKey = key;
      onLook(look);
    }
    if (pose && refs.anchor.current && refs.body.current) {
      applyPose(refs.anchor.current, refs.body.current, pose);
    }
    frameId = window.requestAnimationFrame(step);
  };
  const onVisibility = () => {
    window.cancelAnimationFrame(frameId);
    if (document.visibilityState !== 'visible') return;
    last = performance.now();
    frameId = window.requestAnimationFrame(step);
  };
  frameId = window.requestAnimationFrame(step);
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    window.cancelAnimationFrame(frameId);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

/**
 * Runs the engine on every animation frame. Position goes straight to the DOM; React re-renders
 * only when the sprite frame, props or facing change.
 */
export function useLifeLoop(
  refs: LoopDeps['refs'],
  signals: RefObject<PageSignals>,
  events: LifeEvents,
  isChatBusy: () => boolean,
) {
  const [look, setLook] = useState<Look | null>(null);
  const engineRef = useRef<LifeEngine | null>(null);
  const latest = useRef({ events, isChatBusy });
  useEffect(() => {
    latest.current = { events, isChatBusy };
  });

  useEffect(() => {
    const engine = new LifeEngine(
      {
        onHome: (isHome) => latest.current.events.onHome(isHome),
        onAsk: () => latest.current.events.onAsk(),
        onChatCancel: () => latest.current.events.onChatCancel(),
        onPeekScroll: () => latest.current.events.onPeekScroll(),
      },
      performance.now(),
    );
    engineRef.current = engine;
    const busy = () => latest.current.isChatBusy();
    return startLoop({ engine, refs, signals, isChatBusy: busy, onLook: setLook });
  }, [refs, signals]);

  return { look, engineRef, size: ACTOR_SIZE };
}
