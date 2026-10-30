import { ACTIVITIES, durationOf, pickActivity, type ActivityName } from './activities';
import type { ChatMood } from './chat';
import {
  clampToLedge,
  floorLedge,
  isHomeInView,
  isVisible,
  landingSpot,
  ledgeBelow,
  pickLedge,
} from './geometry';
import type { BodyFrame } from './sprites';
import { createSwing, stepSwing } from './swing';
import { balloonTrack, fallTrack, jumpTrack, parachuteTrack, walkTrack } from './tracks';
import type { Ledge, Point, Pose, Track, View } from './types';

/** Rendered sprite size in px; the hero slot is bigger, so he scales between the two. */
export const ACTOR_SIZE = 80;

const REST_MS = [3000, 7000] as const;
const QUIET_AFTER_SCROLL_MS = 2500;
const SLEEP_AFTER_IDLE_MS = 50000;
const PEEK_AFTER_IDLE_MS = 25000;
const PEEK_COOLDOWN_MS = 120000;
const ASK_COOLDOWN_MS = 180000;
const ASK_NOT_BEFORE_MS = 15000;
const MAX_ASKS = 2;
const WALKABOUT_CHANCE = 0.35;
const GRAB_RADIUS_PX = 170;
const GRAB_CHANCE = 0.4;
const GRAB_COOLDOWN_MS = 35000;
const HANG_MS = [4500, 7000] as const;
const MOOD_HOLD_MS = 1600;
const BLINK_MS = 140;
/** A move longer than this share of the screen height floats instead of jumping. */
const LONG_MOVE = 0.5;
/** He stops waiting for an answer after this long if the reader is not typing. */
const ASK_TIMEOUT_MS = 30000;

export interface PointerState {
  /** Document coordinates. */
  x: number;
  y: number;
  vx: number;
  movedAt: number;
  /** Fine pointer inside the window: grabbing is possible. */
  canGrab: boolean;
}

export interface LifeInput {
  now: number;
  view: View;
  slot: { feet: Point; size: number } | null;
  ledges: readonly Ledge[];
  pointer: PointerState;
  lastScrollAt: number;
  lastInputAt: number;
  isChatBusy: boolean;
}

export interface LifeEvents {
  onHome: (isHome: boolean) => void;
  onAsk: () => void;
  onChatCancel: () => void;
  onPeekScroll: () => void;
}

type Mode = 'home' | 'travel' | 'idle' | 'activity' | 'hang';
type Arrival = 'idle' | 'home' | 'hang';

const rand = (range: readonly [number, number]) => range[0] + Math.random() * (range[1] - range[0]);
const MOOD_FRAME: Record<ChatMood, BodyFrame> = {
  happy: 'happy',
  surprised: 'talk',
  shy: 'happy',
  neutral: 'stand',
};

/** Толик's brain: decides where he goes and what he does; tick() returns the pose to draw. */
export class LifeEngine {
  private mode: Mode = 'home';
  private pos: Point = { x: 0, y: 0 };
  private scale = 1;
  private facing: 1 | -1 = 1;
  private ledge: Ledge | null = null;
  private track: { track: Track; start: number; arrival: Arrival } | null = null;
  private activity: { name: ActivityName; start: number; end: number } | null = null;
  private lastActivity: ActivityName | null = null;
  private restUntil = 0;
  private hold: { frame: BodyFrame; until: number } | null = null;
  private hangUntil = 0;
  private swing = createSwing();
  private wasNear = false;
  private lastGrabAt = -Infinity;
  private lastAskAt = -Infinity;
  private asks = 0;
  private lastPeekAt = -Infinity;
  private nextBlinkAt = 0;
  private readonly bornAt: number;

  constructor(
    private readonly events: LifeEvents,
    now: number,
  ) {
    this.bornAt = now;
  }

  get isHanging() {
    return this.mode === 'hang';
  }

