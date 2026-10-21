'use client';

import { useEffect, useState } from 'react';

const DEFAULT_TICK_MS = 15_000;

/** The current time, refreshed on an interval, for "valid until" and countdown texts. */
export function useNow(tickMs: number = DEFAULT_TICK_MS): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), tickMs);
    return () => clearInterval(id);
  }, [tickMs]);
  return now;
}
