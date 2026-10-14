import { Inject, Injectable } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import type { Body } from 'shared';
import { Clock } from '../../../../platform/clock/clock.js';
import {
  type Page,
  buildPage,
  clampLimit,
  decodeCursor,
} from '../../../../platform/db/pagination.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { LockService } from '../../../../platform/tx/locks.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { AUTH_API, type AuthApi } from '../../../auth/public.js';
import {
  INVITATION_TTL_MS,
  MAX_ACTIVE_INVITATIONS,
  hashInvitationToken,
  newInvitationToken,
} from '../domain/invitation-rules.js';
import { JOINABLE_STATUSES } from '../domain/join-rules.js';
import {
  type InvitationCursor,
  InvitationRepository,
} from '../repositories/invitation.repository.js';
import { SeatRepository } from '../repositories/seat.repository.js';
import { TeamEventRepository } from '../repositories/team-event.repository.js';
import {
  GITHUB_LOGIN_RESOLVER,
  type GithubLoginResolver,
  type ResolvedGithubLogin,
} from './github-login-resolver.js';
import { type InvitationDto, toInvitationDto } from './invitation-dto.js';
import { journalRow } from './team-events.js';
import { TeamLeadLock } from './team-lead-lock.js';

type CreateBody = Body<'createInvitation'>;

export interface InvitationsQuery {
  cursor?: string | undefined;
  limit?: number | undefined;
}

interface Addressee {
  github: ResolvedGithubLogin | null;
  emailHmac: Buffer | null;
}

function invalid(pointer: string, code: string, message: string): DomainError {
  return new DomainError('VALIDATION_FAILED', 422, { errors: [{ pointer, code, message }] });
}

function cursorOf(cursor: string, filters: Record<string, unknown>): InvitationCursor {
  const [at, id] = decodeCursor(cursor, filters).k;
  const when = typeof at === 'string' ? new Date(at) : undefined;
  if (when === undefined || Number.isNaN(when.getTime()) || typeof id !== 'string') {
    throw new DomainError('VALIDATION_FAILED', 400, {
      errors: [{ pointer: '/cursor', code: 'invalid_cursor', message: 'Invalid cursor' }],
    });
  }
  return { at: when, id };
}

