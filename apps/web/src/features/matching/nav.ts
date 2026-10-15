import type { NavItem } from '@/components/shell/nav-types';

export const navItems: NavItem[] = [
  { id: 'search', href: '/search', labelKey: 'matching.nav.search', order: 40 },
  { id: 'demand', href: '/demand', labelKey: 'matching.nav.demand', order: 45 },
];
