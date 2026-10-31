import {validationLabel} from './validation-labels.mjs';
import {messageError} from './localized-error.mjs';
/** Serializable, immutable audio edit state. Times are seconds, never frame indices. */
export const AUDIO_RATE = 48000;
export const AUDIO_CHUNK_BYTES = 192 * 1024;
export const MAX_AUDIO_FILE_BYTES = 32 * 1024 * 1024;
const MAX_AUDIO_PROJECT_BYTES = 96 * 1024 * 1024;
export const MAX_AUDIO_SECONDS = 3600;
const MAX_AUDIO_TRACKS = 64;
const MAX_AUDIO_CLIPS = 4096;
const MAX_AUDIO_VOICES = 32;
const EMPTY_AUDIO = Object.freeze({version: 1, assets: Object.freeze({}), tracks: Object.freeze([])});
const checkedAssets = new WeakSet();
const number = (value, min, max, name) => {
  if (!Number.isFinite(value) || value < min || value > max) throw messageError(new Error(''), "errors.audioModel.mustBeBetweenAnd", {name: validationLabel(name), min: min, max: max});
};
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
export const audioState = report => report?._styk?.audio ?? EMPTY_AUDIO;
export const audioFps = report => report.frame_delay_ms ? 1000 / report.frame_delay_ms : report.fps;
export const audioEnd = state => Math.max(0, ...state.tracks.flatMap(track => track.clips.map(clip => clip.start + clip.duration)));
export const freshAudioId = prefix => `${prefix}-${globalThis.crypto.randomUUID()}`;
export function* validateAudioAssetSteps(asset) {
  if (!asset || typeof asset !== 'object') throw messageError(new Error(''), "errors.audioModel.invalidAudioAsset", {});
  if (checkedAssets.has(asset)) return asset;
  if (!id(asset.id) || typeof asset.name !== 'string' || !asset.name.trim() || asset.name.length > 240) throw messageError(new Error(''), "errors.audioModel.invalidAudioAssetNameOrIdentity", {});
  number(asset.size, 1, MAX_AUDIO_FILE_BYTES, 'Audio file size');
  number(asset.duration, 1 / AUDIO_RATE, MAX_AUDIO_SECONDS, 'Audio duration');
  if (!Number.isInteger(asset.size) || !Array.isArray(asset.chunks) || asset.chunks.length > Math.ceil(MAX_AUDIO_FILE_BYTES / AUDIO_CHUNK_BYTES)) throw messageError(new Error(''), "errors.audioModel.invalidEmbeddedAudio", {});
  let size = 0, count = 0;
  for (const chunk of asset.chunks) {
    const text = chunk?.data_base64;
    if (typeof text !== 'string' || !text.length || text.length > AUDIO_CHUNK_BYTES * 4 / 3 || text.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) throw messageError(new Error(''), "errors.audioModel.invalidEmbeddedAudioBytes", {});
    size += text.length / 4 * 3 - (text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0);
    if (++count % 4 === 0) yield {phase:'validating audio',checked:size};
  }
  if (size !== asset.size) throw messageError(new Error(''), "errors.audioModel.embeddedAudioIsIncomplete", {});
  if (!Array.isArray(asset.peaks) || asset.peaks.length > 4096 || !asset.peaks.length || asset.peaks.some(p => !Number.isFinite(p) || p < 0 || p > 1)) throw messageError(new Error(''), "errors.audioModel.invalidAudioWaveform", {});
  checkedAssets.add(asset);
  return asset;
}
export const audibleClips = state => {
  const solo = state.tracks.some(track => track.solo);
  return state.tracks.filter(track => !track.mute && (!solo || track.solo) && track.gain > 0)
    .flatMap(track => track.clips.filter(clip => clip.gain > 0).map(clip => ({...clip, gain: clip.gain * track.gain})));
};
export const clipGainAt = (clip, time) => {
  const local = time - clip.start;
  if (local < 0 || local >= clip.duration) return 0;
  return clip.gain * Math.min(1, clip.fadeIn ? local / clip.fadeIn : 1, clip.fadeOut ? (clip.duration - local) / clip.fadeOut : 1);
};