/** createInvitation, listInvitations, revokeInvitation (FR-TEAM-08). */
@Injectable()
export class InvitationService {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(LockService) private readonly locks: LockService,
    @Inject(AUTH_API) private readonly auth: AuthApi,
    @Inject(GITHUB_LOGIN_RESOLVER) private readonly github: GithubLoginResolver,
    @Inject(InvitationRepository) private readonly invitations: InvitationRepository,
    @Inject(SeatRepository) private readonly seats: SeatRepository,
    @Inject(TeamEventRepository) private readonly events: TeamEventRepository,
    @Inject(TeamLeadLock) private readonly leadLock: TeamLeadLock,
  ) {}

  /**
   * The login is resolved and the address hashed before BEGIN (no network call inside a
   * transaction). The token exists only in this response: the row keeps its SHA-256.
   */
  async create(
    leadId: string,
    teamId: string,
    body: CreateBody,
  ): Promise<{ invitation: InvitationDto; token: string }> {
    const addressee = await this.addressee(leadId, teamId, body);
    const token = newInvitationToken();
    const invitation = await this.tx.run(() =>
      this.createInTx(leadId, teamId, body.seatId, addressee, token),
    );
    return { invitation, token };
  }

  private async addressee(leadId: string, teamId: string, body: CreateBody): Promise<Addressee> {
    if (body.inviteeGithubLogin !== undefined && body.inviteeEmail !== undefined) {
      throw invalid('/inviteeEmail', 'one_addressee', 'Give either a GitHub login or an e-mail');
    }
    if (body.inviteeGithubLogin !== undefined) {
      // The limit C-13 is read first (outside any transaction): a full team never spends a GitHub
      // call. The authoritative count is still taken under lock #4 in createInTx (S3SEC-02).
      await this.assertBelowInvitationLimit(teamId);
      const found = await this.github.resolve(body.inviteeGithubLogin, leadId);
      if (found === null) {
        throw invalid('/inviteeGithubLogin', 'unknown_login', 'GitHub does not know this login');
      }
      return { github: found, emailHmac: null };
    }
    if (body.inviteeEmail !== undefined) {
      return { github: null, emailHmac: this.auth.hmacOfEmail(body.inviteeEmail) };
    }
    return { github: null, emailHmac: null };
  }

  private async assertBelowInvitationLimit(teamId: string): Promise<void> {
    if ((await this.invitations.countActive(teamId, this.clock.now())) >= MAX_ACTIVE_INVITATIONS) {
      throw new DomainError('INVITATION_LIMIT', 409);
    }
  }

  /** Lock #4; the limit C-13 is counted under it, so 20 parallel requests cannot all pass. */
  private async createInTx(
    leadId: string,
    teamId: string,
    seatId: string,
    addressee: Addressee,
    token: string,
  ): Promise<InvitationDto> {
    const team = await this.leadLock.lock(teamId, leadId);
    if (!JOINABLE_STATUSES.includes(team.status)) throw new DomainError('INVALID_STATE', 409);
    const [seat] = await this.seats.listByTeam(teamId, [seatId]);
    if (seat === undefined) throw new DomainError('NOT_FOUND', 404);
    if (seat.status !== 'open') throw new DomainError('SEAT_NOT_OPEN', 409);
    const now = this.clock.now();
    // No UPDATE of invitation rows here: lock #3 (invitation) must not be taken under #4 (team).
    // countActive filters `expires_at > now`; the hourly invitation-cleanup job expires the rows.
    if ((await this.invitations.countActive(teamId, now)) >= MAX_ACTIVE_INVITATIONS) {
      throw new DomainError('INVITATION_LIMIT', 409);
    }
    const row = {
      id: uuidv7(),
      teamId,
      seatId,
      tokenHash: hashInvitationToken(token),
      inviteeGithubUserId: addressee.github?.id ?? null,
      inviteeGithubLogin: addressee.github?.login ?? null,
      inviteeEmailHmac: addressee.emailHmac,
      status: 'active',
      expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
      usedBy: null,
      usedAt: null,
      createdBy: leadId,
      createdAt: now,
    };
    await this.invitations.insert(row);
    await this.events.insertMany([
      journalRow(teamId, 'invitation_created', leadId, { invitationId: row.id, seatId }, now),
    ]);
    return toInvitationDto(row, seat.roleCode, now);
  }

  async list(teamId: string, query: InvitationsQuery): Promise<Page<InvitationDto>> {
    const now = this.clock.now();
    const filters = { teamId };
    const limit = clampLimit(query.limit);
    const after = query.cursor === undefined ? undefined : cursorOf(query.cursor, filters);
    const rows = await this.tx.run(() => this.invitations.listForTeam(teamId, after, limit + 1));
    const page = buildPage(
      rows,
      limit,
      (row) => [row.invitation.createdAt.toISOString(), row.invitation.id],
      filters,
    );
    return {
      items: page.items.map((row) => toInvitationDto(row.invitation, row.roleCode, now)),
      nextCursor: page.nextCursor,
    };
  }

  /** Lock #3 (the row `acceptInvitation` locks), so revoking and accepting have one winner. */
  revoke(leadId: string, teamId: string, invitationId: string): Promise<void> {
    return this.tx.run(() => this.revokeInTx(leadId, teamId, invitationId));
  }

  private async revokeInTx(leadId: string, teamId: string, invitationId: string): Promise<void> {
    const locked = await this.locks.lockTicket('invitation', invitationId);
    const row = locked === undefined ? undefined : await this.invitations.find(invitationId);
    if (row === undefined || row.teamId !== teamId) throw new DomainError('NOT_FOUND', 404);
    const now = this.clock.now();
    if (row.status !== 'active' || row.expiresAt <= now) {
      throw new DomainError('INVALID_STATE', 409);
    }
    await this.invitations.setStatus(row.id, 'revoked');
    await this.events.insertMany([
      journalRow(teamId, 'invitation_revoked', leadId, { invitationId: row.id }, now),
    ]);
  }
}
