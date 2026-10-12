'use client';

import { useEffect, useRef, useState } from 'react';
import { readTokenFromFragment, stripFragment } from './fragment';

/**
 * Reads the one-time token from `#token=` exactly once, removes the fragment from the address
 * bar at once and submits the token. Returns `undefined` until the browser has been inspected,
 * `null` when there is no usable token. The refs keep React StrictMode's double effect run from
 * reading (and sending) twice.
 */
export function useFragmentToken(submit: (token: string) => void): string | null | undefined {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const read = useRef(false);
  const sent = useRef(false);

  useEffect(() => {
    if (read.current) return;
    read.current = true;
    setToken(readTokenFromFragment(window.location.hash));
    stripFragment();
  }, []);

  useEffect(() => {
    if (!token || sent.current) return;
    sent.current = true;
    submit(token);
  }, [token, submit]);

  return token;
}
