import { IntlMessageFormat } from 'intl-messageformat';

export type MessageParams = Record<string, string | number | boolean | Date | null | undefined>;

export interface MessageTree {
  [key: string]: string | MessageTree;
}

/** Joins nested dictionary objects into dot-separated keys (`status.ok`). */
export function flatten(tree: MessageTree, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out[path] = value;
    else Object.assign(out, flatten(value, path));
  }
  return out;
}

/**
 * Builds `t(key, params)` over flat messages written in ICU MessageFormat
 * (plural rules come from Intl.PluralRules, so Russian one/few/many/other work).
 * An unknown key renders as the key itself instead of breaking the page.
 */
export function createTranslator<K extends string>(
  messages: Readonly<Record<K, string>>,
  locale = 'ru',
) {
  const cache = new Map<string, IntlMessageFormat>();
  const lookup: Readonly<Record<string, string | undefined>> = messages;

  function has(key: string): key is K {
    return lookup[key] !== undefined;
  }

  function t(key: K, params?: MessageParams): string {
    const message = lookup[key];
    if (message === undefined) return key;
    let format = cache.get(key);
    if (!format) {
      format = new IntlMessageFormat(message, locale);
      cache.set(key, format);
    }
    return String(format.format(params));
  }

  return { t, has };
}
