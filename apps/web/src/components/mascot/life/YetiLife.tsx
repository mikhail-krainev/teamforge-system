'use client';

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { t, type MessageKey } from '@/i18n';
import { PixelSprite } from '../pixels';
import { BUBBLE_KEYS } from '../reactions';
import { usePrefersReducedMotion } from '../usePrefersReducedMotion';
import { CHAT_QUESTIONS, type ChatMood, type ChatQuestionKey } from './chat';
import { BODY, PROPS } from './sprites';
import { useLifeLoop, type Look } from './useLifeLoop';
import { usePageSignals } from './usePageSignals';
import { YetiChat } from './YetiChat';
import './life.css';

const CELLS = 20;
const PEEK_SCROLL_PX = 140;
const PEEK_SCROLL_MS = 1200;
const LINE_HOLD_MS = 2500;
const POKE_LINES = Object.values(BUBBLE_KEYS);

const pickOne = <T,>(items: readonly T[]): T | undefined =>
  items[Math.floor(Math.random() * items.length)];

/** He stays put while the reader types an answer or reads his reply. */
function isChatBusy(chat: HTMLElement | null): boolean {
  if (!chat) return false;
  const reply = chat.querySelector('[aria-live]')?.textContent?.trim();
  return chat.contains(document.activeElement) || Boolean(reply);
}

function setSlotAway(isAway: boolean) {
  const slot = document.querySelector<HTMLElement>('.hero-yeti-slot');
  if (!slot || (slot.dataset.away === 'true') === isAway) return;
  if (isAway) slot.dataset.away = 'true';
  else delete slot.dataset.away;
}

function Sprite({ look, size }: { look: Look; size: number }) {
  const cell = size / CELLS;
  return (
    <span className="life-flip" data-facing={look.facing}>
      <PixelSprite grid={BODY[look.frame]} size={size} className="yeti" />
      {look.props.map((prop) => {
        const spec = PROPS[prop.name];
        const width = spec.grid[0]?.length ?? 0;
        const left = (spec.offset[0] + (prop.dx ?? 0)) * cell;
        const top = (spec.offset[1] + (prop.dy ?? 0)) * cell;
        return (
          <span
            key={`${prop.name}-${prop.className ?? ''}`}
            className={prop.className ? `life-prop ${prop.className}` : 'life-prop'}
            style={{ left, top }}
          >
            <PixelSprite grid={spec.grid} size={width * cell} />
          </span>
        );
      })}
    </span>
  );
}

/** Говорилка над головой: his question form, or a short line after a poke. */
function useSpeech() {
  const [question, setQuestion] = useState<ChatQuestionKey | null>(null);
  const [line, setLine] = useState<MessageKey | null>(null);
  const lineTimer = useRef(0);
  const say = (key: MessageKey | undefined) => {
    if (!key) return;
    window.clearTimeout(lineTimer.current);
    setLine(key);
    lineTimer.current = window.setTimeout(() => setLine(null), LINE_HOLD_MS);
  };
  useEffect(() => () => window.clearTimeout(lineTimer.current), []);
  return { question, setQuestion, line, say };
}

const noopSubscribe = () => () => {};

/**
 * Толик on every page (mounted once in the shell). On the landing page he leaves the hero slot when
 * the reader scrolls; on other pages he parachutes in. He lives on the page blocks (or a floor at
 * the bottom of the screen where there are none): travels between them, keeps himself busy, asks
 * questions and sometimes grabs the cursor.
 * Decorative for assistive tech except his question form. Nothing at all under reduced motion.
 */
export function YetiLife() {
  const isReduced = usePrefersReducedMotion();
  // The portal needs document.body, so nothing renders on the server or during hydration.
  const isMounted = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
  if (isReduced || !isMounted) return null;
  return <LiveActor />;
}

type SpeechState = ReturnType<typeof useSpeech>;

/** His line after a poke, or the question form while he asks. */
function Speech({
  speech,
  chatRef,
  onChatDone,
}: {
  speech: SpeechState;
  chatRef: RefObject<HTMLDivElement | null>;
  onChatDone: (mood: ChatMood) => void;
}) {
  if (speech.question) {
    return (
      <div
        ref={chatRef}
        className="life-say life-say-chat"
        role="group"
        aria-label={t('mascot.label')}
      >
        <YetiChat
          questionKey={speech.question}
          onDone={(mood) => {
            speech.setQuestion(null);
            onChatDone(mood);
          }}
        />
      </div>
    );
  }
  return speech.line ? (
    <p className="life-say" aria-hidden="true">
      {t(speech.line)}
    </p>
  ) : null;
}

function LiveActor() {
  const anchor = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const refs = useMemo(() => ({ anchor, body }), []);
  const { signals, scrollByHimself } = usePageSignals();
  const speech = useSpeech();
  const { look, engineRef, size } = useLifeLoop(
    refs,
    signals,
    {
      onHome: (isHome) => setSlotAway(!isHome),
      onAsk: () => speech.setQuestion(pickOne(CHAT_QUESTIONS) ?? null),
      onChatCancel: () => speech.setQuestion(null),
      onPeekScroll: () => scrollByHimself(PEEK_SCROLL_PX, PEEK_SCROLL_MS),
    },
    () => isChatBusy(chatRef.current),
  );
  // Never leave the hero mascot hidden behind if he goes away while out on the page.
  useEffect(() => () => setSlotAway(false), []);
  const onPoke = () => {
    engineRef.current?.poke(performance.now());
    speech.say(pickOne(POKE_LINES));
  };

  return createPortal(
    <div ref={anchor} className="life-anchor" hidden={!look}>
      {/* Always mounted so the loop can place it before the first visible frame. */}
      <div
        ref={body}
        className="life-body"
        data-hanging={look?.isHanging ? 'true' : undefined}
        style={{ width: size, height: size }}
        aria-hidden="true"
        onClick={onPoke}
      >
        {look ? <Sprite look={look} size={size} /> : null}
      </div>
      {look ? (
        <Speech
          speech={speech}
          chatRef={chatRef}
          onChatDone={(mood) => engineRef.current?.endChat(performance.now(), mood)}
        />
      ) : null}
    </div>,
    document.body,
  );
}
