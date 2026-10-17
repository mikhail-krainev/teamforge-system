import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Json, miniFile, miniText, stagesOf, stepOf } from './mini-playbook.fixture.js';
import { MAX_SOURCE_BYTES, parsePlaybookSource } from './parse-source.js';
import type { PlaybookCatalogs } from './playbook-rules.js';
import { validatePlaybookSource } from './validate-playbook.js';

const API_ROOT = path.resolve(import.meta.dirname, '../../../../..');
const read = (...parts: string[]): string => readFileSync(path.join(API_ROOT, ...parts), 'utf8');

const ROLES = [
  'pm',
  'frontend',
  'backend',
  'mobile',
  'ba',
  'product_analyst',
  'system_analyst',
  'designer',
  'ml_engineer',
  'data_engineer',
  'qa',
  'devops',
];

/** Template keys of the migration that seeds the catalog (docs/playbooks.md 5.1). */
const TEMPLATES = [
  ...read('drizzle/0010_seed_platform_templates.sql').matchAll(/\(\$k\$(tpl_\w+)\$k\$/g),
].map((match) => match[1] as string);

const catalogs: PlaybookCatalogs = { roles: new Set(ROLES), templates: new Set(TEMPLATES) };

const validate = (text: string) => validatePlaybookSource(text, catalogs);
const mini = miniText();

function errorsOf(text: string): { pointer: string; code: string; message: string }[] {
  const result = validate(text);
  if (result.ok) throw new Error('expected the file to be rejected');
  return result.errors;
}

const pointersOf = (text: string): string[] => errorsOf(text).map((e) => e.pointer);

describe('S5-02 real playbooks of docs/playbooks.md (FR-PLAY-01, FR-PLAY-07)', () => {
  it.each([
    ['web_service', 84, 8],
    ['ml_product', 91, 8],
  ])(
    '%s: the seed file is valid, %i days, %i stages, no warnings (12-13 weeks)',
    (type, days, stages) => {
      const result = validate(read('seeds/playbooks', `${type}.yaml`));
      if (!result.ok) throw new Error(JSON.stringify(result.errors, null, 2));
      expect(result.playbook.file.product_type).toBe(type);
      expect(result.playbook.file.version).toBe('1.0.0');
      expect(result.playbook.file.total_days).toBe(days);
      expect(result.playbook.file.stages).toHaveLength(stages);
      expect(result.playbook.warnings).toEqual([]);
    },
  );

  it('the migration seeds the 35 template keys of section 5.1', () => {
    expect(TEMPLATES).toHaveLength(35);
    expect(new Set(TEMPLATES).size).toBe(35);
  });
});

describe('S5-02 a small playbook', () => {
  it('FR-PLAY-07: is valid and warns that 28 days is outside 10-16 weeks', () => {
    const result = validate(mini);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.playbook.warnings.map((w) => w.code)).toEqual(['total_days_out_of_range']);
    }
  });

  it('FR-PLAY-05: keeps the text as uploaded and its SHA-256', () => {
    const result = validate(mini);
    expect(result.ok && result.playbook.sourceText).toBe(mini);
    expect(result.ok && result.playbook.sourceSha256).toHaveLength(32);
  });

  it('YAML flow style, quotes and comments are fine', () => {
    const yaml = `# comment\n${JSON.stringify(miniFile(), null, 2).replace(/"([a-z_]+)":/g, '$1:')}`;
    expect(validate(yaml).ok).toBe(true);
  });
});

