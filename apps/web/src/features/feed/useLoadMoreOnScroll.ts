'use client';

import { useEffect, useRef } from 'react';

const ROOT_MARGIN = '200px';

/**
 * Infinite scroll: when the returned sentinel gets near the viewport the next page is requested.
 * Without `IntersectionObserver` (or for keyboard and screen-reader users) the "Показать ещё" button does the same.
 */
export function useLoadMoreOnScroll(options: { enabled: boolean; onLoadMore: () => void }) {
  const sentinel = useRef<HTMLDivElement | null>(null);
  const latest = useRef(options.onLoadMore);
  useEffect(() => {
    latest.current = options.onLoadMore;
  });
  const { enabled } = options;
  useEffect(() => {
    const node = sentinel.current;
    if (!enabled || !node || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) latest.current();
      },
      { rootMargin: ROOT_MARGIN },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled]);
  return sentinel;
}
