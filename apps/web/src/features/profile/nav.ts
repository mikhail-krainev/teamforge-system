import type { NavItem } from '@/components/shell/nav-types';

export const navItems: NavItem[] = [
  { id: 'profile', href: '/profile', labelKey: 'profile.nav.profile', order: 10 },
  { id: 'settings', href: '/settings', labelKey: 'profile.nav.settings', order: 90 },
];
