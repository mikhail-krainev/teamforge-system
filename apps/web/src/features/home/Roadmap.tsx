import type { CSSProperties } from 'react';
import { t, type MessageKey } from '@/i18n';
import './Roadmap.css';

interface Stage {
  n: 1 | 2 | 3;
  color: 'yellow' | 'blue' | 'green';
  titleKey: MessageKey;
  itemKeys: MessageKey[];
  /** Scroll progress (cover %) at which the trail reaches this stage. */
  reachedAt: number;
}

/** The trail draws between these two points of the section's view timeline, ending with the section centred. */
const DRAW_FROM = 8;
const DRAW_TO = 50;
const along = (fraction: number) => Math.round((DRAW_FROM + (DRAW_TO - DRAW_FROM) * fraction) * 10) / 10;

/** Where the stops sit on the trail, as a share of its length; measured from TRAIL. */
const STOPS = [
  { x: 410, y: 175, at: 0.272 },
  { x: 560, y: 365, at: 0.453 },
  { x: 520, y: 505, at: 0.633 },
] as const;

const STAGES: Stage[] = [
  {
    n: 1,
    color: 'yellow',
    titleKey: 'home.route.idea.title',
    itemKeys: ['home.route.idea.a', 'home.route.idea.b', 'home.route.idea.c'],
    reachedAt: along(STOPS[0].at),
  },
  {
    n: 2,
    color: 'blue',
    titleKey: 'home.route.build.title',
    itemKeys: ['home.route.build.a', 'home.route.build.b', 'home.route.build.c'],
    reachedAt: along(STOPS[1].at),
  },
  {
    n: 3,
    color: 'green',
    titleKey: 'home.route.release.title',
    itemKeys: ['home.route.release.a', 'home.route.release.b', 'home.route.release.c'],
    reachedAt: along(STOPS[2].at),
  },
];

/** One wandering trail through the three stops; the wobble is on purpose. */
const TRAIL =
  'M70 70C210 20 330 70 410 175C490 275 440 335 560 365C690 395 640 470 520 505C400 540 470 610 640 612C740 614 800 606 868 566';

/** Loose contour lines of the paper map, drawn by hand. */
function Contours() {
  return (
    <g className="road-contours" fill="none">
      <path d="M612 40c60-18 150-10 196 30 40 36 18 86-40 96-70 12-150-8-176-48-18-30-8-64 20-78z" />
      <path d="M640 62c44-12 110-6 140 22 26 26 10 58-30 64-48 8-100-6-118-32-12-20-8-44 8-54z" />
      <path d="M672 82c24-6 60-2 76 12 14 14 4 30-18 32-26 4-54-4-62-16-6-12-4-24 4-28z" />
      <path d="M-10 600c70-30 160-40 230-6 60 30 50 80-20 92" />
      <path d="M-10 628c60-22 130-28 186-2 44 22 40 54-6 64" />
      <path d="M760 690c20-60 90-96 170-90 50 4 80 30 80 60" />
    </g>
  );
}

function Landmarks() {
  return (
    <g className="road-doodles" strokeLinecap="round" strokeLinejoin="round">
      {/* mountains with snow caps */}
      <path className="road-fill-grey" d="M684 108l42-70 26 34 24-30 48 66z" />
      <path className="road-fill-paper" d="M714 58l12-20 10 13-8 2-6-4-6 6z" />
      <path className="road-fill-paper" d="M770 52l6-8 7 9-6-1z" />
      {/* river with a little bridge */}
      <path className="road-river" d="M940 250c-30 40 10 70-20 110s10 70-14 110" />
      <path className="road-line" d="M904 316h40M904 326h40M908 316v10M940 316v10" />
      {/* pines */}
      <g className="road-pine">
        <path d="M112 470l-18 34h36z" />
        <path d="M112 452l-14 26h28z" />
        <path className="road-line" d="M112 504v14" />
      </g>
      <g className="road-pine" transform="translate(70 34) scale(.8)">
        <path d="M112 470l-18 34h36z" />
        <path d="M112 452l-14 26h28z" />
        <path className="road-line" d="M112 504v14" />
      </g>
      {/* compass rose */}
      <g className="road-compass" transform="translate(930 110)">
        <circle r="26" />
        <path className="road-fill-pink" d="M0-36l7 30-7 6-7-6z" />
        <path className="road-fill-paper" d="M0 36l7-30-7-6-7 6z" />
        <path className="road-line" d="M-4-36v-10l8 10v-10" />
      </g>
      {/* clouds */}
      <path className="road-fill-paper" d="M820 180c10-14 30-14 38 0 22-4 30 18 12 26h-60c-14-4-8-22 10-26z" />
      <path className="road-fill-paper" d="M250 380c8-10 22-10 28 0 16-3 22 13 9 19h-44c-10-3-6-16 7-19z" />
      {/* stars and waves */}
      <path className="road-fill-yellow" d="M930 380l6 14 15 2-11 10 3 15-13-8-13 8 3-15-11-10 15-2z" />
      <path className="road-fill-yellow" d="M280 640l5 11 12 1-9 8 2 12-10-6-10 6 2-12-9-8 12-1z" />
      <path className="road-line" d="M60 330c20-20 40 20 60 0M64 350c20-20 40 20 60 0" />
      <path className="road-line" d="M730 270c40-10 70 10 90 40m-12-4l12-2-2-12" />
      {/* tent at the finish */}
      <g transform="translate(930 560)">
        <path className="road-fill-orange" d="M-34 40l34-56 34 56z" />
        <path className="road-fill-ink" d="M0-16l-10 56h20z" />
        <path className="road-line" d="M-44 40h88" />
      </g>
    </g>
  );
}

