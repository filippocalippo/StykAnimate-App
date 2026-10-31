// A valid saved camera-motion clip of a preset type, as the engine creates it (`styk_edit`), for tests that need a clip without a document.
import {validateCameraMotion} from '../../src/camera-motion.mjs';

const FOLLOW_DEFAULTS = Object.freeze({strength: 1, followX: 1, followY: 1, offsetX: 0, offsetY: 0, lag: 8, deadZone: 0,
  lookAhead: 0, zoomFit: 0, padding: .2, maxZoom: 3, fadeIn: 6, fadeOut: 6});
const DEFAULTS = Object.freeze({strength: 1, moveX: 12, moveY: 12, roll: 1, zoom: 0, frequency: 8, roughness: .5, direction: 0, recovery: 5, phase: 0, fadeIn: 2, fadeOut: 4, seed: 1});
const PRESETS = {
  handheld: {moveX: 3, moveY: 2, roll: .3, frequency: .7},
  wobble: {moveX: 5, moveY: 2, roll: 2, frequency: 1.5},
  impact: {moveX: 18, moveY: 18, roll: 1.5, zoom: .04, fadeIn: 0, fadeOut: 0, frequency: 6},
  pulse: {moveX: 0, moveY: 0, roll: 0, zoom: .08, fadeIn: 0, fadeOut: 0},
};

/** The clip, checked as a document would be: a follow clip needs followed figures, a type must be a preset. */
export function createCameraMotion(type, id, start = 0, duration = 24, {targets} = {}) {
  const clip = type === 'follow'
    ? {id, type, start, duration, enabled: true, targets: targets.map(t => ({uid: t.uid, weight: t.weight})), params: {...FOLLOW_DEFAULTS}}
    : {id, type, start, duration, enabled: true, params: {...DEFAULTS, ...PRESETS[type]}};
  validateCameraMotion({version: 1, clips: [clip]});
  return clip;
}
