import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem, type ProblemBody } from '../../../../test/fixtures/assertions.js';
import {
  adminOf,
  brokenPlaybookYaml,
  miniMutated,
  miniPlaybookYaml,
  uploadPlaybookText,
  type BrokenName,
} from '../../../../test/fixtures/playbooks.js';
import type { UserFixture } from '../../../../test/fixtures/index.js';
import { World } from '../../../../test/fixtures/world.js';
import { describeInfra } from '../../../../test/helpers/infra.js';

/*
 * S5-01: 422 PLAYBOOK_INVALID with the full errors[] list (JSON Pointer into the uploaded file, FR-PLAY-02)
 * and the YAML attacks of docs/architecture.md 11.1 (aliases, tags, size). A pointer is a path into the FILE
 * (snake_case keys of docs/playbooks.md 2.1), not into the response schema. Every case uses a version no
 * playbook of web_service has, but a rejected file stores nothing, so versions can repeat.
 */

describeInfra(
  'S5 playbooks: PLAYBOOK_INVALID and unsafe YAML (FR-PLAY-02, SEC)',
  ['db', 'redis'],
  () => {
    let world: World;
    let admin: UserFixture;

    beforeAll(async () => {
      world = await World.start({ worker: false });
      await world.ensureCatalog(['pm', 'ba', 'backend', 'frontend', 'qa']);
      admin = await adminOf(world);
    });

    afterAll(async () => {
      if (!world) return;
      await world.close();
    });

    const rejected = async (text: string, contentType?: string): Promise<ProblemBody> => {
      const response = await uploadPlaybookText(
        world,
        admin,
        text,
        contentType ? { contentType } : {},
      );
      const body = expectProblem('uploadPlaybook', response, 422, 'PLAYBOOK_INVALID');
      expect(Array.isArray(body.errors)).toBe(true);
      expect((body.errors ?? []).length).toBeGreaterThan(0);
      for (const error of body.errors ?? []) {
        expect(error.pointer === '' || error.pointer.startsWith('/')).toBe(true);
        expect(error.message.length).toBeGreaterThan(0);
      }
      return body;
    };

    const pointersOf = (body: ProblemBody): string[] => (body.errors ?? []).map((e) => e.pointer);

    const stored = async (): Promise<number> => {
      const rows = await world.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM playbooks.playbook`;
      return rows[0]?.n ?? Number.NaN;
    };

    describe('one rule at a time (FR-PLAY-02)', () => {
      const CASES: { rule: string; from: string; to: string; pointer: string }[] = [
        {
          rule: 'total_days is not the sum of duration_days',
          from: 'total_days: 28',
          to: 'total_days: 30',
          pointer: '/total_days',
        },
        {
          rule: 'duration_days is not a positive integer (0)',
          from: '    duration_days: 14\n',
          to: '    duration_days: 0\n',
          pointer: '/stages/1/duration_days',
        },
        {
          rule: 'duration_days is not an integer (1.5)',
          from: '    duration_days: 14\n',
          to: '    duration_days: 1.5\n',
          pointer: '/stages/1/duration_days',
        },
        {
          rule: 'a step with owner_role other than any has no fallback',
          from: '        owner_role: backend\n        alt_roles: []\n        fallback:\n          title: "Спецификация по шаблону"\n          instruction: "Заполнить шаблон мини design doc."\n          template: tpl_design_doc\n',
          to: '        owner_role: backend\n        alt_roles: []\n        fallback: null\n',
          pointer: '/stages/0/steps/3/fallback',
        },
        {
          rule: 'a step with owner_role any has a fallback',
          from: '        owner_role: any\n        fallback: null\n        review_checklist: false\n        auto_checks: ["link_https"]\n        sources:\n          - "https://kanbanguides.org/english/"\n',
          to: '        owner_role: any\n        fallback:\n          title: "Лишний"\n          instruction: "Не нужен."\n          template: tpl_retro\n        review_checklist: false\n        auto_checks: ["link_https"]\n        sources:\n          - "https://kanbanguides.org/english/"\n',
          pointer: '/stages/0/steps/1/fallback',
        },
        {
          rule: 'owner_role is not in the role catalog',
          from: '        owner_role: frontend\n',
          to: '        owner_role: wizard\n',
          pointer: '/stages/1/steps/0/owner_role',
        },
        {
          rule: 'alt_roles contains a role that is not in the catalog',
          from: '        alt_roles: ["ba"]\n',
          to: '        alt_roles: ["sorcerer"]\n',
          pointer: '/stages/0/steps/2/alt_roles/0',
        },
        {
          rule: 'alt_roles contains owner_role',
          from: '        alt_roles: ["ba"]\n',
          to: '        alt_roles: ["pm"]\n',
          pointer: '/stages/0/steps/2/alt_roles/0',
        },
        {
          rule: 'the fallback template is not in the catalog of platform templates',
          from: 'template: tpl_charter',
          to: 'template: tpl_no_such_template',
          pointer: '/stages/0/steps/2/fallback/template',
        },
        {
          rule: 'a step key repeats within the playbook',
          from: 'key: mini_retro',
          to: 'key: mini_design',
          pointer: '/stages/1/steps/1/key',
        },
        {
          rule: 'a stage key repeats',
          from: 'key: mini_s3',
          to: 'key: mini_s1',
          pointer: '/stages/2/key',
        },
        {
          rule: 'sources of a step is empty',
          from: '        sources:\n          - "https://kanbanguides.org/english/"\n',
          to: '        sources: []\n',
          pointer: '/stages/0/steps/1/sources',
        },
        {
          rule: 'submission is set on a ritual',
          from: '        ritual_kind: call\n',
          to: '        ritual_kind: call\n        submission: link\n',
          pointer: '/stages/0/steps/0/submission',
        },
        {
          rule: 'ritual_kind is set on an artifact',
          from: '        submission: link\n        required: true\n        owner_role: any\n        fallback: null\n        review_checklist: false\n        auto_checks: ["link_https"]\n        sources:\n          - "https://kanbanguides.org/english/"\n',
          to: '        submission: link\n        ritual_kind: call\n        required: true\n        owner_role: any\n        fallback: null\n        review_checklist: false\n        auto_checks: ["link_https"]\n        sources:\n          - "https://kanbanguides.org/english/"\n',
          pointer: '/stages/0/steps/1/ritual_kind',
        },
        {
          rule: 'review_checklist is true without review_items',
          from: '        review_items:\n          - "Записаны цели и не-цели?"\n          - "Описаны альтернативы?"\n          - "Указаны риски?"\n',
          to: '',
          pointer: '/stages/0/steps/3/review_items',
        },
        {
          rule: 'review_items are given while review_checklist is false',
          from: '        review_checklist: false\n        auto_checks: ["ritual_fields"]\n        sources:\n          - "https://scrumguides.org/scrum-guide.html"\n      - key: mini_board',
          to: '        review_checklist: false\n        review_items:\n          - "Лишний пункт?"\n        auto_checks: ["ritual_fields"]\n        sources:\n          - "https://scrumguides.org/scrum-guide.html"\n      - key: mini_board',
          pointer: '/stages/0/steps/0/review_items',
        },
        {
          rule: 'auto_checks has a key that is not in the catalog (docs/playbooks.md 2.4)',
          from: 'auto_checks: ["file_ok", "link_https"]',
          to: 'auto_checks: ["file_ok", "link_https", "magic_check"]',
          pointer: '/stages/0/steps/4/auto_checks/2',
        },
      ];

      it.each(CASES)(
        'FR-PLAY-02: $rule -> 422 with the pointer $pointer',
        async ({ from, to, pointer }) => {
          const before = await stored();
          const body = await rejected(miniMutated(from, to));
          expect(pointersOf(body)).toContain(pointer);
          expect(await stored()).toBe(before);
        },
      );

      it('FR-PLAY-02: a stage without any obligatory artifact -> 422 (errors point into that stage)', async () => {
        // stage 2: the only obligatory artifact (mini_design) becomes optional
        const text = miniMutated(
          '        submission: file\n        required: true\n        owner_role: frontend\n',
          '        submission: file\n        required: false\n        owner_role: frontend\n',
        );
        const body = await rejected(text);
        expect(pointersOf(body).some((p) => p === '/stages/1' || p.startsWith('/stages/1/'))).toBe(
          true,
        );
      });

      it('FR-PLAY-02: the last stage without an obligatory step with a link to the release and the repository -> 422', async () => {
        const text = miniMutated(
          'auto_checks: ["link_https", "release_alive_web", "repo_final"]',
          'auto_checks: ["link_https"]',
        );
        const body = await rejected(text);
        expect(pointersOf(body).some((p) => p === '/stages/2' || p.startsWith('/stages/2/'))).toBe(
          true,
        );
      });

      it('FR-PLAY-02: product_type, title, version and stages are required; a version that is not semver is refused', async () => {
        const body = await rejected(miniMutated('version: "9.0.0"', 'version: "nine"'));
        expect(pointersOf(body)).toContain('/version');
        const missing = await rejected(miniMutated('title: "Мини-сценарий"\n', ''));
        expect(pointersOf(missing)).toContain('/title');
      });
    });

    describe('the full list, not only the first error (S5-02 check)', () => {
      it('FR-PLAY-02: a file with several violations returns all of them in one answer', async () => {
        const body = await rejected(brokenPlaybookYaml('many-errors'));
        const pointers = pointersOf(body);
        for (const expected of [
          '/total_days',
          '/stages/0/steps/0/fallback',
          '/stages/0/steps/0/auto_checks/1',
          '/stages/0/steps/1/key',
          '/stages/0/steps/1/owner_role',
          '/stages/0/steps/1/fallback/template',
          '/stages/0/steps/1/sources',
        ]) {
          expect(pointers, expected).toContain(expected);
        }
        expect(new Set(pointers).size).toBe(pointers.length);
      });

      it('FR-PLAY-02: a duplicate stage key and a duplicate step key are both reported', async () => {
        const body = await rejected(brokenPlaybookYaml('duplicate-keys'));
        expect(pointersOf(body)).toEqual(
          expect.arrayContaining(['/stages/1/key', '/stages/0/steps/1/key']),
        );
      });

      it('FR-PLAY-02: an unknown owner role and an unknown alt role are reported with pointers', async () => {
        const body = await rejected(brokenPlaybookYaml('unknown-role'));
        expect(pointersOf(body)).toEqual(
          expect.arrayContaining(['/stages/0/steps/1/owner_role', '/stages/0/steps/1/alt_roles/0']),
        );
      });

      it('FR-PLAY-08: an unknown auto check is reported with the pointer of that list item', async () => {
        const body = await rejected(brokenPlaybookYaml('unknown-check'));
        expect(pointersOf(body)).toContain('/stages/0/steps/0/auto_checks/1');
      });

      it('FR-PLAY-02: a repeated key inside one mapping (title twice) -> 422, not "the last one wins"', async () => {
        await rejected(brokenPlaybookYaml('duplicate-map-key'));
      });
    });

    describe('safe parsing (schema core, no tags, maxAliasCount 0, up to 1 MB)', () => {
      const ATTACKS: BrokenName[] = ['yaml-anchors', 'yaml-bomb', 'yaml-tags'];

      it.each(ATTACKS)('SEC: %s -> 422 PLAYBOOK_INVALID, nothing stored', async (name) => {
        const before = await stored();
        await rejected(brokenPlaybookYaml(name));
        expect(await stored()).toBe(before);
      });

      it('SEC: the alias bomb is answered quickly and does not grow the process memory (no expansion)', async () => {
        const startedAt = Date.now();
        const heapBefore = process.memoryUsage().heapUsed;
        await rejected(brokenPlaybookYaml('yaml-bomb'));
        expect(Date.now() - startedAt).toBeLessThan(5_000);
        expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(200 * 1024 * 1024);
      });

      it('SEC: a file over 1 MB is refused before parsing and stores nothing', async () => {
        const before = await stored();
        const huge = `${miniPlaybookYaml({ version: '9.50.0' })}\n# ${'x'.repeat(1024 * 1024)}\n`;
        const response = await uploadPlaybookText(world, admin, huge);
        // The contract has no 413 for this operation: the body limit gives 400 or 422.
        expect([400, 413, 422]).toContain(response.statusCode);
        expect(response.statusCode).not.toBe(201);
        expect(String(response.headers['content-type'])).toContain('application/problem+json');
        expect(await stored()).toBe(before);
      });

      it('SEC: JSON with a prototype-pollution key is refused or ignored, never merged into the playbook', async () => {
        const text = JSON.stringify({ __proto__: { polluted: true }, product_type: 'web_service' });
        const response = await uploadPlaybookText(world, admin, text, {
          contentType: 'application/json',
        });
        expect(response.statusCode).toBe(422);
        expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
      });

      it('SEC: a binary body is refused (not a valid text file) with 400 or 422', async () => {
        const response = await uploadPlaybookText(world, admin, '\u0000\u0001\u0002��', {});
        expect([400, 415, 422]).toContain(response.statusCode);
      });
    });
  },
);
