import type { UnmetCondition } from '../../../../platform/errors/domain-error.js';
import { MIN_STAGE_MS } from './transition-rules.js';

/**
 * The conditions of completing a project (FR-WORK-13, FR-GH-08, FR-WORK-14; architecture 11.4) as pure
 * functions of facts. The block rules of the anti-fraud list (AF-01, AF-02, AF-04, AF-09, AF-10) are these
 * same conditions: slice 7 reads them as signals (`rewards/internal/fraud`) instead of copying the code.
 */

const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

/** C-01: the project needs this many members when it is completed. */
export const MIN_MEMBERS = 3;
/** C-06a, AF-09: calendar days from the opening of the first stage. */
export const MIN_PROJECT_DAYS = 14;
/** C-09, AF-09: calendar days with a contribution. */
export const MIN_CONTRIBUTION_DAYS = 3;
/** C-52, AF-04: merged pull requests plus closed issues. */
export const MIN_CONTRIBUTIONS = 10;
/** AF-04: accounts with a contribution. */
export const MIN_CONTRIBUTORS = 2;
/** C-53: the second check of the release comes this long after the first. */
export const RELEASE_RECHECK_MS = DAY_MS;
/** A completion check is valid this long after it finished (architecture 11.4). */
export const CHECK_VALID_MS = HOUR_MS;

/** AF-02: addresses of examples and of the local machine are not a release. */
const TEMPLATE_HOSTS: readonly string[] = [
  'example.com',
  'example.org',
  'example.net',
  'localhost',
];

export type UnmetCode =
  | 'STAGES_NOT_CLOSED'
  | 'COMPLETION_CHECK_MISSING'
  | 'COMPLETION_CHECK_EXPIRED'
  | 'REPO_FINAL_FAILED'
  | 'RELEASE_CHECK_FAILED'
  | 'LINK_CHECK_FAILED'
  | 'MEMBERS_BELOW_MIN'
  | 'DURATION_TOO_SHORT'
  | 'CONTRIBUTION_DAYS_TOO_FEW'
  | 'CONTRIBUTION_TOO_LOW'
  | 'CONTRIBUTORS_TOO_FEW'
  | 'STAGE_CLOSED_TOO_FAST'
  | 'FRAUD_BLOCK';

/** The keys of the results of a completion check (`CompletionCheckResult.key`). */
export const REPO_FINAL_KEY = 'repo_final';
export const RELEASE_KEY_PREFIX = 'release_alive';
export const LINK_KEY_PREFIX = 'link_https';

export interface StageFact {
  ordinal: number;
  status: string;
  openedAt: Date | null;
  closedAt: Date | null;
}

export interface ContributionFact {
  userId: string;
  source: string;
  /** The task or pull request that was credited (`issue:<repo>#<n>`, `pr:<repo>#<n>`); one per assignee row. */
  ref: string;
  active: boolean;
  receivedAt: Date;
}

export interface CheckResultFact {
  key: string;
  ok: boolean;
  blocking: boolean;
  message: string;
  data?: Record<string, unknown>;
}

export interface CheckFact {
  validUntil: Date | null;
  results: readonly CheckResultFact[];
}

export interface CompletionFacts {
  now: Date;
  stages: readonly StageFact[];
  memberCount: number;
  contributions: readonly ContributionFact[];
  /** The latest finished check of the team, or `null` when there is none. */
  check: CheckFact | null;
  /** The release address of the team now. */
  releaseUrl: string | null;
  /** The repository that holds the team now (active link). */
  repositoryId: number | null;
  /** AF-02: another completed project holds the same normalized release address (`team.release_key`). */
  releaseAddressHeld: boolean;
}

function unmet(code: UnmetCode, message: string, data?: Record<string, unknown>): UnmetCondition {
  return data === undefined ? { code, message } : { code, message, data };
}

/** FR-WORK-13 (1). */
export function stagesNotClosed(facts: CompletionFacts): UnmetCondition | undefined {
  const open = facts.stages.filter((s) => s.status !== 'closed').map((s) => s.ordinal);
  if (facts.stages.length > 0 && open.length === 0) return undefined;
  return unmet('STAGES_NOT_CLOSED', 'Пройдены не все этапы проекта', { ordinals: open });
}

