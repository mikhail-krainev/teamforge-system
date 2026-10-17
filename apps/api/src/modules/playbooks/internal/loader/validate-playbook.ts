import { createHash } from 'node:crypto';
import { type PlaybookIssue, type PlaybookWarning } from './issue.js';
import { parsePlaybookSource } from './parse-source.js';
import { type PlaybookFile, playbookFileSchema, structureIssues } from './playbook-schema.js';
import { applyPlaybookRules, type PlaybookCatalogs } from './playbook-rules.js';
import { parseSemver, type SemVer } from './semver.js';

export interface ValidPlaybook {
  file: PlaybookFile;
  semver: SemVer;
  sourceText: string;
  sourceSha256: Buffer;
  warnings: PlaybookWarning[];
}

export type ValidationResult =
  { ok: true; playbook: ValidPlaybook } | { ok: false; errors: PlaybookIssue[] };

/**
 * Whole check of a playbook file (FR-PLAY-01, -02, -07): safe parse, structure (zod, docs/playbooks.md
 * 2.1) and domain rules. On failure the list holds EVERY finding, in file order (by pointer), not just
 * the first one; a file that cannot be parsed at all yields the parse errors only.
 */
export function validatePlaybookSource(text: string, catalogs: PlaybookCatalogs): ValidationResult {
  const parsed = parsePlaybookSource(text);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  const structure = playbookFileSchema.safeParse(parsed.value);
  const rules = applyPlaybookRules(parsed.value, catalogs);
  const errors = [...(structure.success ? [] : structureIssues(structure.error)), ...rules.errors];
  if (!structure.success || errors.length > 0) return { ok: false, errors: sortIssues(errors) };
  const semver = parseSemver(structure.data.version);
  if (semver === null) {
    return {
      ok: false,
      errors: [
        {
          pointer: '/version',
          code: 'invalid_version',
          message: 'version must be MAJOR.MINOR.PATCH',
        },
      ],
    };
  }
  return {
    ok: true,
    playbook: {
      file: structure.data,
      semver,
      sourceText: text,
      sourceSha256: createHash('sha256').update(text, 'utf8').digest(),
      warnings: rules.warnings,
    },
  };
}

/** Stable order: by position in the file, then by rule code. */
function sortIssues(issues: PlaybookIssue[]): PlaybookIssue[] {
  const seen = new Set<string>();
  const unique = issues.filter((item) => {
    const id = `${item.pointer}\u0000${item.code}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const position = (pointer: string): number[] =>
    pointer
      .split('/')
      .filter((part) => /^[0-9]+$/.test(part))
      .map(Number);
  return unique.sort((a, b) => {
    const pa = position(a.pointer);
    const pb = position(b.pointer);
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
      const diff = (pa[i] ?? -1) - (pb[i] ?? -1);
      if (diff !== 0) return diff;
    }
    return a.pointer.localeCompare(b.pointer) || a.code.localeCompare(b.code);
  });
}
