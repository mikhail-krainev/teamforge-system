import { useEffect, useState } from 'react';
import type { MessageKey } from '@/i18n';
import { BUBBLE_KEYS, type Reaction } from './reactions';

/** How long a reaction line stays in the bubble before the greeting comes back. */
export const BUBBLE_HOLD_MS = 3000;

/**
 * The reaction line to show instead of the greeting, or null. A new reaction with a line replaces
 * the current one and restarts the hold; reactions without a line leave the bubble as it is.
 */
export function useBubbleLine(reaction: Reaction): { key: MessageKey; serial: number } | null {
  const [line, setLine] = useState<{ key: MessageKey; serial: number } | null>(null);
  const [lastReaction, setLastReaction] = useState(reaction);
  if (reaction !== lastReaction) {
    setLastReaction(reaction);
    const key = BUBBLE_KEYS[reaction];
    if (key) setLine({ key, serial: (line?.serial ?? 0) + 1 });
  }

  useEffect(() => {
    if (!line) return;
    const timer = window.setTimeout(() => setLine(null), BUBBLE_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [line]);

  return line;
}
