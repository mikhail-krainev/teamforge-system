import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { World } from '../../../../test/fixtures/world.js';
import { describeInfra } from '../../../../test/helpers/infra.js';
import { hmacBytes } from '../../../platform/crypto/secret-box.js';
import { DomainError } from '../../../platform/errors/domain-error.js';
import { TxRunner } from '../../../platform/tx/tx-runner.js';
import { AuthService } from '../internal/services/auth.service.js';
import { IdentitySignalsService } from '../internal/services/identity-signals.service.js';

describeInfra('auth facade (AuthApi for other modules)', ['db', 'redis'], () => {
  let world: World;
  let auth: AuthService;
  let signals: IdentitySignalsService;
  let tx: TxRunner;
  let salt: string;

  beforeAll(async () => {
    world = await World.start({ worker: false });
    auth = world.app.get(AuthService, { strict: false });
    signals = world.app.get(IdentitySignalsService, { strict: false });
    tx = world.app.get(TxRunner, { strict: false });
    salt = world.testApp.config.IP_HASH_SALT;
  });

  afterAll(async () => {
    await world.close();
  });

  const githubId = (): number => 2_000_000_000 + Math.floor(Math.random() * 100_000_000);
  const github = (id: number, login = `gh-${id}`) => ({ id, login }) as never;

  it('locks an active user for a join and reports github id and consent', async () => {
    const id = githubId();
    const user = await world.createUser('joiner', { github: github(id) });
    const eligibility = await tx.run(() => auth.lockUserForJoin(user.id));
    expect(eligibility).toEqual({
      userId: user.id,
      status: 'active',
      githubUserId: id,
      consentValid: true,
    });
  });

  it('reports a missing consent and a user without github as null', async () => {
    const user = await world.createUser('no-consent', { consent: false });
    const eligibility = await tx.run(() => auth.lockUserForJoin(user.id));
    expect(eligibility.githubUserId).toBeNull();
    expect(eligibility.consentValid).toBe(false);
    expect(await auth.hasValidConsent(user.id)).toBe(false);
  });

  it('refuses to lock an unknown user with 404 and a deleting user with 409', async () => {
    const deleting = await world.createUser('leaving', { status: 'deleting' });
    const missing = await tx.run(() => auth.lockUserForJoin(randomUUID())).catch((e: unknown) => e);
    expect(missing).toMatchObject({ code: 'NOT_FOUND', status: 404 });
    const inactive = await tx.run(() => auth.lockUserForJoin(deleting.id)).catch((e: unknown) => e);
    expect(inactive).toBeInstanceOf(DomainError);
    expect(inactive).toMatchObject({ code: 'USER_INACTIVE', status: 409 });
  });

  it('returns the identity of a user and null for an unknown id', async () => {
    const id = githubId();
    const user = await world.createUser('identity', { github: github(id, 'octo') });
    expect(await auth.getIdentity(user.id)).toEqual({
      githubUserId: id,
      githubLogin: 'octo',
      status: 'active',
    });
    expect(await auth.getIdentity(randomUUID())).toBeNull();
  });

  it('maps github ids to user ids, skipping unknown ids, and short-circuits an empty list', async () => {
    const id = githubId();
    const user = await world.createUser('mapped', { github: github(id) });
    expect(await auth.findUserIdsByGithubIds([])).toEqual(new Map());
    const found = await auth.findUserIdsByGithubIds([id, id + 1]);
    expect(found).toEqual(new Map([[id, user.id]]));
  });

  it('treats only an active admin as an admin', async () => {
    const admin = await world.createUser('boss', { admin: true });
    const plain = await world.createUser('plain');
    const fired = await world.createUser('fired-admin', { admin: true, status: 'deleting' });
    expect(await auth.isAdmin(admin.id)).toBe(true);
    expect(await auth.isAdmin(plain.id)).toBe(false);
    expect(await auth.isAdmin(fired.id)).toBe(false);
    expect(await auth.isAdmin(randomUUID())).toBe(false);
  });

  it('records ip24 and ua signals as HMACs and reads them back since a moment', async () => {
    const user = await world.createUser('signals');
    await signals.record(user.id, '198.51.100.9', 'Mozilla/5.0 test');
    await signals.record(user.id, '198.51.100.200', 'Mozilla/5.0 test');
    const since = new Date(Date.now() - 60_000);
    const got = await auth.getIdentitySignals([user.id], since);
    expect(got).toHaveLength(2);
    expect(got).toContainEqual({
      userId: user.id,
      kind: 'ip24',
      valueHmac: hmacBytes(salt, '198.51.100.0/24').toString('hex'),
    });
    expect(got).toContainEqual({
      userId: user.id,
      kind: 'ua',
      valueHmac: hmacBytes(salt, 'Mozilla/5.0 test').toString('hex'),
    });
    expect(await auth.getIdentitySignals([user.id], new Date(Date.now() + 60_000))).toEqual([]);
    expect(await auth.getIdentitySignals([], since)).toEqual([]);
  });

  it('writes nothing when neither a valid ip nor a user agent is given', async () => {
    const user = await world.createUser('nosignals');
    await signals.record(user.id, 'garbage', '');
    await signals.record(user.id, null, undefined);
    expect(await auth.getIdentitySignals([user.id], new Date(0))).toEqual([]);
  });

  it('records only the user agent when the ip is missing', async () => {
    const user = await world.createUser('ua-only');
    await signals.record(user.id, undefined, 'curl/8');
    const got = await auth.getIdentitySignals([user.id], new Date(0));
    expect(got.map((s) => s.kind)).toEqual(['ua']);
  });

  async function addTombstone(kind: string, value: string, expiresInMs: number): Promise<void> {
    await world.sql`
      INSERT INTO auth.identity_tombstone (kind, value_hmac, deleted_at, expires_at)
      VALUES (${kind}, ${hmacBytes(salt, value)}, now(), ${new Date(Date.now() + expiresInMs)})`;
  }

  it('matches a tombstone by github id or by normalized e-mail, but not an expired one', async () => {
    const id = githubId();
    const byGithub = await world.createUser('tomb-gh', { github: github(id) });
    await addTombstone('github_user_id', String(id), 3_600_000);
    expect(await auth.matchesTombstone(byGithub.id)).toBe(true);

    const byMail = await world.createUser('tomb-mail');
    await addTombstone('email_normalized', byMail.email.toLowerCase(), 3_600_000);
    expect(await auth.matchesTombstone(byMail.id)).toBe(true);

    const expired = await world.createUser('tomb-old');
    await addTombstone('email_normalized', expired.email.toLowerCase(), -1000);
    expect(await auth.matchesTombstone(expired.id)).toBe(false);
  });

  it('does not match a tombstone for a clean user, an unknown id or a user without identifiers', async () => {
    const clean = await world.createUser('tomb-clean');
    expect(await auth.matchesTombstone(clean.id)).toBe(false);
    expect(await auth.matchesTombstone(randomUUID())).toBe(false);
    await world.sql`UPDATE auth."user" SET email = NULL, email_normalized = NULL WHERE id = ${clean.id}`;
    expect(await auth.matchesTombstone(clean.id)).toBe(false);
  });
});
