import { describe, expect, it } from 'vitest';
import {
  autoCheckFailuresOf,
  failedBlockingChecks,
  type AutoCheckFacts,
} from './auto-check-rules.js';

const artifact = (over: Partial<AutoCheckFacts> = {}): AutoCheckFacts => ({
  kind: 'artifact',
  linkUrl: null,
  linkStatus: 'none',
  heldOn: null,
  externalUrl: null,
  outcome: null,
  filesCount: 0,
  ...over,
});

describe('failedBlockingChecks (FR-PLAY-08: file_ok, ritual_fields, link_https)', () => {
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
