import { Inject, Injectable } from '@nestjs/common';
import { GithubClient, type RepositoryDetail } from '../client/github-client.js';
import { rejectionsOf, type RepoRejectionCode } from './repo-rules.js';

export interface RepoInspection {
  /** `null` when the installation cannot see the repository. */
  repository: RepositoryDetail | null;
  rejections: RepoRejectionCode[];
}

/**
 * What GitHub says about a repository, asked with the installation token (never the request): used
 * when a repository is bound and by the `repo_exists` check of a step (FR-GH-02, FR-PLAY-08).
 * Throws `GithubError` when GitHub cannot answer.
 */
@Injectable()
export class RepoInspectionService {
  constructor(@Inject(GithubClient) private readonly github: GithubClient) {}

  async inspect(installationId: number, repositoryId: number): Promise<RepoInspection> {
    const repository = await this.github.getRepository(installationId, repositoryId);
    // Contributors are only asked for a fork: that is the one case where the answer decides.
    const forkHasOwnCommits =
      repository?.fork === true
        ? (await this.github.listContributors(installationId, repositoryId)).some(
            (contributor) => contributor.contributions > 0,
          )
        : false;
    const facts =
      repository === null
        ? null
        : {
            archived: repository.archived,
            isPrivate: repository.private,
            isFork: repository.fork,
          };
    return { repository, rejections: rejectionsOf(facts, forkHasOwnCommits) };
  }
}
