/**
 * `FakeClock` (docs/plan.md, "Часы"): replaces the `Clock` provider in tests so that deadlines, timers
 * and cooling periods are driven with `advance()`/`set()` instead of `setTimeout`.
 * It is the application's `FixedClock` under the name used by the plan.
 */
export { FixedClock as FakeClock } from '../../src/platform/clock/clock.js';
