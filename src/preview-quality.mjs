import {t as interfaceText} from './localization.mjs';
export const previewQualityLevels = [1, 0.75, 0.5, 0.25];
// WebGPU supports one or four samples, never two.
export const previewMsaaLevels = [4, 1, 1, 1];

// Saved playback preferences select the existing renderer quality levels.
// Editing and export do not use this setting. Automatic is explicitly opt-in.
export const playbackQualityOptions = Object.freeze([
  {id:'normal', label:interfaceText("previewQuality.normal100"), labelKey: "previewQuality.normal100", index:0},
  {id:'medium', label:interfaceText("previewQuality.medium75"), labelKey: "previewQuality.medium75", index:1},
  {id:'low', label:interfaceText("previewQuality.low50"), labelKey: "previewQuality.low50", index:2},
  {id:'draft', label:interfaceText("previewQuality.draft25"), labelKey: "previewQuality.draft25", index:3},
  {id:'auto', label:interfaceText("previewQuality.automatic"), labelKey: "previewQuality.automatic", index:0},
]);
export function normalizePlaybackQuality(value) {
  return playbackQualityOptions.some(option=>option.id===value) ? value : 'normal';
}
export function playbackQualityIndex(value) {
  return playbackQualityOptions.find(option=>option.id===normalizePlaybackQuality(value)).index;
}

/** Preserve CSS coordinates while fitting the physical surface to the device. */
export function viewportBackingSize(width, height, dpr, maxDimension) {
  width = Number.isFinite(width) ? Math.max(1, width) : 1;
  height = Number.isFinite(height) ? Math.max(1, height) : 1;
  dpr = Number.isFinite(dpr) ? Math.max(.25, Math.min(3, dpr)) : 1;
  dpr = Math.min(dpr, maxDimension / width, maxDimension / height);
  return {width, height, dpr, pw: Math.max(1, Math.round(width * dpr)), ph: Math.max(1, Math.round(height * dpr))};
}

/** Return true only when a sustained presentation change selects a new level. */
export function updatePreviewQuality(governor, sample, now, buffering = false) {
  if (!Number.isFinite(sample.fps) || !Number.isFinite(sample.targetFps) || sample.targetFps <= 0 || buffering) {
    governor.lowSince = governor.highSince = null;
    return false;
  }
  const deficit = sample.fps < sample.targetFps * .92;
  // Playback is paced to its target: it cannot sustain 120% of that target.
  const recovered = sample.fps >= sample.targetFps * .98;
  governor.lowSince = deficit ? governor.lowSince ?? now : null;
  governor.highSince = recovered && governor.index > 0 ? governor.highSince ?? now : null;
  if (now - (governor.changedAt ?? 0) <= 2500) return false;
  // Draft is an explicit user choice; Automatic retains its 50% floor.
  if (governor.index < 2 && governor.lowSince !== null && now - governor.lowSince > 2000) {
    governor.index++;
  } else if (governor.index > 0 && governor.highSince !== null && now - governor.highSince > 6000) {
    governor.index--;
  } else return false;
  governor.changedAt = now;
  governor.lowSince = governor.highSince = null;
  return true;
}
