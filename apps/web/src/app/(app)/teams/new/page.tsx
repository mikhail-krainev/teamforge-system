import { CreateTeamForm } from '@/features/teams/CreateTeamForm';
import { t } from '@/i18n';

export default function Page() {
  return (
    <div className="page-wide">
      <h1>{t('teams.create.title')}</h1>
      <p className="lead">{t('teams.create.lead')}</p>
      <CreateTeamForm />
    </div>
  );
}
