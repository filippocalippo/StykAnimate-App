/**
 * Where a value sits along a value control's travel, and back: the scale of a slider field
 * (docs/design/components.md, Value field). A wide range on a straight scale squeezes its useful part into a few
 * pixels (a particle count of 1 to 5000, an emitter of 0 to 4000 px), so such a range takes a scale that gives the
 * small values most of the travel:
 *
 *   linear  position = (value − min) / (max − min)
 *   log     position = ln(1 + (value − min) / knee) / ln(1 + (max − min) / knee): even steps in ratio above the knee,
 *           close to linear below it, so 0 stays reachable
 *   pow     position = ((value − min) / (max − min)) ^ (1 / exponent): a gentler curve for ranges of tens to hundreds
 *
 * Positions are 0 to 1 and values stay inside [min, max]. The functions are pure, so the drawn fill, the scrub and the
 * keyboard's coarse steps agree, and `positionToValue(valueToPosition(v)) ≈ v` (tests/value-scale.test.mjs).
 */
const clamp01 = value => Math.max(0, Math.min(1, value));

/** The knee of a log scale when none is given: a thousandth of the range, and never less than one step. */
export function defaultKnee(min, max, step = 0) {
  return Math.max(Number(step) || 0, (Number(max) - Number(min)) / 1000, Number.EPSILON);
}

/** The scale a control declares, made whole: {scale, min, max, knee, exponent}. Unknown scales are linear. */
export function scaleOf({scale = 'linear', min = 0, max = 1, knee, exponent, step} = {}) {
  const low = Number(min), high = Number(max);
  const kind = scale === 'log' || scale === 'pow' ? scale : 'linear';
  return {
    scale: kind, min: low, max: high,
    knee: kind === 'log' ? (Number(knee) > 0 ? Number(knee) : defaultKnee(low, high, step)) : undefined,
    exponent: kind === 'pow' ? (Number(exponent) > 1 ? Number(exponent) : 2) : undefined,
  };
}

/** Where `value` sits along the travel, 0 to 1 (0 for an empty or invalid range). */
export function valueToPosition(value, options) {
  const {scale, min, max, knee, exponent} = scaleOf(options), span = max - min, v = Number(value);
  if (!(span > 0) || !Number.isFinite(v)) return 0;
  const offset = Math.max(0, Math.min(span, v - min));
  if (scale === 'log') return clamp01(Math.log1p(offset / knee) / Math.log1p(span / knee));
  if (scale === 'pow') return clamp01((offset / span) ** (1 / exponent));
  return clamp01(offset / span);
}

/** The value at `position` (0 to 1) along the travel, inside [min, max]. */
export function positionToValue(position, options) {
  const {scale, min, max, knee, exponent} = scaleOf(options), span = max - min, t = clamp01(Number(position) || 0);
  if (!(span > 0) || t === 0) return min;
  if (t === 1) return max;
  let offset;
  if (scale === 'log') offset = knee * Math.expm1(t * Math.log1p(span / knee));
  else if (scale === 'pow') offset = span * t ** exponent;
  else offset = span * t;
  return Math.max(min, Math.min(max, min + offset));
}

/** A CSS percentage for a position ("37.5%"), the fill and the default's tick of a slider field. */
export const positionPercent = position => `${Number((clamp01(position) * 100).toFixed(2))}%`;
