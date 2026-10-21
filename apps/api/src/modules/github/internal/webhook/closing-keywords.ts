/** `Closes #12`, `fixed: #3`, `RESOLVES #7`: the keywords GitHub links a pull request to an issue by. */
const CLOSING_REFERENCE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d{1,9})\b/gi;

/** Numbers of the issues of the same repository that the text of a pull request promises to close. */
export function closedIssueNumbers(body: string | null | undefined): number[] {
  if (!body) return [];
  const numbers = new Set<number>();
  for (const match of body.matchAll(CLOSING_REFERENCE)) {
    const number = Number(match[1]);
    if (number > 0) numbers.add(number);
  }
  return [...numbers];
}
