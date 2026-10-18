import { describe, expect, it } from 'vitest';
import { safeFileName, sniffArtifact } from './artifact-file.js';

const pdf = (body: string): Buffer =>
  Buffer.from(
    `%PDF-1.4\n1 0 obj\n<< /Type /Catalog ${body} >>\nendobj\ntrailer\n%%EOF\n`,
    'latin1',
  );

describe('sniffArtifact: active content in a PDF (SEC-15, best effort)', () => {
  it('a plain PDF passes', () => {
    expect(sniffArtifact(pdf('/Pages 2 0 R'), 'a.pdf')).toEqual({
      ok: true,
      mime: 'application/pdf',
    });
  });

  it.each([
    '/JavaScript 5 0 R',
    '/JS (app.alert(1))',
    '/JS(app.alert(1))',
    '/Launch << /F (cmd.exe) >>',
    '/EmbeddedFile 4 0 R',
    '/RichMedia 3 0 R',
    '/AA << /O 5 0 R >>',
    '/XFA [ (template) 7 0 R ]',
    '/SubmitForm << /F (https://evil.example/) >>',
    '/ImportData << /F (x.fdf) >>',
    '/GoToR << /F (other.pdf) >>',
    '/GoToE << /T 1 0 R >>',
    '/Rendition 6 0 R',
    '/JavaScript\0 5 0 R',
    '/JS\0(app.alert(1))',
    '/AA\f<< /O 5 0 R >>',
  ])('%s is refused', (body) => {
    expect(sniffArtifact(pdf(body), 'a.pdf')).toMatchObject({
      ok: false,
      reason: 'pdf_active_content',
    });
  });

  it('a name written with #xx escapes is the same name: /J#61vaScript, /Launc#68, /#41A', () => {
    for (const body of [
      '/J#61vaScript 5 0 R',
      '/Launc#68 << >>',
      '/#41A << >>',
      '/#4AS (x)',
    ]) {
      expect(sniffArtifact(pdf(body), 'a.pdf'), body).toMatchObject({
        ok: false,
        reason: 'pdf_active_content',
      });
    }
  });

  it('hyperlinks and an open action alone are not active content: /URI, /OpenAction 5 0 R (go to a page)', () => {
    expect(sniffArtifact(pdf('/URI (https://example.org/)'), 'a.pdf')).toMatchObject({ ok: true });
    expect(sniffArtifact(pdf('/OpenAction [3 0 R /Fit]'), 'a.pdf')).toMatchObject({ ok: true });
  });

  it('an open action that runs a script is still refused through /JavaScript', () => {
    expect(
      sniffArtifact(pdf('/OpenAction << /S /JavaScript /JS (x) >>'), 'a.pdf'),
    ).toMatchObject({ ok: false });
  });

  it('a longer name that only starts like a forbidden one does not match: /AAPL, /JSON, /URIs', () => {
    expect(sniffArtifact(pdf('/AAPL 1 /JSON 2 /URIs 3'), 'a.pdf')).toMatchObject({ ok: true });
  });
});

describe('safeFileName', () => {
  it('drops the path, control characters and Unicode format characters (bidi, zero width)', () => {
    expect(safeFileName('../etc/passwd')).toBe('passwd');
    expect(safeFileName('a\u0000b\u001fc.pdf')).toBe('abc.pdf');
    expect(safeFileName('report‮fdp.exe')).toBe('reportfdp.exe');
    expect(safeFileName('a​b‏c﻿d.txt')).toBe('abcd.txt');
    expect(safeFileName('⁦x⁩.md')).toBe('x.md');
  });

  it('drops line and paragraph separators, C1 controls and invisible filler characters', () => {
    expect(safeFileName('a\u2028b\u2029c.txt')).toBe('abc.txt');
    expect(safeFileName('a\u0085b\u009fc.txt')).toBe('abc.txt');
    expect(safeFileName('a\u3164b\u115fc\u1160d\uffa0e\u2800f.txt')).toBe('abcdef.txt');
    expect(safeFileName('\u3164\u2800')).toBe('file');
  });

  it('falls back to "file" when nothing is left', () => {
    expect(safeFileName('')).toBe('file');
    expect(safeFileName('..')).toBe('file');
    expect(safeFileName('​‮')).toBe('file');
  });
});
