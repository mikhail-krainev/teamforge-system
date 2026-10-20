/**
 * A small valid playbook for the unit tests of the loader (3 stages, 28 days, one pm step with a fallback,
 * the release step in the last stage). Built as an object so that a test changes one field and serializes
 * the result as JSON (JSON is YAML), instead of editing text.
 */
export type Json = Record<string, unknown>;

const SOURCE = 'https://scrumguides.org/scrum-guide.html';

const startStage = (): Json => ({
  key: 'mini_s1',
  title: 'Старт',
  goal: 'Договориться о цели.',
  duration_days: 7,
  exit_criteria: 'Обязательные шаги выполнены.',
  steps: [
    {
      key: 'mini_kickoff',
      title: 'Kickoff',
      description: 'Созвон команды.',
      type: 'ritual',
      ritual_kind: 'call',
      required: true,
      owner_role: 'any',
      fallback: null,
      review_checklist: false,
      auto_checks: ['ritual_fields'],
      sources: [SOURCE],
    },
    {
      key: 'mini_charter',
      title: 'Устав',
      description: 'Документ с целью и ролями.',
      type: 'artifact',
      submission: 'file',
      required: true,
      owner_role: 'pm',
      alt_roles: ['ba'],
      fallback: {
        title: 'Устав по шаблону',
        instruction: 'Заполнить шаблон.',
        template: 'tpl_charter',
      },
      review_checklist: true,
      review_items: ['Записаны no-gos?', 'Указан appetite?'],
      auto_checks: ['file_ok', 'link_https'],
      sources: [SOURCE],
    },
  ],
});

const designStage = (): Json => ({
  key: 'mini_s2',
  title: 'Дизайн',
  goal: 'Сделать прототип.',
  duration_days: 14,
  exit_criteria: 'Прототип готов.',
  steps: [
    {
      key: 'mini_design',
      title: 'Прототип',
      description: 'Файл с прототипом.',
      type: 'artifact',
      submission: 'either',
      required: true,
      owner_role: 'frontend',
      fallback: {
        title: 'Прототип по шаблону',
        instruction: 'Взять готовый UI-кит.',
        template: 'tpl_ui_kit_guide',
        url: 'https://example.com/kit',
      },
      review_checklist: false,
      auto_checks: ['file_ok'],
      sources: [SOURCE],
    },
  ],
});

const releaseStage = (): Json => ({
  key: 'mini_s3',
  title: 'Релиз',
  goal: 'Выпустить.',
  duration_days: 7,
  exit_criteria: 'Релиз работает.',
  steps: [
    {
      key: 'mini_final_links',
      title: 'Релиз и репозиторий',
      description: 'Ссылки на релиз и репозиторий.',
      type: 'artifact',
      submission: 'link',
      required: true,
      owner_role: 'any',
      fallback: null,
      review_checklist: false,
      auto_checks: ['link_https', 'release_alive_web', 'repo_final'],
      sources: [SOURCE],
    },
  ],
});

export function miniFile(): Json {
  return {
    product_type: 'web_service',
    title: 'Мини-сценарий',
    version: '9.0.0',
    total_days: 28,
    stages: [startStage(), designStage(), releaseStage()],
  };
}

/** The file after `change` edited a copy of it, as text. */
export function miniText(change?: (file: Json) => void): string {
  const file = miniFile();
  change?.(file);
  return JSON.stringify(file);
}

/** Typed access to the parts the tests edit. */
export const stagesOf = (file: Json): Json[] => file.stages as Json[];

export function stepOf(file: Json, stage: number, index: number): Json {
  const steps = (stagesOf(file)[stage] as Json).steps as Json[];
  return steps[index] as Json;
}
