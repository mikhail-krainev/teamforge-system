'use client';

import { useCallback, useEffect, useState } from 'react';

/** Whole seconds left until the deadline; `start(n)` begins a new wait (for example `Retry-After`). */
export function useCountdown() {
  const [deadline, setDeadline] = useState<number | null>(null);
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    if (deadline === null) return undefined;
    const tick = () => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setRemaining(left);
      if (left === 0) setDeadline(null);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [deadline]);

  const start = useCallback((seconds: number) => {
    setDeadline(Date.now() + seconds * 1000);
  }, []);

  return { remaining, start };
}
