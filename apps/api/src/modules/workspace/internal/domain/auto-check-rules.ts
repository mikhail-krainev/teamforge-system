/**
 * Blocking automatic checks of a step (FR-PLAY-08, docs/playbooks.md 2.4) that slice 5 evaluates from
 * the stored state of an item: `file_ok`, `ritual_fields`, `link_https`, and `repo_exists` (S6-04: the team
 * has a bound repository; what GitHub says about it is asked by `GithubApi.checkRepositoryExists` and at
 * the completion). S6-06 adds `repo_final` (blocking, FR-GH-08: the verdict of `GithubApi.checkRepositoryFinal`
 * is a fact the completion check supplies; a caller that does not ask leaves it out and the check passes,
 * as with `repoLinked`) and the signals `pr_cross_review:N` and `ci_workflow` of `GithubApi` (score 0, they
 * never block: `raisedSignalChecks`). The other signals (`sha_dedup`, `md_headings`, `min_files`, ...) have
 * their own consumers. Pure functions: the transition and the item write call them.
 */

export type BlockingCheck =
  'file_ok' | 'ritual_fields' | 'link_https' | 'repo_exists' | 'repo_final';

export interface AutoCheckFacts {
  kind: string;
  /** `link`, `file` or `either` for an artifact, null for a ritual. */
  submission: string | null;
  linkUrl: string | null;
  linkStatus: string;
  heldOn: string | null;
  externalUrl: string | null;
  outcome: string | null;
  /** Files of the item that are not deleted. */
  filesCount: number;
  /** Whether the team holds a repository; left out when the caller did not ask (the check then passes). */
  repoLinked?: boolean;
  /** The verdict of `repo_final` (FR-GH-08); left out when the caller did not ask (the check then passes). */
  repoFinalOk?: boolean;
}

/** `min_files:2` is the check `min_files` with a parameter. */
const nameOf = (key: string): string => {
  const colon = key.indexOf(':');
  return colon === -1 ? key : key.slice(0, colon);
};

const present = (value: string | null): boolean => value !== null && value.trim() !== '';

const EVALUATORS: Record<BlockingCheck, (facts: AutoCheckFacts) => boolean> = {
  file_ok: (facts) => facts.filesCount > 0,
  ritual_fields: (facts) =>
    facts.kind !== 'ritual' ||
    (present(facts.heldOn) && present(facts.externalUrl) && present(facts.outcome)),
  // `broken` is a warning (FR-WORK-04); only a link the SSRF policy refused, or none, fails.
  link_https: (facts) => present(facts.linkUrl) && facts.linkStatus !== 'rejected',
  repo_exists: (facts) => facts.repoLinked !== false,
  repo_final: (facts) => facts.repoFinalOk !== false,
};

const isBlocking = (name: string): name is BlockingCheck =>
  Object.prototype.hasOwnProperty.call(EVALUATORS, name);

/**
 * A step with `submission: either` takes a file or a link, so `file_ok` and `link_https` are
 * alternatives: only the way the executor used is checked; with both ways used one passing is enough.
 */
function withoutUnusedWay(
  failed: BlockingCheck[],
  names: readonly string[],
  facts: AutoCheckFacts,
): BlockingCheck[] {
  if (!names.includes('file_ok') || !names.includes('link_https')) return failed;
  const hasLink = present(facts.linkUrl);
  const hasFile = facts.filesCount > 0;
  if (hasLink && hasFile) {
    return EVALUATORS.file_ok(facts) || EVALUATORS.link_https(facts)
      ? failed.filter((name) => name !== 'file_ok' && name !== 'link_https')
      : failed;
  }
  if (hasLink) return failed.filter((name) => name !== 'file_ok');
  if (hasFile) return failed.filter((name) => name !== 'link_https');
  return failed;
}

/** The blocking checks among `autoChecks` that fail for the item, each once, in the order of the step. */
export function failedBlockingChecks(
  autoChecks: readonly string[],
  facts: AutoCheckFacts,
): BlockingCheck[] {
  const names = [...new Set(autoChecks.map(nameOf))];
  const failed = names.filter(isBlocking).filter((name) => !EVALUATORS[name](facts));
  return facts.submission === 'either' ? withoutUnusedWay(failed, names, facts) : failed;
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

/** What the GitHub signal checks read; a fact that is left out means "not known", and no signal is raised. */
export interface SignalFacts {
  /** `GithubApi.getCrossReviewedPullCount`. */
  crossReviewedPulls?: number;
  /** `GithubApi.getCiState`; `null` is "not checked" (no Actions permission). */
  ciState?: 'success' | 'none' | null;
}

export type SignalCheck = 'pr_cross_review' | 'ci_workflow';

const parameterOf = (key: string): number | null => {
  const colon = key.indexOf(':');
  const value = colon === -1 ? Number.NaN : Number(key.slice(colon + 1));
  return Number.isInteger(value) && value > 0 ? value : null;
};

/**
 * The signal checks of the step that fail (FR-PLAY-08): the item is accepted, the result is written
 * as a signal `STEP_<key>` with score 0. `pr_cross_review:N` fails with fewer than N merged pull
 * requests reviewed by somebody but their author; `ci_workflow` fails when no run on the default
 * branch succeeded, and says nothing when GitHub was not asked or would not tell.
 */
export function raisedSignalChecks(
  autoChecks: readonly string[],
  facts: SignalFacts,
): SignalCheck[] {
  const raised: SignalCheck[] = [];
  for (const key of new Set(autoChecks)) {
    const name = nameOf(key);
    if (name === 'pr_cross_review') {
      const needed = parameterOf(key) ?? 1;
      if (facts.crossReviewedPulls !== undefined && facts.crossReviewedPulls < needed) {
        raised.push('pr_cross_review');
      }
    }
    if (name === 'ci_workflow' && facts.ciState === 'none') raised.push('ci_workflow');
  }
  return raised;
}
