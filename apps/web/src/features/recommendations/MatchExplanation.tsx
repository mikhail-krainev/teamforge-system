import { t } from '@/i18n';
import type { MatchReasons } from './api';

const pct = (value: number) => Math.round(value * 100);

/** Lines explaining why the pair fits: the role and every score factor of the contract. */
export function reasonLines(reasons: MatchReasons): string[] {
  const lines = [reasons.role ? t('matching.reasons.role') : t('matching.reasons.roleNo')];
  const stack = t('matching.reasons.stack', { pct: pct(reasons.stack) });
  lines.push(
    reasons.matchedStackTags.length > 0
      ? `${stack} (${t('matching.reasons.stackTags', { tags: reasons.matchedStackTags.join(', ') })})`
      : stack,
  );
  lines.push(t('matching.reasons.level', { pct: pct(reasons.level) }));
  const zone = t('matching.reasons.timezone', { pct: pct(reasons.timezone) });
  lines.push(
    reasons.timezoneDiffHours === undefined
      ? zone
      : `${zone} (${t('matching.reasons.timezoneDiff', { hours: Math.abs(reasons.timezoneDiffHours) })})`,
  );
  lines.push(t('matching.reasons.availability', { pct: pct(reasons.availability) }));
  lines.push(t('matching.reasons.completedProjects', { pct: pct(reasons.completedProjects) }));
  return lines;
}

/** Score badge and the explanation list of one recommendation. */
export function MatchExplanation({ score, reasons }: { score: number; reasons: MatchReasons }) {
  return (
    <div className="stack">
      <p>
        <span className="tag">{t('matching.reasons.score', { pct: pct(score) })}</span>
      </p>
      <ul aria-label={t('matching.reasons.title')} className="muted">
        {reasonLines(reasons).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}
