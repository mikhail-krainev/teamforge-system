import { describe, expect, it } from 'vitest';
import { isWalkable, route } from './paths';
import { createSim, step, type StoryPhase } from './sim';
import { ENTRY, EXIT_INSIDE, QUEUE_SLOTS, SEATS, SPOTS } from './world';

const FRAME = 1 / 60;

function run(seconds: number, onFrame?: (phase: StoryPhase) => void) {
  const sim = createSim();
  for (let i = 0; i < seconds / FRAME; i += 1) {
    step(sim, FRAME);
    onFrame?.(sim.story.phase);
  }
  return sim;
}

describe('office paths', () => {
  it('reaches every seat, spot, queue slot and the exit from the entry', () => {
    const targets = [...SEATS.map((s) => s.at), ...SPOTS.map((s) => s.at), ...QUEUE_SLOTS, EXIT_INSIDE];
    for (const target of targets) {
      expect(route(ENTRY, target).length, JSON.stringify(target)).toBeGreaterThan(0);
    }
  });

  it('keeps queue slots walkable', () => {
    for (const slot of QUEUE_SLOTS) expect(isWalkable(slot)).toBe(true);
  });
});

describe('office simulation', () => {
  it('starts with the old still frame: three in line and one free desk', () => {
    const sim = createSim();
    expect(sim.people.filter((p) => p.role === 'queue')).toHaveLength(3);
    expect(sim.story.freeSeatId).toBe('top-2');
  });

  it('runs whole hiring cycles and keeps the office staffed', () => {
    const seen = new Set<StoryPhase>();
    const sim = run(150, (phase) => seen.add(phase));
    expect([...seen].sort()).toEqual(['done', 'free', 'offer', 'trial', 'walking']);
    const members = sim.people.filter((p) => p.role === 'member');
    expect(members.length).toBeGreaterThanOrEqual(5);
    expect(sim.people.filter((p) => p.role === 'queue').length).toBeGreaterThanOrEqual(2);
    for (const person of sim.people) {
      expect(Number.isFinite(person.pos.x) && Number.isFinite(person.pos.y)).toBe(true);
    }
  });

  it('never seats two members at one desk', () => {
    const sim = run(200);
    const seats = sim.people.filter((p) => p.role === 'member').map((p) => p.seatId);
    expect(new Set(seats).size).toBe(seats.length);
  });
});
