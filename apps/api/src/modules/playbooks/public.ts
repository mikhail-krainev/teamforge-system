/**
 * Public surface of the playbooks module (ADR-0001): the only file other modules may import.
 */
export const PLAYBOOKS_MODULE = 'playbooks' as const;

export type PlaybookId = string;
/** Key of a product type, e.g. `web_service` (immutable). */
export type ProductTypeCode = string;

export interface ProductTypeView {
  code: ProductTypeCode;
  name: string;
  /** FR-PLAY-06: only active types can be chosen for a new team. */
  active: boolean;
}

export interface PublishedPlaybookRef {
  id: PlaybookId;
  version: string;
  totalDays: number;
}

export type RoleKey = string;

/** A fallback step used when the team lacks the role of the step (FR-WORK-02). */
export interface FallbackDefinition {
  title: string;
  instruction: string;
  /** Key of a platform template. */
  template: string;
  url: string | null;
}

export interface StepDefinition {
  key: string;
  /** Position inside the stage, from 1. */
  ordinal: number;
  title: string;
  description: string;
  kind: 'artifact' | 'ritual';
  submission: 'link' | 'file' | 'either' | null;
  ritualKind: 'call' | 'retro' | 'brainstorm' | 'code_review' | null;
  required: boolean;
  /** A role code or `any`. */
  ownerRole: RoleKey | 'any';
  altRoles: RoleKey[];
  fallback: FallbackDefinition | null;
  reviewChecklist: boolean;
  reviewItems: string[];
  autoChecks: string[];
}

export interface StageDefinition {
  key: string;
  /** Position in the playbook, from 1. */
  ordinal: number;
  title: string;
  goal: string;
  durationDays: number;
  exitCriteria: string;
  steps: StepDefinition[];
}

/** A published playbook with everything the workspace needs; immutable, so callers may cache it. */
export interface PlaybookDefinition {
  id: PlaybookId;
  productType: ProductTypeCode;
  version: string;
  totalDays: number;
  stages: StageDefinition[];
}

/** Facade of the playbooks module (architecture 3.3). */
export interface PlaybooksApi {
  /** The published playbook of the highest semver for the type, or `null` when none is published. */
  getLatestPublished(productType: ProductTypeCode): Promise<PublishedPlaybookRef | null>;
  /**
   * The definition of a PUBLISHED playbook, cached in the process by id (published playbooks never
   * change). A draft or an unknown id is 404 NOT_FOUND. The result is frozen.
   */
  getDefinition(id: PlaybookId): Promise<PlaybookDefinition>;
  /** FR-PLAY-06: the type exists and is active. */
  isActiveProductType(code: ProductTypeCode): Promise<boolean>;
  /** Product types ordered by code; `activeOnly` hides the inactive ones. */
  listProductTypes(options?: { activeOnly?: boolean }): Promise<ProductTypeView[]>;
  /** Versions of the given playbooks in one query; unknown ids are absent from the result. */
  getVersions(ids: PlaybookId[]): Promise<Map<PlaybookId, string>>;
}

/** Injection token of the PlaybooksApi implementation. */
export const PLAYBOOKS_API = Symbol('PLAYBOOKS_API');
