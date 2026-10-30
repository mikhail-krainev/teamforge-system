import Link from 'next/link';
import type { ReactNode } from 'react';

interface PageHeadProps {
  title: ReactNode;
  lead?: ReactNode;
  /** An id for the h1 when the page names a region after it. */
  titleId?: string;
  /** Primary action shown under the lead. */
  children?: ReactNode;
}

/** App page header: the title on the left, a muted sentence and one action on the right. */
export function PageHead({ title, lead, titleId, children }: PageHeadProps) {
  return (
    <div className="page-head">
      <h1 id={titleId}>{title}</h1>
      {lead || children ? (
        <div className="page-aside">
          {lead ? <p>{lead}</p> : null}
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** A pill link with a round arrow beside it; reads as one link. */
export function CtaPair({
  href,
  children,
  icon = 'arrow',
}: {
  href: string;
  children: ReactNode;
  icon?: 'arrow' | 'plus';
}) {
  return (
    <Link href={href} className="cta-pair">
      <span className="button">{children}</span>
      <span className="arrow" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 18 18">
          <path
            d={icon === 'plus' ? 'M9 3v12M3 9h12' : 'M3 9h11M9.5 4.5 14 9l-4.5 4.5'}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          />
        </svg>
      </span>
    </Link>
  );
}
