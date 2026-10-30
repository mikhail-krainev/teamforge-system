/**
 * The office simulation: people queue, get an offer, take the free desk, go through the 7-day trial,
 * and meanwhile the rest of the office drinks coffee, meets, plays ping-pong and chats.
 * Pure state plus step(); the scene component only draws it.
 */
import type { Point } from './iso';
import { route } from './paths';
import {
  ENTRY,
  EXIT_INSIDE,
  EXIT_OUTSIDE,
  LOOK_VECTORS,
  PINGPONG_ENDS,
  QUEUE_SLOTS,
  SEATS,
  SPOTS,
  type Look,
  type Spot,
} from './world';

export type Shirt = 'yellow' | 'pink' | 'blue' | 'green' | 'orange' | 'mint' | 'brown' | 'red';
export type Hair = 'short' | 'bun' | 'long' | 'cap' | 'curly' | 'bald';
export type Pose = 'stand' | 'sit' | 'type' | 'swing';
export type Glyph = 'dots' | 'code' | 'heart' | 'cup' | 'idea' | 'bug' | 'check' | 'question';

export interface Person {
  id: number;
  role: 'queue' | 'member' | 'roamer' | 'player' | 'leaver';
  pos: Point;
  path: Point[];
  look: Point;
  pose: Pose;
  /** Walk cycle phase in radians; advances with distance walked. */
  stride: number;
  shirt: Shirt;
  hair: Hair;
  skin: number;
  label: string | null;
  bubble: { glyph: Glyph; since: number; until: number } | null;
  opacity: number;
  seatId: string | null;
  spotId: string | null;
  queueSlot: number;
  /** Seconds until the person picks something new to do. */
  restUntil: number;
  holdsCup: boolean;
  /** What to do on arrival at the end of the path. */
  arrival: 'none' | 'sit' | 'leave' | 'gone';
}

export type StoryPhase = 'free' | 'offer' | 'walking' | 'trial' | 'done';

export interface Story {
  phase: StoryPhase;
  since: number;
  freeSeatId: string;
  youId: number | null;
  trialDays: number;
}

export interface Ball {
  x: number;
  y: number;
  z: number;
}

export interface Sim {
  time: number;
  people: Person[];
  story: Story;
  ball: Ball;
  nextId: number;
  seed: number;
  lastDt: number;
}

const WALK_SPEED = 1.9;
const STRIDE_PER_TILE = 4.2;
const FADE_PER_SECOND = 2.2;
const ARRIVE_EPS = 0.04;
const OFFER_FOR = 2.8;
const FREE_FOR = 2.6;
const TRIAL_DAY = 1.05;
const DONE_FOR = 2.6;
const SPAWN_DELAY = 1.4;
const RALLY_SECONDS = 1.3;
const ROLES = ['QA', 'UX', 'BE', 'FE', 'PM', 'DA', 'iOS', 'ML'] as const;
const SHIRTS: [Shirt, ...Shirt[]] = ['pink', 'blue', 'green', 'orange', 'mint', 'brown', 'red', 'yellow'];
const HAIRS: [Hair, ...Hair[]] = ['short', 'bun', 'long', 'cap', 'curly', 'bald'];
const CHAT_GLYPHS: [Glyph, ...Glyph[]] = ['dots', 'code', 'heart', 'idea', 'bug', 'question', 'cup', 'check'];
export const SKIN_TONES = ['#f3d2b3', '#e4b48c', '#c98d62', '#9c6644', '#6e4630'] as const;

