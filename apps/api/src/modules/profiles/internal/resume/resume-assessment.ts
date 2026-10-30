import {
  coveredMonths,
  findPeriods,
  findSections,
  longestGap,
  readSignals,
  type Period,
  type Section,
  type SectionKind,
  type TextSignals,
} from './resume-signals.js';
import { fitRoles, type RoleFit } from './resume-roles.js';

/**
 * Scoring and screening of a resume text, the way Russian IT recruiting reads one (hh.ru resume
 * recommendations, ATS screening in Хантфлоу/Talantix/Potok, Junior/Middle/Senior grade matrices):
 *
 * - scoring: five weighted criteria, 100 points in all (structure, results, experience, skills,
 *   readability);
 * - screening: stop factors a recruiter filters on (job hopping, long gaps, clichés instead of
 *   facts, no contacts), each costs points;
 * - the score gives the level of the resume, the work history gives the estimated grade;
 * - the conclusion: the catalog roles the text fits best, the strengths a recruiter would note
 *   and the holes (missing parts and stop factors).
 *
 * Rule based and deterministic, a hint for the user only: nothing is decided by it.
 */

export type ResumeLevel = 'strong' | 'good' | 'fair' | 'weak';
export type Seniority = 'intern' | 'junior' | 'middle' | 'senior' | 'lead';
export type CriterionCode = 'structure' | 'achievements' | 'experience' | 'skills' | 'readability';
export type RedFlagCode =
  | 'no_contacts'
  | 'job_hopping'
  | 'employment_gap'
  | 'cliches'
  | 'too_short'
  | 'too_long'
  | 'no_achievements';
export type TipCode =
  | 'add_contacts'
  | 'add_position'
  | 'add_experience'
  | 'add_education'
  | 'add_skills'
  | 'name_technologies'
  | 'add_about'
  | 'quantify_results'
  | 'use_action_verbs'
  | 'add_links'
  | 'adjust_length'
  | 'use_bullets'
  | 'replace_cliches';

export type StrengthCode =
  | 'measurable_results'
  | 'result_oriented'
  | 'solid_experience'
  | 'leadership'
  | 'broad_stack'
  | 'portfolio_links'
  | 'complete_structure'
  | 'stable_career'
  | 'easy_to_read';
/** Holes of the resume: every stop factor plus the parts a recruiter looks for and does not find. */
export type WeaknessCode =
  | RedFlagCode
  | 'no_position'
  | 'no_experience'
  | 'no_education'
  | 'no_skills'
  | 'no_about'
  | 'few_results'
  | 'weak_wording'
  | 'narrow_stack'
  | 'no_links'
  | 'hard_to_read';

export interface ResumeAssessment {
  /** 0..100 after the stop-factor penalties. */
  score: number;
  level: ResumeLevel;
  seniority: Seniority;
  /** Work experience found in the dates, overlaps counted once. */
  experienceMonths: number;
  criteria: { code: CriterionCode; points: number; max: number }[];
  redFlags: RedFlagCode[];
  tips: TipCode[];
  /** Catalog roles the resume fits, best first (at most three); empty when none is recognised. */
  roles: RoleFit[];
  strengths: StrengthCode[];
  weaknesses: WeaknessCode[];
}

const LEVEL_FLOORS: readonly [ResumeLevel, number][] = [
  ['strong', 80],
  ['good', 65],
  ['fair', 45],
];

const PENALTIES: Partial<Record<RedFlagCode, number>> = {
  job_hopping: 6,
  employment_gap: 4,
  cliches: 3,
  too_short: 5,
};

/** Recruiters read fewer than three jobs averaging under a year as job hopping. */
const HOPPING_MIN_JOBS = 3;
const HOPPING_AVG_MONTHS = 12;
const GAP_MONTHS = 12;
const CLICHE_LIMIT = 3;
const WORDS_SHORT = 80;
const WORDS_GOOD = [200, 1000] as const;
const WORDS_LONG = 1600;

interface Facts {
  signals: TextSignals;
  sections: Set<SectionKind>;
  periods: Period[];
  months: number;
  stackTags: number;
}

interface Scored {
  code: CriterionCode;
  points: number;
  max: number;
  tips: TipCode[];
}

/** `perStep` points for each counted item, up to `cap` items. */
const byCount = (count: number, cap: number, perStep: number) => Math.min(count, cap) * perStep;

