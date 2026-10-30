'use client';

import { memo, useEffect, useReducer, useRef, useState } from 'react';
import { usePrefersReducedMotion } from '@/components/mascot/usePrefersReducedMotion';
import { t } from '@/i18n';
import { Figure, GlyphMark } from './office/Figure';
import { depthOf, NORTH_WALL_MATRIX, project, VIEW_H, VIEW_W, WALL_TILE, type Point } from './office/iso';
import { STATIC_SPRITES, type Sprite } from './office/Props';
import { Scenery, SILHOUETTE } from './office/Scenery';
import { createSim, step, type Person, type Sim } from './office/sim';
import { SEATS } from './office/world';
import './OfficeMap.css';

const HEAD_TOP = 44;
const SEAT_LIFT = 14;
const CALENDAR = { u: 16.5 * WALL_TILE, v: 32, cell: 21, gap: 3 } as const;

const StaticScenery = memo(Scenery);

function screenOf(person: Person): Point {
  return project(person.pos.x, person.pos.y);
}

function personSprite(person: Person): Sprite {
  const p = screenOf(person);
  return {
    key: `p-${person.id}`,
    depth: depthOf(person.pos.x, person.pos.y),
    node: (
      <g
        key={`p-${person.id}`}
        transform={`translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`}
        opacity={person.opacity < 1 ? person.opacity.toFixed(2) : undefined}
      >
        <Figure
          id={person.id}
          shirt={person.shirt}
          hair={person.hair}
          skin={person.skin}
          pose={person.pose}
          lookX={Math.round(person.look.x * 10) / 10}
          lookY={Math.round(person.look.y * 10) / 10}
          stride={person.path.length > 0 || person.pose !== 'stand' ? Math.round(person.stride * 20) / 20 : 0}
          isWalking={person.path.length > 0}
          holdsCup={person.holdsCup}
        />
      </g>
    ),
  };
}

function ballSprite(sim: Sim): Sprite {
  const p = project(sim.ball.x, sim.ball.y, sim.ball.z);
  const floor = project(sim.ball.x, sim.ball.y, 25);
  return {
    key: 'ball',
    depth: depthOf(sim.ball.x, sim.ball.y) + 0.4,
    node: (
      <g key="ball">
        <ellipse cx={floor.x.toFixed(1)} cy={floor.y.toFixed(1)} rx="2.6" ry="1.2" className="office-ball-shadow" />
        <circle cx={p.x.toFixed(1)} cy={p.y.toFixed(1)} r="2.4" className="office-ball" />
      </g>
    ),
  };
}

function headTop(person: Person): Point {
  const p = screenOf(person);
  const isSeated = person.pose === 'sit' || person.pose === 'type';
  return { x: p.x, y: p.y - HEAD_TOP + (isSeated ? -SEAT_LIFT + 4 : 0) };
}

function Pill({ at, text, isYou }: { at: Point; text: string; isYou: boolean }) {
  const width = Math.max(26, text.length * 7 + 14);
  return (
    <g transform={`translate(${at.x.toFixed(1)} ${(at.y - 4).toFixed(1)})`} className={isYou ? 'office-pill office-pill-you' : 'office-pill'}>
      <rect x={-width / 2} y="-15" width={width} height="16" rx="8" />
      <text y="-4">{text}</text>
    </g>
  );
}

function Talk({ at, sim, person }: { at: Point; sim: Sim; person: Person }) {
  if (!person.bubble) return null;
  const age = person.bubble.until - sim.time;
  const scale = Math.min(1, (sim.time - person.bubble.since) * 6, age * 6);
  return (
    <g transform={`translate(${at.x.toFixed(1)} ${(at.y - 18).toFixed(1)}) scale(${Math.max(0.01, scale).toFixed(2)})`} className="office-talk">
      <path d="M-14-11h28a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H4l-5 6 .6-6H-14a4 4 0 0 1-4-4V-7a4 4 0 0 1 4-4z" />
      <g transform="translate(0 -2)">
        <GlyphMark glyph={person.bubble.glyph} />
      </g>
    </g>
  );
}

function Callout({ at, text, scale = 1 }: { at: Point; text: string; scale?: number }) {
  const width = text.length * 7.4 + 24;
  return (
    <g transform={`translate(${at.x.toFixed(1)} ${at.y.toFixed(1)}) scale(${scale.toFixed(2)})`} className="office-callout">
      <path d={`M${-width / 2} -32h${width}a3 3 0 0 1 3 3v19a3 3 0 0 1-3 3H8l-8 8-3-8h${-width / 2 + 5}a3 3 0 0 1-3-3v-19a3 3 0 0 1 3-3z`} />
      <text y="-17">{text}</text>
    </g>
  );
}

