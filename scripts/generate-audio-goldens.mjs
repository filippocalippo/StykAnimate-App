// Generates the mixer's goldens from today's `src/audio-pcm.mjs` and `src/audio-model.mjs`: source WAV files, the clips and
// ranges mixed, the float32 WAVs `mixAudio` produced (written as `pcmWave` writes them), the peaks `wavePeaks` produced and the
// clips `audibleClips` selected. The native mixer (`styk-core::audio`) is held to these bit for bit by
// `engine/crates/styk-core/tests/audio_goldens.rs`.
//
//   node scripts/generate-audio-goldens.mjs [out-dir]
//
// The script runs today's mixer twice on identical input and fails when the runs differ (an old-versus-old baseline), and it
// fails when today's mixer is not invariant to the chunk size on a case (a case that is not would make the native chunk checks
// meaningless). Sources are synthesised from integer formulas, so regenerating gives the same files.
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectWave, mixAudio, pcmWave, wavePeaks} from '../src/audio-pcm.mjs';
import {audibleClips} from '../src/audio-model.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] ?? join(root, 'engine/crates/styk-core/tests/fixtures/audio');
mkdirSync(out, {recursive: true});

/** A deterministic signal in [-1, 1]: a slow sine plus integer noise. */
const signal = (i, c, seed) => {
  const noise = (((i * 7919 + c * 104729 + seed * 31) % 65521) / 65521) * 2 - 1;
  return 0.6 * Math.sin(i * 0.031 + c + seed) + 0.3 * noise;
};

function wav({code, channels, rate, bits, frames, value, extensible = false}) {
  const stride = channels * bits / 8, data = frames * stride, fmt = extensible ? 40 : 16;
  const bytes = new Uint8Array(12 + 8 + fmt + 8 + data), view = new DataView(bytes.buffer);
  const put = (at, text) => { for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i); };
  put(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); put(8, 'WAVE'); put(12, 'fmt '); view.setUint32(16, fmt, true);
  view.setUint16(20, extensible ? 0xfffe : code, true); view.setUint16(22, channels, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * stride, true); view.setUint16(32, stride, true); view.setUint16(34, bits, true);
  if (extensible) { view.setUint16(36, 22, true); view.setUint16(38, bits, true); view.setUint32(40, 3, true); view.setUint16(44, code, true); }
  const dataAt = 20 + fmt; put(dataAt, 'data'); view.setUint32(dataAt + 4, data, true);
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) {
    const at = dataAt + 8 + i * stride + c * bits / 8, v = value(i, c);
    if (code === 3) view.setFloat32(at, v, true);
    else if (bits === 8) view.setUint8(at, Math.max(0, Math.min(255, Math.round(v * 127) + 128)));
    else if (bits === 16) view.setInt16(at, Math.max(-32768, Math.min(32767, Math.round(v * 32767))), true);
    else if (bits === 24) { const n = Math.max(-8388608, Math.min(8388607, Math.round(v * 8388607))); view.setUint8(at, n & 255); view.setUint8(at + 1, n >> 8 & 255); view.setUint8(at + 2, n >> 16 & 255); }
    else view.setInt32(at, Math.max(-2147483648, Math.min(2147483647, Math.round(v * 2147483647))), true);
  }
  return bytes;
}

const sine = (seed) => (i, c) => signal(i, c, seed);
// Full scale, a negative full scale, NaN, infinities and values over 1: `sample` clamps and zeroes them.
const edge = (i, c) => [1.5, -1.5, NaN, Infinity, -Infinity, 1, -1, 0, -0, 0.25][(i + c) % 10];
const SOURCES = {
  'mono16-44k': wav({code: 1, channels: 1, rate: 44100, bits: 16, frames: 22050, value: sine(1)}),
  'stereo16-48k': wav({code: 1, channels: 2, rate: 48000, bits: 16, frames: 12000, value: sine(2)}),
  'stereo24-96k-ext': wav({code: 1, channels: 2, rate: 96000, bits: 24, frames: 9600, value: sine(3), extensible: true}),
  'mono8-8k': wav({code: 1, channels: 1, rate: 8000, bits: 8, frames: 4000, value: sine(4)}),
  'mono32i-22k': wav({code: 1, channels: 1, rate: 22050, bits: 32, frames: 3000, value: sine(5)}),
  'stereo-f32-edge': wav({code: 3, channels: 2, rate: 48000, bits: 32, frames: 4800, value: edge}),
  'f32-one': wav({code: 3, channels: 1, rate: 48000, bits: 32, frames: 4800, value: () => 1}),
  'f32-tiny': wav({code: 3, channels: 1, rate: 48000, bits: 32, frames: 4800, value: () => 2 ** -24}),
  'f32-minus-one': wav({code: 3, channels: 1, rate: 48000, bits: 32, frames: 4800, value: () => -1}),
};

