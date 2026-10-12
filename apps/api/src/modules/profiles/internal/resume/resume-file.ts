import { readZipDirectory, zipLimitsExceeded } from '../../../../platform/files/zip-directory.js';

export const PDF_MIME = 'application/pdf';
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const MAX_RESUME_BYTES = 5 * 1024 * 1024;

export type ResumeVerdict =
  | { ok: true; mime: typeof PDF_MIME | typeof DOCX_MIME }
  | { ok: false; status: 415 | 422; reason: string };

const reject = (status: 415 | 422, reason: string): ResumeVerdict => ({
  ok: false,
  status,
  reason,
});

/** Active content in a PDF dictionary: such a file is refused outright (SEC-15). */
const PDF_ACTIVE_TOKENS = ['/JavaScript', '/JS ', '/JS(', '/Launch', '/EmbeddedFile', '/RichMedia'];

function checkPdf(bytes: Buffer): ResumeVerdict {
  const text = bytes.toString('latin1');
  const found = PDF_ACTIVE_TOKENS.find((token) => text.includes(token));
  return found === undefined ? { ok: true, mime: PDF_MIME } : reject(422, 'pdf_active_content');
}

const FORBIDDEN_DOCX_ENTRY = /(^|\/)vbaProject\.bin$|(^|\/)activeX\/|\/embeddings\/[^/]*\.bin$/i;

function checkDocx(bytes: Buffer): ResumeVerdict {
  const entries = readZipDirectory(bytes);
  if (entries === null) return reject(415, 'zip_unreadable');
  const names = new Set(entries.map((entry) => entry.name));
  if (!names.has('[Content_Types].xml') || !names.has('word/document.xml')) {
    return reject(415, 'not_docx');
  }
  if (zipLimitsExceeded(entries)) return reject(422, 'zip_limits');
  if (entries.some((entry) => FORBIDDEN_DOCX_ENTRY.test(entry.name))) {
    return reject(422, 'docx_active_content');
  }
  return { ok: true, mime: DOCX_MIME };
}

/**
 * The type of a resume from its bytes only (architecture 13.7): `%PDF-` or `PK\x03\x04` with the
 * parts of a Word document. The client's name and Content-Type are never trusted.
 */
export function sniffResume(bytes: Buffer): ResumeVerdict {
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return checkPdf(bytes);
  if (bytes.length >= 4 && bytes.readUInt32BE(0) === 0x504b0304) return checkDocx(bytes);
  return reject(415, 'unknown_signature');
}
