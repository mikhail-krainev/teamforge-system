import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { Ok } from 'shared';
import { uuidv7 } from 'uuidv7';
import { Clock } from '../../../../platform/clock/clock.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import { jobId } from '../../../../platform/queues/job-id.js';
import { QueuesService } from '../../../../platform/queues/queues.service.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { GITHUB_API, type GithubApi } from '../../../github/public.js';
import { TEAMS_API, type TeamsApi } from '../../../teams/public.js';
import { WORKSPACE_MODULE } from '../../public.js';
import {
  CHECK_VALID_MS,
  type CheckResultFact,
  LINK_KEY_PREFIX,
  RELEASE_KEY_PREFIX,
  RELEASE_RECHECK_MS,
  REPO_FINAL_KEY,
} from '../domain/completion-rules.js';
import {
  CompletionRepository,
  type CompletionCheckRow,
  type LinkItem,
  type ReleaseItem,
} from '../repositories/completion.repository.js';
import { LinkChecks, type LinkOutcome } from './link-checks.js';
import { ReleaseTargetService } from './release-target.service.js';
import { assertCompletable } from './completion-gate.js';

type CheckDto = Ok<'requestCompletionCheck'>;

export const COMPLETION_CHECK_QUEUE = 'auto-checks' as const;
export const COMPLETION_CHECK_JOB = 'completion-check' as const;

/** A job that never started is queued again after this long (the sweep); one that never finished is given up. */
export const CHECK_REQUEUE_AFTER_MS = 5 * 60_000;
export const CHECK_GIVE_UP_AFTER_MS = 30 * 60_000;
/** The answer of the save-time check of the release is waited for this long, then the completion check goes on. */
const FIRST_CHECK_WAIT_MS = 15_000;
const FIRST_CHECK_SETTLE_MS = 2_000;
const POLL_MS = 150;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function toCheckDto(row: CompletionCheckRow): CheckDto {
  return {
    id: row.id,
    status: row.status as CheckDto['status'],
    requestedAt: row.requestedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    validUntil: row.validUntil?.toISOString() ?? null,
    results: row.results as CheckDto['results'],
  };
}

/** What a check found out about the release, and the row to keep of the look at the address (if one was made). */
interface ReleaseFinding {
  result: CheckResultFact;
  look?: { url: string; checkKey: string; outcome: LinkOutcome; at: Date };
}

/**
 * The check of readiness to complete (FR-WORK-13, FR-WORK-14, FR-GH-08, FR-PLAY-08; architecture 11.4).
 * `request` writes the row and queues the job; `run` (the `auto-checks` worker) asks GitHub about the
 * repository, the `link-checker` about the release and the saved links, and keeps the verdict for an hour.
 * The application itself never opens an address of a student (SSRF): only the `link-check` queue does.
 */
@Injectable()
export class CompletionCheckService {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(QueuesService) private readonly queues: QueuesService,
    @Inject(TEAMS_API) private readonly teams: TeamsApi,
    @Inject(GITHUB_API) private readonly github: GithubApi,
    @Inject(CompletionRepository) private readonly completions: CompletionRepository,
    @Inject(ReleaseTargetService) private readonly targets: ReleaseTargetService,
    @Inject(LinkChecks) private readonly linkChecks: LinkChecks,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {}

  async request(userId: string, teamId: string): Promise<CheckDto> {
    const row = await this.tx.run(async () => {
      const team = await this.teams.lockTeam(teamId, 'share');
      if (team.leadUserId !== userId) throw new DomainError('NOT_TEAM_LEAD', 403);
      assertCompletable(team.status);
      return this.completions.insertCheck({
        id: uuidv7(),
        teamId,
        status: 'queued',
        results: [],
        requestedBy: userId,
        requestedAt: this.clock.now(),
      });
    });
    await this.enqueue(row.id, 0);
    return toCheckDto(row);
  }

  async latest(teamId: string): Promise<CheckDto> {
    const row = await this.tx.run(() => this.completions.latestCheck(teamId));
    if (row === undefined) throw new DomainError('NOT_FOUND', 404);
    return toCheckDto(row);
  }

  /** After the commit: a lost job is queued again by the sweep, so a failure here is not the lead's. */
  async enqueue(checkId: string, round: number): Promise<void> {
    try {
      await this.queues.add(
        COMPLETION_CHECK_QUEUE,
        COMPLETION_CHECK_JOB,
        { checkId },
        { jobId: round === 0 ? jobId('ccheck', checkId) : jobId('ccheck', checkId, round) },
      );
    } catch (error) {
      this.logger.error({ err: error, checkId }, 'completion check was not queued; the sweep will');
    }
  }

