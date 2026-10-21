/** `repo_sync_state.ci_state`: a successful run on the default branch, or none; `NULL` is "not checked". */
export type CiState = 'success' | 'none';

export interface RunFacts {
  conclusion: string | null;
  head_branch: string | null;
}

/**
 * `ci_workflow` (architecture 7.4): at least one completed run with `conclusion = success` on the
 * default branch among the latest runs. `null` runs mean GitHub would not tell (no Actions permission).
 */
export function ciStateOf(runs: readonly RunFacts[] | null, defaultBranch: string): CiState | null {
  if (runs === null) return null;
  const passed = runs.some(
    (run) => run.conclusion === 'success' && run.head_branch === defaultBranch,
  );
  return passed ? 'success' : 'none';
}
