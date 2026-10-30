import { Inject, Injectable } from '@nestjs/common';
import { GITHUB_API, type GithubApi } from '../../../github/public.js';
import type { AccountVerdict } from '../domain/credit-rules.js';

/** FR-GH-09 for a set of people: the stored account checks of github, one batch, no call to GitHub. */
@Injectable()
export class AccountVerdicts {
  constructor(@Inject(GITHUB_API) private readonly github: GithubApi) {}

  async load(userIds: string[]): Promise<Map<string, AccountVerdict>> {
    const checks = await this.github.getAccountChecks(userIds);
    return new Map(
      [...checks].map(([userId, view]) => [
        userId,
        { status: view.eligibility.status, reasons: view.eligibility.reasons },
      ]),
    );
  }
}
