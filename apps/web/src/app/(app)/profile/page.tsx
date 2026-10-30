import { AdminLink } from '@/features/admin/AdminLink';
import { RoleDemandBlock } from '@/features/matching/RoleDemandBlock';
import { ProfilePage } from '@/features/profile/ProfilePage';
import { OwnAwardsBlock } from '@/features/rewards/AwardsBlock';
import { t } from '@/i18n';
import '@/features/profile/profile.css';

export default function Page() {
  return (
    <div className="page-wide">
      <header className="page-head">
        <h1>
          {t('profile.page.titleBefore')}{' '}
          <span className="serif">{t('profile.page.titleSerif')}</span>
        </h1>
        <div className="page-aside">
          <p className="lead">{t('profile.page.lead')}</p>
        </div>
      </header>
      <RoleDemandBlock />
      <ProfilePage />
      <OwnAwardsBlock />
      <AdminLink />
    </div>
  );
}