function structure({ signals, sections }: Facts): Scored {
  const hasContacts = signals.hasEmail || signals.hasPhone || signals.hasMessenger;
  const parts: [boolean, number, TipCode][] = [
    [hasContacts, 5, 'add_contacts'],
    [signals.hasPosition, 4, 'add_position'],
    [sections.has('experience') || sections.has('projects'), 5, 'add_experience'],
    [sections.has('education'), 3, 'add_education'],
    [sections.has('skills'), 5, 'add_skills'],
    [sections.has('about'), 3, 'add_about'],
  ];
  return {
    code: 'structure',
    points: parts.reduce((sum, [ok, points]) => sum + (ok ? points : 0), 0),
    max: 25,
    tips: parts.flatMap(([ok, , tip]) => (ok ? [] : [tip])),
  };
}

function achievements({ signals }: Facts): Scored {
  const tips: TipCode[] = [];
  if (signals.quantified < 3) tips.push('quantify_results');
  if (signals.actionVerbs < 3) tips.push('use_action_verbs');
  return {
    code: 'achievements',
    points: byCount(signals.quantified, 5, 4) + byCount(signals.actionVerbs, 5, 1),
    max: 25,
    tips,
  };
}

const EXPERIENCE_STEPS: readonly [number, number][] = [
  [72, 15],
  [36, 12],
  [12, 9],
  [1, 5],
];
/** A student with no jobs but own projects still has something to show. */
const PROJECTS_ONLY_POINTS = 5;

function experience({ months, sections }: Facts): Scored {
  const fromMonths = EXPERIENCE_STEPS.find(([floor]) => months >= floor)?.[1] ?? 0;
  const points = Math.max(fromMonths, sections.has('projects') ? PROJECTS_ONLY_POINTS : 0);
  return { code: 'experience', points, max: 15, tips: points === 0 ? ['add_experience'] : [] };
}

function skills({ signals, stackTags }: Facts): Scored {
  const tips: TipCode[] = [];
  if (stackTags < 4) tips.push('name_technologies');
  if (signals.links === 0) tips.push('add_links');
  return {
    code: 'skills',
    points: byCount(stackTags, 8, 2) + (signals.links > 0 ? 4 : 0),
    max: 20,
    tips,
  };
}

const MAX_WORDS_PER_SENTENCE = 25;
const WORDS_PER_LINE = 40;

function readability({ signals }: Facts): Scored {
  const { words } = signals;
  const isGoodLength = words >= WORDS_GOOD[0] && words <= WORDS_GOOD[1];
  const isFairLength = words >= WORDS_SHORT && words <= WORDS_LONG;
  const lengthPoints = isGoodLength ? 6 : isFairLength ? 3 : 0;
  const hasBullets = signals.bulletLines >= 3;
  const hasShortSentences = words / signals.sentences <= MAX_WORDS_PER_SENTENCE;
  const isBrokenIntoLines = signals.lines >= words / WORDS_PER_LINE;
  const tips: TipCode[] = [];
  if (!isGoodLength) tips.push('adjust_length');
  if (!hasBullets) tips.push('use_bullets');
  return {
    code: 'readability',
    points:
      lengthPoints +
      (hasBullets ? 3 : 0) +
      (hasShortSentences ? 3 : 0) +
      (isBrokenIntoLines ? 3 : 0),
    max: 15,
    tips,
  };
}

function screen({ signals, periods, months }: Facts): RedFlagCode[] {
  const flags: RedFlagCode[] = [];
  if (!signals.hasEmail && !signals.hasPhone && !signals.hasMessenger) flags.push('no_contacts');
  if (periods.length >= HOPPING_MIN_JOBS && months / periods.length < HOPPING_AVG_MONTHS) {
    flags.push('job_hopping');
  }
  if (longestGap(periods) > GAP_MONTHS) flags.push('employment_gap');
  if (signals.cliches >= CLICHE_LIMIT) flags.push('cliches');
  if (signals.words < WORDS_SHORT) flags.push('too_short');
  if (signals.words > WORDS_LONG) flags.push('too_long');
  if (periods.length > 0 && signals.quantified === 0) flags.push('no_achievements');
  return flags;
}

const SENIOR_MONTHS = 60;
const SENIOR_WITH_MARKERS_MONTHS = 48;
const MIDDLE_MONTHS = 24;
const JUNIOR_MONTHS = 6;

/** Grade by the usual Russian IT matrix: years of experience, raised by lead or senior roles. */
function seniorityOf({ months, signals }: Facts): Seniority {
  if (signals.hasLeadMarkers && months >= SENIOR_MONTHS) return 'lead';
  if (months >= SENIOR_MONTHS) return 'senior';
  if (signals.hasSeniorMarkers && months >= SENIOR_WITH_MARKERS_MONTHS) return 'senior';
  if (months >= MIDDLE_MONTHS) return 'middle';
  if (months >= JUNIOR_MONTHS) return 'junior';
  return 'intern';
}

