const WEAK_SECRETS = new Set([
  'changeme',
  'change-me',
  'secret',
  'password',
  'default',
  'example',
  'test',
  'development',
]);

/** A secret is weak when it is short, a known placeholder, or has too few distinct characters. */
export function isWeakSecret(value: string, minLength = 32): boolean {
  if (value.length < minLength) return true;
  if (WEAK_SECRETS.has(value.toLowerCase())) return true;
  return new Set(value).size < 10;
}
