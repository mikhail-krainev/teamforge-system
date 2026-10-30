/**
 * Test support of the anti-fraud rule tests (S7-01; docs/spec.md 8, docs/architecture.md 10.5): the facts a rule
 * reads, a clean project and the loader of a rule module. This file is written BEFORE the implementation of S7-03.
 *
 * CONTRACT ASSUMED BY THE TESTS (architecture 10.5: "чистые функции `(facts) -> Signal[]` в
 * `rewards/internal/fraud/rules/AF-xx.ts`"; the architecture names neither the shape of the facts nor the export):
 *   - every rule file `AF-xx.ts` exports `evaluate(facts: FraudFacts): Signal[]` (an empty array = the rule is quiet);
 *   - `rules/index.ts` exports `evaluateAll(facts)` (rules of the phase `facts.phase`, sorted by `ruleCode`) and
 *     `summarize(signals)` -> `{ score, frozen }` (FR-REW-15: any block or flag, or a sum of `signal` scores >= C-61 = 3);
 *   - the facts are read before the transaction from `WorkspaceApi.getAntifraudFacts`, `GithubApi.getPullRequestStats`,
 *     `AuthApi.getIdentitySignals`, `ProfilesApi` fingerprints and the own `rewards` tables; the rules do no I/O.
 * If S7-03 names a field or an export differently, only this file (and the one line of `loadRule`) changes.
 * AF-23 (server time, numeric GitHub id), AF-24 (cooling) and AF-25 (audit) are processes, not functions: their
 * tests are in github/test/webhook.test.ts and rewards/test/{cooling,fraud}.test.ts.
 */

export const DAY_MS = 24 * 3_600_000;
export const HOUR_MS = 3_600_000;
export const MINUTE_MS = 60_000;

export type Phase = 'completion' | 'cooling_end';
export type Action = 'block' | 'flag' | 'signal' | 'info';

/** The row of `rewards.fraud_signal` a rule yields (the phase and the team are added by the caller). */
export interface Signal {
  ruleCode: string;
  action: Action;
  score: number;
  data: Record<string, unknown>;
}

export interface StageFacts {
  ordinal: number;
  status: 'open' | 'closed';
  plannedDays: number;
  openedAt: Date | null;
  closedAt: Date | null;
}

export interface ContributionFacts {
  userId: string;
  source: 'issue' | 'pr' | 'artifact' | 'ritual';
  ref: string;
  active: boolean;
  receivedAt: Date;
}

export interface ArtifactFacts {
  name: string;
  sizeBytes: number;
  sha256: string;
  /** Another project holds a file with this hash (`WorkspaceApi.findTeamsWithArtifactHashes`). */
  sameHashInOtherTeam: boolean;
}

export interface IdentitySignalFacts {
  userId: string;
  kind: 'ip24' | 'ua' | 'device';
  valueHmac: string;
}

export interface MemberFacts {
  userId: string;
  registeredAt: Date;
  joinedAt: Date;
  /** `auth.identity_tombstone` matches the GitHub id or the email of the account (AF-15). */
  tombstoneMatch: boolean;
  /** Normalised hash of the profile and resume text; `null` = no text (AF-18). */
  textHash: string | null;
  /** GitHub account check (FR-GH-09); `null` = not checked yet. */
  account: { ageDays: number; hasPublicActivity: boolean } | null;
  /** Days between "now" and the last other project credited to the person; `null` = none (AF-22). */
  lastOtherCreditDaysAgo: number | null;
}

export interface FraudFacts {
  phase: Phase;
  now: Date;
  team: {
    name: string;
    description: string;
    createdAt: Date;
    startedAt: Date;
    completedAt: Date;
  };
  stages: StageFacts[];
  members: MemberFacts[];
  contributions: ContributionFacts[];
  repository: {
    id: number;
    createdAt: Date;
    /** The `repository_id` is already bound to a credited project (AF-01). */
    boundToCreditedProject: boolean;
    forkWithoutOwnCommits: boolean;
  };
  release: {
    url: string;
    /** Another credited project holds the same normalised address (AF-02). */
    heldByCreditedProject: boolean;
    /** The page answers but is a stub ("coming soon", AF-02). */
    placeholderPage: boolean;
  };
  pullRequests: { changedLines: number; maxShare: number };
  artifacts: ArtifactFacts[];
  /** Name and description of the earlier credited projects of the same team (AF-08). */
  earlierProjects: { name: string; description: string }[];
  /** Completed projects with exactly this roster, this one included (AF-13). */
  sameRosterProjects: number;
  /** Marks "желательная" standing at the completion with the time of the last change (AF-14). */
  desiredMarks: { roleCode: string; changedAt: Date }[];
  identitySignals: IdentitySignalFacts[];
  /** hash -> all accounts that hold this text hash, members or not (AF-18). */
  textHolders: Record<string, string[]>;
  /** Sum of the scores of the other rules in this run (AF-22 reads it). */
  scoreSoFar: number;
}

const NOW = new Date('2026-06-30T12:00:00Z');
export const USERS = ['u-lead', 'u-backend', 'u-frontend'] as const;

export const at = (daysBeforeNow: number): Date => new Date(NOW.getTime() - daysBeforeNow * DAY_MS);

