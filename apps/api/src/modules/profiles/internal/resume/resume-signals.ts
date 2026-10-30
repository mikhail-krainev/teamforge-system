/**
 * Facts read from the plain resume text for the assessment (resume-assessment.ts): sections,
 * work periods, contacts, links, quantified results. Rule based and deterministic; the text is
 * data, nothing here is logged.
 */

export type SectionKind = 'experience' | 'education' | 'skills' | 'about' | 'projects';

/** Heading words of the sections, Russian first (hh.ru, Habr Career) and English. */
const SECTION_HEADINGS: Record<SectionKind, readonly string[]> = {
  experience: [
    'опыт работы',
    'опыт',
    'профессиональный опыт',
    'места работы',
    'трудовая деятельность',
    'work experience',
    'experience',
    'employment',
  ],
  education: [
    'образование',
    'основное образование',
    'дополнительное образование',
    'курсы',
    'повышение квалификации',
    'сертификаты',
    'education',
    'courses',
    'certificates',
  ],
  skills: [
    'навыки',
    'ключевые навыки',
    'профессиональные навыки',
    'технические навыки',
    'технологии',
    'стек',
    'стек технологий',
    'компетенции',
    'skills',
    'key skills',
    'technical skills',
    'tech stack',
  ],
  about: ['о себе', 'обо мне', 'цель', 'профиль', 'about', 'about me', 'summary', 'profile'],
  projects: ['проекты', 'pet-проекты', 'портфолио', 'projects', 'pet projects', 'portfolio'],
};

const MAX_HEADING_LENGTH = 40;

export interface Section {
  kind: SectionKind;
  /** Lines of the section body, heading excluded. */
  lines: string[];
}

function headingKind(line: string): SectionKind | null {
  const normalized = line
    .trim()
    .toLowerCase()
    .replace(/[:.\s]+$/u, '');
  if (normalized === '' || normalized.length > MAX_HEADING_LENGTH) return null;
  for (const [kind, words] of Object.entries(SECTION_HEADINGS) as [SectionKind, string[]][]) {
    if (words.some((word) => normalized === word || normalized.startsWith(`${word} `))) return kind;
  }
  return null;
}

