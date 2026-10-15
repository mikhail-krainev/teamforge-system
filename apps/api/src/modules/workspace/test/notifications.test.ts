import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem, expectReplayed } from '../../../../test/fixtures/assertions.js';
import { expectOk, githubUser, team, type OfferDto } from '../../../../test/fixtures/teams.js';
import { World } from '../../../../test/fixtures/world.js';
import { describeInfra, waitFor } from '../../../../test/helpers/infra.js';

interface NotificationDto {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  actorDisplayName?: string;
  createdAt: string;
  readAt: string | null;
}

describeInfra('S3 workspace: notifications (FR-WORK-19)', ['db', 'redis'], () => {
  let world: World;

  beforeAll(async () => {
    world = await World.start();
    await world.ensureCatalog(['backend', 'frontend', 'pm', 'designer', 'qa', 'devops']);
  });

  afterAll(async () => {
    if (!world) return;
    await world.close();
  });

  const list = async (who: Parameters<World['as']>[0], query = ''): Promise<NotificationDto[]> =>
    expectOk<{ items: NotificationDto[] }>(
      'listNotifications',
      await world.as(who).get(`/v1/me/notifications${query}`),
      200,
    ).items;

  /** A pending offer to a fresh candidate; the candidate's notification arrives through the outbox. */
  async function offerToCandidate(label: string) {
    const t = await team(world, { openSeats: 1 });
    const seat = t.openSeats[0];
    if (!seat) throw new Error('no seat');
    const candidate = await githubUser(world, label);
    const offer = expectOk<OfferDto>(
      'createSeatOffer',
      await world
        .as(t.lead)
        .post(`/v1/teams/${t.id}/seat-offers`, { seatId: seat.id, userId: candidate.id }),
      201,
    );
    const notification = await waitFor(async () => {
      const items = await list(candidate);
      return items.find((n) => JSON.stringify(n.payload).includes(offer.id));
    }, 20_000);
    return { t, candidate, offer, notification };
  }

  it('FR-WORK-19: an offer creates an unread notification for the addressee, with ids only in the payload', async () => {
    const { candidate, offer, notification } = await offerToCandidate('notify-offer');
    expect(notification.readAt).toBeNull();
    expect(notification.type.length).toBeGreaterThan(0);
    expect(JSON.stringify(notification.payload)).toContain(offer.id);
    expect(JSON.stringify(notification.payload)).not.toContain(candidate.email);
  });

  it('FR-WORK-19: an offer also sends an e-mail to the addressee (13.13)', async () => {
    const { candidate } = await offerToCandidate('notify-mail');
    const message = await world.mail.latestTo(candidate.email, { minCount: 1 });
    expect(message.subject.length).toBeGreaterThan(0);
  });

  it('FR-WORK-19, SEC-11: the name of the new member is resolved at read time, never stored in the row', async () => {
    const t = await team(world, { members: 2, openSeats: 1 });
    const member = t.members[0];
    if (!member) throw new Error('no member');
    const joined = await waitFor(async () => {
      const items = await list(t.lead);
      return items.find((n) => n.type === 'member_joined' && n.payload['userId'] === member.id);
    }, 20_000);
    // The fixture user has no profile, so the read-time lookup yields the deleted-user placeholder.
    expect(joined.actorDisplayName).toBe('Удалённый пользователь');
    expect(JSON.stringify(joined.payload)).not.toContain(member.displayName);
    const offer = await offerToCandidate('notify-no-actor');
    expect(offer.notification.actorDisplayName).toBeUndefined();
  });

  it('FR-WORK-19: the lead is notified of a new join request', async () => {
    const t = await team(world, { openSeats: 1 });
    const seat = t.openSeats[0];
    if (!seat) throw new Error('no seat');
    const candidate = await githubUser(world, 'notify-request');
    const request = expectOk<OfferDto>(
      'createJoinRequest',
      await world.as(candidate).post(`/v1/teams/${t.id}/join-requests`, { seatId: seat.id }),
      201,
    );
    const found = await waitFor(
      async () => (await list(t.lead)).find((n) => JSON.stringify(n.payload).includes(request.id)),
      20_000,
    );
    expect(found.readAt).toBeNull();
  });

  it('FR-WORK-19: `unread=true` hides the read ones; pages are cursor based', async () => {
    const { candidate, notification } = await offerToCandidate('notify-unread');
    expect((await list(candidate, '?unread=true')).map((n) => n.id)).toContain(notification.id);
    expectOk(
      'markNotificationsRead',
      await world.as(candidate).post('/v1/me/notifications/read-marks', { ids: [notification.id] }),
      204,
    );
    expect((await list(candidate, '?unread=true')).map((n) => n.id)).not.toContain(notification.id);
    const page = expectOk<{ items: NotificationDto[]; nextCursor: string | null }>(
      'listNotifications',
      await world.as(candidate).get('/v1/me/notifications?limit=1'),
      200,
    );
    expect(page.items).toHaveLength(1);
  });

  it('FR-WORK-19: markNotificationsRead sets readAt; a repeated call with the same key replays the 204', async () => {
    const { candidate, notification } = await offerToCandidate('notify-read');
    const key = randomUUID();
    expectOk(
      'markNotificationsRead',
      await world
        .as(candidate)
        .post(
          '/v1/me/notifications/read-marks',
          { ids: [notification.id] },
          { idempotencyKey: key },
        ),
      204,
    );
    const after = (await list(candidate)).find((n) => n.id === notification.id);
    expect(after?.readAt).not.toBeNull();
    const replay = await world
      .as(candidate)
      .post('/v1/me/notifications/read-marks', { ids: [notification.id] }, { idempotencyKey: key });
    expect(replay.statusCode).toBe(204);
    expectReplayed(replay);
  });

  it('FR-WORK-19: foreign notification ids are not marked (x-authz filters by the caller)', async () => {
    const { candidate, notification } = await offerToCandidate('notify-foreign');
    const intruder = await githubUser(world, 'notify-intruder');
    const response = await world
      .as(intruder)
      .post('/v1/me/notifications/read-marks', { ids: [notification.id] });
    // Plan (IDOR list): 404. The contract declares no 404 for this operation; the rule says ids are filtered.
    expect([204, 404]).toContain(response.statusCode);
    expect((await list(candidate)).find((n) => n.id === notification.id)?.readAt).toBeNull();
  });

  it('FR-WORK-19: a user sees only his own notifications', async () => {
    const { notification } = await offerToCandidate('notify-own');
    const other = await githubUser(world, 'notify-other');
    expect((await list(other)).map((n) => n.id)).not.toContain(notification.id);
  });

  describe('validation and sessions', () => {
    it('FR-WORK-19: a non-UUID id -> 400; a missing key -> 400 IDEMPOTENCY_KEY_MISSING', async () => {
      const person = await githubUser(world, 'notify-400');
      expectProblem(
        'markNotificationsRead',
        await world.as(person).post('/v1/me/notifications/read-marks', { ids: ['nope'] }),
        400,
        'VALIDATION_FAILED',
      );
      expectProblem(
        'markNotificationsRead',
        await world
          .as(person)
          .post(
            '/v1/me/notifications/read-marks',
            { ids: [randomUUID()] },
            { idempotencyKey: null },
          ),
        400,
        'IDEMPOTENCY_KEY_MISSING',
      );
    });

    it('FR-AUTH-03: both operations without a session -> 401', async () => {
      expectProblem(
        'listNotifications',
        await world.anonymous().get('/v1/me/notifications'),
        401,
        'UNAUTHENTICATED',
      );
      expectProblem(
        'markNotificationsRead',
        await world.anonymous().post('/v1/me/notifications/read-marks', { ids: [] }),
        401,
        'UNAUTHENTICATED',
      );
    });

    it('FR-WORK-19: limit above 100 -> 400', async () => {
      const person = await githubUser(world, 'notify-limit');
      expectProblem(
        'listNotifications',
        await world.as(person).get('/v1/me/notifications?limit=101'),
        400,
        'VALIDATION_FAILED',
      );
    });
  });
});