  /** The worker: the check is done once; a repeated or late job finds it finished and stops. */
  async run(checkId: string): Promise<void> {
    const check = await this.tx.run(() => this.completions.startCheck(checkId));
    if (check === undefined) return;
    const found = await this.collect(check);
    const finishedAt = this.clock.now();
    await this.tx.run(async () => {
      const done = await this.completions.finishCheck(
        check.id,
        'done',
        found.results,
        finishedAt,
        new Date(finishedAt.getTime() + CHECK_VALID_MS),
      );
      if (!done) return;
      if (found.look !== undefined) {
        const { look } = found;
        await this.completions.insertReleaseCheck({
          id: uuidv7(),
          teamId: check.teamId,
          url: look.url,
          checkKey: look.checkKey,
          completionCheckId: check.id,
          ok: look.outcome.ok,
          httpStatus: look.outcome.httpStatus,
          reason: look.outcome.ok ? null : look.outcome.reason,
          checkedAt: look.at,
        });
      }
      await this.outbox.publish({
        module: WORKSPACE_MODULE,
        type: 'completion_check_done',
        aggregateId: check.id,
        payload: { teamId: check.teamId, checkId: check.id },
      });
    });
  }

  /** The last attempt of the job failed: the check is `failed`, the lead asks again. */
  async fail(checkId: string): Promise<void> {
    await this.tx.run(() =>
      this.completions.finishCheck(checkId, 'failed', [], this.clock.now(), null),
    );
  }

  // ---- what is checked ---------------------------------------------------------------------------

  private async collect(
    check: CompletionCheckRow,
  ): Promise<{ results: CheckResultFact[]; look?: ReleaseFinding['look'] }> {
    const facts = await this.tx.run(async () => {
      const team = await this.teams.getTeamView(check.teamId);
      const release = await this.completions.findReleaseItem(check.teamId);
      const links = await this.completions.linkItems(check.teamId, release?.id);
      return { team, release, links };
    });
    const repo = await this.repoResult(check.teamId);
    const release = await this.releaseFinding(check, facts.release, facts.team?.releaseUrl ?? null);
    const links = await this.linkResults(check, facts.links);
    return {
      results: [repo, release.result, ...links],
      ...(release.look === undefined ? {} : { look: release.look }),
    };
  }

  /** `repo_final` (FR-GH-08, AF-01). A GitHub failure is not a verdict: the check says so and does not pass. */
  private async repoResult(teamId: string): Promise<CheckResultFact> {
    try {
      const link = await this.github.getRepoLink(teamId);
      const final = await this.github.checkRepositoryFinal(teamId);
      const repositoryId = link?.status === 'active' ? link.repositoryId : null;
      return {
        key: REPO_FINAL_KEY,
        ok: final.ok && repositoryId !== null,
        blocking: true,
        message: final.ok
          ? 'Репозиторий прошёл итоговую проверку'
          : 'Репозиторий не прошёл итоговую проверку',
        data: {
          repositoryId,
          reasons: final.reasons,
          commits: final.commits,
          committingMembers: final.committingMembers,
        },
      };
    } catch (error) {
      this.logger.warn({ err: error, teamId }, 'repo_final: GitHub did not answer');
      return {
        key: REPO_FINAL_KEY,
        ok: false,
        blocking: true,
        message: 'GitHub не ответил: повторите проверку позже',
        data: { reason: 'GITHUB_UNAVAILABLE' },
      };
    }
  }