/** Work periods come from the experience section; without one, from all but the education. */
function workPeriods(text: string, sections: readonly Section[], now: Date): Period[] {
  const work = sections.filter((section) => section.kind === 'experience');
  if (work.length > 0) {
    return findPeriods(work.flatMap((section) => section.lines).join('\n'), now);
  }
  const education = new Set(
    sections.filter((section) => section.kind === 'education').flatMap((section) => section.lines),
  );
  const rest = text.split('\n').filter((line) => !education.has(line));
  return findPeriods(rest.join('\n'), now);
}

const STRONG_RESULTS = 3;
const STRONG_VERBS = 5;
const SOLID_MONTHS = 36;
const BROAD_STACK = 6;
const STABLE_AVG_MONTHS = 24;
const EASY_READ_POINTS = 12;
const HARD_READ_POINTS = 8;

const pointsOf = (scored: readonly Scored[], code: CriterionCode) =>
  scored.find((criterion) => criterion.code === code) ?? { points: 0, max: 1 };

function strengthsOf(facts: Facts, scored: readonly Scored[]): StrengthCode[] {
  const { signals, periods, months, stackTags } = facts;
  const structure = pointsOf(scored, 'structure');
  const checks: [boolean, StrengthCode][] = [
    [signals.quantified >= STRONG_RESULTS, 'measurable_results'],
    [signals.actionVerbs >= STRONG_VERBS, 'result_oriented'],
    [months >= SOLID_MONTHS, 'solid_experience'],
    [signals.hasLeadMarkers && months > 0, 'leadership'],
    [stackTags >= BROAD_STACK, 'broad_stack'],
    [signals.links > 0, 'portfolio_links'],
    [structure.points === structure.max, 'complete_structure'],
    [periods.length >= 2 && months / periods.length >= STABLE_AVG_MONTHS, 'stable_career'],
    [pointsOf(scored, 'readability').points >= EASY_READ_POINTS, 'easy_to_read'],
  ];
  return checks.flatMap(([ok, code]) => (ok ? [code] : []));
}

function weaknessesOf(facts: Facts, scored: readonly Scored[], redFlags: RedFlagCode[]) {
  const { signals, sections, months, stackTags } = facts;
  const hasWork = sections.has('experience') || sections.has('projects') || months > 0;
  const checks: [boolean, WeaknessCode][] = [
    [!signals.hasPosition, 'no_position'],
    [!hasWork, 'no_experience'],
    [!sections.has('education'), 'no_education'],
    [!sections.has('skills'), 'no_skills'],
    [!sections.has('about'), 'no_about'],
    [signals.quantified < STRONG_RESULTS && !redFlags.includes('no_achievements'), 'few_results'],
    [signals.actionVerbs < 3, 'weak_wording'],
    [stackTags < 4, 'narrow_stack'],
    [signals.links === 0, 'no_links'],
    [pointsOf(scored, 'readability').points < HARD_READ_POINTS, 'hard_to_read'],
  ];
  const holes = checks.flatMap(([isHole, code]) => (isHole ? [code] : []));
  return [...redFlags, ...holes];
}

function levelOf(score: number): ResumeLevel {
  return LEVEL_FLOORS.find(([, floor]) => score >= floor)?.[0] ?? 'weak';
}

/**
 * Scores the extracted text. `stackTags` is the number of catalog stack tags found in it (the
 * suggestions), `now` closes the periods that run "по настоящее время".
 */
export function assessResume(text: string, stackTags: number, now: Date): ResumeAssessment {
  const lines = text.split('\n');
  const sections = findSections(lines);
  const periods = workPeriods(text, sections, now);
  const facts: Facts = {
    signals: readSignals(text, lines),
    sections: new Set(sections.map((section) => section.kind)),
    periods,
    months: coveredMonths(periods),
    stackTags,
  };
  const scored = [structure, achievements, experience, skills, readability].map((rule) =>
    rule(facts),
  );
  const redFlags = screen(facts);
  const penalty = redFlags.reduce((sum, flag) => sum + (PENALTIES[flag] ?? 0), 0);
  const raw = scored.reduce((sum, criterion) => sum + criterion.points, 0);
  const score = Math.max(0, Math.min(100, raw - penalty));
  const tips = new Set(scored.flatMap((criterion) => criterion.tips));
  if (facts.signals.cliches >= 2) tips.add('replace_cliches');
  return {
    score,
    level: levelOf(score),
    seniority: seniorityOf(facts),
    experienceMonths: facts.months,
    criteria: scored.map(({ code, points, max }) => ({ code, points, max })),
    redFlags,
    tips: [...tips],
    roles: fitRoles(text),
    strengths: strengthsOf(facts, scored),
    weaknesses: weaknessesOf(facts, scored, redFlags),
  };
}
