import type { MessageKey } from '@/i18n';

/** A navigation entry; each feature declares its own in `features/<feature>/nav.ts`. */
export interface NavItem {
  id: string;
  href: string;
  labelKey: MessageKey;
  /** Ascending sort order within the navigation bar. */
  order: number;
}
