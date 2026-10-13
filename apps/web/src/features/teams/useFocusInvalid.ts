'use client';

import { useEffect, useState } from 'react';

/**
 * Moves focus to the first invalid control after a failed submit. `attempt()` is called by the
 * submit handler with the id to focus (or `undefined` when the form is valid).
 */
export function useFocusInvalid() {
  const [target, setTarget] = useState<{ id: string; n: number } | null>(null);
  useEffect(() => {
    if (target) document.getElementById(target.id)?.focus();
  }, [target]);
  return (id: string | undefined) => {
    if (id) setTarget((prev) => ({ id, n: (prev?.n ?? 0) + 1 }));
  };
}
