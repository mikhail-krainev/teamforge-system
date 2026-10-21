import { AdminLink } from '@/features/admin/AdminLink';
import { RoleDemandBlock } from '@/features/matching/RoleDemandBlock';
import { ProfilePage } from '@/features/profile/ProfilePage';
import { OwnAwardsBlock } from '@/features/rewards/AwardsBlock';
import { t } from '@/i18n';

export default function Page() {
  return (
    <div className="page-wide">
      <h1>{t('profile.page.title')}</h1>
      <p className="lead">{t('profile.page.lead')}</p>
      <RoleDemandBlock />
      <ProfilePage />
      <OwnAwardsBlock />
      <AdminLink />
    </div>
  );
}
