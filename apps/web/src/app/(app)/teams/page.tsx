import { CtaPair, PageHead } from '@/components/ui/PageHead';
import { TeamsListPage } from '@/features/teams/TeamsListPage';
import { t } from '@/i18n';

export default function Page() {
  return (
    <div className="page-wide">
      <PageHead
        title={
          <>
            {t('teams.list.headBefore')}
            <span className="serif">{t('teams.list.headSerif')}</span>
            {t('teams.list.headAfter')}
          </>
        }
        lead={t('teams.list.lead')}
      >
        <CtaPair href="/teams/new" icon="plus">
          {t('teams.list.create')}
        </CtaPair>
      </PageHead>
      <TeamsListPage />
    </div>
  );
}
