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

/**
 * Facade of the playbooks module (architecture 3.3). Slice 3 provides the two reads teams need;
 * `getDefinition` and `isActiveProductType` arrive with the stages in slice 5.
 */
export interface PlaybooksApi {
  /** The published playbook of the highest semver for the type, or `null` when none is published. */
  getLatestPublished(productType: ProductTypeCode): Promise<PublishedPlaybookRef | null>;
  /** Product types ordered by code; `activeOnly` hides the inactive ones. */
  listProductTypes(options?: { activeOnly?: boolean }): Promise<ProductTypeView[]>;
}

/** Injection token of the PlaybooksApi implementation. */
export const PLAYBOOKS_API = Symbol('PLAYBOOKS_API');
