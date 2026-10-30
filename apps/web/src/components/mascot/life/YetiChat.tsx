'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { t, type MessageKey } from '@/i18n';
import { pickReply, type ChatMood, type ChatQuestionKey } from './chat';
import './chat.css';

export { CHAT_QUESTIONS, type ChatMood, type ChatQuestionKey } from './chat';

/** How long the reply stays on screen before the chat reports it is done. */
export const REPLY_HOLD_MS = 2500;
const MAX_ANSWER_LENGTH = 80;

interface YetiChatProps {
  questionKey: ChatQuestionKey;
  onDone: (mood: ChatMood) => void;
}

function useChatFlow(questionKey: ChatQuestionKey, onDone: (mood: ChatMood) => void) {
  const [replyKey, setReplyKey] = useState<MessageKey | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finishedRef = useRef(false);
  const onDoneRef = useRef(onDone);

  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const finish = (mood: ChatMood) => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    if (timerRef.current) clearTimeout(timerRef.current);
    onDoneRef.current(mood);
  };

  const submit = (answer: string) => {
    if (replyKey !== null || finishedRef.current) return;
    const reply = pickReply(questionKey, answer);
    setReplyKey(reply.replyKey);
    timerRef.current = setTimeout(() => finish(reply.mood), REPLY_HOLD_MS);
  };

  return { replyKey, submit, finish };
}

export function YetiChat({ questionKey, onDone }: YetiChatProps) {
  const [answer, setAnswer] = useState('');
  const { replyKey, submit, finish } = useChatFlow(questionKey, onDone);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit(answer);
  };

  return (
    <div
      className="yeti-chat"
      onKeyDown={(event) => {
        if (event.key === 'Escape') finish('neutral');
      }}
    >
      <div aria-live="polite" className="yeti-chat-reply">
        {replyKey ? t(replyKey) : null}
      </div>
      {replyKey ? null : (
        <form className="yeti-chat-form" onSubmit={handleSubmit}>
          <label className="yeti-chat-question" htmlFor="yeti-chat-input">
            {t(questionKey)}
          </label>
          <div className="yeti-chat-row">
            <input
              id="yeti-chat-input"
              className="yeti-chat-input"
              type="text"
              maxLength={MAX_ANSWER_LENGTH}
              autoComplete="off"
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
            />
            <button className="yeti-chat-send" type="submit" aria-label={t('mascot.chat.send')}>
              <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
                <path
                  d="M3 9h11M9.5 4.5 14 9l-4.5 4.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                />
              </svg>
            </button>
          </div>
          <button
            className="yeti-chat-close"
            type="button"
            aria-label={t('mascot.chat.close')}
            onClick={() => finish('neutral')}
          >
            <span aria-hidden="true">×</span>
          </button>
        </form>
      )}
    </div>
  );
}
