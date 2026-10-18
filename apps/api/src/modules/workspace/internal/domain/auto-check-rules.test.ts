import { describe, expect, it } from 'vitest';
import {
  autoCheckFailuresOf,
  failedBlockingChecks,
  type AutoCheckFacts,
} from './auto-check-rules.js';

const artifact = (over: Partial<AutoCheckFacts> = {}): AutoCheckFacts => ({
  kind: 'artifact',
  submission: null,
  linkUrl: null,
  linkStatus: 'none',
  heldOn: null,
  externalUrl: null,
  outcome: null,
  filesCount: 0,
  ...over,
});

describe('failedBlockingChecks (FR-PLAY-08: file_ok, ritual_fields, link_https)', () => {
  describe('submission either: the way the executor used is the one that is checked', () => {
    const both = ['file_ok', 'link_https'];
    const either = (over: Partial<AutoCheckFacts>) => artifact({ submission: 'either', ...over });

    it('one file and no link passes', () => {
      expect(failedBlockingChecks(both, either({ filesCount: 1 }))).toEqual([]);
    });

    it('one link and no file passes', () => {
      expect(
        failedBlockingChecks(
          both,
          either({ linkUrl: 'https://a.example.test/', linkStatus: 'ok' }),
        ),
      ).toEqual([]);
    });

    it('a rejected link with no file still fails link_https', () => {
      expect(
        failedBlockingChecks(
          both,
          either({ linkUrl: 'https://a.example.test/', linkStatus: 'rejected' }),
        ),
      ).toEqual(['link_https']);
    });

    it('a rejected link is rescued by a file', () => {
      expect(
        failedBlockingChecks(
          both,
          either({ linkUrl: 'https://a.example.test/', linkStatus: 'rejected', filesCount: 1 }),
        ),
      ).toEqual([]);
    });

    it('neither a file nor a link fails both', () => {
      expect(failedBlockingChecks(both, either({}))).toEqual(['file_ok', 'link_https']);
    });

    it('a step of submission file keeps file_ok strict', () => {
      expect(failedBlockingChecks(['file_ok'], artifact({ submission: 'file' }))).toEqual([
        'file_ok',
      ]);
    });
  });

  it('file_ok fails without a stored file and passes with one', () => {
    expect(failedBlockingChecks(['file_ok'], artifact())).toEqual(['file_ok']);
    expect(failedBlockingChecks(['file_ok'], artifact({ filesCount: 1 }))).toEqual([]);
  });

  it('ritual_fields fails while the day, the link or the outcome is missing', () => {
    const ritual = (over: Partial<AutoCheckFacts>) =>
      artifact({
        kind: 'ritual',
        heldOn: '2026-03-01',
        externalUrl: 'https://example.test/m',
        outcome: 'agreed',
        ...over,
      });
    expect(failedBlockingChecks(['ritual_fields'], ritual({}))).toEqual([]);
    expect(failedBlockingChecks(['ritual_fields'], ritual({ heldOn: null }))).toEqual([
      'ritual_fields',
    ]);
    expect(failedBlockingChecks(['ritual_fields'], ritual({ externalUrl: ' ' }))).toEqual([
      'ritual_fields',
    ]);
    expect(failedBlockingChecks(['ritual_fields'], ritual({ outcome: null }))).toEqual([
      'ritual_fields',
    ]);
  });

  it('link_https fails for a missing link and for a link the SSRF policy rejected, not for a broken one', () => {
    const link = (over: Partial<AutoCheckFacts>) =>
      artifact({ linkUrl: 'https://example.test/x', linkStatus: 'ok', ...over });
    expect(failedBlockingChecks(['link_https'], link({}))).toEqual([]);
    expect(failedBlockingChecks(['link_https'], link({ linkStatus: 'unchecked' }))).toEqual([]);
    expect(failedBlockingChecks(['link_https'], link({ linkStatus: 'broken' }))).toEqual([]);
    expect(failedBlockingChecks(['link_https'], link({ linkStatus: 'rejected' }))).toEqual([
      'link_https',
    ]);
    expect(
      failedBlockingChecks(['link_https'], link({ linkUrl: null, linkStatus: 'none' })),
    ).toEqual(['link_https']);
  });

  it('checks the step does not name are not run; signal checks and later-slice checks never block', () => {
    const bad = artifact({ linkUrl: 'https://x.test/', linkStatus: 'rejected' });
    expect(failedBlockingChecks([], bad)).toEqual([]);
    expect(
      failedBlockingChecks(
        [
          'sha_dedup',
          'md_headings',
          'min_files:2',
          'repo_exists',
          'ci_workflow',
          'pr_cross_review:1',
        ],
        bad,
      ),
    ).toEqual([]);
  });

  it('repo_exists fails only when the caller says the team has no repository', () => {
    const link = artifact({ linkUrl: 'https://github.com/o/r', linkStatus: 'ok' });
    expect(failedBlockingChecks(['repo_exists'], { ...link, repoLinked: true })).toEqual([]);
    expect(failedBlockingChecks(['repo_exists'], { ...link, repoLinked: false })).toEqual([
      'repo_exists',
    ]);
    expect(failedBlockingChecks(['repo_exists'], link)).toEqual([]);
  });

  it('reports every failed check once, in the order the step lists them', () => {
    expect(
      failedBlockingChecks(['link_https', 'file_ok', 'file_ok'], artifact({ linkUrl: null })),
    ).toEqual(['link_https', 'file_ok']);
  });
});