  tick(frame: LifeInput, dt: number): Pose | null {
    const input = { ...frame, ledges: [...frame.ledges, floorLedge(frame.view)] };
    // A hero slot that appears while he is out (back on the landing page) must stay empty.
    if (this.mode !== 'home' && input.slot) this.events.onHome(false);
    switch (this.mode) {
      case 'home':
        this.tickHome(input);
        break;
      case 'travel':
        return this.tickTravel(input);
      case 'hang':
        return this.tickHang(input, dt);
      default:
        this.tickGround(input);
    }
    return this.mode === 'home' ? null : this.groundPose(input.now);
  }

  /** The reader answered (or closed) his question. */
  endChat(now: number, mood: ChatMood) {
    if (this.activity?.name !== 'ask') return;
    this.finishActivity(now);
    this.hold = { frame: MOOD_FRAME[mood], until: now + MOOD_HOLD_MS };
  }

  /** A click on him: lets go of the cursor, or a happy hop in place. */
  poke(now: number) {
    if (this.mode === 'hang') {
      this.hangUntil = now;
      return;
    }
    if (this.mode !== 'idle' && this.mode !== 'activity') return;
    if (this.activity?.name === 'ask') return;
    this.finishActivity(now);
    this.startTrack(now, jumpTrack(this.pos, this.pos, this.scale, this.scale), 'idle');
  }

  private tickHome(input: LifeInput) {
    const { slot, view } = input;
    if (slot && isHomeInView(view)) return;
    const target = pickLedge(input.ledges, view, null);
    if (!target) return;
    if (slot) {
      this.pos = { ...slot.feet };
      this.scale = slot.size / ACTOR_SIZE;
    } else {
      // A page without the hero slot: he parachutes in from above the screen.
      const x = (target.left + target.right) / 2;
      this.pos = { x, y: view.scrollY - ACTOR_SIZE * 2 };
      this.scale = 1;
    }
    this.ledge = target;
    this.events.onHome(false);
    this.travelTo(input, landingSpot(target, this.pos.x), 1, 'idle');
  }

  private tickTravel(input: LifeInput): Pose {
    const current = this.track;
    if (!current) return this.groundPose(input.now);
    const elapsed = input.now - current.start;
    const sample = current.track.sample(Math.min(elapsed, current.track.duration));
    this.pos = { x: sample.x, y: sample.y };
    this.scale = sample.scale;
    this.facing = sample.facing;
    if (elapsed >= current.track.duration) this.arrive(input, current.arrival);
    return { ...sample, isHanging: false };
  }

  private arrive(input: LifeInput, arrival: Arrival) {
    this.track = null;
    this.mode = arrival;
    if (arrival === 'home') this.events.onHome(true);
    if (arrival === 'hang') {
      this.swing = createSwing();
      this.hangUntil = input.now + rand(HANG_MS);
      this.lastGrabAt = input.now;
    }
    if (arrival === 'idle') this.restUntil = input.now + rand(REST_MS);
  }

  private tickHang(input: LifeInput, dt: number): Pose {
    const { pointer, now } = input;
    const scrolled = input.lastScrollAt > this.lastGrabAt;
    if (now >= this.hangUntil || !pointer.canGrab || scrolled) {
      this.letGo(input);
      return this.tickTravel(input);
    }
    this.pos = { x: pointer.x, y: pointer.y + ACTOR_SIZE };
    const rotate = stepSwing(this.swing, dt, pointer.vx);
    return {
      ...this.pos,
      scale: 1,
      sx: 1,
      sy: 1,
      rotate,
      isHanging: true,
      facing: this.facing,
      frame: Math.floor(now / 260) % 2 ? 'hang2' : 'hang1',
      props: [],
    };
  }

