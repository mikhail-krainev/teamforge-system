import { t } from '@/i18n';
import type { Playbook, PlaybookStep, ProjectStage } from './api';

const STAGE_PREFIX = /^этап\s*\d/i;

/** "Этап 2. Разработка": playbook titles usually carry the prefix already; add it when they do not. */
export function stageTitle(stage: Pick<ProjectStage, 'ordinal' | 'title'>): string {
  return STAGE_PREFIX.test(stage.title)
    ? stage.title
    : t('route.stageTitle', { ordinal: stage.ordinal, title: stage.title });
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('ru-RU');
}

export function sortedStages(stages: readonly ProjectStage[]): ProjectStage[] {
  return [...stages].sort((a, b) => a.ordinal - b.ordinal);
}

export function currentStage(stages: readonly ProjectStage[]): ProjectStage | undefined {
  return stages.find((stage) => stage.status === 'open');
}

/** The next stage after `ordinal`, or `undefined` for the last one (completion is another flow). */
export function nextStage(
  stages: readonly ProjectStage[],
  ordinal: number,
): ProjectStage | undefined {
  return sortedStages(stages).find((stage) => stage.ordinal > ordinal);
}

/** Whole calendar timestamp check used for the project-level warning. */
export function isPastDate(iso: string | null | undefined, now: Date): boolean {
  return Boolean(iso) && new Date(iso as string).getTime() < now.getTime();
}

/** Steps of the playbook stage with the same ordinal, by step key. */
export function stepsByKey(
  playbook: Playbook | undefined,
  ordinal: number,
): ReadonlyMap<string, PlaybookStep> {
  const stage = playbook?.stages.find((s) => s.ordinal === ordinal);
  return new Map((stage?.steps ?? []).map((step) => [step.key, step]));
}

export function parseOrdinal(raw: string): number | null {
  return /^[1-9]\d{0,2}$/.test(raw) ? Number(raw) : null;
}

const STAGE_TONES = ['yellow', 'blue', 'green'] as const;

/** Candy colour of a stage block: idea yellow, development blue, release green; then repeat. */
export function stageTone(ordinal: number): (typeof STAGE_TONES)[number] {
  return STAGE_TONES[(Math.max(ordinal, 1) - 1) % STAGE_TONES.length] ?? 'yellow';
}
