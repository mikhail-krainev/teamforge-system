'use client';

import { useQuery } from '@tanstack/react-query';
import type { Schema } from 'shared';
import { Alert } from '@/components/ui/Alert';
import { apiClient } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { describeError } from '@/lib/api/error-message';
import { AwardsBlock } from '@/features/rewards/AwardsBlock';
import { t } from '@/i18n';
import { useRoles } from './useProfileQueries';
import { levelLabel } from './model';

type PublicProfile = Schema<'PublicProfile'>;

/** `getPublicProfile`; `null` when the user does not exist (404). */
async function fetchPublicProfile(userId: string): Promise<PublicProfile | null> {
  try {
    const { data } = await apiClient.GET('/v1/users/{userId}/profile', {
      params: { path: { userId } },
    });
    return data ?? null;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/** Only https links are rendered as links (the contract allows nothing else, but never trust a body). */
export function safeHttpsUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

export function PublicProfileView({ userId }: { userId: string }) {
  const query = useQuery({
    queryKey: ['profile', 'public', userId],
    queryFn: () => fetchPublicProfile(userId),
  });
  const roles = useRoles();

  if (query.isPending) return <p role="status">{t('profile.public.loading')}</p>;
  if (query.isError) {
    return (
      <Alert tone="error">
        <p>{describeError(query.error)}</p>
        <button
          type="button"
          className="button button-secondary"
          onClick={() => void query.refetch()}
        >
          {t('profile.public.retry')}
        </button>
      </Alert>
    );
  }
  const profile = query.data;
  if (!profile) return <Alert tone="info">{t('profile.public.notFound')}</Alert>;
  if (profile.isDeleted) return <Alert tone="info">{t('profile.public.deleted')}</Alert>;
  const roleName = (code: string) => roles.data?.find((r) => r.code === code)?.name ?? code;
  return (
    <div className="stack">
      <ProfileCard profile={profile} roleName={roleName} />
      <AwardsBlock userId={userId} />
    </div>
  );
}

function ProfileCard({
  profile,
  roleName,
}: {
  profile: PublicProfile;
  roleName: (code: string) => string;
}) {
  const portfolio = safeHttpsUrl(profile.portfolioUrl);
  const roles = profile.rolePrefs.map((r) => `${roleName(r.roleCode)}, ${levelLabel(r.level)}`);
  return (
    <article className="card stack" aria-labelledby="public-name">
      <h1 id="public-name">{profile.displayName || t('profile.public.anonymous')}</h1>
      <p className="muted">
        {t('profile.public.timezone', { timezone: profile.timezone })}
        <br />
        {t('profile.public.hours', { hours: profile.hoursPerWeek })}
      </p>
      <TagSection id="public-roles" title={t('profile.public.roles')} items={roles} />
      <TagSection id="public-stack" title={t('profile.public.stack')} items={profile.stack} />
      <PublicExperience items={profile.experience ?? []} />
      <ListSection
        id="public-strengths"
        title={t('profile.public.strengths')}
        items={profile.strengths ?? []}
      />
      {portfolio ? (
        <p>
          <a href={portfolio} rel="noopener noreferrer nofollow" target="_blank">
            {t('profile.public.portfolio')}
          </a>
        </p>
      ) : null}
    </article>
  );
}

function TagSection({ id, title, items }: { id: string; title: string; items: readonly string[] }) {
  if (items.length === 0) return null;
  return (
    <section aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      <ul className="tag-list">
        {items.map((item) => (
          <li key={item} className="tag">
            {item}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ListSection({
  id,
  title,
  items,
}: {
  id: string;
  title: string;
  items: readonly string[];
}) {
  if (items.length === 0) return null;
  return (
    <section aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

function PublicExperience({ items }: { items: NonNullable<PublicProfile['experience']> }) {
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="public-exp">
      <h2 id="public-exp">{t('profile.public.experience')}</h2>
      <ul className="stack">
        {items.map((item, index) => (
          <li key={`${item.title}-${item.from}-${index}`}>
            <strong>{item.title}</strong>
            <br />
            <span className="muted">
              {t('profile.public.experiencePeriod', {
                from: item.from,
                to: item.to ?? t('profile.public.experienceNow'),
              })}
            </span>
            {item.description ? <p>{item.description}</p> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