/** FR-WORK-13 (4). */
export function membersBelowMin(facts: CompletionFacts): UnmetCondition | undefined {
  if (facts.memberCount >= MIN_MEMBERS) return undefined;
  return unmet('MEMBERS_BELOW_MIN', `В команде меньше ${MIN_MEMBERS} участников`, {
    members: facts.memberCount,
    min: MIN_MEMBERS,
  });
}

/** FR-WORK-13 (5), AF-09: at least 14 days since the first stage opened. */
export function durationTooShort(facts: CompletionFacts): UnmetCondition | undefined {
  const opened = facts.stages.find((s) => s.ordinal === 1)?.openedAt ?? facts.stages[0]?.openedAt;
  if (opened === null || opened === undefined) return undefined;
  const days = Math.floor((facts.now.getTime() - opened.getTime()) / DAY_MS);
  if (days >= MIN_PROJECT_DAYS) return undefined;
  return unmet(
    'DURATION_TOO_SHORT',
    `С открытия первого этапа прошло меньше ${MIN_PROJECT_DAYS} дней`,
    {
      days: Math.max(0, days),
      min: MIN_PROJECT_DAYS,
    },
  );
}

/** The day on which a contribution counts: the calendar day (UTC) it was received. */
const dayOf = (at: Date): string => at.toISOString().slice(0, 10);

/** Merged pull requests and closed issues that count now (AF-04). */
export function countedWork(contributions: readonly ContributionFact[]): ContributionFact[] {
  return contributions.filter((c) => c.active && (c.source === 'pr' || c.source === 'issue'));
}

/** FR-WORK-13 (5), AF-09: contributions on at least three calendar days. */
export function contributionDaysTooFew(facts: CompletionFacts): UnmetCondition | undefined {
  const days = new Set(facts.contributions.filter((c) => c.active).map((c) => dayOf(c.receivedAt)));
  if (days.size >= MIN_CONTRIBUTION_DAYS) return undefined;
  return unmet(
    'CONTRIBUTION_DAYS_TOO_FEW',
    `Вклад есть меньше чем в ${MIN_CONTRIBUTION_DAYS} календарных днях`,
    {
      days: days.size,
      min: MIN_CONTRIBUTION_DAYS,
    },
  );
}

/**
 * How many merged pull requests and closed issues count: distinct `source` + `ref`. A task with two
 * assignees has a row per account, but it is one task (AF-04).
 */
export function countedWorkItems(contributions: readonly ContributionFact[]): number {
  return new Set(countedWork(contributions).map((c) => `${c.source}:${c.ref}`)).size;
}

/** FR-WORK-13 (6), AF-04: at least 10 merged pull requests and closed issues. */
export function contributionTooLow(facts: CompletionFacts): UnmetCondition | undefined {
  const count = countedWorkItems(facts.contributions);
  if (count >= MIN_CONTRIBUTIONS) return undefined;
  return unmet('CONTRIBUTION_TOO_LOW', `Меньше ${MIN_CONTRIBUTIONS} слитых PR и закрытых задач`, {
    count,
    min: MIN_CONTRIBUTIONS,
  });
}

/** FR-WORK-13 (6), AF-04: contributions of at least two accounts. */
export function contributorsTooFew(facts: CompletionFacts): UnmetCondition | undefined {
  const contributors = new Set(countedWork(facts.contributions).map((c) => c.userId));
  if (contributors.size >= MIN_CONTRIBUTORS) return undefined;
  return unmet('CONTRIBUTORS_TOO_FEW', `Вклад внесли меньше ${MIN_CONTRIBUTORS} участников`, {
    contributors: contributors.size,
    min: MIN_CONTRIBUTORS,
  });
}

/** AF-10: a stage that stayed open less than 24 hours (the order itself is kept by the transition). */
export function stageClosedTooFast(facts: CompletionFacts): UnmetCondition | undefined {
  const fast = facts.stages
    .filter((s) => s.openedAt !== null && s.closedAt !== null)
    .filter((s) => (s.closedAt as Date).getTime() - (s.openedAt as Date).getTime() < MIN_STAGE_MS)
    .map((s) => s.ordinal);
  if (fast.length === 0) return undefined;
  return unmet('STAGE_CLOSED_TOO_FAST', 'Этап закрыт быстрее чем за 24 часа после открытия', {
    ordinals: fast,
  });
}

