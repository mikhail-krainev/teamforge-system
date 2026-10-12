export const TEMPLATE_DB = 'tf_template';

/** Same server and credentials, different database name. */
export function databaseUrlFor(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}