function cleanMember(userId: string, index: number): MemberFacts {
  return {
    userId,
    registeredAt: at(200 + index * 20),
    joinedAt: at(40 + index * 2),
    tombstoneMatch: false,
    textHash: `hash-${userId}`,
    account: { ageDays: 400, hasPublicActivity: true },
    lastOtherCreditDaysAgo: null,
  };
}

/** Twelve counted contributions of two developers, one per day, nothing in the last 48 hours but one. */
function cleanContributions(): ContributionFacts[] {
  return Array.from({ length: 12 }, (_, i) => ({
    userId: USERS[1 + (i % 2)] ?? 'u-backend',
    source: i % 3 === 0 ? 'pr' : 'issue',
    ref: `${i % 3 === 0 ? 'pr' : 'issue'}:7#${i + 1}`,
    active: true,
    receivedAt: at(28 - i * 2),
  }));
}

/** Stages open and close 10 days each (planned 10 days): 3 stages, 30 days; the project is completed now minus 0. */
function cleanStages(): StageFacts[] {
  return [1, 2, 3].map((ordinal) => ({
    ordinal,
    status: 'closed',
    plannedDays: 10,
    openedAt: at(31 - (ordinal - 1) * 10),
    closedAt: at(21 - (ordinal - 1) * 10),
  }));
}

/** A project no rule objects to: 3 members, 30 days, 12 counted contributions, 480 changed lines, own release. */
export function cleanFacts(change: Partial<FraudFacts> = {}): FraudFacts {
  return {
    phase: 'completion',
    now: NOW,
    team: {
      name: 'Доска задач',
      description: 'Сервис для учёта задач небольших команд',
      createdAt: at(40),
      startedAt: at(31),
      completedAt: NOW,
    },
    stages: cleanStages(),
    members: USERS.map(cleanMember),
    contributions: cleanContributions(),
    repository: {
      id: 7,
      createdAt: at(32),
      boundToCreditedProject: false,
      forkWithoutOwnCommits: false,
    },
    release: {
      url: 'https://app.release.test/',
      heldByCreditedProject: false,
      placeholderPage: false,
    },
    pullRequests: { changedLines: 480, maxShare: 0.34 },
    artifacts: [
      { name: 'brief.pdf', sizeBytes: 5000, sha256: 'a'.repeat(64), sameHashInOtherTeam: false },
      { name: 'design.png', sizeBytes: 8000, sha256: 'b'.repeat(64), sameHashInOtherTeam: false },
    ],
    earlierProjects: [],
    sameRosterProjects: 1,
    desiredMarks: [{ roleCode: 'backend', changedAt: at(40) }],
    identitySignals: USERS.flatMap((userId) => [
      { userId, kind: 'ip24' as const, valueHmac: `ip-${userId}` },
      { userId, kind: 'ua' as const, valueHmac: `ua-${userId}` },
      { userId, kind: 'device' as const, valueHmac: `dev-${userId}` },
    ]),
    textHolders: Object.fromEntries(USERS.map((u) => [`hash-${u}`, [u]])),
    scoreSoFar: 0,
    ...change,
  };
}

type RuleModule = { evaluate: (facts: FraudFacts) => Signal[] };

/**
 * Loads `internal/fraud/rules/AF-xx.ts` by a computed path: the file does not exist before S7-03, and `tsc` must compile the tests
 * anyway; until then a test fails with "cannot find module", not with a syntax or type error.
 */
export async function loadRule(code: string): Promise<RuleModule> {
  const loaded: unknown = await import(/* @vite-ignore */ `../internal/fraud/rules/${code}.js`);
  const evaluate = (loaded as Partial<RuleModule>).evaluate;
  if (typeof evaluate !== 'function') throw new Error(`${code}.ts does not export evaluate(facts)`);
  return { evaluate };
}

type RegistryModule = {
  evaluateAll: (facts: FraudFacts) => Signal[];
  summarize: (signals: Signal[]) => { score: number; frozen: boolean };
};

/** The registry `rules/index.ts` (assembled last, S7-03), loaded the same way. */
export async function loadRegistry(): Promise<RegistryModule> {
  const registry = 'index';
  const loaded = (await import(
    /* @vite-ignore */ `../internal/fraud/rules/${registry}.js`
  )) as Partial<RegistryModule>;
  if (typeof loaded.evaluateAll !== 'function' || typeof loaded.summarize !== 'function') {
    throw new Error('rules/index.ts must export evaluateAll(facts) and summarize(signals)');
  }
  return { evaluateAll: loaded.evaluateAll, summarize: loaded.summarize };
}

/** Runs the rule `code` on the facts. */
export async function run(code: string, facts: FraudFacts): Promise<Signal[]> {
  return (await loadRule(code)).evaluate(facts);
}

/** The score of a run: the sum over `signal` actions only (block and flag are not scored, FR-REW-15). */
export const scoreOf = (signals: Signal[]): number =>
  signals.filter((s) => s.action === 'signal').reduce((sum, s) => sum + s.score, 0);

export const actionsOf = (signals: Signal[]): Action[] => signals.map((s) => s.action);

/** Replaces the contributions with `count` counted items of the given users, `daysAgo(i)` before now. */
export function withContributions(
  count: number,
  users: string[],
  daysAgo: (index: number) => number,
): ContributionFacts[] {
  return Array.from({ length: count }, (_, i) => ({
    userId: users[i % users.length] ?? 'u-backend',
    source: 'issue' as const,
    ref: `issue:7#${i + 1}`,
    active: true,
    receivedAt: at(daysAgo(i)),
  }));
}
