import Link from 'next/link';
import { LiveYeti } from '@/components/mascot/LiveYeti';
import { HeroScene } from '@/features/home/HeroScene';
import { HomeScene, SceneBand } from '@/features/home/HomeScene';
import { OfficeMap } from '@/features/home/OfficeMap';
import { Roadmap } from '@/features/home/Roadmap';
import { WorkBoard } from '@/features/home/WorkBoard';
import { ApiStatusCard } from '@/features/status/ApiStatusCard';
import { t, type MessageKey } from '@/i18n';
import './home.css';
import './home-motion.css';

/** Pixel plus between the marquee roles. */
function Plus() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M7 0h4v7h7v4h-7v7H7v-7H0V7h7z" />
    </svg>
  );
}

function ArrowRight() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <path d="M3 9h11M9.5 4.5 14 9l-4.5 4.5" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

/** Hand-drawn loop under the serif word; draws itself on load. */
function Scribble() {
  return (
    <svg
      className="scribble"
      viewBox="0 0 220 28"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        pathLength={1}
        d="M4 17C40 6 96 4 150 8c40 3 62 8 64 13-3 4-40 5-96 3C70 22 30 20 12 14"
        fill="none"
        stroke="currentColor"
        strokeWidth="3.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Loose riso shapes for the final CTA; decorative. */
function Drift() {
  return (
    <svg className="drift" viewBox="0 0 240 200" aria-hidden="true" focusable="false">
      <g className="drift-a">
        <circle cx="44" cy="46" r="22" fill="var(--pink)" stroke="var(--black)" strokeWidth="2" />
      </g>
      <g className="drift-b">
        <path d="M150 20h24v24h-24z" fill="var(--blue)" stroke="var(--black)" strokeWidth="2" />
      </g>
      <g className="drift-c">
        <path
          d="M92 120h16v-16h16v16h16v16h-16v16h-16v-16H92z"
          fill="var(--green)"
          stroke="var(--black)"
          strokeWidth="2"
        />
      </g>
      <g className="drift-d">
        <path d="M200 120l22 38h-44z" fill="var(--orange)" stroke="var(--black)" strokeWidth="2" />
      </g>
      <g className="drift-e">
        <circle cx="30" cy="150" r="9" fill="var(--black)" />
      </g>
    </svg>
  );
}

function CtaPair({ href, label }: { href: string; label: string }) {
  return (
    <Link className="cta-pair" href={href}>
      <span className="button">{label}</span>
      <span className="arrow">
        <ArrowRight />
      </span>
    </Link>
  );
}

const MARQUEE_ROLES = [
  'frontend',
  'backend',
  'design',
  'qa',
  'analytics',
  'mobile',
  'devops',
  'product',
] as const;

function Marquee() {
  const items = (
    <span>
      {MARQUEE_ROLES.map((role) => (
        <span key={role} className="marquee-role">
          <span className={`role-${role}`}>{t(`home.marquee.${role}`)}</span> <Plus />{' '}
        </span>
      ))}
    </span>
  );
  return (
    <div className="marquee marquee-live" aria-hidden="true" data-yeti-ledge>
      <div className="marquee-row">
        <div className="marquee-track">
          {items}
          {items}
        </div>
      </div>
      <div className="marquee-row marquee-row-back">
        <div className="marquee-track marquee-track-back">
          {items}
          {items}
        </div>
      </div>
    </div>
  );
}

const JOIN_STEPS: { titleKey: MessageKey; bodyKey: MessageKey }[] = [
  { titleKey: 'home.join.queueTitle', bodyKey: 'home.join.queueBody' },
  { titleKey: 'home.join.matchTitle', bodyKey: 'home.join.matchBody' },
  { titleKey: 'home.join.trialTitle', bodyKey: 'home.join.trialBody' },
];

function Join() {
  return (
    <section className="section container join-section" aria-labelledby="join-title">
      <div className="grid-12 join">
        <div className="join-head">
          <span className="section-mark">{t('home.join.mark')}</span>
          <h2 id="join-title">
            {t('home.join.headingStart')}{' '}
            <span className="serif">{t('home.join.headingAccent')}</span>{' '}
            {t('home.join.headingEnd')}
          </h2>
        </div>
        <ul className="join-list">
          {JOIN_STEPS.map((step) => (
            <li key={step.titleKey} className="join-item" data-yeti-ledge>
              <h3>{t(step.titleKey)}</h3>
              <p>{t(step.bodyKey)}</p>
            </li>
          ))}
        </ul>
      </div>
      <OfficeMap />
    </section>
  );
}

const AUDIENCE_CARDS: {
  color: 'yellow' | 'blue';
  labelKey: MessageKey;
  titleKey: MessageKey;
  bodyKey: MessageKey;
}[] = [
  {
    color: 'yellow',
    labelKey: 'home.audience.students.label',
    titleKey: 'home.audience.students.title',
    bodyKey: 'home.audience.students.body',
  },
  {
    color: 'blue',
    labelKey: 'home.audience.partners.label',
    titleKey: 'home.audience.partners.title',
    bodyKey: 'home.audience.partners.body',
  },
];

function Audience() {
  return (
    <section id="audience" className="section container peek" aria-labelledby="audience-title">
      <div className="section-head grid-12">
        <span className="section-mark">{t('home.audience.mark')}</span>
        <h2 id="audience-title">
          {t('home.audience.headingStart')}{' '}
          <span className="serif">{t('home.audience.headingAccent')}</span>
        </h2>
      </div>
      <ul className="peek-strip audience-strip">
        {AUDIENCE_CARDS.map((card) => (
          <li key={card.titleKey} className={`peek-card block block-${card.color}`} data-yeti-ledge>
            <span className="mono">{t(card.labelKey)}</span>
            <h3>{t(card.titleKey)}</h3>
            <p>{t(card.bodyKey)}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Honest() {
  return (
    <section className="container" aria-label={t('home.honest.label')}>
      <div className="block block-ink honest" data-yeti-ledge>
        <p className="statement">
          {t('home.honest.statementStart')}{' '}
          <span className="serif">{t('home.honest.statementAccent')}</span>{' '}
          {t('home.honest.statementEnd')}
        </p>
        <div className="scallop honest-note">
          <span className="mono">{t('home.honest.awardsMark')}</span>
          <p>{t('home.honest.awardsBody')}</p>
        </div>
      </div>
    </section>
  );
}

function Hero() {
  return (
    <div className="hero-wrap">
      <HeroScene />
      <div className="hero-stickers" aria-hidden="true">
        <span className="sticker sticker-pink hero-sticker-a">{t('home.stickerFree')}</span>
        <span className="sticker sticker-green hero-sticker-b">{t('home.stickerNoRatings')}</span>
      </div>
      <section className="hero grid-12" aria-labelledby="hero-title">
        <h1 id="hero-title" className="hero-title">
          <span className="sr-only">{t('home.heading')}. </span>
          <span className="hero-line">
            <span className="hero-line-in">{t('home.heroTitleStart')}</span>
          </span>{' '}
          <span className="hero-line hero-line-2">
            <span className="hero-line-in">{t('home.heroTitleMiddle')}</span>
          </span>{' '}
          <span className="hero-line hero-line-3">
            <span className="hero-line-in">
              <span className="serif hero-accent">
                {t('home.heroTitleAccent')}
                <Scribble />
              </span>{' '}
              {t('home.heroTitleEnd')}
            </span>
          </span>
        </h1>
        <div className="hero-mascot">
          <LiveYeti
            pose="wave"
            size={132}
            greeting={t('home.yetiHello')}
            className="hero-yeti-slot"
          />
        </div>
        <div className="hero-aside" data-yeti-ledge>
          <p className="lead">{t('home.lead')}</p>
          <div className="row">
            <CtaPair href="/search" label={t('home.heroCta')} />
            <a className="text-link" href="#audience">
              {t('home.heroSecondary')}
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}

export default function HomePage() {
  return (
    <HomeScene>
      <Hero />

      <Marquee />
      <Audience />
      <SceneBand kind="lights" />
      <Roadmap />
      <WorkBoard />
      <SceneBand kind="ridge" />
      <Join />
      <SceneBand kind="lights" />
      <Honest />

      <section className="section container" aria-labelledby="cta-title">
        <div className="block block-yellow cta-final" data-yeti-ledge>
          <Drift />
          <h2 id="cta-title">
            {t('home.cta.headingStart')}{' '}
            <span className="serif">{t('home.cta.headingAccent')}</span>.
          </h2>
          <div className="row">
            <CtaPair href="/profile" label={t('home.cta.button')} />
          </div>
        </div>
      </section>

      <ApiStatusCard />
      <SceneBand kind="valley" />
    </HomeScene>
  );
}
