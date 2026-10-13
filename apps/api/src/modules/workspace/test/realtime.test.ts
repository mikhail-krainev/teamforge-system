import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WS_CLOSE_UNAUTHENTICATED, type ServerMessage } from 'shared/realtime';
import { expectOk, seatInput, team, type TeamFixture } from '../../../../test/fixtures/teams.js';
import { World } from '../../../../test/fixtures/world.js';
import { describeInfra, waitFor } from '../../../../test/helpers/infra.js';

/** WebSocket client of Node (undici); the `headers` init option carries the session cookie and the Origin. */
type WsInit = { headers: Record<string, string> };
const connect = (url: string, headers: Record<string, string>): WebSocket =>
  new (WebSocket as unknown as new (u: string, init: WsInit) => WebSocket)(url, { headers });

interface Probe {
  socket: WebSocket;
  messages: ServerMessage[];
  closed: Promise<number>;
  opened: Promise<void>;
}

function probe(url: string, headers: Record<string, string>): Probe {
  const socket = connect(url, headers);
  const messages: ServerMessage[] = [];
  socket.addEventListener('message', (event) =>
    messages.push(JSON.parse(String(event.data)) as ServerMessage),
  );
  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => reject(new Error('socket error')));
  });
  const closed = new Promise<number>((resolve) =>
    socket.addEventListener('close', (e) => resolve(e.code)),
  );
  opened.catch(() => undefined);
  return { socket, messages, closed, opened };
}

describeInfra(
  'S3 workspace: the WebSocket gateway authorizes subscriptions (architecture 9, FR-WORK-19)',
  ['db', 'redis'],
  () => {
    let world: World;
    let wsUrl = '';

    beforeAll(async () => {
      world = await World.start();
      await world.ensureCatalog(['backend', 'frontend', 'pm', 'designer', 'qa', 'devops']);
      await world.app.listen({ port: 0, host: '127.0.0.1' });
      const address = world.app.getHttpServer().address();
      const port = typeof address === 'object' && address ? address.port : 0;
      wsUrl = `ws://127.0.0.1:${port}/api/ws`;
    });

    afterAll(async () => {
      if (!world) return;
      await world.close();
    });

    /** A real session (cookie) for a user who is also a member or the lead of `t`. */
    async function cookieOf(
      label: string,
    ): Promise<{ id: string; headers: Record<string, string> }> {
      const { user, session } = await world.signedIn(label);
      return { id: user.id, headers: { cookie: session.cookieHeader(), origin: world.origin } };
    }

    async function teamOfSignedInLead(
      label: string,
    ): Promise<{ t: TeamFixture; headers: Record<string, string> }> {
      const lead = await cookieOf(label);
      await world.sql`UPDATE auth."user" SET github_user_id = ${Math.floor(Math.random() * 1e9) + 1e6}, github_login = ${label} WHERE id = ${lead.id}`;
      const t = await team(world, {
        lead: { id: lead.id, email: '', displayName: label },
        openSeats: 1,
      });
      return { t, headers: lead.headers };
    }

    describe('the handshake', () => {
      it('FR-AUTH-01: no session cookie -> the connection is closed with 4401', async () => {
        const p = probe(wsUrl, { origin: world.origin });
        expect(await Promise.race([p.closed, p.opened.then(() => p.closed)])).toBe(
          WS_CLOSE_UNAUTHENTICATED,
        );
      });
    });

    describe('subscriptions', () => {
      it('FR-TEAM-02: a team member subscribes to team:<id> and gets team.updated when the lead edits the team', async () => {
        const { t, headers } = await teamOfSignedInLead('ws-lead');
        const p = probe(wsUrl, headers);
        await p.opened;
        p.socket.send(JSON.stringify({ op: 'subscribe', channel: `team:${t.id}` }));
        expectOk(
          'updateTeam',
          await world
            .as(t.lead)
            .patch(`/v1/teams/${t.id}`, { name: 'Realtime team', version: t.dto.version }),
          200,
        );
        const event = await waitFor(
          () => p.messages.find((m) => m.op === 'event' && m.type === 'team.updated'),
          20_000,
        );
        expect(event).toMatchObject({ channel: `team:${t.id}` });
        p.socket.close();
      });

      it('FR-TEAM-02: a user who is not a member is refused (op error FORBIDDEN) and receives nothing from the team', async () => {
        const { t } = await teamOfSignedInLead('ws-owner');
        const outsider = await cookieOf('ws-outsider');
        const p = probe(wsUrl, outsider.headers);
        await p.opened;
        p.socket.send(JSON.stringify({ op: 'subscribe', channel: `team:${t.id}` }));
        const refusal = await waitFor(() => p.messages.find((m) => m.op === 'error'), 20_000);
        expect(refusal).toMatchObject({ op: 'error', code: 'FORBIDDEN' });
        expectOk(
          'addSeats',
          await world.as(t.lead).post(`/v1/teams/${t.id}/seats`, { seats: [seatInput()] }),
          201,
        );
        // Sentinel: a notification for the outsider reaches his user channel, so the relay has run.
        const seat = t.openSeats[0];
        if (!seat) throw new Error('no seat');
        expectOk(
          'createSeatOffer',
          await world
            .as(t.lead)
            .post(`/v1/teams/${t.id}/seat-offers`, { seatId: seat.id, userId: outsider.id }),
          201,
        );
        await waitFor(
          () => p.messages.find((m) => m.op === 'event' && m.type === 'notification.created'),
          20_000,
        );
        expect(p.messages.filter((m) => m.op === 'event' && m.channel === `team:${t.id}`)).toEqual(
          [],
        );
        p.socket.close();
      });

      it('FR-WORK-19: subscribing to the channel of another user is refused', async () => {
        const victim = await cookieOf('ws-victim');
        const spy = await cookieOf('ws-spy');
        const p = probe(wsUrl, spy.headers);
        await p.opened;
        p.socket.send(JSON.stringify({ op: 'subscribe', channel: `user:${victim.id}` }));
        const refusal = await waitFor(() => p.messages.find((m) => m.op === 'error'), 20_000);
        expect(refusal).toMatchObject({ code: 'FORBIDDEN' });
        p.socket.close();
      });

      it('FR-WORK-19: the own user channel needs no subscription: notification.created arrives when an offer is made', async () => {
        const { t } = await teamOfSignedInLead('ws-offerer');
        const candidate = await cookieOf('ws-candidate');
        const p = probe(wsUrl, candidate.headers);
        await p.opened;
        const seat = t.openSeats[0];
        if (!seat) throw new Error('no seat');
        expectOk(
          'createSeatOffer',
          await world
            .as(t.lead)
            .post(`/v1/teams/${t.id}/seat-offers`, { seatId: seat.id, userId: candidate.id }),
          201,
        );
        const event = await waitFor(
          () => p.messages.find((m) => m.op === 'event' && m.type === 'notification.created'),
          20_000,
        );
        expect(event).toMatchObject({ channel: `user:${candidate.id}` });
        p.socket.close();
      });
    });
  },
);
