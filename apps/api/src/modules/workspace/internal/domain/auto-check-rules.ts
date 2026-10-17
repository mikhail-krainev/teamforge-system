/**
 * Blocking automatic checks of a step (FR-PLAY-08, docs/playbooks.md 2.4) that slice 5 evaluates from
 * the stored state of an item: `file_ok`, `ritual_fields`, `link_https`. The signal checks (`sha_dedup`,
 * `md_headings`, `min_files`, ...) never block, and `repo_*`, `pr_cross_review`, `ci_workflow` come
 * with slice 6. Pure functions: the transition and the item write call them.
 */

export type BlockingCheck = 'file_ok' | 'ritual_fields' | 'link_https';

export interface AutoCheckFacts {
  kind: string;
  linkUrl: string | null;
  linkStatus: string;
  heldOn: string | null;
  externalUrl: string | null;
  outcome: string | null;
  /** Files of the item that are not deleted. */
  filesCount: number;
}

/** `min_files:2` is the check `min_files` with a parameter. */
const nameOf = (key: string): string => key.split(':')[0] ?? key;

const present = (value: string | null): boolean => value !== null && value.trim() !== '';

const EVALUATORS: Record<BlockingCheck, (facts: AutoCheckFacts) => boolean> = {
  file_ok: (facts) => facts.filesCount > 0,
  ritual_fields: (facts) =>
    facts.kind !== 'ritual' ||
    (present(facts.heldOn) && present(facts.externalUrl) && present(facts.outcome)),
  // `broken` is a warning (FR-WORK-04); only a link the SSRF policy refused, or none, fails.
  link_https: (facts) => present(facts.linkUrl) && facts.linkStatus !== 'rejected',
};

const isBlocking = (name: string): name is BlockingCheck =>
  Object.prototype.hasOwnProperty.call(EVALUATORS, name);

/** The blocking checks among `autoChecks` that fail for the item, each once, in the order of the step. */
export function failedBlockingChecks(
  autoChecks: readonly string[],
  facts: AutoCheckFacts,
): BlockingCheck[] {
  const names = [...new Set(autoChecks.map(nameOf))];
  return names.filter(isBlocking).filter((name) => !EVALUATORS[name](facts));
}

export interface AutoCheckFailure {
  itemId: string;
  stepKey: string;
  checks: BlockingCheck[];
}

/** Done, required items of a stage whose blocking checks fail (the `AUTO_CHECKS_FAILED` condition of a transition). */
export function autoCheckFailuresOf(
  items: readonly (AutoCheckFacts & {
    id: string;
    stepKey: string;
    required: boolean;
    status: string;
  })[],
  checksOfStep: (stepKey: string) => readonly string[],
): AutoCheckFailure[] {
  return items
    .filter((item) => item.required && item.status === 'done')
    .flatMap((item) => {
      const checks = failedBlockingChecks(checksOfStep(item.stepKey), item);
      return checks.length === 0 ? [] : [{ itemId: item.id, stepKey: item.stepKey, checks }];
    });
}
