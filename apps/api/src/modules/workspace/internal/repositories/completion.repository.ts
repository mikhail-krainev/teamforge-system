import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNotNull, lt, ne, sql } from 'drizzle-orm';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { contribution } from '../schema/contribution.js';
import { completionCheck, projectCompletion } from '../schema/completion.js';
import { participationConfirm, releaseCheck } from '../schema/release.js';
import { checklistItem, projectStage } from '../schema/stage.js';

export type CompletionCheckRow = typeof completionCheck.$inferSelect;
export type ProjectCompletionRow = typeof projectCompletion.$inferSelect;
export type ContributionRow = typeof contribution.$inferSelect;
export type ReleaseCheckRow = typeof releaseCheck.$inferSelect;

/** The release step of the last stage (FR-WORK-14): `*_final_links`. */
export interface ReleaseItem {
  id: string;
  teamId: string;
  stepKey: string;
  version: number;
  linkUrl: string | null;
  linkStatus: string;
}

export interface LinkItem {
  id: string;
  stepKey: string;
  version: number;
  linkUrl: string;
}

/** The step key of the release link ends with this (architecture 11.4, `playbooks.md`). */
const RELEASE_STEP_SUFFIX = '\\_final\\_links';

/** Rows of `completion_check`, `project_completion`, `release_check` and the facts the completion reads (S6-08). */
@Injectable()
export class CompletionRepository {
  constructor(@Inject(TxRunner) private readonly tx: TxRunner) {}

  // ---- completion_check -------------------------------------------------------------------------

  async insertCheck(row: typeof completionCheck.$inferInsert): Promise<CompletionCheckRow> {
    const [created] = await this.tx.tx.insert(completionCheck).values(row).returning();
    if (created === undefined) throw new Error('INSERT completion_check returned no row');
    return created;
  }

  async findCheck(checkId: string): Promise<CompletionCheckRow | undefined> {
    const [row] = await this.tx.tx
      .select()
      .from(completionCheck)
      .where(eq(completionCheck.id, checkId));
    return row;
  }

  async latestCheck(teamId: string): Promise<CompletionCheckRow | undefined> {
    const [row] = await this.tx.tx
      .select()
      .from(completionCheck)
      .where(eq(completionCheck.teamId, teamId))
      .orderBy(desc(completionCheck.requestedAt), desc(completionCheck.id))
      .limit(1);
    return row;
  }

  /** The latest check that finished with a verdict; a check still running does not hide it. */
  async latestDoneCheck(teamId: string): Promise<CompletionCheckRow | undefined> {
    const [row] = await this.tx.tx
      .select()
      .from(completionCheck)
      .where(and(eq(completionCheck.teamId, teamId), eq(completionCheck.status, 'done')))
      .orderBy(desc(completionCheck.finishedAt), desc(completionCheck.id))
      .limit(1);
    return row;
  }

  /** `queued` -> `running`; a check that is running already (a retry of the job) stays so. Returns the row to work on. */
  async startCheck(checkId: string): Promise<CompletionCheckRow | undefined> {
    await this.tx.tx
      .update(completionCheck)
      .set({ status: 'running' })
      .where(and(eq(completionCheck.id, checkId), eq(completionCheck.status, 'queued')));
    const row = await this.findCheck(checkId);
    return row?.status === 'running' ? row : undefined;
  }

  /** The verdict, written once: a check that is no longer `running` is left as it is. */
  async finishCheck(
    checkId: string,
    status: 'done' | 'failed',
    results: unknown[],
    finishedAt: Date,
    validUntil: Date | null,
  ): Promise<boolean> {
    const rows = await this.tx.tx
      .update(completionCheck)
      .set({ status, results, finishedAt, validUntil })
      .where(
        and(
          eq(completionCheck.id, checkId),
          inArray(completionCheck.status, ['queued', 'running']),
        ),
      )
      .returning({ id: completionCheck.id });
    return rows.length === 1;
  }

  /** Checks that wait for the job longer than expected (a lost job, a worker that was down). */
  unfinishedBefore(before: Date, limit: number): Promise<CompletionCheckRow[]> {
    return this.tx.tx
      .select()
      .from(completionCheck)
      .where(
        and(
          inArray(completionCheck.status, ['queued', 'running']),
          lt(completionCheck.requestedAt, before),
        ),
      )
      .orderBy(asc(completionCheck.requestedAt))
      .limit(limit);
  }

  // ---- release_check ----------------------------------------------------------------------------

  /** Rows are read newest first: a look of the same instant as an earlier one (a clock that stands still) comes after it. */
  async insertReleaseCheck(row: typeof releaseCheck.$inferInsert): Promise<void> {
    const [latest] = await this.tx.tx
      .select({ checkedAt: releaseCheck.checkedAt })
      .from(releaseCheck)
      .where(and(eq(releaseCheck.teamId, row.teamId), eq(releaseCheck.url, row.url)))
      .orderBy(desc(releaseCheck.checkedAt))
      .limit(1);
    const checkedAt =
      latest !== undefined && latest.checkedAt.getTime() >= row.checkedAt.getTime()
        ? new Date(latest.checkedAt.getTime() + 1)
        : row.checkedAt;
    await this.tx.tx
      .insert(releaseCheck)
      .values({ ...row, checkedAt })
      .onConflictDoNothing();
  }

