import { describe, expect, it } from 'vitest';
import { resumeBytes } from '../../../../../test/fixtures/profiles.js';
import { DOCX_MIME, PDF_MIME, sniffResume } from './resume-file.js';
import { suggestStack } from './resume-suggestions.js';

describe('sniffResume (FR-PROF-02: the type comes from the bytes)', () => {
  it('accepts a PDF and a DOCX', () => {
    expect(sniffResume(resumeBytes('resume.pdf'))).toEqual({ ok: true, mime: PDF_MIME });
    expect(sniffResume(resumeBytes('resume.docx'))).toEqual({ ok: true, mime: DOCX_MIME });
  });

  it('refuses an executable renamed to .pdf, text and an empty file with 415', () => {
    for (const bytes of [
      resumeBytes('renamed-exe.pdf'),
      Buffer.from('plain words'),
      resumeBytes('empty.pdf'),
    ]) {
      expect(sniffResume(bytes)).toMatchObject({ ok: false, status: 415 });
    }
  });

  it('refuses a ZIP bomb (422) and a ZIP that is not a Word document (415)', () => {
    expect(sniffResume(resumeBytes('docx-bomb.docx'))).toMatchObject({ ok: false, status: 422 });
    expect(sniffResume(Buffer.from('PK\u0003\u0004 not a real archive'))).toMatchObject({
      ok: false,
      status: 415,
    });
  });

  it('refuses a PDF with active content', () => {
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj << /S /JavaScript /JS (app.alert(1)) >> endobj');
    expect(sniffResume(pdf)).toMatchObject({ ok: false, status: 422 });
  });
});

describe('suggestStack (FR-PROF-04)', () => {
  it('names catalog tags that occur as whole words, and nothing else', () => {
    const text = 'Backend: TypeScript, PostgreSQL and c++; not postgres or typescripty';
    expect(suggestStack(text, ['typescript', 'postgresql', 'c++', 'go', 'java'])).toEqual([
      'typescript',
      'postgresql',
      'c++',
    ]);
  });
});
