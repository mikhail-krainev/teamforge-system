import { readZipDirectory, zipLimitsExceeded } from '../../../../platform/files/zip-directory.js';

export const MIN_ARTIFACT_BYTES = 1024;
export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
/** Project quotas C-48, C-49. */
export const PROJECT_MAX_FILES = 30;
export const PROJECT_MAX_BYTES = 50 * 1024 * 1024;

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

export type ArtifactVerdict =
  { ok: true; mime: string } | { ok: false; status: 415 | 422; reason: string };

const reject = (status: 415 | 422, reason: string): ArtifactVerdict => ({
  ok: false,
  status,
  reason,
});

/** Active content in a PDF dictionary: such a file is refused outright (SEC-15). */
const PDF_ACTIVE_TOKENS = ['/JavaScript', '/JS ', '/JS(', '/Launch', '/EmbeddedFile', '/RichMedia'];
const FORBIDDEN_ZIP_ENTRY = /(^|\/)vbaProject\.bin$|(^|\/)activeX\/|\/embeddings\/[^/]*\.bin$/i;

function checkPdf(bytes: Buffer): ArtifactVerdict {
  const text = bytes.toString('latin1');
  return PDF_ACTIVE_TOKENS.some((token) => text.includes(token))
    ? reject(422, 'pdf_active_content')
    : { ok: true, mime: 'application/pdf' };
}

function checkZip(bytes: Buffer): ArtifactVerdict {
  const entries = readZipDirectory(bytes);
  if (entries === null) return reject(415, 'zip_unreadable');
  if (zipLimitsExceeded(entries)) return reject(422, 'zip_limits');
  if (entries.some((entry) => FORBIDDEN_ZIP_ENTRY.test(entry.name))) {
    return reject(422, 'zip_active_content');
  }
  const names = new Set(entries.map((entry) => entry.name));
  if (names.has('word/document.xml')) return { ok: true, mime: DOCX_MIME };
  if (names.has('ppt/presentation.xml')) return { ok: true, mime: PPTX_MIME };
  return { ok: true, mime: 'application/zip' };
}

const TEXT_TYPES: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
};

/** Plain text has no signature: valid UTF-8 without control characters AND a text extension. */
function checkText(bytes: Buffer, filename: string): ArtifactVerdict {
  const extension = /\.([A-Za-z0-9]+)$/.exec(filename)?.[1]?.toLowerCase();
  const mime = extension === undefined ? undefined : TEXT_TYPES[extension];
  if (mime === undefined) return reject(415, 'unknown_signature');
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return reject(415, 'not_text');
  } catch {
    return reject(415, 'not_text');
  }
  return { ok: true, mime };
}

/**
 * The type of an artifact file from its bytes (architecture 13.7): PDF, PNG, JPEG, WebP and ZIP
 * (DOCX, PPTX) by signature; Markdown and text by content plus the extension, since they have no
 * signature. The Content-Type of the client is never read; a name only decides between text types.
 */
export function sniffArtifact(bytes: Buffer, filename: string): ArtifactVerdict {
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return checkPdf(bytes);
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { ok: true, mime: 'image/png' };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { ok: true, mime: 'image/jpeg' };
  }
  if (
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return { ok: true, mime: 'image/webp' };
  }
  if (bytes.length >= 4 && bytes.readUInt32BE(0) === 0x504b0304) return checkZip(bytes);
  return checkText(bytes, filename);
}

/** The name is kept for display only: no path, no control characters, at most 255 characters. */
export function safeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const base = (name.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const cleaned = base === '' || base === '.' || base === '..' ? 'file' : base;
  return Array.from(cleaned).slice(0, 255).join('');
}
