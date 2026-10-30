import { DeletionSection } from '@/features/profile/settings/DeletionSection';
import { GithubSection } from '@/features/profile/settings/GithubSection';
import { t } from '@/i18n';
import '@/features/profile/profile.css';

export default function SettingsPage() {
  return (
    <div className="page-wide">
      <header className="page-head">
        <h1>{t('profile.settings.title')}</h1>
      </header>
      <GithubSection />
      <DeletionSection />
    </div>
  );
}
