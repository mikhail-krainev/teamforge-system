import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RESUME_TEXT, resumeBytes } from '../../test/fixtures/profiles.js';
import { runChild, selfCheckChild } from './run-child.js';

const childPath = fileURLToPath(new URL('./child.ts', import.meta.url));
const options = { childPath };

describe('resume parser in a child process (FR-PROF-03, architecture 13.15)', () => {
  it('reads the text of a PDF and of a DOCX', async () => {
    const pdf = await runChild('pdf', resumeBytes('resume.pdf'), options);
    expect(pdf).toEqual({ v: 1, ok: true, text: RESUME_TEXT, pages: 1 });
    const docx = await runChild('docx', resumeBytes('resume.docx'), options);
    expect(docx).toEqual({ v: 1, ok: true, text: RESUME_TEXT, pages: 1 });
  }, 60_000);

  it.each([
    ['no-text.pdf', 'pdf', 'NO_TEXT'],
    ['pdf-bomb.pdf', 'pdf', 'LIMIT'],
    ['docx-bomb.docx', 'docx', 'LIMIT'],
    ['encrypted.pdf', 'pdf', 'ENCRYPTED'],
    ['renamed-exe.pdf', 'pdf', 'CORRUPTED'],
    ['empty.pdf', 'pdf', 'CORRUPTED'],
  ] as const)(
    '%s ends as %s without text',
    async (name, kind, reason) => {
      expect(await runChild(kind, resumeBytes(name), options)).toEqual({ v: 1, ok: false, reason });
    },
    60_000,
  );

  it('a child that runs too long is killed and reported as TIMEOUT', async () => {
    const outcome = await runChild('pdf', resumeBytes('resume.pdf'), { ...options, timeoutMs: 1 });
    expect(outcome).toEqual({ v: 1, ok: false, reason: 'TIMEOUT' });
  });

  it('the child does not inherit the environment of its parent', async () => {
    process.env.TF_PARENT_SECRET = 'must-not-leak';
    try {
      const report = JSON.parse(await selfCheckChild(options)) as { env: string[] };
      expect(report.env).not.toContain('TF_PARENT_SECRET');
      expect(report.env.filter((name) => /REDIS|DATABASE|SECRET|KEY|TOKEN/i.test(name))).toEqual(
        [],
      );
    } finally {
      delete process.env.TF_PARENT_SECRET;
    }
  });
});
