/** One finding about a playbook file: where (JSON Pointer into the file), which rule, what is wrong. */
export interface PlaybookIssue {
  pointer: string;
  code: string;
  message: string;
}

/** A finding that does not reject the file (FR-PLAY-07). */
export interface PlaybookWarning {
  code: string;
  message: string;
}

/** Escapes one reference token of a JSON Pointer (RFC 6901). */
function escapeToken(token: string | number): string {
  return String(token).replaceAll('~', '~0').replaceAll('/', '~1');
}

export function pointerOf(path: ReadonlyArray<string | number | symbol>): string {
  return path.length === 0 ? '/' : `/${path.map((token) => escapeToken(String(token))).join('/')}`;
}
