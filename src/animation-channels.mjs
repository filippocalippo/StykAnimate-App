import {messageError} from './localized-error.mjs';
import {validateVfxClips} from './vfx-clips.mjs';
import {validateCameraMotion} from './camera-motion.mjs';
import {validateCameraParallaxOffset} from './layer-parallax.mjs';
/** Sparse authored channels overlay the untouched native Pivot animation. */
import {normalizePaint} from './paint.mjs';
import {isVfxProperty, validateVfxValue} from './vfx.mjs';
import {supportsAnimationProperty, ANIMATION_PROPERTIES, isColorAnimationProperty, validateFigureZIndex, validateDrawableZIndex} from './animation-properties.mjs';
import {validateKeyEasing} from './keyframe-easing.mjs';

const properties = Object.fromEntries(Object.entries(ANIMATION_PROPERTIES).map(([kind, values]) => [kind, new Set(values)]));
export function normalizeAnimationTarget(target) {
  if (!target || !properties[target.kind]) throw messageError(new Error(''), "errors.animationChannels.chooseAFigureSegmentLayerCameraOrScene", {});
  if (target.figureTypeId !== undefined && !['segment','polygon'].includes(target.kind)) throw messageError(new Error(''), "errors.animationChannels.onlySegmentAndPolygonAnimationCanBeScoped", {});
  if (target.kind === 'polygon') {
    if (!Number.isInteger(target.uid) || target.uid < 0 || !Number.isInteger(target.polygonId) || target.polygonId < 1 || target.polygonId > 65535 || !Number.isSafeInteger(target.figureTypeId) || target.figureTypeId < 1)
      throw messageError(new Error(''), "errors.animationChannels.polygonAnimationRequiresAFigureUidPolygonIdentity", {});
    return {kind:'polygon', uid:target.uid, polygonId:target.polygonId, figureTypeId:target.figureTypeId};
  }
  if (target.kind === 'figure' || target.kind === 'segment') {
    if (!Number.isInteger(target.uid) || target.uid < 0) throw messageError(new Error(''), "errors.animationChannels.figureAnimationRequiresANativeFigureIdentity", {});
    if (target.kind === 'segment') {
      if (!Number.isInteger(target.handleId) || target.handleId < 1 || target.handleId > 65535) throw messageError(new Error(''), "errors.animationChannels.segmentAnimationRequiresANativeSegmentHandleIdentity", {});
      if (target.figureTypeId !== undefined && (!Number.isSafeInteger(target.figureTypeId) || target.figureTypeId < 1)) throw messageError(new Error(''), "errors.animationChannels.segmentAnimationScopeRequiresAPositiveNativeFigure", {});
      return {kind: 'segment', uid: target.uid, handleId: target.handleId,
        ...(target.figureTypeId === undefined ? {} : {figureTypeId: target.figureTypeId})};
    }
    return {kind: 'figure', uid: target.uid};
  }
  if (target.kind === 'layer') {
    if (typeof target.id !== 'string' || !target.id || target.id.length > 256) throw messageError(new Error(''), "errors.animationChannels.layerAnimationRequiresALayerIdentity", {});
    return {kind: 'layer', id: target.id};
  }
  return {kind: target.kind};
}
export function animationChannelId(target, property) {
  target = normalizeAnimationTarget(target);
  if (!supportsAnimationProperty(target,property)) throw messageError(new Error(''), "errors.animationChannels.propertyCannotAnimateOn", {property: property, kind: target.kind});
  const identity = target.kind === 'polygon' ? `${target.uid}/${target.polygonId}@${target.figureTypeId}` : target.kind === 'segment' ? `${target.uid}/${target.handleId}${target.figureTypeId === undefined ? '' : `@${target.figureTypeId}`}` : target.uid ?? target.id ?? '';
  return `${target.kind}:${encodeURIComponent(identity)}:${property}`;
}
export function validateAnimationValue(target, property, value) {
  animationChannelId(target, property);
  if(isVfxProperty(property))return validateVfxValue(property,value);
  if (property === 'paint') return normalizePaint(value);
  if (property === 'pose') {
    if (value === null) return {frameId: null};
    if (!value || !(value.frameId === null || typeof value.frameId === 'string' && value.frameId.length > 0)) throw messageError(new Error(''), "errors.animationChannels.aPoseKeyMustReferenceANativeFrame", {});
    return {frameId: value.frameId};
  }
  if (target.kind === 'scene' && property === 'color' && value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw messageError(new Error(''), "errors.animationChannels.animationValuesMustBeFiniteNumbers", {});
  if (property === 'zIndex') return target.kind === 'figure' ? validateFigureZIndex(value) : validateDrawableZIndex(value);
  if (property === 'scale' && (value < (target.kind === 'camera' ? 0.000001 : 0) || value > 1e6)) throw messageError(new Error(''), "errors.animationChannels.animationScaleIsOutsideTheSupportedRange", {});
  if (['opacity', 'outlineOpacity', 'gradientOpacity'].includes(property) && (value < 0 || value > 1)) throw messageError(new Error(''), "errors.animationChannels.animationOpacityMustBeBetweenZeroAndOne", {});
  if (property === 'backgroundId' && (!Number.isInteger(value) || value < 0 || value > 0xffffffff)) throw messageError(new Error(''), "errors.animationChannels.chooseAValidBackgroundIdentity", {});
  if (isColorAnimationProperty(property) && (!Number.isInteger(value) || value < 0 || value > 0xffffffff)) throw messageError(new Error(''), "errors.animationChannels.colorMustBeA32BitColor", {});
  if (isColorAnimationProperty(property) && (target.kind === 'segment' || target.kind === 'polygon' || property === 'outlineColor') && value > 0xffffff) throw messageError(new Error(''), "errors.animationChannels.styleColorsUseRgbOpacityHasItsOwn", {});
  if (['outlineWidth', 'thickness'].includes(property) && (value < 0 || value > 1e6)) throw messageError(new Error(''), "errors.animationChannels.widthMustBeBetweenZeroAnd1000", {});
  return value;
}
const EMPTY_CHANNELS = Object.freeze([]), channelIndices = new WeakMap();
export function animationChannels(report) { return report?._styk?.animation?.channels ?? EMPTY_CHANNELS; }
export function findAnimationChannel(report, target, property) {
  const channels = animationChannels(report); let index = channelIndices.get(channels);
  if (!index) { index = new Map(channels.map(channel => [channel.id, channel])); channelIndices.set(channels, index); }
  return index.get(animationChannelId(target, property)) ?? null;
}
export function validateAnimationDocument(report) {
  const steps = validateAnimationDocumentSteps(report);
  for (;;) { const step = steps.next(); if (step.done) return step.value; }
}
/** Cooperative validation never mutates its document; callers may cancel between checkpoints. */
export function* validateAnimationDocumentSteps(report) {
  validateVfxClips(report._styk?.vfxClips);
  validateCameraMotion(report._styk?.cameraMotion);
  let scanned = 0;
  for (const frame of report.keyframes ?? []) {
    validateCameraParallaxOffset(frame.camera);
    if (frame._styk?.easing) validateKeyEasing(frame._styk.easing);
    if (++scanned % 256 === 0) yield {phase: 'animation', frames: scanned};
  }
  for (const id in report._styk?.frameSources ?? {}) {
    const frame = report._styk.frameSources[id];
    validateCameraParallaxOffset(frame.camera);
    if (frame._styk?.easing) validateKeyEasing(frame._styk.easing);
    if (++scanned % 256 === 0) yield {phase: 'animation', frames: scanned};
  }
  const animation = report?._styk?.animation; if (animation == null) return report;
  if (animation.version !== 1 || !Array.isArray(animation.channels) || animation.channels.length > 100000) throw messageError(new Error(''), "errors.animationChannels.invalidAuthoredAnimationChannelTable", {});
  if (animation.nextKeyId !== undefined && (!Number.isSafeInteger(animation.nextKeyId) || animation.nextKeyId < 1)) throw messageError(new Error(''), "errors.animationChannels.invalidAnimationKeyIdentityCounter", {});
  const channels = new Set(), validatedPoses = new WeakSet(); let keyCount = 0, sourceIds, figureTypeIds, visited = 0;
  for (const channel of animation.channels) {
    if (channel.id !== animationChannelId(channel.target, channel.property) || channels.has(channel.id) || !Array.isArray(channel.keys)) throw messageError(new Error(''), "errors.animationChannels.animationChannelsMustHaveUniqueStableIdentities", {});
    if (channel.nativeProperties !== undefined && (channel.nativeProperties !== true || channel.property !== 'pose' || !['figure','layer'].includes(channel.target.kind)))
      throw messageError(new Error(''), "errors.animationChannels.nativePropertyInheritanceIsOnlyValidOnFigure", {});
    if(channel.maskedRanges!==undefined && (channel.property!=='pose' || channel.target.kind!=='figure' || !Array.isArray(channel.maskedRanges) || channel.maskedRanges.length>100000 || channel.maskedRanges.some((range,i)=>
      !Array.isArray(range)||range.length!==2||!Number.isInteger(range[0])||range[0]<0||!Number.isInteger(range[1])||range[1]<=range[0]||range[1]>10000001||i>0&&range[0]<=channel.maskedRanges[i-1][1])))
      throw messageError(new Error(''), "errors.animationChannels.invalidPoseVisibilityRanges", {});
    if(channel.useBasePose!==undefined && (channel.useBasePose!==true||channel.property!=='pose'||channel.target.kind!=='figure'))throw messageError(new Error(''), "errors.animationChannels.invalidNativePosePassthrough", {});
    if(channel.orderAnchor!==undefined && (channel.property!=='pose'||channel.target.kind!=='figure'||!Number.isInteger(channel.orderAnchor)||channel.orderAnchor<0||channel.orderAnchor>0xffffffff||channel.orderAnchor===channel.target.uid))throw messageError(new Error(''), "errors.animationChannels.invalidPoseStackingAnchor", {});
    if (channel.target.figureTypeId !== undefined) {
      if (!figureTypeIds) {
        figureTypeIds = new Set();
        for (const figure of report.figure_types ?? []) {
          figureTypeIds.add(figure.figure_type_id);
          if (++visited % 256 === 0) yield {phase:'animation',channels:channels.size,keys:keyCount};
        }
      }
      if (!figureTypeIds.has(channel.target.figureTypeId)) throw messageError(new Error(''), "errors.animationChannels.animationSegmentScopeReferencesMissingFigureDefinition", {figureTypeId: channel.target.figureTypeId});
    }
    if(channel.movieclipCurve!==undefined&&(channel.movieclipCurve!==true||!['figure','segment','polygon'].includes(channel.target.kind)))throw messageError(new Error(''), "errors.animationChannels.invalidMovieclipCurveContext", {});
    if(channel.clipEnd!==undefined&&(channel.property!=='pose'||channel.target.kind!=='figure'||!Number.isInteger(channel.clipEnd)||channel.clipEnd<0||channel.clipEnd>10000001))throw messageError(new Error(''), "errors.animationChannels.invalidMovieclipEnd", {});
    if(channel.movieclipPart!==undefined&&(channel.property!=='pose'||channel.target.kind!=='figure'||!Number.isInteger(channel.movieclipPart?.instance)||channel.movieclipPart.instance<0||channel.movieclipPart.instance>0xffffffff||typeof channel.movieclipPart.path!=='string'||channel.movieclipPart.path.length>1024))throw messageError(new Error(''), "errors.animationChannels.invalidExpandedMovieclipIdentity", {});
    if(channel.keys[0]?.tick<0&&!channel.movieclipCurve)throw messageError(new Error(''), "errors.animationChannels.onlyMovieclipCurvesCanRetainKeysBeforeThe", {});
    channels.add(channel.id); const ids = new Set(), occupied = new Set(); let previous = channel.movieclipCurve?-10000000:-1;
    if (channel.property === 'pose' && validatedPoses.has(channel.keys)) {
      if (++visited % 256 === 0) yield {phase:'animation',channels:channels.size,keys:keyCount};
      continue;
    }
    for (const key of channel.keys) {
      if (++keyCount > 1000000) throw messageError(new Error(''), "errors.animationChannels.authoredAnimationExceedsTheOneMillionKeyLimit", {});
      if (typeof key.id !== 'string' || !key.id || ids.has(key.id)) throw messageError(new Error(''), "errors.animationChannels.animationKeysMustHaveUniqueStableIdentities", {});
      if (!Number.isInteger(key.tick) || key.tick < (channel.movieclipCurve?-10000000:0) || key.tick > 10000000 || key.tick < previous) throw messageError(new Error(''), "errors.animationChannels.animationKeysMustBeSortedAtValidWhole", {});
      if (key.hidden && channel.property !== 'pose') throw messageError(new Error(''), "errors.animationChannels.onlyNativePoseKeysCanBeHidden", {});
      if (key.passthrough !== undefined && (typeof key.passthrough !== 'boolean' || channel.property === 'pose')) throw messageError(new Error(''), "errors.animationChannels.onlyScalarKeysSupportABooleanPassthroughInterval", {});
      if (key.nativeCurve !== undefined && (key.nativeCurve !== 'pchip' || !['x','y','scale','rotation'].includes(channel.property))) throw messageError(new Error(''), "errors.animationChannels.invalidNativePropertyCurve", {});
      if (key.nativeRotation !== undefined && (key.nativeRotation !== true || channel.property !== 'rotation')) throw messageError(new Error(''), "errors.animationChannels.invalidNativeRotationCurve", {});
      if (key.nativeValueMode !== undefined && (channel.target.kind !== 'figure' || !['color','opacity'].includes(key.nativeValueMode) || key.nativeValueMode !== channel.property)) throw messageError(new Error(''), "errors.animationChannels.invalidNativePropertySamplingMode", {});
      if (!key.hidden && occupied.has(key.tick)) throw messageError(new Error(''), "errors.animationChannels.multiplePropertyKeysOccupyTheSameFrame", {});
      if (!key.hidden) occupied.add(key.tick); ids.add(key.id); previous = key.tick;
      // Older documents may label background holds as linear. Preserve their
      // read compatibility; newly introduced depth tracks require explicit holds.
      validateKeyEasing(key, channel.property === 'zIndex' ? channel.property : undefined);
      validateAnimationValue(channel.target, channel.property, key.value);
      if (channel.property === 'pose' && key.value?.frameId != null) {
        if (!sourceIds) {
          sourceIds = new Set();
          for (const frame of report.keyframes ?? []) {
            const id = frame._styk?.frameId; if (id) sourceIds.add(id);
            if (++visited % 256 === 0) yield {phase:'animation',channels:channels.size,keys:keyCount};
          }
          const retained = report._styk?.frameSources ?? {};
          for (const id in retained) {
            if (Object.hasOwn(retained,id)) sourceIds.add(id);
            if (++visited % 256 === 0) yield {phase:'animation',channels:channels.size,keys:keyCount};
          }
        }
        if (!sourceIds.has(key.value.frameId)) throw messageError(new Error(''), "errors.animationChannels.animationPoseReferencesMissingSourceFrame", {frameId: key.value.frameId});
      }
      if (++visited % 256 === 0) yield {phase:'animation',channels:channels.size,keys:keyCount};
    }
    if (channel.property === 'pose') validatedPoses.add(channel.keys);
    if (++visited % 256 === 0) yield {phase:'animation',channels:channels.size,keys:keyCount};
  }
  return report;
}
export function animationEndTick(report) {
  let end = 0;
  for (const channel of animationChannels(report)) if (channel.keys?.length) {
    const keys = channel.keys, tick = keys.at(-1).tick;
    let visible = false;
    // Imported authoring files may place coincident hidden references after a
    // visible key. Every visible key still owns its final display frame.
    for (let i = keys.length - 1; i >= 0 && keys[i].tick === tick; i--) if (!keys[i].hidden) { visible = true; break; }
    end = Math.max(end, channel.clipEnd??0, tick + (visible ? 1 : 0));
  }
  return end;
}
