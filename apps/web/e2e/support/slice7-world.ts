import { expect } from '@playwright/test';
import { get, person, type Person } from './slice6-world';
import { compose } from './stack';

/**
 * State shared by the steps of the slice 7 scenario (the tests run serially in one worker).
 * The same five people as in slice 6 sign in through the GitHub double: `admin` (publishes the playbook and
 * decides the fraud cases), A (leads), B (Backend, later DevOps), C (Frontend) and D (an outsider that
 * must not see the projects of the others). The first project is the one of slice 6 (finished by its
 * steps); the second one (step 5) is built by support/slice7-project-steps.ts.
 *
 * TIME. The cooling is 7 days (C-17b) and the window of the reviews is 14 days (C-27); both are skipped
 * by moving the throwaway e2e database, the way slices 5 and 6 skip stage time, and then running the
 * worker jobs once through the CLI of the worker image (`run-job`, the way `runWorkerJob` of
 * support/stack.ts runs `matching-auto-add`). REQUIREMENTS FOR S7-02 AND S7-07: the closed list of
 * `apps/api/src/platform/queues/cli-jobs.ts` gains two names that sweep what is due (the same handler as
 * the timer, no team argument):
 *   - `rewards-cooling-end`: every `rewards.credit_run` with `status = 'cooling'` and
 *     `cooling_until <= now()` (index `credit_run_cooling_idx`) goes through the phase `cooling_end` and
 *     `creditProject` (architecture 10.2);
 *   - `review-publish`: every `profiles.review_eligibility` with `window_until <= now()` is published or
 *     withheld (architecture 5.8); the hourly safety-net scanner of the plan does the same.
 * The documented columns only are touched: `rewards.credit_run.completed_at / cooling_until`,
 * `profiles.review_eligibility.window_until`.
 */

export { get, person };
export type { Person };

export const world = {
  /** The first project (slice 6 fixture): ids and names are written once it is finished. */
  firstTeamId: '',
  firstTeamName: '',
  /** The second project (step 5): tiny pull requests, goes `frozen` (AF-05). */
  secondTeamId: '',
  secondTeamName: '',
  /** The fraud case of the second project and the comment of the decision. */
  caseId: '',
  /** Days the first project has been moved into the past so far (cooling 7 + window 14). */
  daysSkipped: 0,
  disputeText: 'Проект заморожен по ошибке: все задачи выполнены нашей командой, прошу проверить.',
  decisionComment: 'Pull request-ы формальные, вклад не подтверждён: решение нарушение.',
};

/** The texts of the reviews (step 4). The authors are A, B; the recipients B, C. */
export const REVIEW_TEXTS = {
  aToB: 'Борис быстро разобрал спорные места в API и всегда отвечал на вопросы.',
  aToC: 'Кирилл аккуратно довёл формы до конца и вовремя показывал промежуточный результат.',
  bToC: 'С Кириллом легко договариваться об интерфейсе, замечания принимает спокойно.',
} as const;

const psqlArgs = ['exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'teamforge'] as const;

/** Runs one statement in the throwaway e2e database (setup that moves time; the step under test is not driven by it). */
export function sql(statement: string): void {
  compose(...psqlArgs, '-c', statement);
}

/** The first column of the first row of a query (`-t -A`: no headers, no padding). */
export function sqlValue(query: string): string {
  return (
    compose(...psqlArgs, '-t', '-A', '-c', query)
      .trim()
      .split(/\r?\n/)[0] ?? ''
  );
}

/** Runs a worker job once, now (see the header). Returns the JSON report the CLI prints on its last line. */
export function runCliJob(job: 'rewards-cooling-end' | 'review-publish'): unknown {
  const output = compose('exec', '-T', 'worker', 'node', 'dist/cli/run-job.js', job);
  const report = output.trim().split(/\r?\n/).at(-1);
  if (report === undefined || !report.startsWith('{')) {
    throw new Error(`run-job ${job} printed no report: ${output}`);
  }
  return JSON.parse(report);
}

/**
 * Moves the cooling and the review window of a project into the past by `days` and runs the jobs that
 * were waiting for the time: the credit of the project (`rewards-cooling-end`) and the publication of
 * the reviews (`review-publish`). 8 days end the cooling (7) and leave the review window (14) open;
 * 7 more days close it.
 */
export function advanceCooling(teamId: string, days: number): void {
  const shift = `interval '${days} days'`;
  sql(
    `UPDATE rewards.credit_run SET completed_at = completed_at - ${shift}, cooling_until = cooling_until - ${shift} WHERE team_id = '${teamId}'`,
  );
  sql(
    `UPDATE profiles.review_eligibility SET window_until = window_until - ${shift} WHERE team_id = '${teamId}'`,
  );
  world.daysSkipped += days;
  runCliJob('rewards-cooling-end');
  runCliJob('review-publish');
}

// ---- reads through the API used by several steps ----------------------------------------------------------

export interface CreditBody {
  teamId: string;
  status: 'cooling' | 'frozen' | 'credited' | 'revoked';
  coolingUntil: string;
  myCredits: { roleCode: string; status: string; reason?: string | null }[];
}

export interface CountersBody {
  total: number;
  byRole: { roleCode: string; value: number }[];
  productTypes: string[];
}

export interface AwardsBody {
  items: { badgeCode: string; name: string; series?: string | null; step?: number | null }[];
}

/** `getTeamCredit`: waits until the credit run of the team exists and has the status (the event is asynchronous). */
export async function waitForCreditStatus(
  who: Person,
  teamId: string,
  status: CreditBody['status'],
): Promise<CreditBody> {
  await expect
    .poll(async () => (await get<CreditBody>(who, `/v1/teams/${teamId}/credit`)).body?.status, {
      timeout: 60_000,
      intervals: [500, 1_000, 2_000],
    })
    .toBe(status);
  return (await get<CreditBody>(who, `/v1/teams/${teamId}/credit`)).body;
}

export async function countersOf(viewer: Person, userId: string): Promise<CountersBody> {
  const response = await get<CountersBody>(viewer, `/v1/users/${userId}/counters`);
  expect(response.status, response.text).toBe(200);
  return response.body;
}

export async function awardNames(viewer: Person, userId: string): Promise<string[]> {
  const response = await get<AwardsBody>(viewer, `/v1/users/${userId}/awards`);
  expect(response.status, response.text).toBe(200);
  return response.body.items.map((award) => award.name).sort();
}

/** "2026-11-04" -> "04.11.2026": how the page of the reviews writes the date of the batch (an assumption of the locator). */
export function dateRu(isoDate: string): string {
  const [year, month, day] = isoDate.split('-');
  return `${day}.${month}.${year}`;
}
