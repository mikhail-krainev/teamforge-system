import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from '../../../../platform/redis/redis.module.js';
import type { RoleDemand } from '../../public.js';
import { DEMAND_CACHE_TTL_SECONDS } from './demand-rules.js';

const PREFIX = 'demand:v1:';
const key = (roleCode: string): string => `${PREFIX}${roleCode}`;

/**
 * Redis cache of showcase rows, one key per role (`demand:v1:<role>`, the `~demand:*` ACL prefix,
 * C-39 = 60 s). Cache failures never fail a request: a read miss is a recount, a write that fails
 * is simply absent. Invalidation errors surface so the event is retried.
 */
@Injectable()
export class DemandCache {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async read(roles: string[]): Promise<Map<string, RoleDemand>> {
    const found = new Map<string, RoleDemand>();
    if (roles.length === 0) return found;
    try {
      const values = await this.redis.mget(roles.map(key));
      values.forEach((raw, i) => {
        const role = roles[i];
        if (raw === null || role === undefined) return;
        const row = JSON.parse(raw) as Omit<RoleDemand, 'computedAt'> & { computedAt: string };
        found.set(role, { ...row, computedAt: new Date(row.computedAt) });
      });
    } catch {
      return new Map();
    }
    return found;
  }

  async write(rows: RoleDemand[]): Promise<void> {
    if (rows.length === 0) return;
    try {
      const pipeline = this.redis.pipeline();
      for (const row of rows) {
        pipeline.set(key(row.roleCode), JSON.stringify(row), 'EX', DEMAND_CACHE_TTL_SECONDS);
      }
      await pipeline.exec();
    } catch {
      // the next reader recounts
    }
  }

  async invalidate(roles: string[]): Promise<void> {
    if (roles.length === 0) return;
    await this.redis.del(...roles.map(key));
  }

  /** For events that do not name a role: drops every cached row (a handful of keys, SCAN not KEYS). */
  async invalidateAll(): Promise<void> {
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', `${PREFIX}*`, 'COUNT', 200);
      cursor = next;
      if (keys.length > 0) await this.redis.del(...keys);
    } while (cursor !== '0');
  }
}
