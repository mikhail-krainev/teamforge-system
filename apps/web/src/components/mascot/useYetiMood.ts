import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  CENTER,
  CLICK_CYCLE,
  FAST_LEAVE_SPEED,
  GAZE_DEAD_ZONE_PX,
  type Gaze,
  PERK_DISTANCE_PX,
  RAPID_CLICKS,
  RAPID_WINDOW_MS,
  REACTION_MS,
  type Reaction,
  WAKE_DISTANCE_PX,
} from './reactions';
import { useYetiAmbient } from './useYetiAmbient';

type Point = { x: number; y: number; time: number };

const axis = (delta: number): -1 | 0 | 1 =>
  delta > GAZE_DEAD_ZONE_PX ? 1 : delta < -GAZE_DEAD_ZONE_PX ? -1 : 0;

/** Pointer speed in px per ms between two samples. */
function speedBetween(from: Point | null, to: Point): number {
  if (!from || to.time <= from.time) return 0;
  return Math.hypot(to.x - from.x, to.y - from.y) / (to.time - from.time);
}

type TrackingDeps = {
  isEnabled: boolean;
  buttonRef: RefObject<HTMLElement | null>;
  reactionRef: RefObject<Reaction>;
  lastActivityRef: RefObject<number>;
  show: (next: Reaction) => void;
  setGaze: Dispatch<SetStateAction<Gaze>>;
};

/** One rAF-throttled document listener: gaze, perk-up near the Yeti, tilt on a fast exit, wake. */
function usePointerTracking(deps: TrackingDeps) {
  const { isEnabled, buttonRef, reactionRef, lastActivityRef, show, setGaze } = deps;
  useEffect(() => {
    if (!isEnabled) return;
    lastActivityRef.current = performance.now();
    let frame = 0;
    let latest: Point = { x: 0, y: 0, time: 0 };
    let previous: Point | null = null;
    let wasNear = false;

    const track = () => {
      frame = 0;
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      const dx = latest.x - (rect.left + rect.width / 2);
      const dy = latest.y - (rect.top + rect.height / 2);
      const distance = Math.hypot(dx, dy);
      if (reactionRef.current === 'sleep') {
        if (distance < WAKE_DISTANCE_PX) show('idle');
        return;
      }
      const next: Gaze = { x: axis(dx), y: axis(dy) };
      setGaze((prev) => (prev.x === next.x && prev.y === next.y ? prev : next));
      const isNear = distance < PERK_DISTANCE_PX;
      const isIdle = reactionRef.current === 'idle';
      if (isNear && !wasNear && isIdle) show('perk');
      if (!isNear && wasNear && isIdle && speedBetween(previous, latest) > FAST_LEAVE_SPEED) {
        show('tilt');
      }
      wasNear = isNear;
      previous = latest;
    };

    const onMove = (event: PointerEvent) => {
      latest = { x: event.clientX, y: event.clientY, time: performance.now() };
      lastActivityRef.current = latest.time;
      if (!frame) frame = requestAnimationFrame(track);
    };
    document.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      document.removeEventListener('pointermove', onMove);
      cancelAnimationFrame(frame);
    };
  }, [isEnabled, buttonRef, reactionRef, lastActivityRef, show, setGaze]);
}

/** State machine for the interactive Yeti: reaction, gaze, blink and the click handler. */
export function useYetiMood(buttonRef: RefObject<HTMLElement | null>, isReduced: boolean) {
  const [reaction, setReaction] = useState<Reaction>('idle');
  const [gaze, setGaze] = useState<Gaze>(CENTER);
  const [isBlinking, setIsBlinking] = useState(false);
  const reactionRef = useRef<Reaction>('idle');
  const lastActivityRef = useRef(0);
  const resetTimer = useRef<number | undefined>(undefined);
  const clickTimes = useRef<number[]>([]);
  const clickCount = useRef(0);

  const show = useCallback((next: Reaction) => {
    window.clearTimeout(resetTimer.current);
    reactionRef.current = next;
    setReaction(next);
    if (next === 'idle' || next === 'sleep') return;
    resetTimer.current = window.setTimeout(() => {
      reactionRef.current = 'idle';
      setReaction('idle');
    }, REACTION_MS[next]);
  }, []);

  useYetiAmbient(!isReduced, { reactionRef, lastActivityRef, show, setGaze, setIsBlinking });

  usePointerTracking({
    isEnabled: !isReduced,
    buttonRef,
    reactionRef,
    lastActivityRef,
    show,
    setGaze,
  });

  useEffect(() => () => window.clearTimeout(resetTimer.current), []);

  const onClick = useCallback(() => {
    const now = performance.now();
    lastActivityRef.current = now;
    const recent = [...clickTimes.current.filter((time) => now - time < RAPID_WINDOW_MS), now];
    if (recent.length >= RAPID_CLICKS) {
      clickTimes.current = [];
      show('dizzy');
      return;
    }
    clickTimes.current = recent;
    show(CLICK_CYCLE[clickCount.current++ % CLICK_CYCLE.length] ?? 'jump');
  }, [show]);

  return { reaction, gaze, isBlinking, onClick };
}
