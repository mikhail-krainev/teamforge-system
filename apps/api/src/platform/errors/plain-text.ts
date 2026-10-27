import { DomainError } from './domain-error.js';

export interface PlainTextLimits {
  /** Minimum length in code points after trimming (a text of spaces only is empty). */
  min: number;
  /** Maximum length in code points of the text as written. */
  max: number;
}

const TAB = 9;
const LINE_FEED = 10;
const CARRIAGE_RETURN = 13;
const FIRST_PRINTABLE = 32;
const DELETE = 127;
/** C1 controls U+0080..U+009F. */
const C1_FIRST = 0x80;
const C1_LAST = 0x9f;
/** Bidi embeddings and overrides U+202A..U+202E and isolates U+2066..U+2069: they reorder what others read. */
const BIDI_EMBEDDING_FIRST = 0x202a;
const BIDI_EMBEDDING_LAST = 0x202e;
const BIDI_ISOLATE_FIRST = 0x2066;
const BIDI_ISOLATE_LAST = 0x2069;

const within = (code: number, first: number, last: number): boolean =>
  code >= first && code <= last;

/** NUL, C0 and C1 controls other than tab, line feed and carriage return, and bidi controls. */
function hasForbiddenControl(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === DELETE || within(code, C1_FIRST, C1_LAST)) return true;
    if (within(code, BIDI_EMBEDDING_FIRST, BIDI_EMBEDDING_LAST)) return true;
    if (within(code, BIDI_ISOLATE_FIRST, BIDI_ISOLATE_LAST)) return true;
    if (code < FIRST_PRINTABLE && code !== TAB && code !== LINE_FEED && code !== CARRIAGE_RETURN) {
      return true;
    }
  }
  return false;
}

const codePoints = (text: string): number => [...text].length;

/**
 * A free text written by a person (a review, a dispute) is stored and returned as written: it is JSON, and the
 * place of output escapes it (React does). Here it is only checked: length in code points and no control
 * characters. Throws 422 `VALIDATION_FAILED` with the pointer of the field.
 */
export function assertPlainText(text: string, limits: PlainTextLimits, pointer: string): void {
  if (hasForbiddenControl(text)) {
    throw invalid(pointer, 'control_characters', 'The text has control characters');
  }
  const length = codePoints(text);
  if (codePoints(text.trim()) < limits.min || length > limits.max) {
    throw invalid(pointer, 'length', `The text is ${limits.min}..${limits.max} characters`);
  }
}

const invalid = (pointer: string, code: string, message: string): DomainError =>
  new DomainError('VALIDATION_FAILED', 422, { errors: [{ pointer, code, message }] });
