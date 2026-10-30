import { PageHead } from '@/components/ui/PageHead';
import { CreateTeamForm } from '@/features/teams/CreateTeamForm';
import { t } from '@/i18n';

export default function Page() {
  return (
    <div className="page-wide">
      <PageHead title={t('teams.create.title')} lead={t('teams.create.lead')} />
      <CreateTeamForm />
    </div>
  );
}
