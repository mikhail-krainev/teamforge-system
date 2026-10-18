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
    '/OpenAction 5 0 R',
    '/AA << /O 5 0 R >>',
    '/XFA [ (template) 7 0 R ]',
    '/URI (https://evil.example/)',
  ])('%s is refused', (body) => {
    expect(sniffArtifact(pdf(body), 'a.pdf')).toMatchObject({
      ok: false,
      reason: 'pdf_active_content',
    });
  });

  it('a name written with #xx escapes is the same name: /J#61vaScript, /Open#41ction, /#41A', () => {
    for (const body of [
      '/J#61vaScript 5 0 R',
      '/Open#41ction 5 0 R',
      '/#41A << >>',
      '/#55RI (x)',
    ]) {
      expect(sniffArtifact(pdf(body), 'a.pdf'), body).toMatchObject({
        ok: false,
        reason: 'pdf_active_content',
      });
    }
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

  it('falls back to "file" when nothing is left', () => {
    expect(safeFileName('')).toBe('file');
    expect(safeFileName('..')).toBe('file');
    expect(safeFileName('​‮')).toBe('file');
  });
});
