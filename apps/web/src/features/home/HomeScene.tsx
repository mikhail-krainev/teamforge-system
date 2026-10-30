import Image from 'next/image';
import type { CSSProperties, ReactNode } from 'react';
import forestLeft from './scene/forest-left.svg';
import forestRight from './scene/forest-right.svg';
import ridgeBand from './scene/ridge-band.svg';
import snowfall from './scene/snowfall.svg';
import stars from './scene/stars.svg';
import stringLights from './scene/string-lights.svg';
import valley from './scene/valley.svg';
import './HomeScene.css';

const BANDS = { lights: stringLights, ridge: ridgeBand, valley } as const;

const layers = {
  '--scene-forest-left': `url(${forestLeft.src})`,
  '--scene-forest-right': `url(${forestRight.src})`,
  '--scene-stars': `url(${stars.src})`,
} as CSSProperties;

/** Night scenery behind the whole landing page: forest walls, stars, falling snow. Always dark. */
export function HomeScene({ children }: { children: ReactNode }) {
  return (
    <div className="home-scene theme-night" style={layers}>
      <div className="home-scene-back" aria-hidden="true" />
      <div className="home-scene-snow" aria-hidden="true">
        <Image src={snowfall} alt="" unoptimized />
      </div>
      <div className="home-scene-body">{children}</div>
    </div>
  );
}

/** A full-width painted strip between sections: string lights, a ridge with a gondola, the valley. */
export function SceneBand({ kind }: { kind: keyof typeof BANDS }) {
  return (
    <div className={`scene-band scene-band-${kind}`} aria-hidden="true">
      <Image src={BANDS[kind]} alt="" unoptimized />
    </div>
  );
}
