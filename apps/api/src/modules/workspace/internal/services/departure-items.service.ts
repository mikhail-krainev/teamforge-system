import { Inject, Injectable } from '@nestjs/common';
import type { DepartureItemsPort } from '../../../teams/public.js';
import { ItemRepository } from '../repositories/item.repository.js';

/** `DepartureItemsPort` of workspace (FR-TEAM-13): the list "tasks without an executor" of a departure. */
@Injectable()
export class DepartureItemsService implements DepartureItemsPort {
  constructor(@Inject(ItemRepository) private readonly items: ItemRepository) {}

  async unassignedItemIds(teamId: string, userIds: string[]): Promise<Map<string, string[]>> {
    const byUser = new Map<string, string[]>();
    for (const { id, userId } of await this.items.orphanedBy(teamId, userIds)) {
      byUser.set(userId, [...(byUser.get(userId) ?? []), id]);
    }
    return byUser;
  }
}