  /** The first check of this address that passed: the second one comes 24 hours after it (C-53). */
  async firstPassedReleaseCheck(
    teamId: string,
    url: string,
    checkKey: string,
  ): Promise<ReleaseCheckRow | undefined> {
    const [row] = await this.tx.tx
      .select()
      .from(releaseCheck)
      .where(
        and(
          eq(releaseCheck.teamId, teamId),
          eq(releaseCheck.url, url),
          eq(releaseCheck.checkKey, checkKey),
          eq(releaseCheck.ok, true),
        ),
      )
      .orderBy(asc(releaseCheck.checkedAt), asc(releaseCheck.id))
      .limit(1);
    return row;
  }

  // ---- items ------------------------------------------------------------------------------------

  /** The `*_final_links` step of the last stage of the team, or `undefined`. */
  async findReleaseItem(teamId: string): Promise<ReleaseItem | undefined> {
    const [row] = await this.tx.tx
      .select({
        id: checklistItem.id,
        teamId: checklistItem.teamId,
        stepKey: checklistItem.stepKey,
        version: checklistItem.version,
        linkUrl: checklistItem.linkUrl,
        linkStatus: checklistItem.linkStatus,
      })
      .from(checklistItem)
      .innerJoin(projectStage, eq(projectStage.id, checklistItem.projectStageId))
      .where(
        and(
          eq(checklistItem.teamId, teamId),
          sql`${checklistItem.stepKey} LIKE ${`%${RELEASE_STEP_SUFFIX}`}`,
          sql`${projectStage.ordinal} = (SELECT max(s.ordinal) FROM workspace.project_stage s WHERE s.team_id = ${teamId})`,
        ),
      )
      .limit(1);
    return row;
  }

  /** The same, for one item: is it the release step of its team? */
  async isReleaseItem(teamId: string, itemId: string): Promise<boolean> {
    const release = await this.findReleaseItem(teamId);
    return release?.id === itemId;
  }

  /** Items with a saved link, the release step left out (it has its own check). */
  async linkItems(teamId: string, exceptItemId: string | undefined): Promise<LinkItem[]> {
    const rows = await this.tx.tx
      .select({
        id: checklistItem.id,
        stepKey: checklistItem.stepKey,
        version: checklistItem.version,
        linkUrl: checklistItem.linkUrl,
      })
      .from(checklistItem)
      .where(
        and(
          eq(checklistItem.teamId, teamId),
          isNotNull(checklistItem.linkUrl),
          exceptItemId === undefined ? undefined : ne(checklistItem.id, exceptItemId),
        ),
      )
      .orderBy(asc(checklistItem.stepKey), asc(checklistItem.id));
    return rows.flatMap((r) => (r.linkUrl === null ? [] : [{ ...r, linkUrl: r.linkUrl }]));
  }

  // ---- contributions and confirmations ----------------------------------------------------------

  /** Every contribution of the team; the rules look at the active ones, the page of results at all of them. */
  listContributions(teamId: string): Promise<ContributionRow[]> {
    return this.tx.tx
      .select()
      .from(contribution)
      .where(eq(contribution.teamId, teamId))
      .orderBy(asc(contribution.receivedAt), asc(contribution.id));
  }

  /** FR-WORK-17: the labels no longer change. Run in the completion transaction. */
  async lockRoles(teamId: string): Promise<void> {
    await this.tx.tx
      .update(contribution)
      .set({ roleLocked: true })
      .where(and(eq(contribution.teamId, teamId), eq(contribution.roleLocked, false)));
  }

  listConfirmations(teamId: string): Promise<(typeof participationConfirm.$inferSelect)[]> {
    return this.tx.tx
      .select()
      .from(participationConfirm)
      .where(eq(participationConfirm.teamId, teamId));
  }

  // ---- project_completion -----------------------------------------------------------------------

  async insertCompletion(row: typeof projectCompletion.$inferInsert): Promise<void> {
    await this.tx.tx.insert(projectCompletion).values(row);
  }

  async findCompletion(teamId: string): Promise<ProjectCompletionRow | undefined> {
    const [row] = await this.tx.tx
      .select()
      .from(projectCompletion)
      .where(eq(projectCompletion.teamId, teamId));
    return row;
  }

  /**
   * Of these teams, the ones with a record of completion that is not dated in the future. A completion
   * cannot be dated later than the database clock in production; only a test clock set ahead can make one.
   */
  async completedTeamIds(teamIds: string[]): Promise<Set<string>> {
    if (teamIds.length === 0) return new Set();
    const rows = await this.tx.tx
      .select({ teamId: projectCompletion.teamId })
      .from(projectCompletion)
      .where(
        and(
          inArray(projectCompletion.teamId, teamIds),
          sql`${projectCompletion.completedAt} <= now()`,
        ),
      );
    return new Set(rows.map((r) => r.teamId));
  }
}
