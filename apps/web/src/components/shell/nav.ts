import { allNavItems } from './nav.generated';
import type { NavItem } from './nav-types';

/** Navigation collected from every feature nav file, sorted and without duplicate ids. */
export function collectNavItems(items: readonly NavItem[] = allNavItems): NavItem[] {
  const unique = new Map<string, NavItem>();
  for (const item of items) unique.set(item.id, item);
  return [...unique.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}
