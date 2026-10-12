/** Source of the current time. Business code never calls `new Date()` or SQL `now()` directly. */
export abstract class Clock {
  abstract now(): Date;
}

export class SystemClock extends Clock {
  override now(): Date {
    return new Date();
  }
}

/** Controllable clock for tests: time moves only when told to. */
export class FixedClock extends Clock {
  private current: Date;

  constructor(initial: Date | string | number = '2026-01-01T00:00:00.000Z') {
    super();
    this.current = new Date(initial);
  }

  override now(): Date {
    return new Date(this.current);
  }

  set(value: Date | string | number): void {
    this.current = new Date(value);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
