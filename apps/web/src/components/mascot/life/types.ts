import type { BodyFrame, PropName } from './sprites';

/** Page coordinates (document, not viewport) of Толик's feet: bottom centre of the sprite. */
export interface Point {
  x: number;
  y: number;
}

/** A walkable top edge of a page block, in document coordinates. */
export interface Ledge {
  id: number;
  left: number;
  right: number;
  top: number;
}

/** A prop drawn this frame; `className` lets CSS animate it (float, fade, flicker). */
export interface PropDraw {
  name: PropName;
  dx?: number;
  dy?: number;
  className?: string;
}

/** Everything the actor needs to draw one frame. */
export interface Pose {
  x: number;
  y: number;
  scale: number;
  /** Squash and stretch around the feet. */
  sx: number;
  sy: number;
  /** Tilt in degrees around the feet (or the hands while hanging). */
  rotate: number;
  isHanging: boolean;
  facing: 1 | -1;
  frame: BodyFrame;
  props: readonly PropDraw[];
}

/** A timed motion: samples a pose at `elapsed` ms; done once elapsed >= duration. */
export interface Track {
  duration: number;
  sample: (elapsed: number) => Omit<Pose, 'isHanging'>;
}

/** What the page looks like right now, read once per frame by the engine. */
export interface View {
  scrollY: number;
  height: number;
  width: number;
}
