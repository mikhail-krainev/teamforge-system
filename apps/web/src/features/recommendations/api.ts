import type { Schema } from 'shared';
import { apiClient } from '@/lib/api/client';

export type TeamRecommendation = Schema<'TeamRecommendation'>;
export type CandidateRecommendation = Schema<'CandidateRecommendation'>;
export type MatchReasons = Schema<'MatchReasons'>;

type Client = typeof apiClient;

export const RECOMMENDATIONS_PAGE = 10;
export const RECOMMENDATIONS_ROOT = ['recommendations'] as const;
export const RECOMMENDED_TEAMS_KEY = ['recommendations', 'teams'] as const;
export const seatCandidatesKey = (teamId: string, seatId: string) =>
  ['recommendations', 'seat', teamId, seatId] as const;

export async function fetchRecommendedTeams(
  cursor: string | undefined,
  client: Pick<Client, 'GET'> = apiClient,
) {
  const { data } = await client.GET('/v1/me/recommended-teams', {
    params: { query: { limit: RECOMMENDATIONS_PAGE, ...(cursor ? { cursor } : {}) } },
  });
  if (!data) throw new Error('Empty recommendations response');
  return data;
}

export async function fetchSeatCandidates(
  teamId: string,
  seatId: string,
  cursor: string | undefined,
  client: Pick<Client, 'GET'> = apiClient,
) {
  const { data } = await client.GET('/v1/teams/{teamId}/seats/{seatId}/candidates', {
    params: {
      path: { teamId, seatId },
      query: { limit: RECOMMENDATIONS_PAGE, ...(cursor ? { cursor } : {}) },
    },
  });
  if (!data) throw new Error('Empty candidates response');
  return data;
}
