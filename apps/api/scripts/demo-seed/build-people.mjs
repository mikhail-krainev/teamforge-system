// Accounts, consents and profiles of the demo people.
import { DAY_MS, GITHUB_ID_BASE, HOUR_MS } from './world.mjs';

/** Adds every person; `consent` is the current version and text hash, so nobody lands on the consent screen. */
export function buildPeople(world, people, consent) {
  people.forEach((p, index) => {
    const userId = world.id();
    const createdAt = world.ago(p.createdDaysAgo);
    const githubUserId = p.githubLogin ? GITHUB_ID_BASE + 1 + index : null;
    const person = { ...p, userId, createdAt, githubUserId, isDemo: p.key.startsWith('demo-') };
    world.people.set(p.key, person);
    world.add('auth.user', {
      id: userId,
      name: p.name,
      email: p.email,
      email_verified: true,
      email_normalized: p.email.toLowerCase(),
      image: null,
      github_user_id: githubUserId,
      github_login: p.githubLogin,
      status: 'active',
      is_admin: p.isAdmin === true,
      locale: 'ru',
      last_seen_at: world.ago(world.between(0, 3)),
      created_at: createdAt,
      updated_at: createdAt,
    });
    world.add('auth.consent', {
      id: world.id(),
      user_id: userId,
      version: consent.version,
      text_hash: consent.textHash,
      accepted_at: new Date(createdAt.getTime() + 5 * 60_000),
      ip_hash: null,
      revoked_at: null,
    });
    addProfile(world, person);
    if (githubUserId !== null) addGithubAccount(world, person);
  });
}

function addProfile(world, p) {
  world.add('profiles.profile', {
    user_id: p.userId,
    display_name: p.name,
    timezone: p.timezone,
    hours_per_week: p.hours,
    portfolio_url: p.portfolio,
    strengths: p.strengths,
    weaknesses: p.weaknesses,
    text_fingerprint: null,
    version: 2,
    updated_at: new Date(p.createdAt.getTime() + HOUR_MS),
  });
  p.roles.forEach(([role, level], ordinal) =>
    world.add('profiles.profile_role_pref', { user_id: p.userId, role_code: role, level, ordinal }),
  );
  for (const tag of p.stack)
    world.add('profiles.profile_stack', { user_id: p.userId, stack_tag_code: tag });
  p.experience.forEach((e, ordinal) =>
    world.add('profiles.profile_experience', {
      id: world.id(),
      user_id: p.userId,
      title: e.title,
      description: e.description ?? null,
      period_from: e.from,
      period_to: e.to,
      ordinal,
    }),
  );
}

/** The GitHub identity and its account check (anti-fraud reads it at completion). */
function addGithubAccount(world, p) {
  world.add('auth.account', {
    id: world.id(),
    user_id: p.userId,
    provider_id: 'github',
    account_id: String(p.githubUserId),
    created_at: p.createdAt,
    updated_at: p.createdAt,
  });
  world.add('github.account_check', {
    github_user_id: p.githubUserId,
    account_created_at: new Date(p.createdAt.getTime() - world.int(300, 2000) * DAY_MS),
    public_repos: world.int(2, 30),
    has_public_activity: true,
    checked_at: p.createdAt,
  });
}
