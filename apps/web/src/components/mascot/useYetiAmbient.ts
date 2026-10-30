import { type Dispatch, type RefObject, type SetStateAction, useEffect } from 'react';
import { CENTER, type Gaze, type Reaction, SLEEP_AFTER_MS } from './reactions';

const BLINK_MIN_MS = 2500;
const BLINK_MAX_MS = 5500;
const BLINK_HOLD_MS = 140;
const LOOK_MIN_MS = 6000;
const LOOK_MAX_MS = 12_000;
const LOOK_HOLD_MS = 1200;
const LOOK_QUIET_MS = 3000;
const SLEEP_CHECK_MS = 1000;
const LOOK_TARGETS: readonly Gaze[] = [
  { x: -1, y: 0 },
  { x: 1, y: 0 },
  { x: -1, y: -1 },
  { x: 1, y: -1 },
];

type AmbientDeps = {
  reactionRef: RefObject<Reaction>;
  lastActivityRef: RefObject<number>;
  show: (next: Reaction) => void;
  setGaze: Dispatch<SetStateAction<Gaze>>;
  setIsBlinking: Dispatch<SetStateAction<boolean>>;
};

/** Runs `run` at random intervals; returns a stop function. */
function randomLoop(run: () => void, minMs: number, maxMs: number): () => void {
  let id = 0;
  const schedule = () => {
    id = window.setTimeout(
      () => {
        run();
        schedule();
      },
      minMs + Math.random() * (maxMs - minMs),
    );
  };
  schedule();
  return () => window.clearTimeout(id);
}

function startAmbient(deps: AmbientDeps): () => void {
  const { reactionRef, lastActivityRef, show, setGaze, setIsBlinking } = deps;
  const holds = new Set<number>();
  const hold = (fn: () => void, ms: number) => {
    const id = window.setTimeout(() => {
      holds.delete(id);
      fn();
    }, ms);
    holds.add(id);
  };
  const stopBlink = randomLoop(
    () => {
      if (reactionRef.current !== 'idle') return;
      setIsBlinking(true);
      hold(() => setIsBlinking(false), BLINK_HOLD_MS);
    },
    BLINK_MIN_MS,
    BLINK_MAX_MS,
  );
  const stopLook = randomLoop(
    () => {
      const isQuiet = performance.now() - lastActivityRef.current > LOOK_QUIET_MS;
      if (reactionRef.current !== 'idle' || !isQuiet) return;
      setGaze(LOOK_TARGETS[Math.floor(Math.random() * LOOK_TARGETS.length)] ?? CENTER);
      hold(() => setGaze(CENTER), LOOK_HOLD_MS);
    },
    LOOK_MIN_MS,
    LOOK_MAX_MS,
  );
  const sleepCheck = window.setInterval(() => {
    const isIdleLongEnough = performance.now() - lastActivityRef.current > SLEEP_AFTER_MS;
    if (reactionRef.current === 'idle' && isIdleLongEnough) show('sleep');
  }, SLEEP_CHECK_MS);
  return () => {
    stopBlink();
    stopLook();
    window.clearInterval(sleepCheck);
    for (const id of holds) window.clearTimeout(id);
  };
}

/** Blink, look-around and fall-asleep timers; paused while the tab is hidden. */
export function useYetiAmbient(isEnabled: boolean, deps: AmbientDeps) {
  const { reactionRef, lastActivityRef, show, setGaze, setIsBlinking } = deps;
  useEffect(() => {
    if (!isEnabled) return;
    const current = { reactionRef, lastActivityRef, show, setGaze, setIsBlinking };
    let stop = document.hidden ? null : startAmbient(current);
    const onVisibility = () => {
      stop?.();
      stop = null;
      if (document.hidden) return;
      lastActivityRef.current = performance.now();
      stop = startAmbient(current);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stop?.();
    };
  }, [isEnabled, reactionRef, lastActivityRef, show, setGaze, setIsBlinking]);
}
