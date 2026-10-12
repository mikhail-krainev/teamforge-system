import { ApiStatusCard } from '@/features/status/ApiStatusCard';
import { t } from '@/i18n';

export default function HomePage() {
  return (
    <>
      <h1>{t('home.heading')}</h1>
      <p className="lead">{t('home.lead')}</p>
      <ApiStatusCard />
    </>
  );
}
