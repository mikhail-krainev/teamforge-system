/** Pendulum for hanging off the cursor: the cursor's acceleration pushes him the other way. */
const STIFFNESS = 0.00006;
const DAMPING = 0.0035;
const PUSH = 0.5;
/** Caps jerky input (a jumping cursor) so he swings, not spins. */
const MAX_ACCEL = 0.04;
const MAX_ANGLE_DEG = 40;
const RAD_TO_DEG = 180 / Math.PI;

export interface Swing {
  angle: number;
  velocity: number;
  lastPointerVx: number;
}

export function createSwing(): Swing {
  return { angle: 0, velocity: 0, lastPointerVx: 0 };
}

/**
 * Advances the swing by dt ms. pointerVx is the cursor's horizontal speed in px/ms;
 * returns the tilt in degrees (positive swings the feet to the right).
 */
export function stepSwing(swing: Swing, dt: number, pointerVx: number): number {
  const step = Math.min(dt, 40);
  const raw = (pointerVx - swing.lastPointerVx) / Math.max(step, 1);
  const accel = Math.max(-MAX_ACCEL, Math.min(MAX_ACCEL, raw));
  swing.lastPointerVx = pointerVx;
  swing.velocity +=
    (-STIFFNESS * swing.angle - DAMPING * swing.velocity - PUSH * accel * 0.01) * step;
  swing.angle += swing.velocity * step;
  const limit = MAX_ANGLE_DEG / RAD_TO_DEG;
  swing.angle = Math.max(-limit, Math.min(limit, swing.angle));
  return swing.angle * RAD_TO_DEG;
}
