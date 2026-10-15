import { describe, expect, it } from 'vitest';
import {
  hashInvitationToken,
  inviteeHint,
  isAddressee,
  isUsable,
  newInvitationToken,
  shownStatus,
} from './invitation-rules.js';

const NOW = new Date('2026-01-10T00:00:00Z');
const later = new Date(NOW.getTime() + 1000);
const earlier = new Date(NOW.getTime() - 1000);

describe('invitation token', () => {
  it('is 43 base64url characters and differs every time', () => {
    const [a, b] = [newInvitationToken(), newInvitationToken()];
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it('is stored as SHA-256 (32 bytes), deterministic', () => {
    expect(hashInvitationToken('x')).toHaveLength(32);
    expect(hashInvitationToken('x').equals(hashInvitationToken('x'))).toBe(true);
    expect(hashInvitationToken('x').equals(hashInvitationToken('y'))).toBe(false);
  });
});

describe('isAddressee', () => {
  const open = { inviteeGithubUserId: null, inviteeEmailHmac: null };
  const holder = { githubUserId: 7, emailHmac: Buffer.from('aa', 'hex') };

  it('lets anyone take a link invitation', () => {
    expect(isAddressee(open, { githubUserId: null, emailHmac: null })).toBe(true);
  });

  it('compares the GitHub id exactly', () => {
    expect(isAddressee({ ...open, inviteeGithubUserId: 7 }, holder)).toBe(true);
    expect(isAddressee({ ...open, inviteeGithubUserId: 8 }, holder)).toBe(false);
    expect(
      isAddressee({ ...open, inviteeGithubUserId: 7 }, { ...holder, githubUserId: null }),
    ).toBe(false);
  });

  it('compares the e-mail HMAC and refuses an account without an address', () => {
    expect(isAddressee({ ...open, inviteeEmailHmac: Buffer.from('aa', 'hex') }, holder)).toBe(true);
    expect(isAddressee({ ...open, inviteeEmailHmac: Buffer.from('bb', 'hex') }, holder)).toBe(
      false,
    );
    expect(
      isAddressee(
        { ...open, inviteeEmailHmac: Buffer.from('aa', 'hex') },
        { ...holder, emailHmac: null },
      ),
    ).toBe(false);
    expect(isAddressee({ ...open, inviteeEmailHmac: Buffer.from('aabb', 'hex') }, holder)).toBe(
      false,
    );
  });
});

describe('status', () => {
  it('is usable only while active and before expiry', () => {
    expect(isUsable({ status: 'active', expiresAt: later }, NOW)).toBe(true);
    expect(isUsable({ status: 'active', expiresAt: NOW }, NOW)).toBe(false);
    expect(isUsable({ status: 'used', expiresAt: later }, NOW)).toBe(false);
    expect(isUsable({ status: 'revoked', expiresAt: later }, NOW)).toBe(false);
  });

  it('shows an overdue active invitation as expired', () => {
    expect(shownStatus({ status: 'active', expiresAt: earlier }, NOW)).toBe('expired');
    expect(shownStatus({ status: 'active', expiresAt: later }, NOW)).toBe('active');
    expect(shownStatus({ status: 'used', expiresAt: earlier }, NOW)).toBe('used');
  });
});

describe('inviteeHint', () => {
  it('shows the login, the word email, or nothing', () => {
    expect(inviteeHint({ inviteeGithubLogin: 'octo', inviteeEmailHmac: null })).toBe('octo');
    expect(inviteeHint({ inviteeGithubLogin: null, inviteeEmailHmac: Buffer.alloc(32) })).toBe(
      'email',
    );
    expect(inviteeHint({ inviteeGithubLogin: null, inviteeEmailHmac: null })).toBeNull();
  });
});