describe('autoCheckFailuresOf (done, required items of a stage)', () => {
  const item = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    stepKey: `step_${id}`,
    required: true,
    status: 'done',
    ...artifact({ linkUrl: 'https://x.test/', linkStatus: 'rejected' }),
    ...over,
  });
  const checksOf = (key: string): string[] =>
    key === 'step_a' || key === 'step_c' ? ['link_https'] : [];

  it('lists the done, required items whose blocking checks fail; open and optional items are not judged', () => {
    const failures = autoCheckFailuresOf(
      [item('a'), item('b'), item('c', { status: 'open' }), item('d', { required: false })],
      (stepKey) => (stepKey === 'step_d' ? ['link_https'] : checksOf(stepKey)),
    );
    expect(failures).toEqual([{ itemId: 'a', stepKey: 'step_a', checks: ['link_https'] }]);
  });
});

describe('failedBlockingChecks: edges found while implementing S5-09 (S5-14)', () => {
  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'])(
    'the name "%s" of the prototype chain is not a blocking check (a step file cannot switch a check on by naming it)',
    (name) => {
      expect(failedBlockingChecks([name], artifact())).toEqual([]);
    },
  );

  it('a parameter after the colon does not change which check it is: file_ok:1 and link_https:strict block like the plain names', () => {
    expect(failedBlockingChecks(['file_ok:1'], artifact())).toEqual(['file_ok']);
    expect(failedBlockingChecks(['link_https:strict'], artifact())).toEqual(['link_https']);
    expect(failedBlockingChecks(['file_ok:1', 'file_ok'], artifact())).toEqual(['file_ok']);
  });

  it('ritual_fields does not judge an artifact item, whatever fields it lacks', () => {
    expect(failedBlockingChecks(['ritual_fields'], artifact())).toEqual([]);
  });

  it('ritual_fields treats a blank day or outcome like a missing one', () => {
    const ritual = (over: Partial<AutoCheckFacts>) =>
      artifact({
        kind: 'ritual',
        heldOn: '2026-03-01',
        externalUrl: 'https://example.test/m',
        outcome: 'agreed',
        ...over,
      });
    expect(failedBlockingChecks(['ritual_fields'], ritual({ heldOn: '  ' }))).toEqual([
      'ritual_fields',
    ]);
    expect(failedBlockingChecks(['ritual_fields'], ritual({ outcome: '\n\t' }))).toEqual([
      'ritual_fields',
    ]);
    expect(failedBlockingChecks(['ritual_fields'], ritual({ externalUrl: null }))).toEqual([
      'ritual_fields',
    ]);
  });

  it('link_https fails for a blank address even with a good status; a link in the state "none" with an address passes (status is judged by the checker, not here)', () => {
    expect(
      failedBlockingChecks(['link_https'], artifact({ linkUrl: '   ', linkStatus: 'ok' })),
    ).toEqual(['link_https']);
    expect(
      failedBlockingChecks(
        ['link_https'],
        artifact({ linkUrl: 'https://example.test/', linkStatus: 'none' }),
      ),
    ).toEqual([]);
  });

  it('file_ok counts stored files only: the number the caller passes is what decides (deleted files are not in it)', () => {
    expect(failedBlockingChecks(['file_ok'], artifact({ filesCount: 3 }))).toEqual([]);
    expect(failedBlockingChecks(['file_ok'], artifact({ filesCount: 0 }))).toEqual(['file_ok']);
  });

  it('every blocking check of one step is reported when all of them fail, in the step order', () => {
    const ritual = artifact({ kind: 'ritual', linkUrl: null });
    expect(failedBlockingChecks(['ritual_fields', 'link_https', 'file_ok'], ritual)).toEqual([
      'ritual_fields',
      'link_https',
      'file_ok',
    ]);
  });
});

describe('autoCheckFailuresOf: several items and several checks (S5-14)', () => {
  const base = artifact();
  const row = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    stepKey: `step_${id}`,
    required: true,
    status: 'done',
    ...base,
    ...over,
  });

  it('keeps the order of the items and gives every item its own list of failed checks', () => {
    const failures = autoCheckFailuresOf(
      [
        row('a', { linkUrl: 'https://x.test/', linkStatus: 'rejected' }),
        row('b', { filesCount: 1 }),
        row('c'),
      ],
      (key) =>
        key === 'step_a'
          ? ['link_https']
          : key === 'step_b'
            ? ['file_ok']
            : ['file_ok', 'link_https'],
    );
    expect(failures).toEqual([
      { itemId: 'a', stepKey: 'step_a', checks: ['link_https'] },
      { itemId: 'c', stepKey: 'step_c', checks: ['file_ok', 'link_https'] },
    ]);
  });

  it('a stage without items and a step the playbook does not know give no failure', () => {
    expect(autoCheckFailuresOf([], () => ['file_ok'])).toEqual([]);
    expect(autoCheckFailuresOf([row('a')], () => [])).toEqual([]);
  });
});
