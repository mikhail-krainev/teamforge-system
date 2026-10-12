export class InvalidJobIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidJobIdError';
  }
}

/**
 * Builds a deterministic BullMQ job id from parts joined with `_` (architecture 13.12).
 * BullMQ rejects custom ids containing `:` unless they have exactly three segments, and rejects
 * integer-like ids; UUIDs only contain `-`, so `_` is a safe separator. Throws on violations.
 */
export function jobId(...parts: Array<string | number>): string {
  if (parts.length === 0) throw new InvalidJobIdError('jobId needs at least one part');
  const texts = parts.map(String);
  for (const part of texts) {
    if (part === '') throw new InvalidJobIdError('jobId parts must not be empty');
    if (part.includes(':')) throw new InvalidJobIdError('jobId parts must not contain ":"');
  }
  const id = texts.join('_');
  if (/^\d+$/.test(id)) throw new InvalidJobIdError('jobId must not be an integer');
  return id;
}

/** Validates an id produced elsewhere (same rules as `jobId`). */
export function assertValidJobId(id: string): void {
  if (id === '' || id.includes(':')) throw new InvalidJobIdError('jobId must not contain ":"');
  if (/^\d+$/.test(id)) throw new InvalidJobIdError('jobId must not be an integer');
}
