const MAX_SUGGESTED_TAGS = 30;

const escapeRegExp = (value: string): string => value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Hints for the profile from the resume text (FR-PROF-04): the catalog stack tags that occur in the
 * text as whole words. Rule based and run in the worker, outside the sandbox; the user confirms
 * every field, nothing is applied by itself. Only catalog codes can come out.
 */
export function suggestStack(text: string, catalogCodes: readonly string[]): string[] {
  const haystack = text.toLowerCase();
  const found = catalogCodes.filter((code) =>
    new RegExp(`(?<![a-z0-9])${escapeRegExp(code)}(?![a-z0-9])`).test(haystack),
  );
  return found.slice(0, MAX_SUGGESTED_TAGS);
}
