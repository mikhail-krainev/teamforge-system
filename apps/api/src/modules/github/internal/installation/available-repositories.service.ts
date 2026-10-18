import { Inject, Injectable } from '@nestjs/common';
import type { Ok } from 'shared';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { clampLimit, decodeCursor, encodeCursor } from '../../../../platform/db/pagination.js';
import { GithubClient } from '../client/github-client.js';
import { GithubError } from '../client/github-error.js';
import { githubUnavailable } from './github-problems.js';
import { InstallationRepository } from './installation.repository.js';

const FIRST_PAGE = 1;

/** The error of a missing grant: an installation of somebody else looks like one that does not exist. */
export const installationNotGranted = (): DomainError =>
  new DomainError('INSTALLATION_NOT_GRANTED', 404);

/** listAvailableRepositories (FR-GH-01, SEC-02). */
@Injectable()
export class AvailableRepositoriesService {
  constructor(
    @Inject(GithubClient) private readonly github: GithubClient,
    @Inject(InstallationRepository) private readonly installations: InstallationRepository,
  ) {}

  /**
   * Reads the repositories from GitHub with the installation token, page by page, and caches nothing.
   * The cursor is the next GitHub page bound to the team and the installation it was made for.
   */
  async list(
    userId: string,
    teamId: string,
    query: { installationId: number; cursor?: string; limit?: number },
  ): Promise<Ok<'listAvailableRepositories'>> {
    const limit = clampLimit(query.limit);
    const binding = { teamId, installationId: query.installationId };
    const page =
      query.cursor === undefined ? FIRST_PAGE : Number(decodeCursor(query.cursor, binding).k[0]);
    if (!Number.isSafeInteger(page) || page < FIRST_PAGE) {
      throw new DomainError('VALIDATION_FAILED', 400, {
        errors: [{ pointer: '/cursor', code: 'invalid_cursor', message: 'Invalid cursor' }],
      });
    }
    if (!(await this.installations.hasActiveGrant(query.installationId, teamId, userId))) {
      throw installationNotGranted();
    }
    try {
      const result = await this.github.listInstallationRepositories(
        query.installationId,
        page,
        limit,
      );
      return {
        items: result.items.map((repository) => ({
          repositoryId: repository.id,
          fullName: repository.full_name,
          private: repository.private,
          fork: repository.fork,
          createdAt: new Date(repository.created_at).toISOString(),
        })),
        nextCursor: result.hasMore ? encodeCursor([page + 1], binding) : null,
      };
    } catch (error) {
      throw this.refusal(error);
    }
  }

  private refusal(error: unknown): unknown {
    if (!(error instanceof GithubError)) return error;
    // Gone on GitHub: the grant outlived the installation until the webhook revokes it (S6-05).
    if (error.kind === 'installation_gone' || error.kind === 'installation_suspended') {
      return new DomainError('INSTALLATION_INVALID', 404);
    }
    return githubUnavailable(error);
  }
}