function Overlay({ sim }: { sim: Sim }) {
  const story = sim.story;
  const you = sim.people.find((p) => p.id === story.youId);
  const seat = SEATS.find((s) => s.id === story.freeSeatId);
  const isSeatOpen = seat && (story.phase === 'free' || story.phase === 'offer' || story.phase === 'walking');
  const seatPoint = seat ? project(seat.at.x, seat.at.y) : null;
  const sinceOffer = sim.time - story.since;
  return (
    <g className="office-overlay">
      {isSeatOpen && seatPoint && (
        <Callout
          at={{ x: seatPoint.x, y: seatPoint.y - 34 + Math.sin(sim.time * 2.4) * 2 }}
          text={t('home.join.map.free')}
        />
      )}
      {sim.people.map((person) => {
        const top = headTop(person);
        const isYou = person.id === story.youId;
        return (
          <g key={person.id} opacity={person.opacity < 1 ? person.opacity.toFixed(2) : undefined}>
            {isYou && <Pill at={top} text={t('home.join.map.you')} isYou />}
            {!isYou && person.label && <Pill at={top} text={person.label} isYou={false} />}
            <Talk at={isYou || person.label ? { x: top.x, y: top.y - 16 } : top} sim={sim} person={person} />
          </g>
        );
      })}
      {story.phase === 'offer' && you && (
        <Callout
          at={{ x: headTop(you).x, y: headTop(you).y - 20 }}
          text={t('home.join.map.offer')}
          scale={Math.min(1, sinceOffer * 5)}
        />
      )}
    </g>
  );
}

/** Seat marker on the floor under the free desk's chair. */
function FreeSeatMark({ sim }: { sim: Sim }) {
  const seat = SEATS.find((s) => s.id === sim.story.freeSeatId);
  if (!seat || sim.story.phase === 'trial' || sim.story.phase === 'done') return null;
  const p = project(seat.at.x, seat.at.y);
  return <ellipse className="office-free" cx={p.x.toFixed(1)} cy={p.y.toFixed(1)} rx="17" ry="8.5" />;
}

/** The seven trial days on the trial room wall, filled one by one. */
function Calendar({ sim }: { sim: Sim }) {
  const days = sim.story.trialDays;
  return (
    <g transform={NORTH_WALL_MATRIX} className="office-calendar">
      {Array.from({ length: 7 }, (_, i) => {
        const u = CALENDAR.u + i * (CALENDAR.cell + CALENDAR.gap);
        const isDone = i < days;
        return (
          <g key={i} className={isDone ? 'office-day office-day-done' : 'office-day'}>
            <rect x={u} y={CALENDAR.v} width={CALENDAR.cell} height={CALENDAR.cell} rx="3" />
            <text x={u + CALENDAR.cell / 2} y={CALENDAR.v + 9}>
              {i + 1}
            </text>
            {isDone && <path d={`M${u + 5} ${CALENDAR.v + 14}l3.5 3.5 7-7`} className="office-day-check" />}
          </g>
        );
      })}
    </g>
  );
}

/** Wall clock in the team room; minutes fly by. */
function Clock({ sim }: { sim: Sim }) {
  const u = 15.1 * WALL_TILE;
  const v = 30;
  const minute = (sim.time * 60) % 360;
  const hour = (sim.time * 5) % 360;
  return (
    <g transform={NORTH_WALL_MATRIX} className="office-clock">
      <circle cx={u} cy={v} r="10" />
      <path d={`M${u} ${v}V${v - 7}`} transform={`rotate(${minute.toFixed(0)} ${u} ${v})`} />
      <path d={`M${u} ${v}V${v - 4.5}`} transform={`rotate(${hour.toFixed(0)} ${u} ${v})`} />
    </g>
  );
}

function useIsVisible(ref: React.RefObject<Element | null>): boolean {
  const [isVisible, setIsVisible] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver !== 'function') return;
    const observer = new IntersectionObserver(([entry]) => setIsVisible(entry?.isIntersecting ?? false), {
      rootMargin: '120px',
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return isVisible;
}

/** Runs the simulation while the map is on screen; re-renders once per frame. */
function useOfficeLoop(sim: Sim, isRunning: boolean) {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!isRunning) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      step(sim, (now - last) / 1000);
      last = now;
      redraw();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [sim, isRunning]);
}

/** A living isometric office: the queue, the team room with a free desk, the 7-day trial and the rooms around. */
export function OfficeMap() {
  const [sim] = useState(createSim);
  const ref = useRef<SVGSVGElement>(null);
  const isVisible = useIsVisible(ref);
  const isReduced = usePrefersReducedMotion();
  useOfficeLoop(sim, isVisible && !isReduced);

  const sprites = [...STATIC_SPRITES, ...sim.people.map(personSprite), ballSprite(sim)].sort(
    (a, b) => a.depth - b.depth,
  );

  return (
    <div className="office-wrap">
      <svg
        ref={ref}
        className="office-map"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        role="img"
        aria-label={t('home.join.map.label')}
        data-yeti-ledge
      >
        <StaticScenery />
        <Calendar sim={sim} />
        <Clock sim={sim} />
        <FreeSeatMark sim={sim} />
        <g className="office-sprites">{sprites.map((sprite) => sprite.node)}</g>
        <polygon points={SILHOUETTE} className="office-grain" clipPath="url(#office-silhouette)" />
        <Overlay sim={sim} />
      </svg>
    </div>
  );
}
