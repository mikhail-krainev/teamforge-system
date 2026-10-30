'use client';

import { useMemo, useRef } from 'react';
import { t } from '@/i18n';
import { PixelSprite } from './pixels';
import type { Reaction } from './reactions';
import { useBubbleLine } from './useBubbleLine';
import { useYetiMood } from './useYetiMood';
import { usePrefersReducedMotion } from './usePrefersReducedMotion';
import { buildFrame } from './yetiFrames';
import './mascot.css';
import type { YetiPose } from './Yeti';

const CONFETTI_COUNT = 10;
const CONFETTI = Array.from({ length: CONFETTI_COUNT }, (_, index) => index);
const BANG: readonly string[] = ['E', 'E', 'E', '.', 'E'];
const SLEEP_Z: readonly string[] = ['EEE', '..E', '.E.', 'E..', 'EEE'];

function Props({
  reaction,
  size,
  isReduced,
}: {
  reaction: Reaction;
  size: number;
  isReduced: boolean;
}) {
  return (
    <>
      {reaction === 'surprised' ? (
        <span className="live-yeti-bang" aria-hidden="true">
          <PixelSprite grid={BANG} size={size / 14} />
        </span>
      ) : null}
      {reaction === 'sleep' ? (
        <span className="live-yeti-z" aria-hidden="true">
          <PixelSprite grid={SLEEP_Z} size={size / 10} />
        </span>
      ) : null}
      {reaction === 'celebrate' && !isReduced ? (
        // Own wrapper so :nth-of-type counts confetti only, not the body span before them.
        <span className="live-yeti-burst" aria-hidden="true">
          {CONFETTI.map((index) => (
            <span key={index} className="live-yeti-confetti" />
          ))}
        </span>
      ) : null}
    </>
  );
}

/** Speech bubble: a reaction line replaces the greeting for a few seconds. */
function Bubble({
  reaction,
  greeting,
  className,
}: {
  reaction: Reaction;
  greeting: string;
  className: string;
}) {
  const line = useBubbleLine(reaction);
  return (
    <p className={className}>
      {/* Keyed so each new line pops in; reaction lines are decorative, the greeting is not. */}
      <span
        key={line?.serial ?? 0}
        className="live-yeti-line"
        aria-hidden={line ? true : undefined}
      >
        {line ? t(line.key) : greeting}
      </span>
    </p>
  );
}

/**
 * Interactive pixel Yeti: idles, follows the pointer, falls asleep and reacts to clicks.
 * With `greeting` it also renders the speech bubble (after the button, for the parent's layout):
 * a reaction line replaces the greeting for a few seconds, then the greeting comes back.
 */
export function LiveYeti({
  size = 160,
  pose = 'idle',
  className,
  greeting,
  bubbleClassName = 'bubble',
  isDecorative = false,
}: {
  size?: number;
  pose?: YetiPose;
  className?: string;
  greeting?: string;
  bubbleClassName?: string;
  /** A decorative copy (e.g. the scroll companion) stays out of the tab order. */
  isDecorative?: boolean;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const isReduced = usePrefersReducedMotion();
  const { reaction, gaze, isBlinking, onClick } = useYetiMood(buttonRef, isReduced);
  const grid = useMemo(
    () => buildFrame(pose, reaction, gaze, isBlinking),
    [pose, reaction, gaze, isBlinking],
  );

  return (
    <>
      <span className={className ? `live-yeti ${className}` : 'live-yeti'}>
        <button
          ref={buttonRef}
          type="button"
          className="live-yeti-button"
          data-reaction={reaction}
          aria-label={t('mascot.label')}
          onClick={onClick}
          tabIndex={isDecorative ? -1 : undefined}
        >
          <span className="live-yeti-body">
            <PixelSprite grid={grid} size={size} className="yeti" />
          </span>
          <Props reaction={reaction} size={size} isReduced={isReduced} />
        </button>
      </span>
      {greeting ? (
        <Bubble reaction={reaction} greeting={greeting} className={bubbleClassName} />
      ) : null}
    </>
  );
}
