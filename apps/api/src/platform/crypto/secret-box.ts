import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.js';

const VERSION = 'v1';

function keyBytes(value: string): Buffer {
  return /^[0-9a-fA-F]{64}$/.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
}

/**
 * AES-256-GCM with `DATA_ENCRYPTION_KEY` (architecture 13.8). Format `v1:<iv>:<ciphertext>:<tag>`,
 * all base64url; the version prefix leaves room for key rotation. Used for data that has to wait in
 * Redis (mail jobs) without being readable there.
 */
@Injectable()
export class SecretBox {
  private readonly key: Buffer;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.key = keyBytes(config.DATA_ENCRYPTION_KEY);
  }

  seal(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [VERSION, iv, body, cipher.getAuthTag()]
      .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
      .join(':');
  }

  /** Throws when the value was not produced by `seal` with this key. */
  open(sealed: string): string {
    const [version, iv, body, tag] = sealed.split(':');
    if (version !== VERSION || iv === undefined || body === undefined || tag === undefined) {
      throw new Error('Unsupported sealed value');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(body, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}

/** HMAC-SHA-256 of a value with `IP_HASH_SALT` (architecture 5.2 SEC-13), as raw bytes. */
export function hmacBytes(salt: string, value: string): Buffer {
  return createHmac('sha256', salt).update(value).digest();
}