  private letGo(input: LifeInput) {
    const below = ledgeBelow(input.ledges, this.pos.x, this.pos.y) ?? this.ledge;
    if (!below) {
      this.mode = 'home';
      this.events.onHome(true);
      return;
    }
    this.ledge = below;
    const spot = { x: clampToLedge(below, this.pos.x), y: below.top };
    const track = spot.y >= this.pos.y ? fallTrack(this.pos, spot) : jumpTrack(this.pos, spot);
    this.startTrack(input.now, track, 'idle');
  }

  private tickGround(input: LifeInput) {
    const { now } = input;
    this.refreshLedge(input.ledges);
    if (input.slot && isHomeInView(input.view)) {
      this.cancelForMove(now);
      this.travelTo(input, input.slot.feet, input.slot.size / ACTOR_SIZE, 'home');
      return;
    }
    const target = pickLedge(input.ledges, input.view, this.ledge);
    const isHeldByChat =
      input.isChatBusy &&
      this.ledge !== null &&
      isVisible({ x: 0, y: this.ledge.top }, input.view, 0);
    if (target && target.id !== this.ledge?.id && !isHeldByChat) {
      this.cancelForMove(now);
      this.ledge = target;
      this.travelTo(input, landingSpot(target, this.pos.x), 1, 'idle');
      return;
    }
    if (this.tryGrab(input)) return;
    if (this.mode === 'activity') this.tickActivity(input);
    else this.maybeStartSomething(input);
  }

  /**
   * Blocks may move (fonts, images, resize, scroll for the floor): keep his feet on the same block.
   * A block that is gone (another page) leaves him without one, so he picks a new one.
   */
  private refreshLedge(ledges: readonly Ledge[]) {
    if (!this.ledge) return;
    const fresh = ledges.find((ledge) => ledge.id === this.ledge?.id);
    if (!fresh) {
      this.ledge = null;
      return;
    }
    this.ledge = fresh;
    this.pos = { x: clampToLedge(fresh, this.pos.x), y: fresh.top };
  }

  private tryGrab(input: LifeInput): boolean {
    const { pointer, now } = input;
    if (!pointer.canGrab || now - pointer.movedAt > 600 || this.activity?.name === 'ask') {
      this.wasNear = false;
      return false;
    }
    const head = { x: this.pos.x, y: this.pos.y - ACTOR_SIZE };
    const isNear =
      pointer.y < this.pos.y && Math.hypot(pointer.x - head.x, pointer.y - head.y) < GRAB_RADIUS_PX;
    const isEntering = isNear && !this.wasNear;
    this.wasNear = isNear;
    if (!isEntering || now - this.lastGrabAt < GRAB_COOLDOWN_MS || Math.random() > GRAB_CHANCE) {
      return false;
    }
    this.finishActivity(now);
    this.lastGrabAt = now;
    this.startTrack(now, jumpTrack(this.pos, { x: pointer.x, y: pointer.y + ACTOR_SIZE }), 'hang');
    return true;
  }

  private maybeStartSomething(input: LifeInput) {
    const { now } = input;
    if (now < this.restUntil || now - input.lastScrollAt < QUIET_AFTER_SCROLL_MS || !this.ledge) {
      return;
    }
    const idleFor = now - input.lastInputAt;
    if (idleFor > SLEEP_AFTER_IDLE_MS) return this.startActivity(now, 'sleep');
    if (Math.random() < WALKABOUT_CHANCE) {
      const spot = landingSpot(this.ledge, this.pos.x + (Math.random() - 0.5) * 360);
      this.startTrack(now, walkTrack(this.pos, spot.x), 'idle');
      return;
    }
    const name = pickActivity(this.allowedActivities(input, idleFor), this.lastActivity);
    if (name) this.startActivity(now, name);
  }