/** Small seeded generator so the server and the first client frame draw the same office. */
function nextRandom(sim: Sim): number {
  sim.seed = (sim.seed + 0x6d2b79f5) | 0;
  let t = sim.seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function pick<T>(sim: Sim, list: readonly [T, ...T[]]): T {
  return list[Math.floor(nextRandom(sim) * list.length)] ?? list[0];
}

function between(sim: Sim, min: number, max: number): number {
  return min + nextRandom(sim) * (max - min);
}

function lookVector(look: Look): Point {
  return LOOK_VECTORS[look];
}

function seatById(id: string) {
  const seat = SEATS.find((s) => s.id === id);
  if (!seat) throw new Error(`Unknown seat ${id}`);
  return seat;
}

function spotById(id: string): Spot {
  const spot = SPOTS.find((s) => s.id === id);
  if (!spot) throw new Error(`Unknown spot ${id}`);
  return spot;
}

function makePerson(sim: Sim, role: Person['role'], pos: Point, look: Look): Person {
  const person: Person = {
    id: sim.nextId,
    role,
    pos: { ...pos },
    path: [],
    look: lookVector(look),
    pose: 'stand',
    stride: 0,
    shirt: pick(sim, SHIRTS),
    hair: pick(sim, HAIRS),
    skin: Math.floor(nextRandom(sim) * SKIN_TONES.length),
    label: null,
    bubble: null,
    opacity: 1,
    seatId: null,
    spotId: null,
    queueSlot: -1,
    restUntil: between(sim, 2, 9),
    holdsCup: false,
    arrival: 'none',
  };
  sim.nextId += 1;
  return person;
}

function walkTo(person: Person, target: Point, arrival: Person['arrival']) {
  const path = route(person.pos, target);
  person.path = path.length > 0 ? path.slice(1) : [{ ...target }];
  person.pose = 'stand';
  person.arrival = arrival;
}

function sitAtSeat(person: Person, seatId: string) {
  const seat = seatById(seatId);
  person.seatId = seatId;
  person.pos = { ...seat.at };
  person.look = lookVector(seat.look);
  person.pose = 'type';
}

/** The opening frame: matches the still picture of the old map (three in line, one free desk). */
export function createSim(seed = 20261030): Sim {
  const sim: Sim = {
    time: 0,
    people: [],
    story: { phase: 'free', since: 0, freeSeatId: 'top-2', youId: null, trialDays: 0 },
    ball: { x: PINGPONG_ENDS[0].x, y: PINGPONG_ENDS[0].y, z: 30 },
    nextId: 1,
    seed,
    lastDt: 0,
  };
  ['top-0', 'top-1', 'bottom-0', 'bottom-1', 'bottom-2'].forEach((seatId) => {
    const member = makePerson(sim, 'member', seatById(seatId).at, 's');
    sitAtSeat(member, seatId);
    sim.people.push(member);
  });
  QUEUE_SLOTS.slice(0, 3).forEach((slot, i) => {
    const waiting = makePerson(sim, 'queue', slot, 'e');
    waiting.queueSlot = i;
    waiting.label = ROLES[i] ?? null;
    sim.people.push(waiting);
  });
  ['kitchen-a', 'kitchen-b', 'sofa-1', 'board'].forEach((spotId) => {
    const spot = spotById(spotId);
    const roamer = makePerson(sim, 'roamer', spot.at, spot.look);
    roamer.spotId = spotId;
    roamer.pose = spot.isSeated ? 'sit' : 'stand';
    sim.people.push(roamer);
  });
  PINGPONG_ENDS.forEach((end, i) => {
    const player = makePerson(sim, 'player', end, i === 0 ? 'e' : 'w');
    player.pose = 'swing';
    sim.people.push(player);
  });
  return sim;
}

function byId(sim: Sim, id: number | null): Person | undefined {
  return id === null ? undefined : sim.people.find((p) => p.id === id);
}

function isSpotTaken(sim: Sim, spotId: string): boolean {
  return sim.people.some((p) => p.spotId === spotId);
}

function partnerAt(sim: Sim, person: Person): Person | undefined {
  if (!person.spotId || person.path.length > 0) return undefined;
  const group = spotById(person.spotId).group;
  return sim.people.find(
    (p) =>
      p !== person &&
      p.spotId !== null &&
      p.path.length === 0 &&
      spotById(p.spotId).group === group,
  );
}

function say(sim: Sim, person: Person, glyph: Glyph, seconds: number) {
  person.bubble = { glyph, since: sim.time, until: sim.time + seconds };
}

function arrive(sim: Sim, person: Person) {
  if (person.arrival === 'gone') return;
  if (person.arrival === 'sit' && person.seatId) {
    sitAtSeat(person, person.seatId);
  } else if (person.spotId) {
    const spot = spotById(person.spotId);
    person.pos = { ...spot.at };
    person.look = lookVector(spot.look);
    person.pose = spot.isSeated ? 'sit' : 'stand';
  } else if (person.queueSlot >= 0) {
    person.look = lookVector('e');
  } else if (person.arrival === 'leave') {
    person.path = [{ ...EXIT_OUTSIDE }];
    person.arrival = 'gone';
    return;
  }
  person.arrival = 'none';
}

function moveAlongPath(sim: Sim, person: Person, dt: number) {
  let budget = WALK_SPEED * dt;
  while (budget > 0 && person.path.length > 0) {
    const target = person.path[0];
    if (!target) break;
    const dx = target.x - person.pos.x;
    const dy = target.y - person.pos.y;
    const dist = Math.hypot(dx, dy);
    if (dist < ARRIVE_EPS) {
      person.path.shift();
      if (person.path.length === 0) arrive(sim, person);
      continue;
    }
    const step = Math.min(dist, budget);
    person.pos = { x: person.pos.x + (dx / dist) * step, y: person.pos.y + (dy / dist) * step };
    person.look = { x: dx / dist, y: dy / dist };
    person.stride += step * STRIDE_PER_TILE;
    budget -= step;
  }
}

function sendToSpot(sim: Sim, person: Person) {
  const free = SPOTS.filter((s) => !isSpotTaken(sim, s.id) && s.id !== person.spotId);
  if (free.length === 0) return;
  // Prefer spots where someone already is, so conversations happen.
  const social = free.filter((s) =>
    sim.people.some((p) => p.spotId !== null && spotById(p.spotId).group === s.group),
  );
  const pool = social.length > 0 && nextRandom(sim) < 0.6 ? social : free;
  const spot = pool[Math.floor(nextRandom(sim) * pool.length)];
  if (!spot) return;
  person.spotId = spot.id;
  walkTo(person, spot.at, 'none');
}

function thinkRoamer(sim: Sim, person: Person) {
  if (person.path.length > 0) return;
  const partner = partnerAt(sim, person);
  if (partner && !person.bubble && !partner.bubble && nextRandom(sim) < 0.025) {
    person.look = { x: partner.pos.x - person.pos.x, y: partner.pos.y - person.pos.y };
    if (person.pose === 'stand') {
      partner.look = { x: -person.look.x, y: -person.look.y };
    }
    say(sim, person, pick(sim, CHAT_GLYPHS), 1.6);
  }
  if (sim.time < person.restUntil) return;
  person.restUntil = sim.time + between(sim, 7, 15);
  person.holdsCup = person.spotId === 'coffee';
  sendToSpot(sim, person);
}

function thinkMember(sim: Sim, person: Person) {
  if (person.path.length > 0 || !person.seatId) return;
  const isYou = person.id === sim.story.youId;
  const seat = seatById(person.seatId);
  const isSeated = Math.hypot(person.pos.x - seat.at.x, person.pos.y - seat.at.y) < 0.05;
  if (isSeated && !person.bubble && nextRandom(sim) < 0.004) {
    say(sim, person, pick(sim, ['code', 'bug', 'check', 'idea'] as const), 1.8);
  }
  if (sim.time < person.restUntil || isYou) return;
  person.restUntil = sim.time + between(sim, 9, 20);
  if (isSeated && nextRandom(sim) < 0.45) {
    if (isSpotTaken(sim, 'coffee')) return;
    person.holdsCup = false;
    person.spotId = 'coffee';
    person.restUntil = sim.time + between(sim, 4, 7);
    walkTo(person, spotById('coffee').at, 'none');
    return;
  }
  if (!isSeated) {
    person.holdsCup = person.spotId === 'coffee';
    person.spotId = null;
    walkTo(person, seat.at, 'sit');
  }
}

function thinkQueue(sim: Sim, person: Person) {
  const slot = QUEUE_SLOTS[person.queueSlot];
  if (!slot || person.path.length > 0) return;
  if (Math.hypot(person.pos.x - slot.x, person.pos.y - slot.y) > ARRIVE_EPS) {
    walkTo(person, slot, 'none');
    return;
  }
  if (sim.time > person.restUntil) {
    person.restUntil = sim.time + between(sim, 3, 7);
    person.look = lookVector(nextRandom(sim) < 0.7 ? 'e' : pick(sim, ['n', 's'] as const));
  }
}

function updatePlayers(sim: Sim) {
  const players = sim.people.filter((p) => p.role === 'player');
  const [a, b] = PINGPONG_ENDS;
  const phase = (sim.time % (RALLY_SECONDS * 2)) / RALLY_SECONDS;
  const isOutbound = phase < 1;
  const t = isOutbound ? phase : phase - 1;
  const fromX = isOutbound ? a.x + 0.5 : b.x - 0.5;
  const toX = isOutbound ? b.x - 0.5 : a.x + 0.5;
  // One bounce on the far half of the table.
  const arc = t < 0.6 ? Math.sin((t / 0.6) * Math.PI) * 26 : Math.sin(((t - 0.6) / 0.4) * Math.PI) * 18;
  sim.ball = { x: fromX + (toX - fromX) * t, y: a.y + Math.sin(sim.time * 1.7) * 0.25, z: 22 + arc };
  players.forEach((player, i) => {
    const end = PINGPONG_ENDS[i] ?? a;
    player.pos = { x: end.x, y: end.y + Math.sin(sim.time * 1.7 + i) * 0.22 };
    player.stride = sim.time * 6 + i * Math.PI;
  });
}

function startQueueShift(sim: Sim) {
  sim.people
    .filter((p) => p.role === 'queue')
    .forEach((p) => {
      p.queueSlot -= 1;
    });
}

function spawnNewcomer(sim: Sim) {
  const waiting = sim.people.filter((p) => p.role === 'queue');
  const slot = waiting.reduce((max, p) => Math.max(max, p.queueSlot), -1) + 1;
  if (slot >= QUEUE_SLOTS.length) return;
  const newcomer = makePerson(sim, 'queue', ENTRY, 'e');
  newcomer.queueSlot = slot;
  newcomer.opacity = 0;
  newcomer.label = pick(sim, ROLES);
  sim.people.push(newcomer);
}

function enterPhase(sim: Sim, phase: StoryPhase) {
  sim.story.phase = phase;
  sim.story.since = sim.time;
}

function directStory(sim: Sim) {
  const story = sim.story;
  const elapsed = sim.time - story.since;
  const you = byId(sim, story.youId);
  if (story.phase === 'free' && elapsed > FREE_FOR) {
    const front = sim.people.find((p) => p.role === 'queue' && p.queueSlot === 0);
    if (!front || front.path.length > 0) return;
    story.youId = front.id;
    front.label = null;
    front.look = lookVector('e');
    enterPhase(sim, 'offer');
  } else if (story.phase === 'offer' && elapsed > OFFER_FOR && you) {
    you.role = 'member';
    you.queueSlot = -1;
    you.seatId = story.freeSeatId;
    you.restUntil = Infinity;
    walkTo(you, seatById(story.freeSeatId).at, 'sit');
    startQueueShift(sim);
    enterPhase(sim, 'walking');
  } else if (story.phase === 'walking' && you && you.pose === 'type') {
    story.trialDays = 0;
    enterPhase(sim, 'trial');
  } else if (story.phase === 'trial') {
    story.trialDays = Math.min(7, Math.floor(elapsed / TRIAL_DAY));
    if (story.trialDays === 7) {
      if (you) say(sim, you, 'check', DONE_FOR);
      enterPhase(sim, 'done');
    }
  } else if (story.phase === 'done' && elapsed > DONE_FOR) {
    finishCycle(sim, you);
  }
  if (story.phase === 'walking' && elapsed > SPAWN_DELAY && elapsed - sim.lastDt <= SPAWN_DELAY) {
    spawnNewcomer(sim);
  }
}

/** A veteran leaves through the lounge; their desk becomes the next free seat. */
function finishCycle(sim: Sim, you: Person | undefined) {
  const story = sim.story;
  if (you) you.restUntil = sim.time + between(sim, 6, 12);
  const veterans = sim.people.filter((p) => p.role === 'member' && p !== you && p.seatId);
  const leaver = veterans[Math.floor(nextRandom(sim) * veterans.length)];
  if (leaver?.seatId) {
    story.freeSeatId = leaver.seatId;
    leaver.role = 'leaver';
    leaver.seatId = null;
    leaver.spotId = null;
    walkTo(leaver, EXIT_INSIDE, 'leave');
    say(sim, leaver, 'heart', 2);
  }
  story.youId = null;
  story.trialDays = 0;
  enterPhase(sim, 'free');
}

function fade(person: Person, dt: number) {
  if (person.arrival === 'gone') {
    person.opacity = Math.max(0, person.opacity - dt * FADE_PER_SECOND * 0.7);
  } else if (person.opacity < 1) {
    person.opacity = Math.min(1, person.opacity + dt * FADE_PER_SECOND);
  }
}

/** Advances the office by dt seconds (clamped, so a background tab does not teleport anyone). */
export function step(sim: Sim, rawDt: number) {
  const dt = Math.min(rawDt, 0.05);
  sim.time += dt;
  sim.lastDt = dt;
  for (const person of sim.people) {
    if (person.bubble && person.bubble.until < sim.time) person.bubble = null;
    if (person.role === 'roamer') thinkRoamer(sim, person);
    else if (person.role === 'member') thinkMember(sim, person);
    else if (person.role === 'queue') thinkQueue(sim, person);
    if (person.role !== 'player') moveAlongPath(sim, person, dt);
    fade(person, dt);
  }
  updatePlayers(sim);
  directStory(sim);
  sim.people = sim.people.filter((p) => !(p.arrival === 'gone' && p.opacity === 0));
}
