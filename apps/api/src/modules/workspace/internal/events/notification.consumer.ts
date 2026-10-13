import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import { APP_CONFIG } from '../../../../platform/config/config.module.js';
import type { AppConfig } from '../../../../platform/config/config.js';
import { Clock } from '../../../../platform/clock/clock.js';
import { MailService } from '../../../../platform/mail/mail.service.js';
import { EventConsumers } from '../../../../platform/outbox/event-consumers.js';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import type { EventConsumer, OutboxEventData } from '../../../../platform/outbox/outbox.types.js';
import { AUTH_API, type AuthApi } from '../../../auth/public.js';
import { TEAMS_API, type TeamsApi } from '../../../teams/public.js';
import { WORKSPACE_MODULE } from '../../public.js';
import { type TeamAudience, planNotifications } from '../domain/notification-plan.js';
import { notificationMail } from '../notifications/notification-mail.js';
import { MAILED_TYPES, type NotificationDraft } from '../notifications/notification-types.js';
import { NotificationRepository } from '../repositories/notification.repository.js';

/** Outbox event that tells the realtime relay that a notification row exists. */
export const NOTIFICATION_CREATED = 'notification_created';

/** Events that can create notifications (architecture 3.6). */
export const NOTIFICATION_SOURCES = [
  'teams.offer_created',
  'teams.invitation_accepted',
  'teams.member_joined',
  'teams.member_left',
  'teams.seat_opened',
  'teams.team_started',
  'teams.lead_changed',
  'teams.vote_updated',
  'matching.auto_added',
] as const;

/**
 * Turns events of other modules into notification rows (FR-WORK-19, ADR-0005). Runs in the worker,
 * inside the inbox transaction: rows, `workspace.notification_created` events and the mail jobs
 * stand or fall together. A repeated delivery creates nothing (`dedupe_key`).
 */
@Injectable()
export class NotificationConsumer implements EventConsumer, OnModuleInit {
  readonly consumer = 'workspace.notifications';
  readonly types = NOTIFICATION_SOURCES;

  constructor(
    @Inject(EventConsumers) private readonly consumers: EventConsumers,
    @Inject(NotificationRepository) private readonly notifications: NotificationRepository,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(TEAMS_API) private readonly teams: TeamsApi,
    @Inject(AUTH_API) private readonly auth: AuthApi,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.consumers.register(this);
  }

  async handle(event: OutboxEventData): Promise<void> {
    const audiences = new Map<string, Promise<TeamAudience | null>>();
    const audience = (teamId: string): Promise<TeamAudience | null> => {
      let found = audiences.get(teamId);
      if (found === undefined) {
        found = this.audienceOf(teamId);
        audiences.set(teamId, found);
      }
      return found;
    };
    const drafts = await planNotifications(
      { id: event.id, name: `${event.module}.${event.type}`, payload: event.payload },
      audience,
    );
    if (drafts.length === 0) return;
    const now = this.clock.now();
    const created = await this.notifications.insertNew(
      drafts.map((d) => ({
        id: uuidv7(),
        userId: d.userId,
        type: d.type,
        payload: d.payload,
        dedupeKey: d.dedupeKey,
        createdAt: now,
        readAt: null,
      })),
    );
    const byKey = new Map(drafts.map((d) => [`${d.userId}|${d.dedupeKey}`, d]));
    await this.outbox.publishMany(
      created.map((row) => ({
        module: WORKSPACE_MODULE,
        type: NOTIFICATION_CREATED,
        aggregateId: row.id,
        payload: { userId: row.userId, notificationId: row.id },
      })),
    );
    for (const row of created) {
      const made = byKey.get(`${row.userId}|${row.dedupeKey}`);
      if (made !== undefined) await this.sendMail(made);
    }
  }

  private async audienceOf(teamId: string): Promise<TeamAudience | null> {
    const view = await this.teams.getTeamView(teamId);
    if (view === null) return null;
    const roster = await this.teams.getRoster(teamId);
    return { leadUserId: view.leadUserId, memberUserIds: roster.map((m) => m.userId) };
  }

  /** The address is read now and only for an active user with a valid consent (SEC-11). */
  private async sendMail(draft: NotificationDraft): Promise<void> {
    if (!MAILED_TYPES.has(draft.type)) return;
    const to = await this.auth.getMailRecipient(draft.userId);
    if (to === null) return;
    const teamId = draft.payload['teamId'];
    const link =
      typeof teamId === 'string'
        ? `${this.config.APP_ORIGIN}/teams/${teamId}`
        : `${this.config.APP_ORIGIN}/`;
    const message = notificationMail(draft.type, to, link);
    if (message !== null) await this.mail.enqueue(message);
  }
}