const clip = (assetId, start, offset, duration, gain = 1, fadeIn = 0, fadeOut = 0) => ({assetId, start, offset, duration, gain, fadeIn, fadeOut});
const CASES = [
  {name: 'mono16-44k-fades', start: 0, frames: 4800, clips: [clip('mono16-44k', .01, .12, .08, .8, .02, .03)]},
  {name: 'stereo16-48k-overlap', start: 0, frames: 4800, clips: [clip('stereo16-48k', 0, 0, .1, .5), clip('stereo16-48k', .02, .01, .07, 1.5, .01)]},
  {name: 'stereo24-96k-extensible-seek', start: 480, frames: 4320, clips: [clip('stereo24-96k-ext', .0123, .00777, .0777, 1.1, 0, .02)]},
  {name: 'mono8-8k-saturates', start: 0, frames: 4800, clips: [clip('mono8-8k', .003, 0, .09, 2, .05, .04)]},
  {name: 'mono32i-22k', start: 0, frames: 4800, clips: [clip('mono32i-22k', 0, .005, .095, .33)]},
  {name: 'float-edge-values', start: 0, frames: 2400, clips: [clip('stereo-f32-edge', 0, 0, .05, 1), clip('stereo-f32-edge', .01, .002, .03, .5)]},
  // Document order [1 at .02, 2^-24 at 0, -1 at .01]: [0, 0] at sample 1440. Sorted by start the sample is 5.96e-8.
  {name: 'three-clip-cancellation', start: 0, frames: 4800, clips: [clip('f32-one', .02, 0, .1), clip('f32-tiny', 0, 0, .1), clip('f32-minus-one', .01, 0, .1)]},
  {name: 'clip-outside-and-missing', start: 0, frames: 2400, clips: [clip('nope', 1, 0, .05), clip('mono16-44k', 0, 0, .04, .9)]},
  {name: 'late-seek-and-tail', start: 22050, frames: 4800, clips: [clip('mono16-44k', 0, 0, .5, 1)]},
  {name: 'fractional-times', start: 100, frames: 3000, clips: [clip('mono16-44k', .0003333, .00021, .05, 1, .01, .01)]},
  {name: 'clip-on-sample-boundaries', start: 0, frames: 4800, clips: [clip('stereo16-48k', .0125, .005, .05, 1)]},
];

const AUDIBLE_STATES = [
  {name: 'no-solo', state: {version: 1, assets: {}, tracks: [
    {id: 't1', name: 'a', gain: .5, mute: false, solo: false, clips: [clip('x', 0, 0, 1, 1), clip('y', 1, 0, 1, 0), clip('z', 2, 0, 1, 2)]},
    {id: 't2', name: 'b', gain: 1, mute: true, solo: false, clips: [clip('x', 0, 0, 1, 1)]},
    {id: 't3', name: 'c', gain: 0, mute: false, solo: false, clips: [clip('x', 0, 0, 1, 1)]},
    {id: 't4', name: 'd', gain: 4, mute: false, solo: false, clips: [clip('w', 3, 0, 1, .3333333333333333)]}]}},
  {name: 'solo', state: {version: 1, assets: {}, tracks: [
    {id: 't1', name: 'a', gain: .5, mute: false, solo: false, clips: [clip('x', 0, 0, 1, 1)]},
    {id: 't2', name: 'b', gain: .7, mute: false, solo: true, clips: [clip('y', 0, 0, 1, .9), clip('z', 5, 1, 1, 1)]},
    {id: 't3', name: 'c', gain: 1, mute: true, solo: true, clips: [clip('x', 0, 0, 1, 1)]}]}},
];

const sources = new Map(), files = {}, peaks = {};
for (const [name, bytes] of Object.entries(SOURCES)) {
  files[name] = `${name}.wav`; writeFileSync(join(out, files[name]), bytes);
  const source = await inspectWave(new Blob([bytes])); sources.set(name, source);
  peaks[name] = {duration: source.duration, frames: source.frames, peaks: await wavePeaks(source)};
}

const same = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
const cases = [];
for (const c of CASES) {
  const mixed = await mixAudio(c.clips, sources, c.start, c.frames), again = await mixAudio(c.clips, sources, c.start, c.frames);
  if (!same(mixed, again)) throw new Error(`${c.name}: today's mixer differs between two runs on identical input`);
  for (const chunk of [1, 7, 480, 1200, 4800, 12000]) {
    const joined = new Float32Array(c.frames * 2);
    for (let at = 0; at < c.frames; at += chunk) joined.set(await mixAudio(c.clips, sources, c.start + at, Math.min(chunk, c.frames - at)), at * 2);
    if (!same(mixed, joined)) throw new Error(`${c.name}: today's mixer is not invariant to a chunk size of ${chunk}`);
  }
  const left = new Float32Array(c.frames), right = new Float32Array(c.frames);
  for (let i = 0; i < c.frames; i++) { left[i] = mixed[i * 2]; right[i] = mixed[i * 2 + 1]; }
  const bytes = Buffer.from(await pcmWave([left, right]).arrayBuffer());
  const golden = `${c.name}.f32.wav`; writeFileSync(join(out, golden), bytes);
  cases.push({...c, golden});
}

const audible = AUDIBLE_STATES.map(({name, state}) => ({name, state, clips: audibleClips(state)}));
writeFileSync(join(out, 'cases.json'), JSON.stringify({sources: files, cases, peaks, audible}, null, 1) + '\n');
console.log(`wrote ${Object.keys(files).length} sources, ${cases.length} cases and ${audible.length} audible states to ${out}`);
