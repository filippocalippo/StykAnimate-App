import {messageError} from './localized-error.mjs';
import english from './locales/en-features/keyframeEasing.mjs';
/** One outgoing timing curve per key. Native Pivot auto curves are import-only. */
import {isDiscreteAnimationProperty} from './animation-properties.mjs';
export const DEFAULT_BEZIER = Object.freeze([0.42, 0, 0.58, 1]);
const EASE_IN = Object.freeze([0.42, 0, 1, 1]), EASE_OUT = Object.freeze([0, 0, 0.58, 1]);
export const EASING_MODES = Object.freeze([
  {id: 'auto', label: english["keyframeEasing.auto"], labelKey: "keyframeEasing.auto", sample: t => t * t * (3 - 2 * t)},
  {id: 'bezier', label: english["keyframeEasing.bezier"], labelKey: "keyframeEasing.bezier", sample: (t, key) => cubicBezierProgress(t, key?.bezier ?? DEFAULT_BEZIER)},
  {id: 'ease-in', label: english["keyframeEasing.easeIn"], labelKey: "keyframeEasing.easeIn", sample: t => cubicBezierProgress(t, EASE_IN)},
  {id: 'ease-out', label: english["keyframeEasing.easeOut"], labelKey: "keyframeEasing.easeOut", sample: t => cubicBezierProgress(t, EASE_OUT)},
  {id: 'linear', label: english["keyframeEasing.linear"], labelKey: "keyframeEasing.linear", sample: t => t},
  {id: 'constant', label: english["keyframeEasing.constant"], labelKey: "keyframeEasing.constant", sample: t => t < 1 ? 0 : 1},
]);
const modes = new Map(EASING_MODES.map(mode => [mode.id, mode]));
export function easingMode(key) { return key?.interpolation === 'hold' ? 'constant' : key?.interpolation ?? 'linear'; }
export function validateKeyEasing(key, property) {
  if (!modes.has(easingMode(key))) throw messageError(new Error(''), "errors.keyframeEasing.invalidKeyInterpolationChooseAutoBezierEaseIn", {});
  if (key?.bezier !== undefined && (easingMode(key) !== 'bezier' || !Array.isArray(key.bezier) || key.bezier.length !== 4 ||
    !key.bezier.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1)))
    throw messageError(new Error(''), "errors.keyframeEasing.bezierRequiresFourControlCoordinatesBetween0And", {});
  if (isDiscreteAnimationProperty(property) && easingMode(key) !== 'constant') {
    const messageKey = property === 'paint' ? "keyframeEasing.gradientLayouts" : property === 'zIndex' ? "keyframeEasing.zIndexValues" : "keyframeEasing.backgroundIdentities";
    throw messageError(new Error(''), "errors.keyframeEasing.useConstantEasing", {value: {messageKey, diagnosticValue: english[messageKey]}});
  }
  return key;
}
/** Canonical fields for writes/copies. `hold` is a read-compatible legacy alias. */
export function keyEasing(key) {
  validateKeyEasing(key);
  const interpolation = easingMode(key);
  return {interpolation, ...(interpolation === 'bezier' ? {bezier: [...(key?.bezier ?? DEFAULT_BEZIER)]} : {})};
}
const coordinate = (t, a, b) => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t * t * b + t ** 3;
/** Invert x(u) before evaluating y(u); elapsed time is not the curve parameter. */
export function cubicBezierProgress(t, points = DEFAULT_BEZIER) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const [x1, y1, x2, y2] = points;
  let low = 0, high = 1, u = t;
  for (let i = 0; i < 40; i++) {
    const x = coordinate(u, x1, x2);
    if (Math.abs(x - t) < 1e-10) break;
    if (x < t) low = u; else high = u;
    u = (low + high) / 2;
  }
  return coordinate(u, y1, y2);
}
export function easedProgress(key, fraction) {
  const t = Math.max(0, Math.min(1, fraction));
  const mode = modes.get(easingMode(key));
  if (!mode) validateKeyEasing(key);
  return mode.sample(t, key);
}
