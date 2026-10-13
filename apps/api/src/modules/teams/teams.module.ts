import { Module } from '@nestjs/common';
import { TeamOperations } from './internal/authz/team-operations.js';
import { StubDeficitPort, StubTeamLifecyclePort } from './internal/ports/stub-ports.js';
import { TeamAccessRepository } from './internal/repositories/team-access.repository.js';
import { TeamsFacade } from './internal/services/teams-facade.service.js';
import { DEFICIT_PORT, TEAM_LIFECYCLE_PORT, TEAMS_API } from './public.js';

/**
 * Teams: schema, facade and authorization policies (S3-02). Services and controllers arrive in
 * S3-03..S3-10. The ports are bound to stubs here; matching (slice 4) and workspace (slice 5)
 * replace the bindings.
 */
@Module({
  providers: [
    TeamAccessRepository,
    TeamOperations,
    TeamsFacade,
    { provide: TEAMS_API, useExisting: TeamsFacade },
    { provide: DEFICIT_PORT, useClass: StubDeficitPort },
    { provide: TEAM_LIFECYCLE_PORT, useClass: StubTeamLifecyclePort },
  ],
  exports: [TEAMS_API, DEFICIT_PORT, TEAM_LIFECYCLE_PORT],
})
export class TeamsModule {}
