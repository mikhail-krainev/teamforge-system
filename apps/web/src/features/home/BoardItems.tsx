import type { HTMLAttributes } from 'react';
import { t } from '@/i18n';

type Grab = HTMLAttributes<HTMLElement>;

function Check({ isDone }: { isDone: boolean }) {
  return (
    <span className="board-check" data-done={isDone}>
      {isDone ? (
        <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
          <path
            d="M3 11l5 5L18 3"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : null}
    </span>
  );
}

export function NoteIdea({ grab }: { grab: Grab }) {
  return (
    <article className="board-item board-note board-note-1" {...grab}>
      <span className="board-tape" aria-hidden="true" />
      <span className="mono">{t('home.peek.a.stage')}</span>
      <h3>{t('home.peek.a.title')}</h3>
      <p>{t('home.peek.a.note')}</p>
      <span className="board-marker" aria-hidden="true">
        <svg viewBox="0 0 120 60" focusable="false">
          <ellipse
            cx="60"
            cy="30"
            rx="54"
            ry="22"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray="300 40"
          />
        </svg>
        {t('home.peek.board.two')}
      </span>
    </article>
  );
}

export function NoteBuild({ grab }: { grab: Grab }) {
  return (
    <article className="board-item board-note board-note-2" {...grab}>
      <span className="board-pushpin" aria-hidden="true" />
      <span className="mono">{t('home.peek.b.stage')}</span>
      <h3>{t('home.peek.b.title')}</h3>
      <p>{t('home.peek.b.note')}</p>
      <span className="board-file">
        <svg viewBox="0 0 16 20" aria-hidden="true" focusable="false">
          <path
            d="M2 1h8l4 4v14H2z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
        </svg>
        {t('home.peek.board.file')}
      </span>
      <span className="board-scrawl board-scrawl-ahead" aria-hidden="true">
        {t('home.peek.board.ahead')}
        <svg viewBox="0 0 60 30" focusable="false">
          <path
            d="M2 24C20 4 40 4 56 16m-10-9l10 9-13 4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    </article>
  );
}

export function NoteRelease({ grab }: { grab: Grab }) {
  return (
    <article className="board-item board-note board-note-3" {...grab}>
      <span className="board-clip" aria-hidden="true" />
      <span className="mono">{t('home.peek.c.stage')}</span>
      <h3>{t('home.peek.c.title')}</h3>
      <p>{t('home.peek.c.note')}</p>
      <ul className="board-todo">
        <li>
          <Check isDone />
          <s>{t('home.peek.board.readme')}</s>
        </li>
        <li>
          <Check isDone={false} />
          {t('home.peek.board.shots')}
        </li>
        <li>
          <Check isDone={false} />
          {t('home.peek.board.retro')}
        </li>
      </ul>
    </article>
  );
}

export function Photo({ grab }: { grab: Grab }) {
  return (
    <figure className="board-item board-photo" {...grab}>
      <span className="board-tape board-tape-small" aria-hidden="true" />
      <svg viewBox="0 0 120 80" aria-hidden="true" focusable="false">
        <rect width="120" height="80" fill="var(--surface-2)" />
        <rect x="8" y="8" width="104" height="10" rx="3" fill="var(--blue)" />
        <rect x="8" y="26" width="48" height="46" rx="4" fill="var(--yellow)" />
        <rect x="64" y="26" width="48" height="20" rx="4" fill="var(--pink)" />
        <rect x="64" y="52" width="48" height="20" rx="4" fill="var(--green)" />
      </svg>
      <figcaption>{t('home.peek.board.files')}</figcaption>
    </figure>
  );
}

export function Sticky({ grab }: { grab: Grab }) {
  return (
    <div className="board-item board-sticky" aria-hidden="true" {...grab}>
      {t('home.peek.board.demo')}
    </div>
  );
}
