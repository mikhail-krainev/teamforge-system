/**
 * The facts an anti-fraud rule reads (docs/spec.md 8, docs/architecture.md 10.5) and the row it yields.
 * The facts are collected before the transaction from the other modules and the own tables; the rules do no I/O.
 */

export type Phase = 'completion' | 'cooling_end';
export type Action = 'block' | 'flag' | 'signal' | 'info';

/** The row of `rewards.fraud_signal` a rule yields (the phase and the team are added by the caller). */
export interface Signal {
  ruleCode: string;
  action: Action;
  score: number;
  /** Ids, numbers and rule-specific facts only: never a raw address, text or HMAC. */
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
