import { type DynamicModule, type ModuleMetadata, Module } from '@nestjs/common';
import type { AppConfig } from './platform/config/config.js';
import { PlatformModule, type PlatformOptions } from './platform/platform.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { GithubModule } from './modules/github/github.module.js';
import { MatchingModule } from './modules/matching/matching.module.js';
import { PlaybooksModule } from './modules/playbooks/playbooks.module.js';
import { ProfilesModule } from './modules/profiles/profiles.module.js';
import { RewardsModule } from './modules/rewards/rewards.module.js';
import { TeamsModule } from './modules/teams/teams.module.js';
import { WorkspaceModule } from './modules/workspace/workspace.module.js';

/** The eight domain modules (architecture 2). Shared registration point, edited by the orchestrator. */
export const DOMAIN_MODULES = [
  AuthModule,
  ProfilesModule,
  PlaybooksModule,
  TeamsModule,
  MatchingModule,
  WorkspaceModule,
  GithubModule,
  RewardsModule,
];

export type AppOptions = Pick<PlatformOptions, 'logging'> & {
  /**
   * Extra modules of the HTTP application. Production passes none; the test bootstrap adds the
   * test-support module (test/support) here, so nothing test-only is part of `AppModule` or the build.
   */
  extraImports?: ModuleMetadata['imports'];
};

/** HTTP application (process `api`). */
@Module({})
export class AppModule {
  static forRoot(config: AppConfig, options: AppOptions = {}): DynamicModule {
    const { extraImports = [], ...platform } = options;
    return {
      module: AppModule,
      imports: [
        PlatformModule.forRoot(config, { http: true, ...platform }),
        ...DOMAIN_MODULES,
        ...extraImports,
      ],
    };
  }
}
