import { describe, expect, it } from 'vitest';
import { FakeGithubInstall, type Account, type GhUser } from './fake-github-install.js';
import { InstallStateFlow, STATE_TTL_MS } from './install-state-flow.js';

const lead: GhUser = { id: 1, login: 'lead' };
const stranger: GhUser = { id: 2, login: 'stranger' };
const newLead: GhUser = { id: 3, login: 'new-lead' };
const personal: Account = { login: 'lead', type: 'User', ownerIds: [1] };
const org: Account = { login: 'acme', type: 'Organization', ownerIds: [1, 3] };
const strangerOrg: Account = { login: 'evil', type: 'Organization', ownerIds: [2] };

function setup(options: ConstructorParameters<typeof FakeGithubInstall>[0] = {}) {
  let now = 1_000_000;
  const github = new FakeGithubInstall(options);
  const leads = new Map([['team-a', 1]]);
  const flow = new InstallStateFlow({
    github,
    accounts: [personal, org, strangerOrg],
    now: () => now,
    isLead: (teamId, userId) => leads.get(teamId) === userId,
  });
  return { github, flow, leads, advance: (ms: number) => (now += ms) };
}

describe('S6-01 installation state flow (twin)', () => {
  it('binds the installation to the team and user when state, code and ownership match', async () => {
    const { github, flow } = setup();
    const state = flow.createSession('team-a', lead.id);
    const result = await flow.callback(lead.id, github.install(lead, personal, state));
    expect(result).toMatchObject({ ok: true, teamId: 'team-a', mode: 'state' });
    expect(flow.grants).toHaveLength(1);
    expect(flow.grants[0]).toMatchObject({ teamId: 'team-a', userId: lead.id });
  });

  it('state is single use', async () => {
    const { github, flow } = setup();
    const state = flow.createSession('team-a', lead.id);
    const query = github.install(lead, personal, state);
    expect((await flow.callback(lead.id, query)).ok).toBe(true);
    const replay = await flow.callback(lead.id, github.install(lead, personal, state));
    expect(replay).toEqual({ ok: false, error: 'STATE_INVALID' });
    expect(flow.grants).toHaveLength(1);
  });

  it('rejects a state presented by another platform user, and burns it', async () => {
    const { github, flow } = setup();
    const state = flow.createSession('team-a', lead.id);
    const result = await flow.callback(stranger.id, github.install(lead, personal, state));
    expect(result).toEqual({ ok: false, error: 'STATE_USER_MISMATCH' });
    expect(flow.grants).toHaveLength(0);
    // The owner has to start over: GETDEL already consumed the value.
    const retry = await flow.callback(lead.id, github.install(lead, personal, state));
    expect(retry).toEqual({ ok: false, error: 'STATE_INVALID' });
  });

  it('rejects an expired state', async () => {
    const { github, flow, advance } = setup();
    const state = flow.createSession('team-a', lead.id);
    advance(STATE_TTL_MS + 1);
    const result = await flow.callback(lead.id, github.install(lead, personal, state));
    expect(result).toEqual({ ok: false, error: 'STATE_INVALID' });
  });

  it('rejects a state with a colon before touching the store (shared gh_state: namespace)', async () => {
    const { github, flow } = setup();
    const before = flow.storeReads;
    const result = await flow.callback(lead.id, github.install(lead, personal, 'cache:login:octocat'));
    expect(result).toEqual({ ok: false, error: 'STATE_INVALID' });
    expect(flow.storeReads).toBe(before);
  });

  it('rejects when the session user is no longer the team lead', async () => {
    const { github, flow, leads } = setup();
    const state = flow.createSession('team-a', lead.id);
    leads.set('team-a', newLead.id);
    const result = await flow.callback(lead.id, github.install(lead, personal, state));
    expect(result).toEqual({ ok: false, error: 'NOT_LEAD' });
  });

  it('the same callback repeated 10 times in parallel yields exactly one success and one grant', async () => {
    const { github, flow } = setup();
    const state = flow.createSession('team-a', lead.id);
    const query = github.install(lead, personal, state);
    const results = await Promise.all(Array.from({ length: 10 }, () => flow.callback(lead.id, query)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(flow.grants).toHaveLength(1);
  });

  it('a forged installation_id of someone else does not pass GET /user/installations', async () => {
    const { github, flow } = setup();
    github.install(stranger, strangerOrg, 'x'); // creates the stranger installation
    const state = flow.createSession('team-a', lead.id);
    const own = github.install(lead, personal, state);
    const forged = { ...own, installation_id: '1000' };
    const result = await flow.callback(lead.id, forged);
    expect(result).toEqual({ ok: false, error: 'INSTALLATION_NOT_OWNED' });
    expect(flow.grants).toHaveLength(0);
  });

  it('a callback without code is rejected', async () => {
    const { github, flow } = setup();
    const state = flow.createSession('team-a', lead.id);
    const full = github.install(lead, personal, state);
    const noCode = { installation_id: full.installation_id, setup_action: full.setup_action, state: full.state };
    expect(await flow.callback(lead.id, noCode)).toEqual({ ok: false, error: 'CODE_MISSING' });
  });

  it('an organization install by a non-owner returns no installation_id: pending approval, no grant', async () => {
    const { github, flow } = setup();
    const state = flow.createSession('team-a', stranger.id);
    const query = github.install(stranger, org, state);
    expect(query.setup_action).toBe('request');
    expect(await flow.callback(stranger.id, query)).toEqual({ ok: false, error: 'PENDING_APPROVAL' });
    expect(flow.grants).toHaveLength(0);
  });

  it('owner approval arrives without state and code: it creates no grant for the requesting team', async () => {
    const { github, flow } = setup();
    const approved = github.approveRequest(lead, org);
    expect(approved.state).toBeUndefined();
    expect(await flow.callback(lead.id, approved)).toEqual({ ok: false, error: 'CODE_MISSING' });
    expect(flow.grants).toHaveLength(0);
  });

  it('reinstall by the same account returns setup_action=update with the same installation_id', async () => {
    const { github, flow, leads } = setup();
    const first = github.install(lead, org, flow.createSession('team-a', lead.id));
    await flow.callback(lead.id, first);
    leads.set('team-a', newLead.id);
    const second = github.install(newLead, org, flow.createSession('team-a', newLead.id));
    expect(second.setup_action).toBe('update');
    expect(second.installation_id).toBe(first.installation_id);
    expect((await flow.callback(newLead.id, second)).ok).toBe(true);
    expect(flow.activeGrants(Number(first.installation_id))).toHaveLength(2);
  });

  it('after the installation is revoked, grants are revoked and a new callback finds no installation', async () => {
    const { github, flow } = setup();
    const query = github.install(lead, personal, flow.createSession('team-a', lead.id));
    await flow.callback(lead.id, query);
    const id = Number(query.installation_id);
    github.deleteInstallation(id);
    expect(github.webhooks).toEqual([{ event: 'installation.deleted', installationId: id }]);
    flow.onInstallationDeleted(id);
    expect(flow.activeGrants(id)).toHaveLength(0);
    const stale = github.install(lead, personal, flow.createSession('team-a', lead.id));
    expect(Number(stale.installation_id)).not.toBe(id);
  });

  it('rejects an installation missing a required permission', async () => {
    const { github, flow } = setup({ permissions: { metadata: 'read', issues: 'read', pull_requests: 'read' } });
    const state = flow.createSession('team-a', lead.id);
    const result = await flow.callback(lead.id, github.install(lead, personal, state));
    expect(result).toEqual({ ok: false, error: 'PERMISSIONS_MISSING' });
  });

  it('a code is single use', async () => {
    const { github } = setup();
    const query = github.install(lead, personal, 's');
    expect(github.exchangeCode(query.code ?? '')).not.toBeNull();
    expect(github.exchangeCode(query.code ?? '')).toBeNull();
  });

  describe('fallback when GitHub does not echo state', () => {
    it('binds by installation_id plus OAuth ownership, with no team until PUT /repository', async () => {
      const { github, flow } = setup({ dropState: true });
      const state = flow.createSession('team-a', lead.id);
      const query = github.install(lead, personal, state);
      expect(query.state).toBeUndefined();
      const result = await flow.callback(lead.id, query);
      expect(result).toMatchObject({ ok: true, teamId: null, mode: 'fallback' });
    });

    it('still rejects an installation the session user does not own', async () => {
      const { github, flow } = setup({ dropState: true });
      github.install(stranger, strangerOrg, 'x');
      const own = github.install(lead, personal, 'y');
      const result = await flow.callback(lead.id, { ...own, installation_id: '1000' });
      expect(result).toEqual({ ok: false, error: 'INSTALLATION_NOT_OWNED' });
    });
  });
});
