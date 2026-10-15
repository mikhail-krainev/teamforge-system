import { Inject, Injectable } from '@nestjs/common';
import { DomainError, type FieldError } from '../../../../platform/errors/domain-error.js';
import { PROFILES_API, type ProfilesApi } from '../../../profiles/public.js';
import type { SeatInputLike } from '../domain/team-rules.js';

/**
 * Roles and stack tags of seats must exist in the profiles catalogs (422). Runs before the
 * transaction: the catalogs are reference data and are never locked by team scenarios.
 */
@Injectable()
export class SeatCatalogCheck {
  constructor(@Inject(PROFILES_API) private readonly profiles: ProfilesApi) {}

  async check(seats: readonly Pick<SeatInputLike, 'roleCode' | 'stack'>[]): Promise<void> {
    const flat = seats.flatMap((seat, seatIndex) =>
      seat.stack.map((tag, tagIndex) => ({
        tag,
        pointer: `/seats/${seatIndex}/stack/${tagIndex}`,
      })),
    );
    const errors = [...(await this.unknownRoles(seats)), ...(await this.unknownTags(flat))];
    if (errors.length > 0) throw new DomainError('VALIDATION_FAILED', 422, { errors });
  }

  /** Stack tags of a seat patch (`/stack/<i>` pointers). */
  async checkStack(stack: readonly string[]): Promise<void> {
    const flat = stack.map((tag, index) => ({ tag, pointer: `/stack/${index}` }));
    const errors = await this.unknownTags(flat);
    if (errors.length > 0) throw new DomainError('VALIDATION_FAILED', 422, { errors });
  }

  private async unknownRoles(
    seats: readonly Pick<SeatInputLike, 'roleCode'>[],
  ): Promise<FieldError[]> {
    const active = new Set((await this.profiles.listRoles()).map((role) => role.code));
    return seats.flatMap((seat, index) =>
      active.has(seat.roleCode)
        ? []
        : [
            {
              pointer: `/seats/${index}/roleCode`,
              code: 'unknown_role',
              message: 'Unknown or inactive role',
            },
          ],
    );
  }

  /** Tags are checked in one call; the pointers of the catalog check are mapped back to the request. */
  private async unknownTags(flat: { tag: string; pointer: string }[]): Promise<FieldError[]> {
    try {
      await this.profiles.assertStackTagsExist(flat.map((entry) => entry.tag));
      return [];
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== 'VALIDATION_FAILED') throw error;
      return (error.data.errors ?? []).flatMap((entry) => {
        const target = flat[Number(entry.pointer.slice(1))];
        return target === undefined
          ? []
          : [{ pointer: target.pointer, code: 'unknown_stack_tag', message: 'Unknown stack tag' }];
      });
    }
  }
}
