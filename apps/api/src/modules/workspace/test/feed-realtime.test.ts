import { afterAll, beforeAll, expect, it } from 'vitest';
import type { ServerMessage } from 'shared/realtime';
import {
  connectRepository,
  closedIssueDelivered,
  ghPerson,
} from '../../../../test/fixtures/github.js';
import { githubUser, team, type TeamFixture } from '../../../../test/fixtures/teams.js';
import { startRouteWorld } from '../../../../test/fixtures/workspace.js';
import type { World } from '../../../../test/fixtures/world.js';
import { FakeClock } from '../../../../test/helpers/clock.js';
import { describeInfra, waitFor } from '../../../../test/helpers/infra.js';

/*
 * S6-02: real-time events of the feed (FR-WORK-16, architecture 9): a member subscribed to `team:<id>` is
 * told `contribution.recorded {teamId, contributionId}` when a contribution appears, a stranger is not.
 * The plan names the event `feed.updated`; the architecture and the shared contract name it
 * `contribution.recorded` - this test follows the contract of packages/shared/src/realtime.ts.
 */

type WsInit = { headers: Record<string, string> };
const connect = (url: string, headers: Record<string, string>): WebSocket =>
  new (WebSocket as unknown as new (u: string, init: WsInit) => WebSocket)(url, { headers });

interface Probe {
  socket: WebSocket;
  messages: ServerMessage[];
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
  opened.catch(() => undefined);
  return { socket, messages, opened };
}

describeInfra(
  'S6 workspace: the feed is pushed over WebSocket (FR-WORK-16)',
  ['db', 'redis'],
  () => {
    let world: World;
    const clock = new FakeClock(Date.now());
    let wsUrl = '';

    beforeAll(async () => {
      world = await startRouteWorld({ github: true, clock });
      await world.app.listen({ port: 0, host: '127.0.0.1' });
      const address = world.app.getHttpServer().address();
      const port = typeof address === 'object' && address ? address.port : 0;
      wsUrl = `ws://127.0.0.1:${port}/api/ws`;
    });

    afterAll(async () => {
      if (!world) return;
      await world.close();
    });

    async function signedLeadTeam(label: string): Promise<{
      t: TeamFixture;
      headers: Record<string, string>;
    }> {
      const { user, session } = await world.signedIn(label);
      await world.sql`UPDATE auth."user" SET github_user_id = ${Math.floor(Math.random() * 1e9) + 1e6}, github_login = ${label} WHERE id = ${user.id}`;
      const t = await team(world, {
        lead: user,
        members: 3,
        openSeats: 1,
        roleCode: 'devops',
        joinPlannedRoles: true,
        status: 'active',
      });
      return { t, headers: { cookie: session.cookieHeader(), origin: world.origin } };
    }

    it('FR-WORK-16: a webhook that creates a contribution reaches the subscribed member as contribution.recorded', async () => {
      const { t, headers } = await signedLeadTeam('ws6-lead');
      const connected = await connectRepository(world, t, t.members);
      const first = t.members[0];
      if (!first) throw new Error('fixture');
      const author = await ghPerson(world, first);
      const p = probe(wsUrl, headers);
      await p.opened;
      p.socket.send(JSON.stringify({ op: 'subscribe', channel: `team:${t.id}` }));
      await new Promise((resolve) => setTimeout(resolve, 300));
      await closedIssueDelivered(world, connected.repo, { author, assignees: [author] });
      const event = await waitFor(
        () => p.messages.find((m) => m.op === 'event' && m.type === 'contribution.recorded'),
        20_000,
      );
      expect(event).toMatchObject({ channel: `team:${t.id}`, data: { teamId: t.id } });
      expect(JSON.stringify(event)).not.toMatch(/Починить|title|email/);
      p.socket.close();
    });

    it('SEC-03: a stranger cannot subscribe to the team and learns nothing about its contributions', async () => {
      const { t } = await signedLeadTeam('ws6-owner');
      const connected = await connectRepository(world, t, t.members);
      const first = t.members[0];
      if (!first) throw new Error('fixture');
      const author = await ghPerson(world, first);
      const stranger = await world.signedIn('ws6-stranger');
      await githubUser(world, 'ws6-padding');
      const p = probe(wsUrl, { cookie: stranger.session.cookieHeader(), origin: world.origin });
      await p.opened;
      p.socket.send(JSON.stringify({ op: 'subscribe', channel: `team:${t.id}` }));
      const refusal = await waitFor(() => p.messages.find((m) => m.op === 'error'), 20_000);
      expect(refusal).toMatchObject({ op: 'error', code: 'FORBIDDEN' });
      await closedIssueDelivered(world, connected.repo, { author, assignees: [author] });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(p.messages.filter((m) => m.op === 'event')).toEqual([]);
      p.socket.close();
    });
  },
);
