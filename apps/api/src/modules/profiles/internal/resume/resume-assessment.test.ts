import { describe, expect, it } from 'vitest';
import { assessResume } from './resume-assessment.js';
import { fitRoles } from './resume-roles.js';
import { coveredMonths, findPeriods, longestGap } from './resume-signals.js';

const NOW = new Date('2026-06-15T00:00:00Z');

const STRONG = `Иван Петров
Backend-разработчик (Node.js, TypeScript)
ivan@example.com, +7 (912) 345-67-89, t.me/ivanp
github.com/ivanp

О себе
Пишу бэкенд на Node.js. Люблю измеримые результаты и понятный код.

Опыт работы
ООО «Ромашка», Senior backend developer
март 2021 — по настоящее время
- Разработал платёжный сервис на 2 млн пользователей.
- Сократил время ответа API на 40% за счёт кэширования.
- Внедрил CI/CD, релизы ускорились в 3 раза.
- Руководил командой из 4 разработчиков.

ООО «Лютик», Backend developer
01.2018 - 02.2021
- Спроектировал миграцию на PostgreSQL, снизил затраты на 25%.
- Автоматизировал отчёты, экономия 10 часов в неделю.

Ключевые навыки
TypeScript, Node.js, PostgreSQL, Redis, Docker, Kubernetes, Kafka, NestJS

Образование
УрФУ, программная инженерия
2013 — 2017
`;

describe('resume periods', () => {
  it('reads Russian and numeric ranges, "по настоящее время" ends now', () => {
    const periods = findPeriods('март 2021 — по настоящее время\n01.2018 - 02.2021', NOW);
    expect(periods).toEqual([
      { start: 2021 * 12 + 2, end: 2026 * 12 + 5 },
      { start: 2018 * 12, end: 2021 * 12 + 1 },
    ]);
  });

  it('counts overlapping jobs once and finds the longest break', () => {
    const periods = [
      { start: 0, end: 11 },
      { start: 6, end: 17 },
      { start: 36, end: 47 },
    ];
    expect(coveredMonths(periods)).toBe(30);
    expect(longestGap(periods)).toBe(18);
  });

  it('ignores ranges that end in the future or run backwards', () => {
    expect(findPeriods('2030 - 2031\n2020 - 2019', NOW)).toEqual([]);
  });
});

describe('assessResume', () => {
  it('scores a complete resume with measured results as strong and grades it by the dates', () => {
    const result = assessResume(STRONG, 8, NOW);
    expect(result.level).toBe('strong');
    expect(result.score).toBeGreaterThanOrEqual(80);
    // 2018-01..2021-02 and 2021-03..2026-06, education dates are not work.
    expect(result.experienceMonths).toBe(102);
    expect(result.seniority).toBe('lead');
    expect(result.redFlags).toEqual([]);
    expect(result.criteria.map((criterion) => criterion.code)).toEqual([
      'structure',
      'achievements',
      'experience',
      'skills',
      'readability',
    ]);
    expect(result.criteria.reduce((sum, criterion) => sum + criterion.max, 0)).toBe(100);
  });

  it('screens out a short resume of clichés without contacts', () => {
    const text = 'Ответственный, коммуникабельный, стрессоустойчивый. Быстро обучаюсь.';
    const result = assessResume(text, 0, NOW);
    expect(result.level).toBe('weak');
    expect(result.seniority).toBe('intern');
    expect(result.redFlags).toEqual(
      expect.arrayContaining(['no_contacts', 'cliches', 'too_short']),
    );
    expect(result.tips).toEqual(
      expect.arrayContaining(['add_contacts', 'quantify_results', 'replace_cliches']),
    );
  });

  it('flags job hopping and long breaks between jobs', () => {
    const text = [
      'Опыт работы',
      'янв 2019 - июн 2019',
      'июл 2019 - дек 2019',
      'янв 2022 - май 2022',
    ].join('\n');
    const result = assessResume(text, 0, NOW);
    expect(result.redFlags).toEqual(expect.arrayContaining(['job_hopping', 'employment_gap']));
    expect(result.experienceMonths).toBe(17);
    expect(result.seniority).toBe('junior');
  });

  it('gives a student with own projects some experience points', () => {
    const text = 'Проекты\nTodo-приложение на React';
    const experience = assessResume(text, 1, NOW).criteria.find(
      (criterion) => criterion.code === 'experience',
    );
    expect(experience?.points).toBe(5);
  });

  it('concludes the best fitting role and lists the strengths of a strong resume', () => {
    const result = assessResume(STRONG, 8, NOW);
    expect(result.roles[0]?.code).toBe('backend');
    expect(result.roles.length).toBeLessThanOrEqual(3);
    expect(result.strengths).toEqual(
      expect.arrayContaining([
        'measurable_results',
        'result_oriented',
        'solid_experience',
        'leadership',
        'broad_stack',
        'portfolio_links',
        'complete_structure',
        'stable_career',
      ]),
    );
    expect(result.weaknesses).toEqual([]);
  });

  it('reads the desired position in the first lines as the strongest role signal', () => {
    const text = 'Анна Смирнова\nUI/UX дизайнер\nFigma, прототипирование, дизайн-системы';
    expect(fitRoles(text)[0]?.code).toBe('designer');
    expect(fitRoles('Люблю котов и путешествия')).toEqual([]);
  });

  it('lists the holes of a thin resume: stop factors and missing parts', () => {
    const result = assessResume('Ответственный, коммуникабельный, стрессоустойчивый.', 0, NOW);
    expect(result.strengths).toEqual([]);
    expect(result.weaknesses).toEqual(
      expect.arrayContaining([
        'no_contacts',
        'cliches',
        'no_position',
        'no_experience',
        'no_skills',
        'few_results',
        'no_links',
      ]),
    );
  });

  it('never leaves the 0..100 range', () => {
    const result = assessResume('', 0, NOW);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });
});