describe('S5-02 broken fixtures give the full list of errors (FR-PLAY-02)', () => {
  const broken = (name: string): string => read('test/fixtures/playbooks/broken', `${name}.yaml`);

  it('several violations in one file are all reported, each pointer once', () => {
    const pointers = pointersOf(broken('many-errors'));
    expect(pointers).toEqual(
      expect.arrayContaining([
        '/total_days',
        '/stages/0/steps/0/fallback',
        '/stages/0/steps/0/auto_checks/1',
        '/stages/0/steps/1/key',
        '/stages/0/steps/1/owner_role',
        '/stages/0/steps/1/fallback/template',
        '/stages/0/steps/1/sources',
      ]),
    );
    expect(new Set(pointers).size).toBe(pointers.length);
  });

  it('a duplicate stage key and a duplicate step key', () => {
    expect(pointersOf(broken('duplicate-keys'))).toEqual(
      expect.arrayContaining(['/stages/1/key', '/stages/0/steps/1/key']),
    );
  });

  it('an unknown owner role and an unknown alt role', () => {
    expect(pointersOf(broken('unknown-role'))).toEqual(
      expect.arrayContaining(['/stages/0/steps/1/owner_role', '/stages/0/steps/1/alt_roles/0']),
    );
  });

  it('an unknown auto check, by the pointer of the list item', () => {
    expect(errorsOf(broken('unknown-check'))).toContainEqual(
      expect.objectContaining({
        pointer: '/stages/0/steps/0/auto_checks/1',
        code: 'unknown_check',
      }),
    );
  });

  it('a repeated key inside one mapping is an error, not "the last one wins"', () => {
    expect(errorsOf(broken('duplicate-map-key')).map((e) => e.code)).toContain(
      'yaml_duplicate_key',
    );
  });

  it.each([
    ['yaml-anchors', 'yaml_alias'],
    ['yaml-bomb', 'yaml_alias'],
    ['yaml-tags', 'yaml_tag'],
  ])('SEC: %s is refused as %s without expanding anything', (name, code) => {
    const started = Date.now();
    expect(errorsOf(broken(name)).map((e) => e.code)).toContain(code);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('YAML anchors without an alias are refused too', () => {
    const yaml = `${JSON.stringify(miniFile(), null, 2).replace('"product_type": "web_service"', 'product_type: &t web_service')}`;
    expect(errorsOf(yaml).map((e) => e.code)).toContain('yaml_anchor');
  });
});

describe('S5-02 domain rules of FR-PLAY-02, one at a time on a small playbook', () => {
  const cases: [string, (file: Json) => void, string][] = [
    ['total_days is not the sum', (f) => void (f.total_days = 30), '/total_days'],
    [
      'duration_days is 0',
      (f) => void (stagesOf(f)[1]!.duration_days = 0),
      '/stages/1/duration_days',
    ],
    [
      'duration_days is not an integer',
      (f) => void (stagesOf(f)[1]!.duration_days = 1.5),
      '/stages/1/duration_days',
    ],
    [
      'owner_role not in the catalog',
      (f) => void (stepOf(f, 1, 0).owner_role = 'wizard'),
      '/stages/1/steps/0/owner_role',
    ],
    [
      'alt role not in the catalog',
      (f) => void (stepOf(f, 0, 1).alt_roles = ['sorcerer']),
      '/stages/0/steps/1/alt_roles/0',
    ],
    [
      'alt_roles holds owner_role',
      (f) => void (stepOf(f, 0, 1).alt_roles = ['pm']),
      '/stages/0/steps/1/alt_roles/0',
    ],
    [
      'template not in the catalog',
      (f) => void ((stepOf(f, 0, 1).fallback as Json).template = 'tpl_nope'),
      '/stages/0/steps/1/fallback/template',
    ],
    [
      'step key repeats',
      (f) => void (stepOf(f, 1, 0).key = 'mini_kickoff'),
      '/stages/1/steps/0/key',
    ],
    ['stage key repeats', (f) => void (stagesOf(f)[2]!.key = 'mini_s1'), '/stages/2/key'],
    ['version is not semver', (f) => void (f.version = 'nine'), '/version'],
    ['version is a number, not a string', (f) => void (f.version = 9.5), '/version'],
    ['a field of the file is unknown', (f) => void (f.extra = 1), '/extra'],
    [
      'a field of a step is unknown (typo)',
      (f) => void (stepOf(f, 0, 0).alt_role = []),
      '/stages/0/steps/0/alt_role',
    ],
    [
      'owner other than any without a fallback',
      (f) => void (stepOf(f, 0, 1).fallback = null),
      '/stages/0/steps/1/fallback',
    ],
    [
      'owner any with a fallback',
      (f) =>
        void (stepOf(f, 0, 0).fallback = { title: 't', instruction: 'i', template: 'tpl_retro' }),
      '/stages/0/steps/0/fallback',
    ],
    [
      'owner any with alt_roles',
      (f) => void (stepOf(f, 0, 0).alt_roles = ['ba']),
      '/stages/0/steps/0/alt_roles',
    ],
    ['sources is empty', (f) => void (stepOf(f, 0, 0).sources = []), '/stages/0/steps/0/sources'],
    [
      'a source is not a URL',
      (f) => void (stepOf(f, 0, 0).sources = ['not a url']),
      '/stages/0/steps/0/sources/0',
    ],
    [
      'submission on a ritual',
      (f) => void (stepOf(f, 0, 0).submission = 'link'),
      '/stages/0/steps/0/submission',
    ],
    [
      'ritual_kind on an artifact',
      (f) => void (stepOf(f, 0, 1).ritual_kind = 'call'),
      '/stages/0/steps/1/ritual_kind',
    ],
    [
      'an artifact without submission',
      (f) => void delete stepOf(f, 0, 1).submission,
      '/stages/0/steps/1/submission',
    ],
    [
      'a ritual without ritual_kind',
      (f) => void delete stepOf(f, 0, 0).ritual_kind,
      '/stages/0/steps/0/ritual_kind',
    ],
    [
      'checklist without items',
      (f) => void delete stepOf(f, 0, 1).review_items,
      '/stages/0/steps/1/review_items',
    ],
    [
      'items without checklist',
      (f) => void (stepOf(f, 0, 1).review_checklist = false),
      '/stages/0/steps/1/review_items',
    ],
    [
      'unknown auto check',
      (f) => void (stepOf(f, 0, 1).auto_checks = ['file_ok', 'magic']),
      '/stages/0/steps/1/auto_checks/1',
    ],
    ['a title is blank', (f) => void (f.title = '  '), '/title'],
    ['stages is empty', (f) => void (f.stages = []), '/stages'],
  ];

  it.each(cases)('%s', (_name, change, pointer) => {
    expect(pointersOf(miniText(change))).toContain(pointer);
  });

  it('a missing required field is reported at its own pointer', () => {
    expect(pointersOf(miniText((f) => void delete f.title))).toContain('/title');
    expect(pointersOf(miniText((f) => void delete stepOf(f, 1, 0).required))).toContain(
      '/stages/1/steps/0/required',
    );
  });

  it('a stage without a required artifact points into the stage', () => {
    const text = miniText((f) => void (stepOf(f, 1, 0).required = false));
    expect(pointersOf(text)).toContain('/stages/1/steps');
  });

  it('the last stage needs a required step with release_alive_* and repo_final', () => {
    for (const checks of [['link_https'], ['link_https', 'release_alive_web'], ['repo_final']]) {
      const text = miniText((f) => void (stepOf(f, 2, 0).auto_checks = checks));
      expect(errorsOf(text)).toContainEqual(
        expect.objectContaining({ pointer: '/stages/2/steps', code: 'release_step_missing' }),
      );
    }
    const ml = miniText(
      (f) => void (stepOf(f, 2, 0).auto_checks = ['release_alive_ml', 'repo_final']),
    );
    expect(validate(ml).ok).toBe(true);
    expect(pointersOf(miniText((f) => void (stepOf(f, 2, 0).required = false)))).toContain(
      '/stages/2/steps',
    );
  });

  it('parameters of checks: min_files:5 and pr_cross_review:3 are fine; bare, non-numeric, zero, huge and stray ones are not', () => {
    const ok = miniText(
      (f) => void (stepOf(f, 0, 1).auto_checks = ['file_ok', 'min_files:5', 'pr_cross_review:3']),
    );
    expect(validate(ok).ok).toBe(true);
    for (const bad of [
      'min_files',
      'min_files:x',
      'min_files:0',
      'min_files:101',
      'file_ok:1',
      'pr_cross_review:',
    ]) {
      const text = miniText((f) => void (stepOf(f, 0, 1).auto_checks = [bad]));
      expect(errorsOf(text), bad).toContainEqual(
        expect.objectContaining({
          pointer: '/stages/0/steps/1/auto_checks/0',
          code: 'invalid_check_parameter',
        }),
      );
    }
  });

  it('FR-PLAY-07: 70 and 112 days are inside 10-16 weeks, 69 and 113 are warned about', () => {
    const withDays = (days: number): string =>
      miniText((f) => {
        f.total_days = days;
        stagesOf(f)[1]!.duration_days = days - 14;
      });
    for (const [days, warned] of [
      [70, false],
      [112, false],
      [69, true],
      [113, true],
    ] as const) {
      const result = validate(withDays(days));
      expect(result.ok && result.playbook.warnings.length > 0, String(days)).toBe(warned);
    }
  });
});

describe('S5-02 safe parsing', () => {
  const failure = (text: string) => {
    const result = parsePlaybookSource(text);
    if (result.ok) throw new Error('expected a failure');
    return result.errors;
  };

  it('SEC: over 1 MiB is refused before parsing', () => {
    expect(failure(`a: ${'x'.repeat(MAX_SOURCE_BYTES)}`).map((e) => e.code)).toEqual(['too_large']);
  });

  it('an empty file, a list and a scalar are refused', () => {
    expect(failure('   \n').map((e) => e.code)).toEqual(['empty']);
    expect(failure('- a\n- b\n').map((e) => e.code)).toEqual(['not_an_object']);
    expect(failure('just text').map((e) => e.code)).toEqual(['not_an_object']);
  });

  it('SEC: a second document and a broken file are errors, not exceptions', () => {
    expect(failure('a: 1\n---\nb: 2\n').map((e) => e.code)).toContain('yaml_multiple_docs');
    expect(failure('a: [1, 2\n').length).toBeGreaterThan(0);
  });

  it('SEC: extreme nesting is a rejected file, not a crash', () => {
    const deep = `a: ${'['.repeat(200_000)}${']'.repeat(200_000)}`;
    expect(failure(deep).length).toBeGreaterThan(0);
  });

  it('JSON is read as YAML', () => {
    const result = parsePlaybookSource('{"product_type": "web_service", "n": 1}');
    expect(result).toEqual({ ok: true, value: { product_type: 'web_service', n: 1 } });
  });

  it('the core schema leaves yes/no/dates as strings', () => {
    const result = parsePlaybookSource('a: yes\nb: 2026-01-01\nc: 0x10\n');
    expect(result).toEqual({ ok: true, value: { a: 'yes', b: '2026-01-01', c: 16 } });
  });
});
