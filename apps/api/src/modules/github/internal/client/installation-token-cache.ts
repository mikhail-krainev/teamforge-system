import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Clock } from '../../../../platform/clock/clock.js';
import type { SecretBox } from '../../../../platform/crypto/secret-box.js';

/** Architecture 7.5: an installation token lives an hour on GitHub, 55 minutes here. */
export const INSTALLATION_TOKEN_TTL_SECONDS = 55 * 60;
/** A cached token that expires sooner than this is not handed out. */
export const TOKEN_EXPIRY_MARGIN_MS = 60_000;
/** The `api` and `worker` ACL users may use this prefix (docker/redis/users.acl.tpl). */
export const INSTALLATION_TOKEN_PREFIX = 'gh_inst_token:';

const EXPIRES_AT_FIELD = 2;
const log = new Logger('GithubTokenCache');

/**
 * Cache of `@octokit/auth-app` (`get`/`set` of an opaque string) kept in Redis. The value holds the
 * installation token, so it is sealed with AES-256-GCM (`DATA_ENCRYPTION_KEY`); the token never goes to
 * the database. An unreadable or failing cache costs one more token request, nothing else.
 */
export class InstallationTokenCache {
  constructor(
    private readonly redis: Redis,
    private readonly box: SecretBox,
    private readonly clock: Clock,
  ) {}

  async get(key: string): Promise<string | undefined> {
    try {
      const sealed = await this.redis.get(`${INSTALLATION_TOKEN_PREFIX}${key}`);
      if (sealed === null) return undefined;
      const value = this.box.open(sealed);
      // Format of auth-app: token|createdAt|expiresAt|...
      const expiresAt = Date.parse(value.split('|')[EXPIRES_AT_FIELD] ?? '');
      return expiresAt - this.clock.now().getTime() > TOKEN_EXPIRY_MARGIN_MS ? value : undefined;
    } catch {
      log.warn('installation token cache read failed, a new token will be requested');
      return undefined;
    }
  }

  async set(key: string, value: string): Promise<void> {
    try {
      await this.redis.set(
        `${INSTALLATION_TOKEN_PREFIX}${key}`,
        this.box.seal(value),
        'EX',
        INSTALLATION_TOKEN_TTL_SECONDS,
      );
    } catch {
      log.warn('installation token cache write failed, the token is used once');
    }
  }
}
