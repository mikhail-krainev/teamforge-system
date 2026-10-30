import { t } from '@/i18n';
import { useRoles } from '../useProfileQueries';
import type { ResumeUpload } from './api';

type Assessment = NonNullable<ResumeUpload['assessment']>;

const MONTHS_IN_YEAR = 12;

function experienceText(months: number): string {
  if (months === 0) return t('profile.resume.assessment.noExperience');
  return t('profile.resume.assessment.experience', {
    years: Math.floor(months / MONTHS_IN_YEAR),
    months: months % MONTHS_IN_YEAR,
  });
}

function Summary({ assessment }: { assessment: Assessment }) {
  const { score, level, seniority } = assessment;
  return (
    <div className="resume-assessment-summary" data-level={level}>
      <meter
        className="resume-score"
        min={0}
        max={100}
        low={45}
        high={80}
        optimum={100}
        value={score}
        aria-label={t('profile.resume.assessment.scoreLabel')}
      />
      <dl className="resume-assessment-facts">
        <div>
          <dt>{t('profile.resume.assessment.scoreLabel')}</dt>
          <dd className="resume-score-value">{t('profile.resume.assessment.score', { score })}</dd>
        </div>
        <div>
          <dt>{t('profile.resume.assessment.levelLabel')}</dt>
          <dd>
            <span className="resume-level">{t(`profile.resume.assessment.level.${level}`)}</span>
          </dd>
        </div>
        <div>
          <dt>{t('profile.resume.assessment.seniorityLabel')}</dt>
          <dd>
            {t(`profile.resume.assessment.seniority.${seniority}`)}
            <span className="muted"> · {experienceText(assessment.experienceMonths)}</span>
          </dd>
        </div>
      </dl>
    </div>
  );
}

function Criteria({ criteria }: { criteria: Assessment['criteria'] }) {
  return (
    <>
      <h4>{t('profile.resume.assessment.criteriaTitle')}</h4>
      <ul className="resume-criteria">
        {criteria.map(({ code, points, max }) => (
          <li key={code}>
            <span>{t(`profile.resume.assessment.criterion.${code}`)}</span>
            <progress value={points} max={max} aria-hidden="true" />
            <span className="mono">{t('profile.resume.assessment.points', { points, max })}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function Conclusion({ assessment }: { assessment: Assessment }) {
  const catalog = useRoles();
  const roleName = (code: string) => catalog.data?.find((role) => role.code === code)?.name ?? code;
  const grade = t(`profile.resume.assessment.seniority.${assessment.seniority}`);
  const [best, ...others] = assessment.roles;
  return (
    <section className="stack resume-conclusion" aria-labelledby="resume-conclusion-heading">
      <h4 id="resume-conclusion-heading">{t('profile.resume.assessment.conclusionTitle')}</h4>
      <p className="resume-conclusion-main">
        {best
          ? t('profile.resume.assessment.conclusion', { role: roleName(best.code), grade })
          : t('profile.resume.assessment.conclusionNoRole', { grade })}
      </p>
      {others.length > 0 ? (
        <p className="muted">
          {t('profile.resume.assessment.alsoFits', {
            roles: others
              .map((role) =>
                t('profile.resume.assessment.roleMatch', {
                  role: roleName(role.code),
                  match: role.match,
                }),
              )
              .join(', '),
          })}
        </p>
      ) : null}
    </section>
  );
}

interface Note {
  key: string;
  text: string;
  badge?: string | undefined;
}

function Notes({
  title,
  empty,
  tone,
  items,
}: {
  title: string;
  empty?: string;
  tone: 'plus' | 'minus' | 'tip';
  items: Note[];
}) {
  if (items.length === 0 && !empty) return null;
  return (
    <section className="stack resume-notes" data-tone={tone}>
      <h4>{title}</h4>
      {items.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <ul>
          {items.map((item) => (
            <li key={item.key}>
              {item.text}
              {item.badge ? <span className="resume-badge">{item.badge}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const ASSESSMENT = 'profile.resume.assessment';

/**
 * Score, level and grade of the resume, the conclusion (best fitting role and grade), its strengths
 * and holes, the points per criterion and tips.
 */
export function ResumeAssessment({ assessment }: { assessment: Assessment }) {
  const stopFactors = new Set<string>(assessment.redFlags);
  return (
    <section className="stack resume-assessment" aria-labelledby="resume-assessment-heading">
      <h3 id="resume-assessment-heading">{t(`${ASSESSMENT}.title`)}</h3>
      <p className="muted">{t(`${ASSESSMENT}.lead`)}</p>
      <Summary assessment={assessment} />
      <Conclusion assessment={assessment} />
      <div className="resume-pros-cons">
        <Notes
          title={t(`${ASSESSMENT}.strengthsTitle`)}
          empty={t(`${ASSESSMENT}.strengthsEmpty`)}
          tone="plus"
          items={assessment.strengths.map((code) => ({
            key: code,
            text: t(`${ASSESSMENT}.strength.${code}`),
          }))}
        />
        <Notes
          title={t(`${ASSESSMENT}.weaknessesTitle`)}
          empty={t(`${ASSESSMENT}.weaknessesEmpty`)}
          tone="minus"
          items={assessment.weaknesses.map((code) => ({
            key: code,
            text: t(`${ASSESSMENT}.weakness.${code}`),
            badge: stopFactors.has(code) ? t(`${ASSESSMENT}.stopFactor`) : undefined,
          }))}
        />
      </div>
      <Criteria criteria={assessment.criteria} />
      <Notes
        title={t(`${ASSESSMENT}.tipsTitle`)}
        tone="tip"
        items={assessment.tips.map((code) => ({ key: code, text: t(`${ASSESSMENT}.tip.${code}`) }))}
      />
    </section>
  );
}
