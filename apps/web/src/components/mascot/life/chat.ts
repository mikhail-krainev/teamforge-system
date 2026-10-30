import type { MessageKey } from '@/i18n';

export type ChatQuestionKey =
  | 'mascot.chat.question.stack'
  | 'mascot.chat.question.drink'
  | 'mascot.chat.question.project'
  | 'mascot.chat.question.day'
  | 'mascot.chat.question.tabs';

export type ChatMood = 'happy' | 'neutral' | 'surprised' | 'shy';

export const CHAT_QUESTIONS: readonly ChatQuestionKey[] = [
  'mascot.chat.question.stack',
  'mascot.chat.question.drink',
  'mascot.chat.question.project',
  'mascot.chat.question.day',
  'mascot.chat.question.tabs',
];

interface Bucket {
  keywords: readonly string[];
  replyKey: MessageKey;
  mood: ChatMood;
}

interface QuestionRules {
  buckets: readonly Bucket[];
  fallback: { replyKey: MessageKey; mood: ChatMood };
}

const SHY_REPLY = { replyKey: 'mascot.chat.reply.shy', mood: 'shy' } as const;

/** Buckets are checked in order: the first one whose keyword occurs in the answer wins. */
const RULES: Record<ChatQuestionKey, QuestionRules> = {
  'mascot.chat.question.stack': {
    buckets: [
      {
        keywords: ['и то и друг', 'оба', 'фулстек', 'fullstack', 'full stack'],
        replyKey: 'mascot.chat.reply.stack.both',
        mood: 'surprised',
      },
      {
        keywords: ['фронт', 'front', 'react', 'css', 'верст'],
        replyKey: 'mascot.chat.reply.stack.front',
        mood: 'happy',
      },
      {
        keywords: ['бэк', 'бек', 'back', 'сервер', 'api', 'баз'],
        replyKey: 'mascot.chat.reply.stack.back',
        mood: 'happy',
      },
    ],
    fallback: { replyKey: 'mascot.chat.reply.stack.other', mood: 'neutral' },
  },
  'mascot.chat.question.drink': {
    buckets: [
      {
        keywords: ['и то и друг', 'оба', 'всё', 'все '],
        replyKey: 'mascot.chat.reply.drink.both',
        mood: 'surprised',
      },
      {
        keywords: ['чай', 'чаёк', 'чаек', 'tea'],
        replyKey: 'mascot.chat.reply.drink.tea',
        mood: 'happy',
      },
      {
        keywords: ['кофе', 'coffee', 'эспрессо', 'латте'],
        replyKey: 'mascot.chat.reply.drink.coffee',
        mood: 'happy',
      },
    ],
    fallback: { replyKey: 'mascot.chat.reply.drink.other', mood: 'neutral' },
  },
  'mascot.chat.question.project': {
    buckets: [
      {
        keywords: ['не знаю', 'пока не', 'не решил', 'без понятия', 'хз'],
        replyKey: 'mascot.chat.reply.project.unsure',
        mood: 'neutral',
      },
      {
        keywords: ['опенсорс', 'open source', 'opensource', 'oss'],
        replyKey: 'mascot.chat.reply.project.oss',
        mood: 'happy',
      },
      {
        keywords: ['свой', 'мой', 'pet', 'пет'],
        replyKey: 'mascot.chat.reply.project.own',
        mood: 'happy',
      },
    ],
    fallback: { replyKey: 'mascot.chat.reply.project.other', mood: 'neutral' },
  },
  'mascot.chat.question.day': {
    buckets: [
      {
        keywords: ['плох', 'ужас', 'тяжел', 'устал', 'хреново', 'так себе'],
        replyKey: 'mascot.chat.reply.day.bad',
        mood: 'shy',
      },
      {
        keywords: ['хорош', 'отлич', 'супер', 'класс', 'здорово', 'норм'],
        replyKey: 'mascot.chat.reply.day.good',
        mood: 'happy',
      },
      {
        keywords: ['нормально', 'обычно', 'ровно', 'ничего', 'потихоньку'],
        replyKey: 'mascot.chat.reply.day.meh',
        mood: 'neutral',
      },
    ],
    fallback: { replyKey: 'mascot.chat.reply.day.other', mood: 'neutral' },
  },
  'mascot.chat.question.tabs': {
    buckets: [
      {
        keywords: ['и то и друг', 'оба', 'both'],
        replyKey: 'mascot.chat.reply.tabs.both',
        mood: 'surprised',
      },
      { keywords: ['таб', 'tab'], replyKey: 'mascot.chat.reply.tabs.tabs', mood: 'happy' },
      { keywords: ['пробел', 'space'], replyKey: 'mascot.chat.reply.tabs.spaces', mood: 'happy' },
    ],
    fallback: { replyKey: 'mascot.chat.reply.tabs.other', mood: 'neutral' },
  },
};

function normalize(answer: string): string {
  return answer.trim().toLowerCase().replaceAll('ё', 'е');
}

export function pickReply(
  questionKey: ChatQuestionKey,
  answer: string,
): { replyKey: MessageKey; mood: ChatMood } {
  const text = normalize(answer);
  if (text === '') return SHY_REPLY;
  const { buckets, fallback } = RULES[questionKey];
  const hit = buckets.find((bucket) =>
    bucket.keywords.some((word) => text.includes(normalize(word))),
  );
  const { replyKey, mood } = hit ?? fallback;
  return { replyKey, mood };
}
