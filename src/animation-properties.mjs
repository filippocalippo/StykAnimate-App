import {messageError} from './localized-error.mjs';
import {vfxDescriptor,isVfxProperty} from './vfx.mjs';
/** Shared channel vocabulary for validation, timeline rows and discrete sampling. */
export const ANIMATION_PROPERTIES = Object.freeze({
  figure: Object.freeze(['x', 'y', 'scale', 'rotation', 'color', 'opacity', 'outlineColor', 'outlineWidth', 'outlineOpacity', 'zIndex', 'pose']),
  segment: Object.freeze(['color', 'opacity', 'thickness', 'gradientColor', 'gradientOpacity', 'paint', 'zIndex']),
  polygon: Object.freeze(['color', 'opacity', 'zIndex']),
  camera: Object.freeze(['pose', 'x', 'y', 'scale', 'rotation']),
  scene: Object.freeze(['pose', 'backgroundId', 'color']),
  layer: Object.freeze(['pose']),
});
// Imported scalar transform curves remain readable, but new figure translation
// and rotation edits belong to Pose. Camera transforms remain independent.
const isFigurePoseTransform = (target, property) => target.kind === 'figure' && ['x','y','rotation'].includes(property);
const AUTHORING_PROPERTIES = Object.freeze({...ANIMATION_PROPERTIES,
  figure:Object.freeze(ANIMATION_PROPERTIES.figure.filter(property=>!isFigurePoseTransform({kind:'figure'},property))),
});
const ANIMATION_PROPERTY_NAMES = Object.freeze({pose: 'Pose', x: 'Position X', y: 'Position Y', scale: 'Scale', rotation: 'Rotation', opacity: 'Opacity', outlineOpacity: 'Outline opacity', outlineColor: 'Outline color', outlineWidth: 'Outline width', thickness: 'Width', gradientColor: 'Gradient color', gradientOpacity: 'Gradient opacity', paint: 'Fill style', zIndex: 'Z-index', backgroundId: 'Background', color: 'Color'});
export const isColorAnimationProperty = property => ['color', 'outlineColor', 'gradientColor'].includes(property) || vfxDescriptor(property)?.type==='color';
export const isDiscreteAnimationProperty = property => property === 'backgroundId' || property === 'zIndex' || property === 'paint' || Boolean(vfxDescriptor(property)?.discrete);
export const supportsAnimationProperty=(target,property)=>property==='vfxScope'?target.kind==='figure':ANIMATION_PROPERTIES[target.kind]?.includes(property)||(['figure','segment','scene'].includes(target.kind)&&isVfxProperty(property)&&Boolean(vfxDescriptor(property)));
export function validateFigureZIndex(value) {
  if (!Number.isSafeInteger(value) || Math.abs(value) > 1000000) throw messageError(new Error(''), "errors.animationProperties.zIndexMustBeAWholeNumberFrom", {});
  return value;
}
// Imported internal orders may contain fractional positions or tied depths.
export function validateDrawableZIndex(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(Math.fround(value)))
    throw messageError(new Error(''), "errors.animationProperties.drawOrderMustBeAFiniteNativeNumber", {});
  return value;
}
