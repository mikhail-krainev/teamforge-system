import { isAlias, isNode, LineCounter, parseDocument, visit, type YAMLError } from 'yaml';
import type { PlaybookIssue } from './issue.js';

/** Upper bound of a playbook file (openapi `uploadPlaybook`: maxLength 1048576). */
export const MAX_SOURCE_BYTES = 1_048_576;

export type ParseResult = { ok: true; value: unknown } | { ok: false; errors: PlaybookIssue[] };

const issue = (code: string, message: string, pointer = '/'): PlaybookIssue => ({
  pointer,
  code,
  message,
});

function describe(error: YAMLError): PlaybookIssue {
  const where = error.linePos?.[0];
  const at = where === undefined ? '' : ` (line ${where.line}, column ${where.col})`;
  return issue(`yaml_${error.code.toLowerCase()}`, `${error.message.split('\n')[0] ?? ''}${at}`);
}

/**
 * Safe reading of a playbook file (architecture 11.1): YAML 1.2 core schema (plain strings, numbers,
 * booleans, null), no tags, no anchors or aliases (`maxAliasCount: 0`: no alias expansion bombs), no
 * merge keys, no duplicate keys, one document, at most 1 MiB. JSON is a subset of YAML and passes the
 * same way. Never throws: every failure becomes a list entry.
 */
export function parsePlaybookSource(text: string): ParseResult {
  if (Buffer.byteLength(text, 'utf8') > MAX_SOURCE_BYTES) {
    return {
      ok: false,
      errors: [issue('too_large', `The file is larger than ${MAX_SOURCE_BYTES} bytes`)],
    };
  }
  if (text.trim() === '') return { ok: false, errors: [issue('empty', 'The file is empty')] };
  const lines = new LineCounter();
  try {
    const document = parseDocument(text, {
      schema: 'core',
      version: '1.2',
      uniqueKeys: true,
      merge: false,
      lineCounter: lines,
    });
    const errors = document.errors.map(describe);
    const where = (offset: number | undefined): string => {
      if (offset === undefined) return '';
      const { line, col } = lines.linePos(offset);
      return ` (line ${line}, column ${col})`;
    };
    visit(document, (_key, node) => {
      if (!isNode(node)) return undefined;
      const offset = node.range?.[0];
      if (isAlias(node)) {
        errors.push(issue('yaml_alias', `Aliases are not allowed${where(offset)}`));
      } else if ('anchor' in node && typeof node.anchor === 'string') {
        errors.push(issue('yaml_anchor', `Anchors are not allowed${where(offset)}`));
      }
      if (typeof node.tag === 'string') {
        errors.push(issue('yaml_tag', `Tags are not allowed (${node.tag})${where(offset)}`));
      }
      return undefined;
    });
    if (errors.length > 0) return { ok: false, errors };
    const value: unknown = document.toJS({ maxAliasCount: 0 });
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { ok: false, errors: [issue('not_an_object', 'The file must hold one mapping')] };
    }
    return { ok: true, value };
  } catch (error) {
    // A pathological nesting depth overflows the parser's stack; it is a rejected file, not a crash.
    const reason =
      error instanceof RangeError ? 'The file is nested too deeply' : 'Unreadable file';
    return { ok: false, errors: [issue('yaml_unreadable', reason)] };
  }
}
