import { SearchPage } from '@/features/matching/SearchPage';
import { t } from '@/i18n';

export default function Page() {
  return (
    <div className="page-wide">
      <h1>{t('matching.search.title')}</h1>
      <p className="lead">{t('matching.search.lead')}</p>
      <SearchPage />
    </div>
  );
}
