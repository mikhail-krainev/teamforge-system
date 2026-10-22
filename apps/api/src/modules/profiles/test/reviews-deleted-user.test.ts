import { afterAll, beforeAll, expect, it } from 'vitest';
import { runEligibilityScan } from '../../../../test/fixtures/reviews.js';
import type { Project } from '../../../../test/fixtures/rewards.js';
import { clockOf } from '../../../../test/fixtures/workspace.js';
import { describeInfra } from '../../../../test/helpers/infra.js';
import { reviewProject, startReviewWorld, type ReviewWorld } from './reviews-support.js';

/*
 * S7SEC-02: the scanner `review-eligibility-scan` rebuilds the rows of a team from the immutable list of members
 * of the completion. A person whose account is `deleting` or `deleted` gets no review right back (FR-AUTH-09).
 */

describeInfra('S7 profiles: the eligibility scan skips deleted people (S7SEC-02)', ['db', 'redis', 's3'], () => {
  let rw: ReviewWorld;
  let project: Project;

  beforeAll(async () => {
    rw = await startReviewWorld();
    project = await reviewProject(rw);
  }, 300_000);

  afterAll(async () => {
    if (rw) await rw.close();
  });

  it('a repaired team has rows for the people who stay and none for a deleting or a deleted one', async () => {
    const teamId = project.fx.team.id;
    await rw.world.sql`DELETE FROM profiles.review_eligibility WHERE team_id = ${teamId}`;
    await rw.world.sql`UPDATE auth."user" SET status = 'deleting' WHERE id = ${project.frontend.id}`;
    await rw.world.sql`UPDATE auth."user" SET status = 'deleted' WHERE id = ${project.lead.id}`;
    clockOf(rw.world).advance(11 * 60_000);
    await runEligibilityScan(rw.world);
    const rows = await rw.world.sql<{ user_id: string }[]>`
      SELECT user_id FROM profiles.review_eligibility WHERE team_id = ${teamId}`;
    expect(rows.map((r) => r.user_id)).toEqual([project.backend.id]);
  });
});
