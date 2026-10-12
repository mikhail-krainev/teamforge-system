#!/usr/bin/env node
// Generates the resume fixtures of slice 2 (docs/plan.md S2-02, S2-10). Nothing is downloaded: every
// file is built here from node built-ins, deterministically, so the outputs can be regenerated and diffed.
//   node apps/api/test/fixtures/files/generate.mjs
// Files:
//   resume.pdf        valid one-page PDF with the known text RESUME_TEXT
//   resume.docx       valid DOCX with the same text
//   no-text.pdf       valid PDF whose page has no text (a scan) -> failure reason scan_without_text
//   pdf-bomb.pdf      PDF with 400 pages (limit C-24 is 30) -> limit_exceeded
//   docx-bomb.docx    DOCX whose archive expands to 60 MB (limit C-25 is 50 MB) -> limit_exceeded
//   encrypted.pdf     PDF with a standard-security /Encrypt dictionary (user password required)
//   renamed-exe.pdf   a Windows executable (MZ header) named like a PDF
//   empty.pdf         zero bytes
import { crc32, deflateRawSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
export const RESUME_TEXT =
  'Ivan Petrov. Backend developer. TypeScript, PostgreSQL, Redis. 2024-2026 Teamforge.';

/** Builds a PDF from page content streams (strings); `extra` adds trailer entries and objects. */
function buildPdf(contents, { encrypt = false } = {}) {
  const objects = [];
  const add = (body) => objects.push(body) && objects.length;
  const pageCount = contents.length;
  // 1 = catalog, 2 = pages, 3 = font, 4 = encrypt dict (if any), then page + content pairs.
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('PAGES_PLACEHOLDER');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  if (encrypt) {
    const hex = (seed) => Buffer.alloc(32, seed).toString('hex');
    add(`<< /Filter /Standard /V 1 /R 2 /P -4 /O <${hex(0x41)}> /U <${hex(0x42)}> >>`);
  }
  const kids = [];
  for (const content of contents) {
    const pageNumber = objects.length + 1;
    kids.push(`${pageNumber} 0 R`);
    add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageNumber + 1} 0 R >>`,
    );
    add(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pageCount} >>`;
  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  const encryptEntry = encrypt ? ' /Encrypt 4 0 R' : '';
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encryptEntry} /ID [<${'00'.repeat(16)}> <${'00'.repeat(16)}>] >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const textPage = (text) => `BT /F1 12 Tf 72 720 Td (${text.replaceAll(/[()\\]/g, '\\$&')}) Tj ET`;

/** Minimal ZIP writer: `entries` are [name, Buffer]; deflate when it pays off. */
function buildZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const deflated = deflateRawSync(data, { level: 9 });
    const method = deflated.length < data.length ? 8 : 0;
    const payload = method === 8 ? deflated : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0x21000000, 10); // fixed DOS date 1980-01-01 for reproducible output
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, payload);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(0x21000000, 12);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(payload.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + payload.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, end]);
}

function docxEntries(text, extra = []) {
  const types =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>';
  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';
  const document =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    `<w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`;
  return [
    ['[Content_Types].xml', Buffer.from(types)],
    ['_rels/.rels', Buffer.from(rels)],
    ['word/document.xml', Buffer.from(document)],
    ...extra,
  ];
}

const files = {
  'resume.pdf': buildPdf([textPage(RESUME_TEXT)]),
  'resume.docx': buildZip(docxEntries(RESUME_TEXT)),
  'no-text.pdf': buildPdf(['q Q']),
  'pdf-bomb.pdf': buildPdf(Array.from({ length: 400 }, () => 'q Q')),
  'docx-bomb.docx': buildZip(
    docxEntries(RESUME_TEXT, [['word/media/filler.bin', Buffer.alloc(60 * 1024 * 1024)]]),
  ),
  'encrypted.pdf': buildPdf([textPage(RESUME_TEXT)], { encrypt: true }),
  'renamed-exe.pdf': Buffer.concat([
    Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xFF\xFF\x00\x00', 'latin1'),
    Buffer.from('This program cannot be run in DOS mode.\r\r\n$'.padEnd(2048, '\0'), 'latin1'),
  ]),
  'empty.pdf': Buffer.alloc(0),
};

mkdirSync(dir, { recursive: true });
for (const [name, data] of Object.entries(files)) {
  writeFileSync(path.join(dir, name), data);
  process.stdout.write(`${name}: ${data.length} bytes\n`);
}
