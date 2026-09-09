/** Shared channel vocabulary for validation, timeline rows and discrete sampling. */
export const ANIMATION_PROPERTIES = Object.freeze({
  figure: Object.freeze(['x', 'y', 'scale', 'rotation', 'color', 'opacity', 'outlineColor', 'outlineWidth', 'outlineOpacity', 'zIndex', 'pose']),
  segment: Object.freeze(['color', 'opacity', 'thickness', 'gradientColor', 'gradientOpacity', 'paint']),
  polygon: Object.freeze(['color', 'opacity']),
  camera: Object.freeze(['pose', 'x', 'y', 'scale', 'rotation']),
  scene: Object.freeze(['pose', 'backgroundId', 'color']),
  layer: Object.freeze(['pose']),
});
// Imported scalar transform curves remain readable, but new figure translation
// and rotation edits belong to Pose. Camera transforms remain independent.
export const isFigurePoseTransform = (target, property) => target.kind === 'figure' && ['x','y','rotation'].includes(property);
export const AUTHORING_PROPERTIES = Object.freeze({...ANIMATION_PROPERTIES,
  figure:Object.freeze(ANIMATION_PROPERTIES.figure.filter(property=>!isFigurePoseTransform({kind:'figure'},property))),
});
export const ANIMATION_PROPERTY_NAMES = Object.freeze({pose: 'Pose', x: 'Position X', y: 'Position Y', scale: 'Scale', rotation: 'Rotation', opacity: 'Opacity', outlineOpacity: 'Outline opacity', outlineColor: 'Outline color', outlineWidth: 'Outline width', thickness: 'Width', gradientColor: 'Gradient color', gradientOpacity: 'Gradient opacity', paint: 'Fill style', zIndex: 'Z-index', backgroundId: 'Background', color: 'Color'});
export const isColorAnimationProperty = property => ['color', 'outlineColor', 'gradientColor'].includes(property);
export const isDiscreteAnimationProperty = property => property === 'backgroundId' || property === 'zIndex' || property === 'paint';
export function validateFigureZIndex(value) {
  if (!Number.isSafeInteger(value) || Math.abs(value) > 1000000) throw new Error('Z-index must be a whole number from -1,000,000 to 1,000,000.');
  return value;
}
