/** C-38: the interval of the `matching-auto-add` run; pairs found within one window are "simultaneous". */
export const AUTO_ADD_WINDOW_MS = 60_000;

/** A pair "application role x open seat" that passed the filters and the threshold (C-45). */
export interface AutoAddPair {
  seatId: string;
  teamId: string;
  roleCode: string;
  /** Priority of the role in the application, 1 is the highest. */
  priority: number;
  score: number;
  /** Last time the seat was opened; null when unknown. */
  openedAt: Date | null;
  /** When the role was added to the application. */
  addedAt: Date;
}

/** Number of the run window a moment falls into. */
export function windowOf(at: Date): number {
  return Math.floor(at.getTime() / AUTO_ADD_WINDOW_MS);
}

/** FR-MATCH-06: the pair became possible when both the seat and the role existed. */
export function matchPossibleAt(openedAt: Date | null, addedAt: Date): Date {
  return openedAt === null || openedAt < addedAt ? addedAt : openedAt;
}

type SortKey = readonly [window: number, priority: number, negScore: number, openedAt: number];

function compareKeys(a: SortKey, b: SortKey): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3];
}

function keyOf(pair: AutoAddPair): SortKey {
  const possible = matchPossibleAt(pair.openedAt, pair.addedAt);
  return [windowOf(possible), pair.priority, -pair.score, (pair.openedAt ?? possible).getTime()];
}

/**
 * Order in which the pairs of one application are tried (architecture 6.4 step 2):
 * `(window(match_possible_at), priority, -score, seat.opened_at, seat_id)`. An earlier window wins
 * whatever the priority; inside one window the role with the smaller priority number wins.
 */
export function orderPairs<T extends AutoAddPair>(pairs: readonly T[]): T[] {
  return pairs
    .map((pair) => ({ pair, key: keyOf(pair) }))
    .sort((a, b) => {
      const byKey = compareKeys(a.key, b.key);
      if (byKey !== 0) return byKey;
      return a.pair.seatId < b.pair.seatId ? -1 : a.pair.seatId > b.pair.seatId ? 1 : 0;
    })
    .map((entry) => entry.pair);
}

/** Applications are served by `enqueued_at` (who waits longer first), then by id (step 3). */
export function compareApplications(
  a: { id: string; enqueuedAt: Date },
  b: { id: string; enqueuedAt: Date },
): number {
  const byTime = a.enqueuedAt.getTime() - b.enqueuedAt.getTime();
  if (byTime !== 0) return byTime;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
