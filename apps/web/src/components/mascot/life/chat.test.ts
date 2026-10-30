import { describe, expect, it } from 'vitest';
import { CHAT_QUESTIONS, pickReply } from './chat';

describe('pickReply', () => {
  it('matches keyword buckets case-insensitively and trims', () => {
    expect(pickReply('mascot.chat.question.stack', '  ФРОНТ ').replyKey).toBe(
      'mascot.chat.reply.stack.front',
    );
    expect(pickReply('mascot.chat.question.drink', 'Кофе')).toEqual({
      replyKey: 'mascot.chat.reply.drink.coffee',
      mood: 'happy',
    });
  });

  it('treats ё as е', () => {
    expect(pickReply('mascot.chat.question.drink', 'чёрный чаёк').replyKey).toBe(
      'mascot.chat.reply.drink.tea',
    );
  });

  it('prefers the "both" bucket when the answer names both options', () => {
    expect(pickReply('mascot.chat.question.tabs', 'и то и другое')).toEqual({
      replyKey: 'mascot.chat.reply.tabs.both',
      mood: 'surprised',
    });
  });

  it('falls back when nothing matches', () => {
    for (const key of CHAT_QUESTIONS) {
      expect(pickReply(key, 'qwerty zzz').replyKey).toMatch(/\.other$/);
    }
  });

  it('answers shyly to an empty or blank answer', () => {
    for (const key of CHAT_QUESTIONS) {
      expect(pickReply(key, '   ')).toEqual({ replyKey: 'mascot.chat.reply.shy', mood: 'shy' });
    }
  });
});