  private allowedActivities(input: LifeInput, idleFor: number): ActivityName[] {
    const { now, view } = input;
    const allowed: ActivityName[] = ['wipe', 'read', 'campfire', 'guitar'];
    const canAsk =
      this.asks < MAX_ASKS &&
      now - this.lastAskAt > ASK_COOLDOWN_MS &&
      now - this.bornAt > ASK_NOT_BEFORE_MS;
    if (canAsk) allowed.push('ask');
    const nearBottom = view.scrollY + view.height * 1.5 > document.documentElement.scrollHeight;
    if (idleFor > PEEK_AFTER_IDLE_MS && now - this.lastPeekAt > PEEK_COOLDOWN_MS && !nearBottom) {
      allowed.push('peek');
    }
    return allowed;
  }

  private startActivity(now: number, name: ActivityName) {
    this.mode = 'activity';
    this.activity = { name, start: now, end: now + durationOf(name) };
    this.lastActivity = name;
    if (name === 'ask') {
      this.asks += 1;
      this.lastAskAt = now;
      this.events.onAsk();
    }
    if (name === 'peek') {
      this.lastPeekAt = now;
      this.events.onPeekScroll();
    }
  }

  private tickActivity(input: LifeInput) {
    const current = this.activity;
    if (!current) return;
    const isWoken = current.name === 'sleep' && input.lastInputAt > current.start;
    const isScrolled = current.name !== 'ask' && input.lastScrollAt > current.start;
    const isIgnored =
      current.name === 'ask' && !input.isChatBusy && input.now - current.start > ASK_TIMEOUT_MS;
    if (isIgnored) this.events.onChatCancel();
    if (input.now >= current.end || isWoken || isScrolled || isIgnored) {
      this.finishActivity(input.now);
    }
  }

  private finishActivity(now: number) {
    if (!this.activity) return;
    this.activity = null;
    this.mode = 'idle';
    this.restUntil = now + rand(REST_MS);
  }

  private cancelForMove(now: number) {
    if (this.activity?.name === 'ask') this.events.onChatCancel();
    this.finishActivity(now);
    this.hold = null;
  }

  private travelTo(input: LifeInput, to: Point, toScale: number, arrival: Arrival) {
    const { view, now } = input;
    const scales = [this.scale, toScale] as const;
    const dy = to.y - this.pos.y;
    let track: Track;
    if (!isVisible(this.pos, view)) {
      // Off screen: he comes in from the edge he was beyond.
      const isAbove = this.pos.y < view.scrollY;
      const edgeY = isAbove
        ? view.scrollY - ACTOR_SIZE * 2
        : view.scrollY + view.height + ACTOR_SIZE;
      const from = { x: to.x + (isAbove ? -60 : 60), y: edgeY };
      track = isAbove ? parachuteTrack(from, to, ...scales) : balloonTrack(from, to, ...scales);
    } else if (dy < -view.height * LONG_MOVE) {
      track = balloonTrack(this.pos, to, ...scales);
    } else if (dy > view.height * LONG_MOVE) {
      track = parachuteTrack(this.pos, to, ...scales);
    } else {
      track = jumpTrack(this.pos, to, ...scales);
    }
    this.startTrack(now, track, arrival);
  }

  private startTrack(now: number, track: Track, arrival: Arrival) {
    this.mode = 'travel';
    this.track = { track, start: now, arrival };
  }

  private groundPose(now: number): Pose {
    const base = { ...this.pos, scale: this.scale, sx: 1, sy: 1, rotate: 0, isHanging: false };
    if (this.activity) {
      const { frame, props } = ACTIVITIES[this.activity.name].sample(now - this.activity.start);
      return { ...base, facing: this.facing, frame, props };
    }
    if (this.hold && now < this.hold.until) {
      return { ...base, facing: this.facing, frame: this.hold.frame, props: [] };
    }
    return { ...base, facing: this.facing, frame: this.blinkFrame(now), props: [] };
  }

  private blinkFrame(now: number): BodyFrame {
    if (now > this.nextBlinkAt + BLINK_MS) this.nextBlinkAt = now + rand([2600, 5200]);
    return now >= this.nextBlinkAt ? 'blink' : 'stand';
  }
}
