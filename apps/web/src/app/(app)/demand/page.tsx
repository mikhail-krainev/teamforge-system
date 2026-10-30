import { PageHead } from '@/components/ui/PageHead';
import { DemandPage } from '@/features/matching/DemandPage';
import { t } from '@/i18n';

export default function Page() {
  return (
    <div className="page-wide">
      <PageHead title={t('matching.demand.title')} lead={t('matching.demand.lead')} />
      <DemandPage />
    </div>
  );
}
