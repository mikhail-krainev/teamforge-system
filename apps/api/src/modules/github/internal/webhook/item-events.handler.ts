import { Inject, Injectable } from '@nestjs/common';
import { RepoLinkRepository } from '../services/repo-link.repository.js';
import { ContributionEvents } from './contribution-events.js';
import { closedIssueNumbers } from './closing-keywords.js';
import { MemberAttribution } from './member-attribution.service.js';
import { ItemRepository, type ItemRow, type ItemWrite } from './item.repository.js';
import type { IssueObject, PullRequestObject } from './payload-schemas.js';
import { apply, type DeliveryPlan, type EventIds, IGNORE } from './plan.js';

interface Context {
  teamId: string;
  repositoryId: number;
  receivedAt: Date;
  /** GitHub account -> member of the team, resolved before the transaction. */
  members: Map<number, string>;
}

const date = (value: string | null | undefined): Date | null =>
  value == null ? null : new Date(value);

function issueWrite(repositoryId: number, issue: IssueObject, receivedAt: Date): ItemWrite {
  return {
    repositoryId,
    kind: 'issue',
    number: issue.number,
    title: issue.title,
    htmlUrl: issue.html_url,
    authorGithubId: issue.user?.id ?? null,
    assigneeGithubIds: issue.assignees.map((a) => a.id),
    state: issue.state,
    merged: false,
    labels: issue.labels.map((l) => l.name),
    additions: null,
    deletions: null,
    closedAt: date(issue.closed_at),
    mergedAt: null,
    sourceUpdatedAt: new Date(issue.updated_at),
    receivedAt,
  };
}

function pullWrite(repositoryId: number, pull: PullRequestObject, receivedAt: Date): ItemWrite {
  return {
    ...issueWrite(repositoryId, pull, receivedAt),
    kind: 'pr',
    merged: pull.merged,
    additions: pull.additions ?? null,
    deletions: pull.deletions ?? null,
    mergedAt: date(pull.merged_at),
  };
}

/**
 * Issues and pull requests (FR-GH-05, architecture 7.3 item 4): the item is kept as GitHub last said
 * it, and a change of the state that earns or takes away a contribution becomes an event for the
 * workspace. The conditional upsert makes an old or repeated delivery a no-op, so an event is only
 * written when the state really changed.
 */
@Injectable()
export class ItemEventsHandler {
  constructor(
    @Inject(ItemRepository) private readonly items: ItemRepository,
    @Inject(RepoLinkRepository) private readonly links: RepoLinkRepository,
    @Inject(MemberAttribution) private readonly attribution: MemberAttribution,
    @Inject(ContributionEvents) private readonly events: ContributionEvents,
  ) {}

  async issue(
    repo: { repositoryId: number; installationId: number },
    issue: IssueObject,
    receivedAt: Date,
  ): Promise<DeliveryPlan> {
    const ctx = await this.context(repo, receivedAt, async (teamId) => {
      const ids = [issue.user?.id, ...issue.assignees.map((a) => a.id)];
      const closer = await this.closerAuthorId(repo.repositoryId, issue.number);
      return this.attribution.membersByGithubId(
        teamId,
        [...ids, closer].filter((id): id is number => id != null),
      );
    });
    if (ctx === undefined) return IGNORE;
    return apply(() => this.applyIssue(ctx, issue));
  }

  async pullRequest(
    repo: { repositoryId: number; installationId: number },
    pull: PullRequestObject,
    receivedAt: Date,
  ): Promise<DeliveryPlan> {
    const ctx = await this.context(repo, receivedAt, (teamId) =>
      this.attribution.membersByGithubId(teamId, pull.user ? [pull.user.id] : []),
    );
    if (ctx === undefined) return IGNORE;
    return apply(() => this.applyPull(ctx, pull));
  }

  private async context(
    repo: { repositoryId: number; installationId: number },
    receivedAt: Date,
    members: (teamId: string) => Promise<Map<number, string>>,
  ): Promise<Context | undefined> {
    const link = await this.links.findActiveByRepository(repo.repositoryId);
    if (link === undefined || link.installationId !== repo.installationId) return undefined;
    return {
      teamId: link.teamId,
      repositoryId: repo.repositoryId,
      receivedAt,
      members: await members(link.teamId),
    };
  }