function Flags() {
  return (
    <>
      <g className="road-start" transform="translate(44 44)">
        <path
          className="road-fill-pink road-flag"
          d="M0 40V-4M0-4l30 8-30 10"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <text x="12" y="62" className="road-label">
          {t('home.route.start')}
        </text>
      </g>
      <g className="road-finish" transform="translate(850 520)">
        <path className="road-line" d="M-18 78h50" strokeWidth="3" />
        <path className="road-line" d="M0 78V4" strokeWidth="3" />
        <g className="road-finish-cloth">
          <path className="road-fill-yellow road-flag" d="M0 6c18-6 36 8 54 4-10 8-6 16 0 22-18 4-36-10-54-4z" strokeWidth="3" strokeLinejoin="round" />
        </g>
        <text x="-6" y="104" className="road-label">
          {t('home.route.finish')}
        </text>
      </g>
    </>
  );
}

/** A small hiker that walks the trail as the trail draws. */
function Walker() {
  return (
    <g className="road-walker" style={{ offsetPath: `path('${TRAIL}')` } as CSSProperties}>
      <g className="road-walker-body">
        <ellipse cx="0" cy="0" rx="10" ry="3.5" className="road-walker-shadow" />
        <path className="road-fill-blue" d="M-7-22h9a3 3 0 0 1 3 3v11h-15v-11a3 3 0 0 1 3-3z" />
        <path className="road-fill-orange" d="M-12-20h6v12h-6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z" />
        <path className="road-line" d="M-5-8l-3 8M1-8l3 8" />
        <circle cx="-2" cy="-28" r="6" className="road-fill-skin" />
        <path className="road-fill-pink" d="M-8-29a6 6 0 0 1 12 0z" />
        <path className="road-line" d="M5-18l6 4v14" />
      </g>
    </g>
  );
}

/** Hand-drawn map: contours, landmarks, trail, stops and the walker behind the stage cards. */
function MapDrawing() {
  return (
    <svg
      className="road-map"
      viewBox="0 0 1000 680"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <mask id="road-reveal" maskUnits="userSpaceOnUse" x="0" y="0" width="1000" height="680">
          <path
            className="road-reveal"
            pathLength={1}
            d={TRAIL}
            fill="none"
            stroke="#fff"
            strokeWidth="40"
            strokeLinecap="round"
          />
        </mask>
      </defs>
      <Contours />
      <Landmarks />
      <g mask="url(#road-reveal)">
        <path className="road-marker" d={TRAIL} />
        <path className="road-trail" d={TRAIL} />
      </g>
      {STOPS.map((stop, i) => (
        <g
          key={stop.at}
          className="road-stop"
          transform={`translate(${stop.x} ${stop.y})`}
          style={{ '--at': `${along(stop.at)}%` } as CSSProperties}
        >
          <circle r="11" />
          <text y="4.5">{i + 1}</text>
        </g>
      ))}
      <Flags />
      <Walker />
    </svg>
  );
}

export function Roadmap() {
  return (
    <section className="section container" aria-labelledby="route-title">
      <div className="section-head grid-12">
        <span className="section-mark">{t('home.route.mark')}</span>
        <h2 id="route-title">
          {t('home.route.headingStart')}{' '}
          <span className="serif">{t('home.route.headingAccent')}</span>{' '}
          {t('home.route.headingEnd')}
        </h2>
        <p>{t('home.route.note')}</p>
      </div>
      <div className="roadmap" data-yeti-ledge>
        <MapDrawing />
        {STAGES.map((stage) => (
          <article
            key={stage.n}
            className={`road-card road-card-${stage.n} block-${stage.color}`}
            style={{ '--reached': `${stage.reachedAt}%` } as CSSProperties}
          >
            <span className="road-tape" aria-hidden="true" />
            <span className="road-pin" aria-hidden="true">
              {stage.n}
            </span>
            <span className="road-stage-num">{t('home.route.stageOf', { n: stage.n })}</span>
            <h3>{t(stage.titleKey)}</h3>
            <ul className="checks road-checks">
              {stage.itemKeys.map((key, i) => (
                <li key={key} style={{ '--i': i } as CSSProperties}>
                  {t(key)}
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </section>
  );
}
