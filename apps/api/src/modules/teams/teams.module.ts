import { Module } from '@nestjs/common';
import { InvitationController } from './internal/controllers/invitation.controller.js';
import { OfferController } from './internal/controllers/offer.controller.js';
import { SeatController } from './internal/controllers/seat.controller.js';
import { TeamController } from './internal/controllers/team.controller.js';
import { TeamOperations } from './internal/authz/team-operations.js';
import { StubDeficitPort, StubTeamLifecyclePort } from './internal/ports/stub-ports.js';
import { InvitationCleanup } from './internal/jobs/invitation-cleanup.js';
import { InvitationRepository } from './internal/repositories/invitation.repository.js';
import { JoinRepository } from './internal/repositories/join.repository.js';
import { OfferRepository } from './internal/repositories/offer.repository.js';
import { TeamAccessRepository } from './internal/repositories/team-access.repository.js';
import { SeatRepository } from './internal/repositories/seat.repository.js';
import { TeamEventRepository } from './internal/repositories/team-event.repository.js';
import { TeamListRepository } from './internal/repositories/team-list.repository.js';
import { TeamRepository } from './internal/repositories/team.repository.js';
import {
  GITHUB_LOGIN_RESOLVER,
  HttpGithubLoginResolver,
} from './internal/services/github-login-resolver.js';
import { InvitationAcceptService } from './internal/services/invitation-accept.service.js';
import { InvitationService } from './internal/services/invitation.service.js';
import { JoinService } from './internal/services/join.service.js';
import { OffersDecisionService } from './internal/services/offers-decision.service.js';
import { OffersQueryService } from './internal/services/offers-query.service.js';
import { OffersService } from './internal/services/offers.service.js';
import { SeatCatalogCheck } from './internal/services/seat-catalog-check.js';
import { SeatService } from './internal/services/seat.service.js';
import { TeamLeadLock } from './internal/services/team-lead-lock.js';
import { TeamQueryService } from './internal/services/team-query.service.js';
import { TeamViewService } from './internal/services/team-view.service.js';
import { TeamService } from './internal/services/team.service.js';
import { TeamsFacade } from './internal/services/teams-facade.service.js';
import { START_CONTROLLERS, START_PROVIDERS } from './internal/start.providers.js';
import { DEFICIT_PORT, TEAM_LIFECYCLE_PORT, TEAMS_API } from './public.js';

/**
 * Teams: schema, facade and authorization policies (S3-02), teams and seats (S3-03), joining and
 * offers (S3-04), invitations (S3-05). The other services and controllers arrive in S3-05..S3-10. The ports are bound to stubs here; matching (slice 4) and workspace (slice 5)
 * replace the bindings.
 */
@Module({
  controllers: [TeamController, SeatController, OfferController, InvitationController, ...START_CONTROLLERS],
  providers: [
    ...START_PROVIDERS,
    TeamAccessRepository,
    TeamRepository,
    TeamListRepository,
    SeatRepository,
    JoinRepository,
    OfferRepository,
    InvitationRepository,
    TeamEventRepository,
    TeamLeadLock,
    SeatCatalogCheck,
    TeamViewService,
    TeamService,
    SeatService,
    JoinService,
    OffersService,
    OffersDecisionService,
    OffersQueryService,
    InvitationService,
    InvitationAcceptService,
    InvitationCleanup,
    { provide: GITHUB_LOGIN_RESOLVER, useClass: HttpGithubLoginResolver },
    TeamQueryService,
    TeamOperations,
    TeamsFacade,
    { provide: TEAMS_API, useExisting: TeamsFacade },
    { provide: DEFICIT_PORT, useClass: StubDeficitPort },
    { provide: TEAM_LIFECYCLE_PORT, useClass: StubTeamLifecyclePort },
  ],
  exports: [TEAMS_API, DEFICIT_PORT, TEAM_LIFECYCLE_PORT],
})
export class TeamsModule {}