/** Splits the text into the sections it names; text before the first heading is left out. */
export function findSections(lines: readonly string[]): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;
  for (const line of lines) {
    const kind = headingKind(line);
    if (kind) {
      current = { kind, lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return sections;
}

const MONTHS: readonly [RegExp, number][] = [
  [/^(янв|jan)/u, 1],
  [/^(фев|feb)/u, 2],
  [/^(мар|mar)/u, 3],
  [/^(апр|apr)/u, 4],
  [/^(ма[йяе]|may)/u, 5],
  [/^(июн|jun)/u, 6],
  [/^(июл|jul)/u, 7],
  [/^(авг|aug)/u, 8],
  [/^(сен|sep)/u, 9],
  [/^(окт|oct)/u, 10],
  [/^(ноя|nov)/u, 11],
  [/^(дек|dec)/u, 12],
];

const MONTH_WORD = '[а-яёa-z]{3,9}';
const DATE = `(?:(${MONTH_WORD})\\.?\\s+|(\\d{1,2})[./])?((?:19|20)\\d{2})`;
const PRESENT =
  '(?:по\\s+)?(?:н\\.?\\s?в\\.?|настоящее\\s+время|наст\\.?\\s?вр\\.?|сейчас|сегодня|present|now|current|today)';
const RANGE = new RegExp(`${DATE}\\s*(?:[-–—]|по|до|to|till)\\s*(?:${DATE}|(${PRESENT}))`, 'giu');
const MAX_PERIOD_MONTHS = 50 * 12;

/** A work period as month numbers (year * 12 + month - 1), both ends included. */
export interface Period {
  start: number;
  end: number;
}

function monthOf(word: string | undefined, numeric: string | undefined): number | null {
  if (numeric) {
    const value = Number(numeric);
    return value >= 1 && value <= 12 ? value : null;
  }
  if (!word) return null;
  const lower = word.toLowerCase();
  return MONTHS.find(([pattern]) => pattern.test(lower))?.[1] ?? null;
}

/** Date ranges such as "март 2020 — по настоящее время", "01.2019 - 06.2021", "2018–2020". */
export function findPeriods(text: string, now: Date): Period[] {
  const nowMonth = now.getUTCFullYear() * 12 + now.getUTCMonth();
  const periods: Period[] = [];
  for (const match of text.matchAll(RANGE)) {
    const [, startWord, startNumber, startYear, endWord, endNumber, endYear, present] = match;
    const startMonth = monthOf(startWord, startNumber) ?? 1;
    const start = Number(startYear) * 12 + startMonth - 1;
    const end = present
      ? nowMonth
      : Number(endYear) * 12 +
        (monthOf(endWord, endNumber) ?? (endYear === startYear ? 12 : 1)) -
        1;
    const isSane = end >= start && end <= nowMonth && end - start < MAX_PERIOD_MONTHS;
    if (isSane) periods.push({ start, end });
  }
  return periods;
}

/** Months covered by the periods; overlapping jobs are counted once. */
export function coveredMonths(periods: readonly Period[]): number {
  const sorted = [...periods].sort((a, b) => a.start - b.start);
  let total = 0;
  let reach = -Infinity;
  for (const { start, end } of sorted) {
    const from = Math.max(start, reach + 1);
    if (end >= from) total += end - from + 1;
    reach = Math.max(reach, end);
  }
  return total;
}

/** The longest break between the end of one job and the start of the next, in months. */
export function longestGap(periods: readonly Period[]): number {
  const sorted = [...periods].sort((a, b) => a.start - b.start);
  let gap = 0;
  let reach = sorted[0]?.end ?? 0;
  for (const { start, end } of sorted.slice(1)) {
    gap = Math.max(gap, start - reach - 1);
    reach = Math.max(reach, end);
  }
  return gap;
}

const EMAIL = /[\w.+-]+@[\w-]+\.[a-z]{2,}/iu;
const PHONE = /(?:\+7|(?<!\d)8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}(?!\d)/u;
const MESSENGER = /t\.me\/|telegram|телеграм/iu;
const LINKS =
  /github\.com|gitlab\.com|career\.habr\.com|habr\.com\/[a-z]{2}\/users|behance\.net|dribbble\.com|kaggle\.com|figma\.com|linkedin\.com/giu;
const POSITION_WORDS =
  /желаемая должность|позиция|position|разработчик|программист|developer|engineer|инженер|аналитик|analyst|дизайнер|designer|тестировщик|\bqa\b|devops|frontend|front-end|backend|back-end|fullstack|full-stack|android|\bios\b|продакт|product|менеджер|manager|data scientist|стаж[её]р|intern/iu;
const QUANTIFIED =
  /\d+(?:[.,]\d+)?\s?(?:%|процент|раз(?:а)?(?![\p{L}])|x(?![\p{L}])|×|млн|тыс|k(?![\p{L}])|₽|руб|пользовател|клиент|заказ|запрос|rps|мс(?![\p{L}])|ms(?![\p{L}]))/giu;
const ACTION_VERBS =
  /(?<![\p{L}])(?:разработал|внедрил|увеличил|сократил|снизил|ускорил|оптимизировал|запустил|автоматизировал|спроектировал|реализовал|улучшил|настроил|перевёл|перевел|мигрировал|построил|создал|руководил|организовал|обучил|повысил|developed|implemented|increased|reduced|improved|launched|built|designed|automated|optimi[sz]ed|led|migrated|delivered)/giu;
const CLICHES =
  /стрессоустойчив|коммуникабельн|ответственн|целеустремл|пунктуальн|исполнительн|быстро обуча|обучаем|нацелен(?:а)? на результат|командный игрок|team player|hard-?working|fast learner|self-motivated/giu;
const LEAD_MARKERS =
  /тимлид|team ?lead|tech ?lead|техлид|руководител|руководил|head of|lead developer|ведущий/iu;
const SENIOR_MARKERS = /senior|сеньор|старший|архитектор|architect/iu;
const BULLET = /^\s*(?:[-•*–▪●◦]|\d+[.)])\s+/u;

export interface TextSignals {
  words: number;
  lines: number;
  bulletLines: number;
  sentences: number;
  hasEmail: boolean;
  hasPhone: boolean;
  hasMessenger: boolean;
  hasPosition: boolean;
  links: number;
  quantified: number;
  actionVerbs: number;
  cliches: number;
  hasLeadMarkers: boolean;
  hasSeniorMarkers: boolean;
}

const POSITION_LINES = 8;
const countOf = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].length;

export function readSignals(text: string, lines: readonly string[]): TextSignals {
  const nonEmpty = lines.filter((line) => line.trim() !== '');
  const head = nonEmpty.slice(0, POSITION_LINES).join('\n');
  return {
    words: text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0,
    lines: nonEmpty.length,
    bulletLines: nonEmpty.filter((line) => BULLET.test(line)).length,
    sentences: Math.max(1, countOf(text, /[.!?…]+(?:\s|$)/gu)),
    hasEmail: EMAIL.test(text),
    hasPhone: PHONE.test(text),
    hasMessenger: MESSENGER.test(text),
    hasPosition: POSITION_WORDS.test(head),
    links: new Set(text.match(LINKS)?.map((link) => link.toLowerCase())).size,
    quantified: countOf(text, QUANTIFIED),
    actionVerbs: countOf(text, ACTION_VERBS),
    cliches: countOf(text, CLICHES),
    hasLeadMarkers: LEAD_MARKERS.test(text),
    hasSeniorMarkers: SENIOR_MARKERS.test(text),
  };
}
