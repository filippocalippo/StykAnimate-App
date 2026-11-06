/** The influence of a motion-path falloff drag, which the interface draws and sets (the writes of an edit are the session's:
 * styk-edit `motion_path.rs`). */

const MOTION_PATH_FALLOFF_SHAPES = Object.freeze(['smooth', 'linear', 'sharp', 'flat']);
export const MOTION_PATH_FALLOFF_MAX = 240;

/** Influence at `distance` frames from the grabbed frame: 1 there, 0 beyond
 * `radius`, and strictly positive inside it for every shape. */
export function falloffWeight(distance, radius, shape = 'smooth') {
  distance = Math.abs(distance);
  if (distance === 0) return 1;
  if (!(radius > 0) || distance > radius) return 0;
  const u = distance / (radius + 1);
  if (shape === 'linear') return 1 - u;
  if (shape === 'sharp') return (1 - u) ** 3;
  if (shape === 'flat') return 1;
  return 0.5 + 0.5 * Math.cos(Math.PI * u);
}
