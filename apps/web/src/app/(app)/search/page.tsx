import { PageHead } from '@/components/ui/PageHead';
import { SearchPage } from '@/features/matching/SearchPage';
import { t } from '@/i18n';

export default function Page() {
  return (
    <div className="page-wide">
      <PageHead title={t('matching.search.title')} lead={t('matching.search.lead')} />
      <SearchPage />
    </div>
  );
}
