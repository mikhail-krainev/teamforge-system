const POSITIVE_INTEGER = /^[1-9]\d{0,14}$/;
const SETUP_ERROR_CODE = /^[a-z_]{1,40}$/;

/** `installation` query parameter of the page GitHub sends the browser back to; anything else is dropped. */
export function parseInstallationId(raw: string | undefined): number | null {
  return raw !== undefined && POSITIVE_INTEGER.test(raw) ? Number(raw) : null;
}

/** `error` query parameter as a safe dictionary suffix (never an arbitrary text). */
export function parseSetupError(raw: string | undefined): string | null {
  return raw !== undefined && SETUP_ERROR_CODE.test(raw) ? raw : null;
}

/** The install URL comes from the server but is navigated to, so only https is followed. */
export function safeInstallUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function githubRepositoryUrl(fullName: string): string | null {
  return /^[\w.-]+\/[\w.-]+$/.test(fullName) ? `https://github.com/${fullName}` : null;
}
