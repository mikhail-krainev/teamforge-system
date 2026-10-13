'use client';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { useMe } from '@/features/auth/session';
import { hasMessage, t } from '@/i18n';
import { describeError } from '@/lib/api/error-message';
import { useIdempotentMutation } from '@/lib/api/idempotency';
import { markRead, NOTIFICATIONS_ROOT, UNREAD_LIMIT, type Notification } from './api';
import { useNotifications, useUnreadCount } from './queries';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MARK = 100;

/** Where a notification leads, built only from a validated team id in its payload. */
export function notificationHref(item: Pick<Notification, 'type' | 'payload'>): string | null {
  const teamId = item.payload['teamId'];
  if (typeof teamId !== 'string' || !UUID.test(teamId)) return null;
  return /vote|leader/.test(item.type) ? `/teams/${teamId}/vote` : `/teams/${teamId}`;
}

function notificationText(type: string): string {
  const key = `notifications.types.${type.replace(/[^a-z0-9_]/gi, '_')}`;
  return hasMessage(key) ? t(key) : t('notifications.generic');
}

function BellIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M12 3a6 6 0 0 0-6 6v3.5L4.5 16h15L18 12.5V9a6 6 0 0 0-6-6Zm-2 15a2 2 0 0 0 4 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface ItemProps {
  item: Notification;
  onRead: (ids: string[]) => void;
}

function ItemBody({ item, unread }: { item: Notification; unread: boolean }) {
  return (
    <>
      <span className={unread ? 'bell-item-text bell-item-unread' : 'bell-item-text'}>
        {notificationText(item.type)}
      </span>
      <span className="muted bell-item-meta">
        {unread ? `${t('notifications.unreadMark')} · ` : ''}
        {new Date(item.createdAt).toLocaleString('ru-RU', {
          dateStyle: 'short',
          timeStyle: 'short',
        })}
      </span>
    </>
  );
}

function NotificationItem({ item, onRead }: ItemProps) {
  const unread = item.readAt === null;
  const href = notificationHref(item);
  const body = <ItemBody item={item} unread={unread} />;
  const markIfUnread = () => {
    if (unread) onRead([item.id]);
  };
  return (
    <li role="none">
      {href ? (
        <Link
          href={href}
          role="menuitem"
          tabIndex={-1}
          className="bell-item"
          onClick={markIfUnread}
        >
          {body}
        </Link>
      ) : (
        <div
          role="menuitem"
          tabIndex={-1}
          className="bell-item"
          onClick={markIfUnread}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              markIfUnread();
            }
          }}
        >
          {body}
        </div>
      )}
    </li>
  );
}

function useMarkRead() {
  const queryClient = useQueryClient();
  return useIdempotentMutation({
    mutationFn: (ids: string[], key) => markRead(ids, key),
    onSettled: () => queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_ROOT }),
  });
}

function ListState({ list, count }: { list: ReturnType<typeof useNotifications>; count: number }) {
  if (list.isPending) return <p role="status">{t('notifications.loading')}</p>;
  if (list.isError) {
    return (
      <div role="alert" className="alert alert-error">
        <p>{t('notifications.loadFailed')}</p>
        <button
          type="button"
          className="button button-secondary"
          onClick={() => void list.refetch()}
        >
          {t('notifications.retry')}
        </button>
      </div>
    );
  }
  return count === 0 ? <p className="muted">{t('notifications.empty')}</p> : null;
}

/** Arrow keys move between the menu items (WAI-ARIA menu pattern); Escape is handled by the bell. */
function arrowNavigation(panel: HTMLElement | null, event: KeyboardEvent<HTMLElement>) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const entries = [...(panel?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
  if (entries.length === 0) return;
  event.preventDefault();
  const at = entries.indexOf(document.activeElement as HTMLElement);
  const step = event.key === 'ArrowDown' ? 1 : -1;
  entries[(at + step + entries.length) % entries.length]?.focus();
}

interface FooterProps {
  list: ReturnType<typeof useNotifications>;
  pending: boolean;
  unreadIds: string[];
  onMarkAll: (ids: string[]) => void;
}

function PanelFooter({ list, pending, unreadIds, onMarkAll }: FooterProps) {
  return (
    <div className="row">
      {unreadIds.length > 0 ? (
        <button
          type="button"
          className="button button-secondary"
          disabled={pending}
          onClick={() => onMarkAll(unreadIds.slice(0, MAX_MARK))}
        >
          {t('notifications.markAll')}
        </button>
      ) : null}
      {list.hasNextPage ? (
        <button
          type="button"
          className="button button-secondary"
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {list.isFetchingNextPage ? t('notifications.loadingMore') : t('notifications.loadMore')}
        </button>
      ) : null}
    </div>
  );
}

function BellPanel({ id }: { id: string }) {
  const list = useNotifications(true);
  const read = useMarkRead();
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  const unreadIds = items.filter((i) => i.readAt === null).map((i) => i.id);
  const panel = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={panel}
      id={id}
      className="bell-panel card stack"
      onKeyDown={(event) => arrowNavigation(panel.current, event)}
    >
      <ListState list={list} count={items.length} />
      {items.length > 0 ? (
        <ul role="menu" aria-label={t('notifications.menu')} className="bell-list">
          {items.map((item) => (
            <NotificationItem key={item.id} item={item} onRead={(ids) => read.mutate(ids)} />
          ))}
        </ul>
      ) : null}
      {read.isError ? (
        <p role="alert" className="field-error">
          {t('notifications.markFailed')} {describeError(read.error)}
        </p>
      ) : null}
      <PanelFooter
        list={list}
        pending={read.isPending}
        unreadIds={unreadIds}
        onMarkAll={(ids) => read.mutate(ids)}
      />
    </div>
  );
}

/** Closes the panel on a click outside or Escape (focus returns to the bell button). */
function useDismiss(
  open: boolean,
  close: () => void,
  root: RefObject<HTMLElement | null>,
  button: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open) return undefined;
    const outside = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) close();
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      close();
      button.current?.focus();
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open, close, root, button]);
}

function Bell() {
  const [open, setOpen] = useState(false);
  const unread = useUnreadCount(true);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, root, button);

  const count = unread.data?.count ?? 0;
  const capped = unread.data?.capped || count >= UNREAD_LIMIT;
  return (
    <div ref={root} className="bell">
      <button
        ref={button}
        type="button"
        className="button button-secondary bell-button"
        aria-label={t('notifications.bell')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <BellIcon />
      </button>
      {count > 0 ? (
        <span
          role="status"
          aria-label={capped ? t('notifications.unreadMany') : t('notifications.unread', { count })}
          className="bell-badge"
        >
          <span aria-hidden="true">{capped ? '99+' : count}</span>
        </span>
      ) : null}
      {open ? <BellPanel id={panelId} /> : null}
    </div>
  );
}

/** Header bell for signed-in users: unread count, list with pagination, mark as read. */
export function NotificationBell() {
  const me = useMe();
  if (!me.data || me.data.consentRequired) return null;
  return <Bell />;
}
