import { describe, expect, it } from 'vitest';
import { inviteLink, readInviteToken } from './token';

const TOKEN = 'abcdefghij0123456789ABCDEFGHIJ-_abcdefghijK';

describe('FR-TEAM-09: invitation token in the fragment', () => {
  it('reads a bare fragment and the token= form', () => {
    expect(readInviteToken(`#${TOKEN}`)).toBe(TOKEN);
    expect(readInviteToken(`#token=${TOKEN}`)).toBe(TOKEN);
  });

  it.each(['', '#', '#short', `#${TOKEN}!`, `#${'a'.repeat(65)}`, `?token=${TOKEN}`])(
    'rejects %j',
    (hash) => {
      expect(readInviteToken(hash)).toBeNull();
    },
  );

  it('builds a link that keeps the token in the fragment only', () => {
    const link = inviteLink('https://app.example', TOKEN);
    expect(link).toBe(`https://app.example/invite#${TOKEN}`);
    expect(new URL(link).search).toBe('');
  });
});
