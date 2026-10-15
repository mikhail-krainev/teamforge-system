import { TeamsListPage } from '@/features/teams/TeamsListPage';
import { t } from '@/i18n';

export default function Page() {
  return (
    <div className="page-wide">
      <h1>{t('teams.list.title')}</h1>
      <p className="lead">{t('teams.list.lead')}</p>
      <TeamsListPage />
    </div>
  );
}
