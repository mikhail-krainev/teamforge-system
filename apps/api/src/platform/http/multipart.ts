import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

/**
 * Largest multipart request accepted (resume 5 MiB + form overhead). The file size itself is checked
 * by the operation, which answers 413 FILE_TOO_LARGE as problem+json.
 */
export const MULTIPART_BODY_LIMIT = 6 * 1024 * 1024;

/** The one file of a multipart form. Bytes and names are hidden from enumeration (see `parsedForm`). */
export interface UploadedFile {
  readonly bytes: Buffer;
  readonly filename: string;
  readonly contentType: string;
}

/** Plain fields of the form plus the names of its files; this is what `request.body` enumerates. */
export interface MultipartBody {
  fields: Record<string, string>;
  files: Record<string, { sha256: string; size: number }>;
}

const FILES = new WeakMap<object, Map<string, UploadedFile>>();

/** Bytes of the uploaded files of a parsed multipart body (not part of the body's JSON shape). */
export function uploadedFiles(body: unknown): Map<string, UploadedFile> {
  return (typeof body === 'object' && body !== null ? FILES.get(body) : undefined) ?? new Map();
}

function boundaryOf(contentType: string): string | undefined {
  return (
    /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType)?.[1] ??
    /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType)?.[2]
  );
}

interface RawPart {
  headers: Map<string, string>;
  content: Buffer;
}

function parseHeaders(block: string): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of block.split('\r\n')) {
    const at = line.indexOf(':');
    if (at > 0) headers.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim());
  }
  return headers;
}

/** Splits a buffered multipart/form-data body at its boundary. Returns null when it is malformed. */
function splitParts(body: Buffer, boundary: string): RawPart[] | null {
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: RawPart[] = [];
  let at = body.indexOf(delimiter);
  while (at !== -1) {
    const afterDelimiter = at + delimiter.length;
    if (body.subarray(afterDelimiter, afterDelimiter + 2).toString() === '--') return parts;
    const start = afterDelimiter + 2;
    const next = body.indexOf(delimiter, start);
    if (next === -1) return null;
    const section = body.subarray(start, next - 2);
    const split = section.indexOf('\r\n\r\n');
    if (split === -1) return null;
    parts.push({
      headers: parseHeaders(section.subarray(0, split).toString('utf8')),
      content: section.subarray(split + 4),
    });
    at = next;
  }
  return null;
}

function dispositionOf(value: string | undefined): { name?: string; filename?: string } {
  const read = (key: string): string | undefined =>
    new RegExp(`(?:^|[;\\s])${key}="([^"]*)"`, 'i').exec(value ?? '')?.[1];
  const name = read('name');
  const filename = read('filename');
  return {
    ...(name === undefined ? {} : { name }),
    ...(filename === undefined ? {} : { filename }),
  };
}

/** Parses a buffered form into the enumerable `MultipartBody` and the hidden file bytes. */
export function parseMultipart(body: Buffer, contentType: string): MultipartBody | null {
  const boundary = boundaryOf(contentType);
  const parts = boundary === undefined ? null : splitParts(body, boundary);
  if (parts === null) return null;
  const parsed: MultipartBody = { fields: {}, files: {} };
  const files = new Map<string, UploadedFile>();
  for (const part of parts) {
    const { name, filename } = dispositionOf(part.headers.get('content-disposition'));
    if (name === undefined || name in Object.prototype) return null;
    if (filename === undefined) {
      parsed.fields[name] = part.content.toString('utf8');
      continue;
    }
    parsed.files[name] = {
      sha256: createHash('sha256').update(part.content).digest('hex'),
      size: part.content.length,
    };
    files.set(name, {
      bytes: part.content,
      filename,
      contentType: part.headers.get('content-type') ?? 'application/octet-stream',
    });
  }
  FILES.set(parsed, files);
  return parsed;
}

/**
 * Registers the multipart parser. The request body becomes a small JSON-like object (field values
 * and the SHA-256 and size of each file), so that the idempotency hash covers the content of the file
 * and not the random boundary; the bytes are read with `uploadedFiles(request.body)`.
 */
export function registerMultipart(fastify: FastifyInstance): void {
  fastify.addContentTypeParser(
    'multipart/form-data',
    { parseAs: 'buffer', bodyLimit: MULTIPART_BODY_LIMIT },
    (request, body, done) => {
      const parsed = parseMultipart(body as Buffer, String(request.headers['content-type'] ?? ''));
      // A malformed form is an empty one: the operation answers 400 for the missing file.
      done(null, parsed ?? { fields: {}, files: {} });
    },
  );
}
