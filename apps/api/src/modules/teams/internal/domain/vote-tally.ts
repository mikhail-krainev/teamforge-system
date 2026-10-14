import { isMajority } from './leader-vote-machine.js';

/** A candidate on the ballot with the votes that count for the current decision. */
export interface CandidateScore {
  userId: string;
  /** `vote_eligible.joined_at`: the seniority in the team. */
  joinedAt: Date;
  /**
   * Orders two members who joined within the same millisecond: the id of the membership row
   * (a UUIDv7, so it follows the order of joining). Empty when the member has left.
   */
  seniorityKey: string;
  votes: number;
  inRunoff: boolean;
}

/** Who joined the team first; the user id only makes the order total. */
export function bySeniority(a: CandidateScore, b: CandidateScore): number {
  const diff = a.joinedAt.getTime() - b.joinedAt.getTime();
  if (diff !== 0) return diff;
  return a.seniorityKey.localeCompare(b.seniorityKey) || a.userId.localeCompare(b.userId);
}

/** The candidates with the highest number of votes (empty when nobody is on the ballot). */
export function leadersOf(scores: CandidateScore[]): CandidateScore[] {
  if (scores.length === 0) return [];
  const top = Math.max(...scores.map((s) => s.votes));
  return scores.filter((s) => s.votes === top);
}

/** FR-TEAM-17: the candidate with more than N/2 of the eligible snapshot, if any. */
export function majorityHolder(
  scores: CandidateScore[],
  eligibleCount: number,
): CandidateScore | undefined {
  return scores.find((s) => isMajority(s.votes, eligibleCount));
}

/**
 * The order in which winners are asked to confirm (FR-TEAM-17, "the next one by votes"): after a
 * runoff its candidates first, then more votes, then who joined the team earlier.
 */
export function confirmationOrder(scores: CandidateScore[], round: 1 | 2): CandidateScore[] {
  return [...scores].sort((a, b) => {
    if (round === 2 && a.inRunoff !== b.inRunoff) return a.inRunoff ? -1 : 1;
    return b.votes - a.votes || bySeniority(a, b);
  });
}

export interface TieResolution {
  winner: CandidateScore;
  /** Seniority was equal too, the winner was drawn. */
  byLot: boolean;
}

/**
 * A second tie (FR-TEAM-19): the longer-serving member wins; only when nothing separates the
 * members (same moment, same membership) is the winner drawn by lot.
 */
export function resolveTie(tied: CandidateScore[], draw: (n: number) => number): TieResolution {
  const sorted = [...tied].sort(bySeniority);
  const first = sorted[0];
  if (first === undefined) throw new Error('resolveTie needs at least one candidate');
  const equal = sorted.filter(
    (s) =>
      s.joinedAt.getTime() === first.joinedAt.getTime() && s.seniorityKey === first.seniorityKey,
  );
  if (equal.length === 1) return { winner: first, byLot: false };
  return { winner: equal[draw(equal.length)] ?? first, byLot: true };
}
