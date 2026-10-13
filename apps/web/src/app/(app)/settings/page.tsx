import { DeletionSection } from '@/features/profile/settings/DeletionSection';
import { GithubSection } from '@/features/profile/settings/GithubSection';
import { t } from '@/i18n';

export default function SettingsPage() {
  return (
    <div className="page-wide">
      <h1>{t('profile.settings.title')}</h1>
      <GithubSection />
      <DeletionSection />
    </div>
  );
}