  /** The author of the merged pull request that promised to close the issue, if one did. */
  private async closerAuthorId(repositoryId: number, issueNumber: number): Promise<number | null> {
    const issue = await this.items.find(repositoryId, 'issue', issueNumber);
    if (issue?.closerPrNumber == null) return null;
    const pull = await this.items.find(repositoryId, 'pr', issue.closerPrNumber);
    return pull?.merged === true ? pull.authorGithubId : null;
  }

  private async applyIssue(ctx: Context, issue: IssueObject): Promise<EventIds> {
    const { applied, previous } = await this.items.upsert(
      issueWrite(ctx.repositoryId, issue, ctx.receivedAt),
    );
    if (!applied) return [];
    const wasClosed = previous?.state === 'closed';
    if (issue.state === 'open' && wasClosed) {
      return this.events.revoked(ctx.teamId, 'issue', {
        repositoryId: ctx.repositoryId,
        number: issue.number,
      });
    }
    if (issue.state !== 'closed' || wasClosed) return [];
    const stored = await this.items.find(ctx.repositoryId, 'issue', issue.number);
    if (stored === undefined) return [];
    return this.events.detected({
      teamId: ctx.teamId,
      source: 'issue',
      item: stored,
      userIds: await this.executors(ctx, stored),
      occurredAt: stored.closedAt ?? stored.sourceUpdatedAt,
      receivedAt: ctx.receivedAt,
    });
  }

  /** The assignees; an issue nobody was assigned to goes to the author of the merged pull request that closed it. */
  private async executors(ctx: Context, issue: ItemRow): Promise<string[]> {
    const githubIds =
      issue.assigneeGithubIds.length > 0
        ? issue.assigneeGithubIds
        : [await this.closerAuthorId(issue.repositoryId, issue.number)];
    return githubIds.flatMap((id) => {
      const userId = id === null ? undefined : ctx.members.get(id);
      return userId === undefined ? [] : [userId];
    });
  }

  private async applyPull(ctx: Context, pull: PullRequestObject): Promise<EventIds> {
    const { applied, previous } = await this.items.upsert(
      pullWrite(ctx.repositoryId, pull, ctx.receivedAt),
    );
    if (!applied || !pull.merged || previous?.merged === true) return [];
    const stored = await this.items.find(ctx.repositoryId, 'pr', pull.number);
    if (stored === undefined) return [];
    const author = pull.user ? ctx.members.get(pull.user.id) : undefined;
    const own = await this.events.detected({
      teamId: ctx.teamId,
      source: 'pr',
      item: stored,
      userIds: author === undefined ? [] : [author],
      occurredAt: stored.mergedAt ?? stored.closedAt ?? stored.sourceUpdatedAt,
      receivedAt: ctx.receivedAt,
    });
    return [...own, ...(await this.creditClosedIssues(ctx, pull, author))];
  }

  /** `Closes #n` in a merged pull request: remember who closed the issue, and credit it if it was already closed without anybody. */
  private async creditClosedIssues(
    ctx: Context,
    pull: PullRequestObject,
    author: string | undefined,
  ): Promise<EventIds> {
    const ids: EventIds = [];
    for (const number of closedIssueNumbers(pull.body)) {
      const { previous, linked } = await this.items.setCloser(
        ctx.repositoryId,
        number,
        pull.number,
        ctx.receivedAt,
      );
      const waiting =
        linked &&
        author !== undefined &&
        previous?.state === 'closed' &&
        previous.assigneeGithubIds.length === 0;
      if (!waiting || previous === undefined) continue;
      const written = await this.events.detected({
        teamId: ctx.teamId,
        source: 'issue',
        item: previous,
        userIds: [author],
        occurredAt: previous.closedAt ?? previous.sourceUpdatedAt,
        receivedAt: ctx.receivedAt,
      });
      ids.push(...written);
    }
    return ids;
  }
}
