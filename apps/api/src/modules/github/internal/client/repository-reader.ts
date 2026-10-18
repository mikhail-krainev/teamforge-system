import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { GithubClient } from './github-client.js';
import { GithubError, statusOf } from './github-error.js';

const PAGE_SIZE = 100;
const RUNS_PAGE_SIZE = 10;
const NOT_MODIFIED = 304;

export type ItemFeed = 'issues' | 'pulls';

/** One page of the list of issues or pull requests; the items are validated by the caller, per item. */
export type FeedPage =
  { modified: false } | { modified: true; items: unknown[]; etag: string | null; hasNext: boolean };

const reviewSchema = z.object({
  user: z.object({ id: z.number().int().positive() }).nullable(),
  state: z.string().min(1),
  submitted_at: z.string().nullish(),
});
export type PullReview = z.infer<typeof reviewSchema>;

const workflowRunSchema = z.object({
  conclusion: z.string().nullable(),
  head_branch: z.string().nullable(),
});
export type WorkflowRunFact = z.infer<typeof workflowRunSchema>;

const accountSchema = z.object({
  id: z.number().int().positive(),
  login: z.string().min(1),
  created_at: z.string().refine((value) => !Number.isNaN(Date.parse(value))),
  public_repos: z.number().int().nonnegative().default(0),
});
export type GithubAccount = z.infer<typeof accountSchema>;

const hasNextLink = (link: unknown): boolean =>
  typeof link === 'string' && /<[^>]+>;\s*rel="next"/.test(link);

/**
 * The reads of the daily reconciliation and of the account checks (architecture 7.4), all with an
 * installation token. Every failure is a `GithubError`; a limit carries when to come back.
 */
@Injectable()
export class RepositoryReader {
  constructor(@Inject(GithubClient) private readonly github: GithubClient) {}

  /**
   * A page of `GET /repositories/{id}/issues|pulls`, every state, last updated first. The first page can
   * be asked conditionally (`etag`): a 304 costs no quota (FR-GH-06).
   */
  async listFeed(
    installationId: number,
    repositoryId: number,
    feed: ItemFeed,
    page: number,
    etag: string | null,
  ): Promise<FeedPage> {
    const headers = etag !== null && page === 1 ? { 'if-none-match': etag } : {};
    try {
      const response = await this.github.installationRequest(installationId, (octokit) =>
        octokit.request(`GET /repositories/{repository_id}/${feed}`, {
          repository_id: repositoryId,
          state: 'all',
          sort: 'updated',
          direction: 'desc',
          per_page: PAGE_SIZE,
          page,
          headers,
        }),
      );
      if (!Array.isArray(response.data)) throw new GithubError('unavailable');
      const header = response.headers['etag'];
      return {
        modified: true,
        items: response.data as unknown[],
        etag: typeof header === 'string' ? header : null,
        hasNext: hasNextLink(response.headers['link']),
      };
    } catch (error) {
      // `installationRequest` turns the 304 of Octokit into a `GithubError` that keeps the status.
      if (statusOf(error) === NOT_MODIFIED) return { modified: false };
      throw error;
    }
  }

  /** `GET /repositories/{id}/pulls/{n}`: the list leaves out the line counts and `merged`. */
  async getPull(installationId: number, repositoryId: number, number: number): Promise<unknown> {
    const response = await this.github.installationRequest(installationId, (octokit) =>
      octokit.request('GET /repositories/{repository_id}/pulls/{number}', {
        repository_id: repositoryId,
        number,
      }),
    );
    return response.data;
  }

  /** The first 100 reviews of a pull request; malformed entries are left out. */
  async listReviews(
    installationId: number,
    repositoryId: number,
    number: number,
  ): Promise<PullReview[]> {
    const response = await this.github.installationRequest(installationId, (octokit) =>
      octokit.request('GET /repositories/{repository_id}/pulls/{number}/reviews', {
        repository_id: repositoryId,
        number,
        per_page: PAGE_SIZE,
      }),
    );
    if (!Array.isArray(response.data)) throw new GithubError('unavailable');
    return response.data.flatMap((raw: unknown) => {
      const parsed = reviewSchema.safeParse(raw);
      return parsed.success ? [parsed.data] : [];
    });
  }

  /**
   * The last ten workflow runs. `null` when the installation lacks the Actions permission (403): that
   * is "not checked", not an error (architecture 7.4).
   */
  async listWorkflowRuns(
    installationId: number,
    repositoryId: number,
  ): Promise<WorkflowRunFact[] | null> {
    try {
      const response = await this.github.installationRequest(installationId, (octokit) =>
        octokit.request('GET /repositories/{repository_id}/actions/runs', {
          repository_id: repositoryId,
          per_page: RUNS_PAGE_SIZE,
        }),
      );
      const runs = (response.data as { workflow_runs?: unknown }).workflow_runs;
      if (!Array.isArray(runs)) throw new GithubError('unavailable');
      return runs.flatMap((raw: unknown) => {
        const parsed = workflowRunSchema.safeParse(raw);
        return parsed.success ? [parsed.data] : [];
      });
    } catch (error) {
      if (error instanceof GithubError && error.kind === 'forbidden') return null;
      throw error;
    }
  }

  /** `GET /user/{id}`: public data of an account; `null` when GitHub does not know it. */
  async getAccount(installationId: number, githubUserId: number): Promise<GithubAccount | null> {
    try {
      const response = await this.github.installationRequest(installationId, (octokit) =>
        octokit.request('GET /user/{account_id}', { account_id: githubUserId }),
      );
      const parsed = accountSchema.safeParse(response.data);
      if (!parsed.success) throw new GithubError('unavailable');
      return parsed.data;
    } catch (error) {
      if (error instanceof GithubError && error.kind === 'not_found') return null;
      throw error;
    }
  }

  /** Whether the account has any public event (FR-GH-09: activity in place of public repositories). */
  async hasPublicActivity(installationId: number, login: string): Promise<boolean> {
    const response = await this.github.installationRequest(installationId, (octokit) =>
      octokit.request('GET /users/{username}/events/public', { username: login, per_page: 1 }),
    );
    return Array.isArray(response.data) && response.data.length > 0;
  }
}
