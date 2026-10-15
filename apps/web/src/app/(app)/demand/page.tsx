import { DemandPage } from '@/features/matching/DemandPage';
import { t } from '@/i18n';

export default function Page() {
  return (
    <div className="page-wide">
      <h1>{t('matching.demand.title')}</h1>
      <p className="lead">{t('matching.demand.lead')}</p>
      <DemandPage />
    </div>
  );
}