/** The hostname of an address, lower case without the dot at the end; `null` for text that is no address. */
function hostOf(address: string): string | null {
  try {
    return new URL(address).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
}

/** AF-02: an address of examples or of the local machine. */
export function isTemplateAddress(address: string): boolean {
  const host = hostOf(address);
  if (host === null) return false;
  return TEMPLATE_HOSTS.some((t) => host === t || host === `www.${t}` || host.endsWith(`.${t}`));
}

/** AF-02 (FRAUD_BLOCK): a template address or one already used by a completed project. */
export function fraudBlock(facts: CompletionFacts): UnmetCondition | undefined {
  if (facts.releaseUrl === null) return undefined;
  if (isTemplateAddress(facts.releaseUrl)) {
    return unmet('FRAUD_BLOCK', 'Адрес релиза — шаблонный или локальный', { rule: 'AF-02' });
  }
  if (facts.releaseAddressHeld) {
    return unmet('FRAUD_BLOCK', 'Этот адрес релиза уже есть у другого завершённого проекта', {
      rule: 'AF-02',
    });
  }
  return undefined;
}

const resultOf = (check: CheckFact, key: string): CheckResultFact | undefined =>
  check.results.find((r) => r.key === key);

function repoCondition(check: CheckFact, facts: CompletionFacts): UnmetCondition | undefined {
  const repo = resultOf(check, REPO_FINAL_KEY);
  const repoId = repo?.data?.['repositoryId'];
  if (repo?.ok === true && facts.repositoryId !== null && repoId === facts.repositoryId) {
    return undefined;
  }
  return unmet('REPO_FINAL_FAILED', repo?.message ?? 'Репозиторий не прошёл итоговую проверку');
}

function releaseCondition(check: CheckFact, facts: CompletionFacts): UnmetCondition | undefined {
  const release = check.results.find((r) => r.key.startsWith(RELEASE_KEY_PREFIX));
  if (release === undefined || !release.ok) {
    return unmet(
      'RELEASE_CHECK_FAILED',
      release?.message ?? 'Ссылка на релиз не прошла проверку',
      release?.data,
    );
  }
  if (facts.releaseUrl !== null && release.data?.['url'] === facts.releaseUrl) return undefined;
  return unmet(
    'RELEASE_CHECK_FAILED',
    'Ссылка на релиз изменилась после проверки: проверьте её заново',
  );
}

function linkCondition(check: CheckFact): UnmetCondition | undefined {
  const broken = check.results.filter((r) => r.key.startsWith(LINK_KEY_PREFIX) && !r.ok);
  if (broken.length === 0) return undefined;
  return unmet('LINK_CHECK_FAILED', 'Не все ссылки проекта работают', {
    keys: broken.map((r) => r.key),
  });
}

/** The results of the last check as conditions: it exists, it is fresh, and each part passed for what is now. */
export function checkConditions(facts: CompletionFacts): UnmetCondition[] {
  const { check, now } = facts;
  if (check === null) {
    return [
      unmet('COMPLETION_CHECK_MISSING', 'Сначала запустите проверку готовности к завершению'),
    ];
  }
  if (check.validUntil === null || check.validUntil.getTime() <= now.getTime()) {
    return [
      unmet('COMPLETION_CHECK_EXPIRED', 'Проверка устарела (действует 1 час): запустите её снова'),
    ];
  }
  return [repoCondition(check, facts), releaseCondition(check, facts), linkCondition(check)].filter(
    (c): c is UnmetCondition => c !== undefined,
  );
}

/** Every condition of completing a project that is not met, in the order of the contract's `UnmetCode`. */
export function completionUnmet(facts: CompletionFacts): UnmetCondition[] {
  return [
    stagesNotClosed(facts),
    ...checkConditions(facts),
    membersBelowMin(facts),
    durationTooShort(facts),
    contributionDaysTooFew(facts),
    contributionTooLow(facts),
    contributorsTooFew(facts),
    stageClosedTooFast(facts),
    fraudBlock(facts),
  ].filter((c): c is UnmetCondition => c !== undefined);
}

/** FR-WORK-12: days of delay of the whole project, rounded up. */
export function overdueDaysOf(plannedEnd: Date, completedAt: Date): number {
  return Math.max(0, Math.ceil((completedAt.getTime() - plannedEnd.getTime()) / DAY_MS));
}
