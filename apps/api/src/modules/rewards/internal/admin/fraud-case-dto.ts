import type { Ok } from 'shared';
import type { DisputeRow, FraudCaseRow, FraudSignalRow } from '../repositories/fraud.repository.js';

type FraudCaseDto = Ok<'getFraudCase'>;

/** A short code such as `ip24`, `pr` or a role; an identifier (it has a dash) or any text is not one. */
const CODE = /^[a-z0-9_]{1,32}$/;

/**
 * What the administrator may see of the `data` of a signal (FR-REW-16, SEC-13): numbers, flags and short codes,
 * and the SIZE of every list. A person, an address, a hash or a text never leave: deny by default.
 */
export function visibleData(data: unknown): Record<string, unknown> {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return {};
  const shown: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'number' || typeof value === 'boolean') shown[key] = value;
    else if (typeof value === 'string' && CODE.test(value)) shown[key] = value;
    else if (Array.isArray(value)) shown[`${key}Count`] = value.length;
  }
  return shown;
}

export interface CaseParts {
  teamName: string;
  signals: FraudSignalRow[];
  disputes: DisputeRow[];
}

/** The `FraudCase` of the contract: the project, the rules that fired and the disputes, nobody's id or address. */
export function toFraudCaseDto(row: FraudCaseRow, parts: CaseParts): FraudCaseDto {
  return {
    id: row.id,
    teamId: row.teamId,
    teamName: parts.teamName,
    status: row.status as FraudCaseDto['status'],
    openedAt: row.openedAt.toISOString(),
    signals: parts.signals.map((s) => ({
      ruleCode: s.ruleCode,
      score: s.score,
      action: s.action as FraudCaseDto['signals'][number]['action'],
      data: visibleData(s.data) as Record<string, never>,
    })),
    disputes: parts.disputes.map((d) => ({ text: d.text, createdAt: d.createdAt.toISOString() })),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    comment: row.comment,
  };
}