  /**
   * `release_alive_*` (FR-WORK-14): the second look at the address comes at least 24 hours after the first
   * one that passed (C-53). Without a first one this look is the first; the verdict then says when to come back.
   */
  private async releaseFinding(
    check: CompletionCheckRow,
    release: ReleaseItem | undefined,
    teamReleaseUrl: string | null,
  ): Promise<ReleaseFinding> {
    const url = teamReleaseUrl ?? release?.linkUrl ?? null;
    if (release === undefined || url === null) {
      return {
        result: {
          key: `${RELEASE_KEY_PREFIX}_web`,
          ok: false,
          blocking: true,
          message: 'Ссылка на релиз не сохранена в шаге с итоговыми ссылками',
          data: { reason: 'NO_RELEASE_URL' },
        },
      };
    }
    const key = await this.targets.checkKeyOf(check.teamId, release.stepKey);
    const first = await this.awaitFirstLook(check.teamId, url, key);
    const now = this.clock.now();
    if (first !== undefined && now.getTime() - first.getTime() < RELEASE_RECHECK_MS) {
      const nextCheckAt = new Date(first.getTime() + RELEASE_RECHECK_MS);
      return { result: tooEarly(key, url, nextCheckAt) };
    }
    const outcome = await this.lookAt(check, release, url);
    const look = { url, checkKey: key, outcome, at: this.clock.now() };
    if (!outcome.ok) return { result: releaseFailed(key, url, outcome), look };
    if (first === undefined) {
      const nextCheckAt = new Date(look.at.getTime() + RELEASE_RECHECK_MS);
      return { result: tooEarly(key, url, nextCheckAt), look };
    }
    return {
      result: {
        key,
        ok: true,
        blocking: true,
        message: 'Релиз отвечает, обе проверки пройдены',
        data: { url, firstCheckedAt: first.toISOString() },
      },
      look,
    };
  }

  /**
   * When the link of the release was saved a moment ago, its first look may still be on the way: wait for it a little.
   * Returns the time of the first look that passed, if there is one.
   */
  private async awaitFirstLook(
    teamId: string,
    url: string,
    key: string,
  ): Promise<Date | undefined> {
    const started = Date.now();
    let settledAt: number | undefined;
    for (;;) {
      const first = await this.tx.run(() =>
        this.completions.firstPassedReleaseCheck(teamId, url, key),
      );
      if (first !== undefined) return first.checkedAt;
      const item = await this.tx.run(() => this.completions.findReleaseItem(teamId));
      if (item?.linkStatus !== 'unchecked') settledAt ??= Date.now();
      const now = Date.now();
      if (now - started > FIRST_CHECK_WAIT_MS) return undefined;
      if (settledAt !== undefined && now - settledAt > FIRST_CHECK_SETTLE_MS) return undefined;
      await sleep(POLL_MS);
    }
  }

  private async lookAt(
    check: CompletionCheckRow,
    release: ReleaseItem,
    url: string,
  ): Promise<LinkOutcome> {
    const id = jobId('ccr', check.id, release.id);
    const [outcome] = await this.linkChecks.run([
      {
        jobId: id,
        data: { teamId: check.teamId, itemId: release.id, version: release.version, url },
      },
    ]);
    return outcome ?? { ok: false, reason: 'TIMEOUT', httpStatus: null };
  }

  /** `link_https` again for every saved link (FR-PLAY-08); one look per address, shared by the steps that carry it. */
  private async linkResults(
    check: CompletionCheckRow,
    links: LinkItem[],
  ): Promise<CheckResultFact[]> {
    const byUrl = new Map<string, LinkItem>();
    for (const link of links) if (!byUrl.has(link.linkUrl)) byUrl.set(link.linkUrl, link);
    const jobs = [...byUrl.values()].map((link) => ({
      jobId: jobId('ccl', check.id, link.id),
      data: { teamId: check.teamId, itemId: link.id, version: link.version, url: link.linkUrl },
    }));
    const outcomes = await this.linkChecks.run(jobs);
    const outcomeOf = new Map([...byUrl.keys()].map((url, i) => [url, outcomes[i]] as const));
    return links.map((link) => {
      const outcome = outcomeOf.get(link.linkUrl) ?? {
        ok: false,
        reason: 'TIMEOUT',
        httpStatus: null,
      };
      return {
        key: `${LINK_KEY_PREFIX}:${link.stepKey}`,
        ok: outcome.ok,
        blocking: true,
        message: outcome.ok ? 'Ссылка работает' : 'Ссылка не открывается',
        data: { stepKey: link.stepKey, reason: outcome.reason, httpStatus: outcome.httpStatus },
      };
    });
  }
}

function tooEarly(key: string, url: string, nextCheckAt: Date): CheckResultFact {
  return {
    key,
    ok: false,
    blocking: true,
    message: `Вторая проверка релиза возможна не ранее ${nextCheckAt.toISOString()} (через 24 часа после первой)`,
    data: { url, reason: 'SECOND_CHECK_PENDING', nextCheckAt: nextCheckAt.toISOString() },
  };
}

function releaseFailed(key: string, url: string, outcome: LinkOutcome): CheckResultFact {
  return {
    key,
    ok: false,
    blocking: true,
    message: 'Релиз не отвечает требованиям проверки',
    data: { url, reason: outcome.reason, httpStatus: outcome.httpStatus },
  };
}
