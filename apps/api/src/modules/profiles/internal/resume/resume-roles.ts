/**
 * Which catalog role the resume reads as (codes of `profiles.role`, migration 0004). Each role has
 * marker words (RU and EN: titles, tools, practices); a word in the first lines, where the desired
 * position sits, weighs more. A word ending in `~` is a stem and matches any ending.
 */
const ROLE_MARKERS: Record<string, readonly string[]> = {
  pm: [
    'менеджер проект~',
    'project manager',
    'руководитель проект~',
    'scrum',
    'agile',
    'kanban',
    'jira',
    'roadmap',
    'стейкхолдер~',
    'stakeholder~',
    'delivery manager',
  ],
  frontend: [
    'frontend',
    'front-end',
    'фронтенд~',
    'react',
    'vue',
    'angular',
    'javascript',
    'html',
    'css',
    'next.js',
    'redux',
    'webpack',
    'вёрстк~',
    'верстк~',
  ],
  backend: [
    'backend',
    'back-end',
    'бэкенд~',
    'бекенд~',
    'node.js',
    'nestjs',
    'java',
    'spring',
    'django',
    'fastapi',
    'golang',
    'php',
    'laravel',
    '.net',
    'postgresql',
    'mysql',
    'redis',
    'rabbitmq',
    'rest api',
    'микросервис~',
    'microservice~',
  ],
  mobile: [
    'мобильн~',
    'mobile',
    'ios',
    'android',
    'swift',
    'swiftui',
    'kotlin',
    'flutter',
    'react native',
    'jetpack compose',
  ],
  ba: [
    'бизнес-аналитик~',
    'business analyst',
    'bpmn',
    'бизнес-процесс~',
    'business process~',
    'требовани~',
    'requirements',
    'user story',
    'use case~',
    'cjm',
  ],
  product_analyst: [
    'продуктов~ аналитик~',
    'product analyst',
    'a/b',
    'ab-тест~',
    'метрик~',
    'retention',
    'когорт~',
    'cohort~',
    'amplitude',
    'mixpanel',
    'юнит-экономик~',
    'unit-экономик~',
    'datalens',
    'tableau',
    'power bi',
    'гипотез~',
  ],
  system_analyst: [
    'системн~ аналитик~',
    'system analyst',
    'uml',
    'sequence',
    'openapi',
    'swagger',
    'интеграци~',
    'техническ~ задани~',
    'er-диаграмм~',
    'xsd',
    'json schema',
  ],
  designer: [
    'дизайнер~',
    'designer',
    'figma',
    'ui/ux',
    'ux',
    'ui',
    'прототип~',
    'prototyp~',
    'макет~',
    'photoshop',
    'illustrator',
    'дизайн-систем~',
    'design system~',
    'behance',
    'dribbble',
  ],
  ml_engineer: [
    'ml',
    'machine learning',
    'машинн~ обучени~',
    'pytorch',
    'tensorflow',
    'scikit-learn',
    'sklearn',
    'нейросет~',
    'neural',
    'nlp',
    'computer vision',
    'llm',
    'catboost',
    'xgboost',
    'data scientist',
    'kaggle',
  ],
  data_engineer: [
    'data engineer',
    'дата-инженер~',
    'data-инженер~',
    'etl',
    'elt',
    'airflow',
    'spark',
    'hadoop',
    'dwh',
    'хранилищ~ данных',
    'clickhouse',
    'dbt',
    'greenplum',
  ],
  qa: [
    'qa',
    'тестировщик~',
    'тестировани~',
    'testing',
    'автотест~',
    'autotest~',
    'selenium',
    'playwright',
    'cypress',
    'postman',
    'pytest',
    'junit',
    'тест-кейс~',
    'test case~',
    'jmeter',
  ],
  devops: [
    'devops',
    'sre',
    'docker',
    'kubernetes',
    'k8s',
    'terraform',
    'ansible',
    'ci/cd',
    'gitlab ci',
    'jenkins',
    'prometheus',
    'grafana',
    'helm',
    'nginx',
    'linux',
  ],
};

const HEAD_LINES = 8;
const HEAD_WEIGHT = 3;
const TOP_ROLES = 3;

export interface RoleFit {
  code: string;
  /** Share of all role markers found in the text, 0..100. */
  match: number;
}

const escapeRegExp = (value: string): string => value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');

function markerPattern(marker: string): RegExp {
  const isStem = marker.endsWith('~');
  const body = marker.replace(/~$/u, '').split('~ ').map(escapeRegExp).join('[\\p{L}]*\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}${isStem ? '' : '(?![\\p{L}\\p{N}])'}`, 'iu');
}

const PATTERNS: [string, RegExp[]][] = Object.entries(ROLE_MARKERS).map(([code, markers]) => [
  code,
  markers.map(markerPattern),
]);

/** The best fitting roles, best first; empty when the text names none of the markers. */
export function fitRoles(text: string): RoleFit[] {
  const head = text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .slice(0, HEAD_LINES)
    .join('\n');
  const scores = PATTERNS.map(([code, patterns]) => {
    const score = patterns.reduce(
      (sum, pattern) => sum + (pattern.test(text) ? 1 : 0) + (pattern.test(head) ? HEAD_WEIGHT : 0),
      0,
    );
    return { code, score };
  }).filter(({ score }) => score > 0);
  const total = scores.reduce((sum, { score }) => sum + score, 0);
  return scores
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_ROLES)
    .map(({ code, score }) => ({ code, match: Math.round((100 * score) / total) }));
}
