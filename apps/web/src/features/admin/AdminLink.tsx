'use client';

import Link from 'next/link';
import { useMe } from '@/features/auth/session';
import { t } from '@/i18n';

/** A link to the manual review for administrators only (the api checks the right itself). */
export function AdminLink() {
  const me = useMe();
  if (!me.data?.isAdmin) return null;
  return (
    <p>
      <Link href="/admin/fraud">{t('fraud.title')}</Link>
    </p>
  );
}
