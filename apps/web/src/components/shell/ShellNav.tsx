'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { Yeti } from '@/components/mascot/Yeti';
import { t } from '@/i18n';
import type { NavItem } from './nav-types';

function isActive(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}

/** Closes the panel on Escape and on a click outside the nav. */
function useDismiss(isOpen: boolean, close: () => void) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    const onPointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) close();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [isOpen, close]);
  return ref;
}

/** Focus moves to the first link when the panel opens and back to the toggle when it closes. */
function useFocusHandoff(isOpen: boolean, navRef: RefObject<HTMLElement | null>) {
  const toggleRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (isOpen) navRef.current?.querySelector<HTMLElement>('#shell-nav-list a')?.focus();
    else if (wasOpen.current) toggleRef.current?.focus();
    wasOpen.current = isOpen;
  }, [isOpen, navRef]);
  return toggleRef;
}

function MenuIcon({ isOpen }: { isOpen: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d={isOpen ? 'M3 3l10 10M13 3L3 13' : 'M2 5.5h12M2 10.5h12'}
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Main navigation: a pill row on wide screens; on narrower ones a "Menu" pill opens the same
 * links as a panel (the toggle is hidden by CSS on wide screens, the list always stays in DOM).
 */
export function ShellNav({ items }: { items: readonly NavItem[] }) {
  const pathname = usePathname();
  const [isOpen, setIsOpen] = useState(false);
  const [lastPathname, setLastPathname] = useState(pathname);
  if (pathname !== lastPathname) {
    setLastPathname(pathname);
    setIsOpen(false);
  }
  const ref = useDismiss(isOpen, () => setIsOpen(false));
  const toggleRef = useFocusHandoff(isOpen, ref);

  return (
    <nav
      ref={ref}
      aria-label={t('shell.navLabel')}
      className="shell-nav"
      data-open={isOpen ? 'true' : undefined}
    >
      <button
        ref={toggleRef}
        type="button"
        className="menu-toggle"
        aria-expanded={isOpen}
        aria-controls="shell-nav-list"
        onClick={() => setIsOpen((open) => !open)}
      >
        {t('shell.menu')}
        <MenuIcon isOpen={isOpen} />
      </button>
      <ul id="shell-nav-list">
        {items.map((item) => (
          <li key={item.id}>
            <Link
              href={item.href}
              aria-current={isActive(pathname, item.href) ? 'page' : undefined}
            >
              {t(item.labelKey)}
            </Link>
          </li>
        ))}
        <li className="nav-yeti" aria-hidden="true">
          <Yeti pose="wave" size={72} />
        </li>
      </ul>
    </nav>
  );
}
