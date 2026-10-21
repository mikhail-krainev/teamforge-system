import type { Signal } from './facts.js';

/** One row of a rule: the helpers keep the action and the score of each kind in one place. */
export const block = (ruleCode: string, data: Record<string, unknown> = {}): Signal => ({
  ruleCode,
  action: 'block',
  score: 0,
  data,
});

export const flag = (ruleCode: string, data: Record<string, unknown> = {}): Signal => ({
  ruleCode,
  action: 'flag',
  score: 0,
  data,
});

export const scored = (
  ruleCode: string,
  score: number,
  data: Record<string, unknown> = {},
): Signal => ({ ruleCode, action: 'signal', score, data });

export const info = (ruleCode: string, data: Record<string, unknown> = {}): Signal => ({
  ruleCode,
  action: 'info',
  score: 0,
  data,
});

/** Case, outer and repeated spaces do not matter (AF-08). */
export const normalizeText = (text: string): string =>
  text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
