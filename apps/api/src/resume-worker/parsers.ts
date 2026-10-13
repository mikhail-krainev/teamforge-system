import { definePDFJSModule, extractText, getDocumentProxy } from 'unpdf';
import mammoth from 'mammoth';
import { readZipDirectory, zipLimitsExceeded } from '../platform/files/zip-directory.js';
import { type ParseOutcome, sanitizeText } from './protocol.js';

/** C-24: at most 30 pages are read. */
const MAX_PAGES = 30;

/** pdf.js options of architecture 13.15: no eval, no font loading, no outside resources. */
const PDF_OPTIONS = {
  isEvalSupported: false,
  disableFontFace: true,
  useSystemFonts: false,
  disableAutoFetch: true,
  disableStream: true,
  verbosity: 0,
} as const;

let pdfjsReady: Promise<void> | undefined;

/** The pinned `pdfjs-dist` (>= 4.2.67, CVE-2024-4367) is the PDF.js unpdf runs on. */
function usePinnedPdfjs(): Promise<void> {
  pdfjsReady ??= definePDFJSModule(() => import('pdfjs-dist/legacy/build/pdf.mjs'));
  return pdfjsReady;
}

const fail = (reason: Extract<ParseOutcome, { ok: false }>['reason']): ParseOutcome => ({
  v: 1,
  ok: false,
  reason,
});

function pdfFailure(error: unknown): ParseOutcome {
  process.stderr.write('DBGPDF ' + String(error) + String.fromCharCode(10));
  const name = (error as { name?: string } | undefined)?.name;
  return fail(name === 'PasswordException' ? 'ENCRYPTED' : 'CORRUPTED');
}

export async function parsePdf(bytes: Uint8Array): Promise<ParseOutcome> {
  await usePinnedPdfjs();
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    pdf = await getDocumentProxy(new Uint8Array(bytes), PDF_OPTIONS);
  } catch (error) {
    return pdfFailure(error);
  }
  try {
    if (pdf.numPages > MAX_PAGES) return fail('LIMIT');
    const { text } = await extractText(pdf, { mergePages: true });
    const clean = sanitizeText(text);
    return clean === '' ? fail('NO_TEXT') : { v: 1, ok: true, text: clean, pages: pdf.numPages };
  } catch (error) {
    return pdfFailure(error);
  }
}

/** DOCX: the central directory is judged first, so a bomb is never inflated (C-25). */
export async function parseDocx(bytes: Uint8Array): Promise<ParseOutcome> {
  const buffer = Buffer.from(bytes);
  const entries = readZipDirectory(buffer);
  if (entries === null) return fail('CORRUPTED');
  if (zipLimitsExceeded(entries)) return fail('LIMIT');
  try {
    const { value } = await mammoth.extractRawText({ buffer });
    const clean = sanitizeText(value);
    // A Word file has no fixed pages; one counts as the reading unit.
    return clean === '' ? fail('NO_TEXT') : { v: 1, ok: true, text: clean, pages: 1 };
  } catch {
    return fail('CORRUPTED');
  }
}

export function parseDocument(kind: 'pdf' | 'docx', bytes: Uint8Array): Promise<ParseOutcome> {
  return kind === 'pdf' ? parsePdf(bytes) : parseDocx(bytes);
}
