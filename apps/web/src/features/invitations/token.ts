const TOKEN = /^[A-Za-z0-9_-]{43,64}$/;

/**
 * Reads the invitation token from a URL fragment: `#<token>` (the form the link is created in) or
 * `#token=<token>`. Returns `null` when it does not look like a token (length and charset follow the
 * contract). The fragment never reaches server logs or the Referer header.
 */
export function readInviteToken(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const value = raw.startsWith('token=') ? raw.slice('token='.length) : raw;
  return TOKEN.test(value) ? value : null;
}

/** The shareable link; the token stays in the fragment. */
export function inviteLink(origin: string, token: string): string {
  return `${origin}/invite#${token}`;
}
