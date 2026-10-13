import { Inject, Injectable } from '@nestjs/common';
import type { Schema } from 'shared';
import { Clock } from '../../../../platform/clock/clock.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { RateLimiter } from '../../../../platform/ratelimit/rate-limiter.js';
import { LockService } from '../../../../platform/tx/locks.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { AUTH_API, type AuthApi } from '../../../auth/public.js';
import { hashInvitationToken, isAddressee, isUsable } from '../domain/invitation-rules.js';
import { joinRefusalStatus } from '../domain/join-rules.js';
import { InvitationRepository, type InvitationRow } from '../repositories/invitation.repository.js';
import { JoinService } from './join.service.js';
import type { JoinResultDto } from './offer-dto.js';

export type InvitationPreviewDto = Schema<'InvitationPreview'>;

const gone = (): DomainError => new DomainError('INVITATION_GONE', 410);
const notFound = (): DomainError => new DomainError('NOT_FOUND', 404);
const notForYou = (): DomainError => new DomainError('INVITATION_NOT_FOR_YOU', 403);

/**
 * previewInvitation and acceptInvitation (FR-TEAM-09). Guessing is limited per user before the
 * token is looked up. An unknown token is 404, a known one that is over (expired, used, revoked)
 * is 410, and only after that is the addressee checked, so a stranger learns nothing about a
 * team from a token that is not his.
 */
@Injectable()
export class InvitationAcceptService {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(LockService) private readonly locks: LockService,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(AUTH_API) private readonly auth: AuthApi,
    @Inject(InvitationRepository) private readonly invitations: InvitationRepository,
    @Inject(JoinService) private readonly join: JoinService,
  ) {}

  /** Changes nothing: no lock, no write. */
  async preview(userId: string, token: string): Promise<InvitationPreviewDto> {
    const row = await this.lookup(userId, token);
    if (!isUsable(row, this.clock.now())) throw gone();
    const identity = await this.auth.getIdentity(userId);
    await this.assertAddressee(row, userId, identity?.githubUserId ?? null);
    const data = await this.invitations.previewData(row.teamId, row.seatId);
    if (data === undefined) throw gone();
    return {
      teamId: row.teamId,
      teamName: data.teamName,
      roleCode: data.roleCode,
      productTypeCode: data.productTypeCode,
      expiresAt: row.expiresAt.toISOString(),
    };
  }

  async accept(userId: string, token: string): Promise<JoinResultDto> {
    const known = await this.lookup(userId, token);
    return this.tx.run(() => this.acceptInTx(userId, known.id));
  }

  /** CC-8: lock #1 (the joining user), then #3 (the invitation row), then the join path (#4, #5). */
  private async acceptInTx(userId: string, invitationId: string): Promise<JoinResultDto> {
    const eligibility = await this.auth.lockUserForJoin(userId);
    const locked = await this.locks.lockTicket('invitation', invitationId);
    const row = locked === undefined ? undefined : await this.invitations.find(invitationId);
    if (row === undefined) throw gone();
    const now = this.clock.now();
    if (!isUsable(row, now)) throw gone();
    await this.assertAddressee(row, userId, eligibility.githubUserId);
    const joined = await this.join.join({
      seatId: row.seatId,
      userId,
      via: 'invite',
      userLocked: true,
    });
    if (!joined.ok) throw new DomainError(joined.code, joinRefusalStatus(joined.code));
    await this.invitations.markUsed(row.id, userId, now);
    return {
      teamId: joined.teamId,
      seatId: joined.seatId,
      roleCode: joined.roleCode,
      joinedVia: 'invite',
      trialUntil: joined.trialUntil?.toISOString() ?? null,
      deficitAtJoin: joined.deficitAtJoin,
    };
  }

  private async lookup(userId: string, token: string): Promise<InvitationRow> {
    await this.limiter.enforce('invitationToken', this.limiter.userSubject(userId));
    const row = await this.invitations.findByTokenHash(hashInvitationToken(token));
    if (row === undefined) throw notFound();
    return row;
  }

  private async assertAddressee(
    row: InvitationRow,
    userId: string,
    githubUserId: number | null,
  ): Promise<void> {
    const emailHmac = row.inviteeEmailHmac === null ? null : await this.auth.getEmailHmac(userId);
    if (!isAddressee(row, { githubUserId, emailHmac })) throw notForYou();
  }
}
