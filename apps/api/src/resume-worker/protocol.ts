import { z } from 'zod';

/** Result of the isolated parser (architecture 13.15): the only thing resume-worker returns. */
export type ParseOutcome =
  | { v: 1; ok: true; text: string; pages: number }
  | {
      v: 1;
      ok: false;
      reason: 'NO_TEXT' | 'TIMEOUT' | 'LIMIT' | 'ENCRYPTED' | 'CORRUPTED' | 'UNSUPPORTED';
    };

/** C-26: at most 100 000 characters. */
export const MAX_TEXT_CHARS = 100_000;

/** Kind byte the parent sends before the file bytes. */
export const KIND_BYTES = { pdf: 0x50, docx: 0x44 } as const;

/**
 * Text as the application accepts it: line breaks unified, NUL and control characters other than
 * tab and line feed removed, cut at the limit, surrounding blank space trimmed.
 */
export function sanitizeText(raw: string): string {
  const unified = raw.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  let out = '';
  for (const char of unified) {
    const code = char.codePointAt(0) ?? 0;
    if ((code < 32 && code !== 9 && code !== 10) || code === 127) continue;
    out += char;
    if (out.length >= MAX_TEXT_CHARS) break;
  }
  return out.slice(0, MAX_TEXT_CHARS).trim();
}

/** Checks what comes back from the child process: anything else counts as a corrupted file. */
export const outcomeSchema = z.union([
  z
    .object({
      v: z.literal(1),
      ok: z.literal(true),
      text: z.string().max(MAX_TEXT_CHARS),
      pages: z.number().int().min(0).max(30),
    })
    .strict(),
  z
    .object({
      v: z.literal(1),
      ok: z.literal(false),
      reason: z.enum(['NO_TEXT', 'TIMEOUT', 'LIMIT', 'ENCRYPTED', 'CORRUPTED', 'UNSUPPORTED']),
    })
    .strict(),
]);

/** Job data of `resume-parse`: the upload id, the type and the bytes. Nothing else crosses over. */
export const jobDataSchema = z
  .object({
    uploadId: z.string().uuid(),
    mime: z.enum([
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ]),
    data: z.string(),
  })
  .strict();
