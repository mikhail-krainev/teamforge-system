'use client';

import { t } from '@/i18n';
import { NoteBuild, NoteIdea, NoteRelease, Photo, Sticky } from './BoardItems';
import { useBoardDrag } from './useBoardDrag';
import './WorkBoard.css';

/** Corkboard with notes the visitor can drag around; layout falls back to a plain stack on phones. */
export function WorkBoard() {
  const grab = useBoardDrag();
  return (
    <section className="section container peek" aria-labelledby="peek-title">
      <div className="section-head grid-12">
        <span className="section-mark">{t('home.peek.mark')}</span>
        <h2 id="peek-title">
          {t('home.peek.headingStart')}{' '}
          <span className="serif">{t('home.peek.headingAccent')}</span>
        </h2>
        <p>{t('home.peek.note')}</p>
      </div>
      <div
        className="board"
        role="group"
        aria-label={t('home.peek.board.boardLabel')}
        data-yeti-ledge
      >
        <span className="board-stain" aria-hidden="true" />
        <NoteIdea grab={grab} />
        <NoteBuild grab={grab} />
        <NoteRelease grab={grab} />
        <Photo grab={grab} />
        <Sticky grab={grab} />
      </div>
    </section>
  );
}
