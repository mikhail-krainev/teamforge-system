// Shared state of one seed run: generated ids, a seeded random source, the clock and the rows to insert.
import { createHash } from 'node:crypto';

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
/** Every demo uuid starts with this, so a rerun deletes exactly the demo rows (and what the app added to them). */
export const ID_PREFIX = 'dec0de00';
/** Demo GitHub numbers (users, repositories, the installation) start here, far above any real id. */
export const GITHUB_ID_BASE = 9_000_000_000_000;
export const MAX_ACTIVE_PROJECTS = 2;
const ACTIVE_STATUSES = new Set(['forming', 'active', 'voting']);

export class World {
  constructor(now) {
    this.now = now;
    this.rows = {};
    this.counter = 0;
    this.seed = 20261030;
    this.people = new Map();
    this.activeProjects = new Map();
    this.finishedProjects = new Map();
  }

  id() {
    this.counter += 1;
    return `${ID_PREFIX}-0000-7000-8000-${this.counter.toString(16).padStart(12, '0')}`;
  }

  add(table, row) {
    (this.rows[table] ??= []).push(row);
    return row;
  }

  /** mulberry32: the same data on every run. */
  random() {
    this.seed = (this.seed + 0x6d2b79f5) | 0;
    let t = this.seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  }

  between(min, max) {
    return min + (max - min) * this.random();
  }

  int(min, max) {
    return Math.floor(this.between(min, max + 1));
  }

  pick(list) {
    return list[Math.floor(this.random() * list.length)];
  }

  chance(p) {
    return this.random() < p;
  }

  ago(days) {
    return new Date(this.now.getTime() - days * DAY_MS);
  }

  /** A moment between two dates, never in the future. */
  during(from, to) {
    const end = Math.min(to.getTime(), this.now.getTime());
    return new Date(from.getTime() + (end - from.getTime()) * this.random());
  }

  bytes(label) {
    return createHash('sha256').update(`${label}:${this.counter}`).digest();
  }

  person(key) {
    const found = this.people.get(key);
    if (found === undefined) throw new Error(`Unknown demo person ${key}`);
    return found;
  }

  /** Counts the project against the person's limit of active projects (teams FR: 2 at a time). */
  join(person, status) {
    if (ACTIVE_STATUSES.has(status)) {
      const count = (this.activeProjects.get(person.key) ?? 0) + 1;
      if (count > MAX_ACTIVE_PROJECTS)
        throw new Error(`${person.key} would have ${count} active projects`);
      this.activeProjects.set(person.key, count);
    } else {
      this.finishedProjects.set(person.key, (this.finishedProjects.get(person.key) ?? 0) + 1);
    }
  }

  /**
   * Someone of the crowd for a seat: the role is among the preferences, the person is free for another
   * active project and not in the team yet. Primary role and fewer projects first; ties broken at random.
   */
  pickHolder(role, status, taken) {
    const active = ACTIVE_STATUSES.has(status);
    const load = (p) =>
      active ? (this.activeProjects.get(p.key) ?? 0) : (this.finishedProjects.get(p.key) ?? 0);
    const candidates = [...this.people.values()]
      .filter((p) => !p.isDemo && !taken.has(p.key))
      .filter((p) => p.roles.some(([r]) => r === role))
      .filter((p) => !active || (this.activeProjects.get(p.key) ?? 0) < MAX_ACTIVE_PROJECTS)
      .map((p) => ({ p, rank: (p.roles[0][0] === role ? 0 : 2) + load(p) * 1.5 + this.random() }))
      .sort((a, b) => a.rank - b.rank);
    if (candidates.length === 0) throw new Error(`Nobody left for a ${role} seat`);
    return candidates[0].p;
  }
}

export const dateOnly = (date) => date.toISOString().slice(0, 10);
