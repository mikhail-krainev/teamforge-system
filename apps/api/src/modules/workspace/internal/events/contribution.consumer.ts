import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import { Clock } from '../../../../platform/clock/clock.js';
import { EventConsumers } from '../../../../platform/outbox/event-consumers.js';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import type { EventConsumer, OutboxEventData } from '../../../../platform/outbox/outbox.types.js';
import { GITHUB_API, type GithubApi, parseContributionRef } from '../../../github/public.js';
import { TEAMS_API, type TeamsApi } from '../../../teams/public.js';
import { WORKSPACE_MODULE } from '../../public.js';
import { contributionRole } from '../domain/contribution-role.js';
import { ContributionRepository } from '../repositories/contribution.repository.js';

/** Outbox event that tells the realtime relay that the feed of a team changed. */
export const CONTRIBUTION_RECORDED = 'contribution_recorded';

const source = z.enum(['issue', 'pr']);
const detected = z.object({
  teamId: z.uuid(),
  repositoryId: z.number().int(),
  source,
  ref: z.string(),
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  userIds: z.array(z.uuid()),
  labels: z.array(z.string()).default([]),
  occurredAt: z.string(),
  receivedAt: z.string(),
});
const revoked = z.object({ teamId: z.uuid(), source, ref: z.string() });

/**
 * Contributions of GitHub (FR-GH-05, FR-WORK-17, architecture 7.6): `github.contribution_detected` credits
 * the members, `github.contribution_revoked` takes the credit back. Events are not delivered in order,
 * so the state of the issue is read again before anything is written: a "detected" for an issue that is
 * open now writes nothing, a "revoked" for one that is closed again changes nothing. Repeats end on
 * `contribution_uq`. A credit takes the team lock (#4, shared) and writes nothing once the project is
 * completed: the snapshot of the completion holds every contribution of the project, and no row appears later.
 */
@Injectable()
export class ContributionConsumer implements EventConsumer, OnModuleInit {
  readonly consumer = 'workspace.contributions';
  readonly types = ['github.contribution_detected', 'github.contribution_revoked'] as const;

  constructor(
    @Inject(EventConsumers) private readonly consumers: EventConsumers,
    @Inject(ContributionRepository) private readonly contributions: ContributionRepository,
    @Inject(GITHUB_API) private readonly github: GithubApi,
    @Inject(TEAMS_API) private readonly teams: TeamsApi,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(Clock) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.consumers.register(this);
  }

  async handle(event: OutboxEventData): Promise<void> {
    if (event.type === 'contribution_detected') await this.credit(event.payload);
    else await this.takeBack(event.payload);
  }

  private async credit(payload: Record<string, unknown>): Promise<void> {
    const parsed = detected.safeParse(payload);
    const work = parsed.success ? parsed.data : undefined;
    const ref = work === undefined ? null : parseContributionRef(work.ref);
    if (work === undefined || ref === null) return;
    const standing = await this.github.isContributionSourceStanding(
      ref.source,
      ref.repositoryId,
      ref.number,
    );
    if (standing === false) return;
    // Lock #4 like the completion, in the same order (team first): the credit lands wholly before the
    // snapshot of the completion or not at all, never between (architecture 12.3).
    const team = await this.teams.lockTeam(work.teamId, 'share');
    if (team.status === 'completed' || team.status === 'archived') return;
    const roster = new Map((await this.teams.getRoster(work.teamId)).map((m) => [m.userId, m]));
    const stageOrdinal = await this.contributions.stageOrdinalAt(
      work.teamId,
      new Date(work.receivedAt),
    );
    const rows = work.userIds.flatMap((userId) => {
      const roleCode = contributionRole(work.labels, roster.get(userId)?.roles ?? []);
      if (roleCode === undefined) return [];
      return [
        {
          teamId: work.teamId,
          userId,
          source: work.source,
          ref: work.ref,
          title: work.title,
          url: work.url === '' ? null : work.url,
          roleCode,
          stageOrdinal,
          occurredAt: new Date(work.occurredAt),
          receivedAt: new Date(work.receivedAt),
        },
      ];
    });
    await this.announce(work.teamId, await this.contributions.record(rows));
  }

  private async takeBack(payload: Record<string, unknown>): Promise<void> {
    const parsed = revoked.safeParse(payload);
    const ref = parsed.success ? parseContributionRef(parsed.data.ref) : null;
    if (!parsed.success || ref === null) return;
    const standing = await this.github.isContributionSourceStanding(
      ref.source,
      ref.repositoryId,
      ref.number,
    );
    if (standing !== false) return;
    const { teamId, source: kind } = parsed.data;
    await this.announce(teamId, await this.contributions.deactivate(teamId, kind, parsed.data.ref));
  }

  /** The feed of the team changed: one signal per contribution, ids only (ADR-0011). */
  private async announce(teamId: string, contributionIds: string[]): Promise<void> {
    if (contributionIds.length === 0) return;
    await this.outbox.publishMany(
      contributionIds.map((contributionId) => ({
        module: WORKSPACE_MODULE,
        type: CONTRIBUTION_RECORDED,
        aggregateId: teamId,
        payload: { teamId, contributionId, at: this.clock.now().toISOString() },
      })),
    );
  }
}
