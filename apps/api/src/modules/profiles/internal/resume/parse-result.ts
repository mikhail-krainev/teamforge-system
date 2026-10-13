import { z } from 'zod';

/** C-24 pages, C-26 characters (architecture 13.15). */
export const MAX_PARSE_PAGES = 30;
export const MAX_PARSE_CHARS = 100_000;

/** NUL and control characters other than tab (9) and line feed (10) are not allowed in the text. */
function hasForbiddenControl(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if ((code < 32 && code !== 9 && code !== 10) || code === 127) return true;
  }
  return false;
}

export const FAILURE_REASONS = [
  'NO_TEXT',
  'TIMEOUT',
  'LIMIT',
  'ENCRYPTED',
  'CORRUPTED',
  'UNSUPPORTED',
] as const;

/** What the isolated parser may answer; anything else is a failed upload (strict, no extras). */
export const parseResultSchema = z.union([
  z
    .object({
      v: z.literal(1),
      ok: z.literal(true),
      text: z
        .string()
        .max(MAX_PARSE_CHARS)
        .refine((text) => !hasForbiddenControl(text)),
      pages: z.number().int().min(0).max(MAX_PARSE_PAGES),
    })
    .strict(),
  z.object({ v: z.literal(1), ok: z.literal(false), reason: z.enum(FAILURE_REASONS) }).strict(),
]);

export type ParseResult = z.infer<typeof parseResultSchema>;

/** `ResumeUpload.failureReason` values of the contract. */
export type ContractFailure = 'scan_without_text' | 'timeout' | 'limit_exceeded' | 'corrupted';

const REASON_MAP: Record<(typeof FAILURE_REASONS)[number], ContractFailure> = {
  NO_TEXT: 'scan_without_text',
  TIMEOUT: 'timeout',
  LIMIT: 'limit_exceeded',
  CORRUPTED: 'corrupted',
  // The contract has no value of their own for these: the user can only try another file.
  ENCRYPTED: 'corrupted',
  UNSUPPORTED: 'corrupted',
};

export function contractFailure(reason: (typeof FAILURE_REASONS)[number]): ContractFailure {
  return REASON_MAP[reason];
}
