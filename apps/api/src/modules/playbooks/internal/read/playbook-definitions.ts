import { Inject, Injectable } from '@nestjs/common';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import type { PlaybookDefinition } from '../../public.js';
import { PlaybookReader, toDefinition } from './playbook-reader.js';

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

/**
 * `PlaybooksApi.getDefinition` (architecture 3.3): the definition of a published playbook, cached by id for
 * the life of the process. Published playbooks never change (FR-PLAY-03), so no invalidation is needed and
 * every instance caches on its own.
 */
@Injectable()
export class PlaybookDefinitions {
  private readonly cache = new Map<string, Promise<PlaybookDefinition>>();

  constructor(@Inject(PlaybookReader) private readonly reader: PlaybookReader) {}

  get(id: string): Promise<PlaybookDefinition> {
    const cached = this.cache.get(id);
    if (cached !== undefined) return cached;
    const loading = this.load(id);
    this.cache.set(id, loading);
    // A failure (unknown id, a draft, a database error) is not remembered.
    loading.catch(() => this.cache.delete(id));
    return loading;
  }

  private async load(id: string): Promise<PlaybookDefinition> {
    const row = await this.reader.findRow(id);
    if (row?.status !== 'published') throw new DomainError('NOT_FOUND', 404);
    return deepFreeze(toDefinition(await this.reader.loadTree(row)));
  }
}
