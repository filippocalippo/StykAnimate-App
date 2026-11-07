// Generates the frozen fixtures the native video export is held to, from today's JavaScript:
//
//   engine/crates/styk-core/tests/fixtures/video-export-jobs.tsv       export request -> encoder configuration
//   engine/crates/styk-platform/tests/fixtures/ffmpeg-arguments.tsv    encoder configuration -> FFmpeg arguments
//
// Run once (`node scripts/generate-video-export-fixtures.mjs`); the output is committed and never edited by hand. A
// behaviour change is a bug in the native code, not a reason to regenerate. The records are tab-separated `key=value`
// fields (values escape backslash, tab and newline), so the Rust tests read them without a JSON dependency.
import {createRequire} from 'node:module';
import {mkdirSync, writeFileSync} from 'node:fs';
import {EventEmitter} from 'node:events';

const require = createRequire(import.meta.url);
const root = new URL('../', import.meta.url);

// Capture what the service spawns (the mux pass is not exported): patch spawn before the service is loaded.
const childProcess = require('node:child_process');
let spawned = [];
childProcess.spawn = (command, args) => {
  spawned.push(args);
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  setImmediate(() => child.emit('close', 0));
  return child;
};
globalThis.Worker = class {};
globalThis.OffscreenCanvas = class {};
globalThis.createImageBitmap = () => {};

const {validateConfig, encoderArguments, VideoExportService} = require(new URL('desktop/video-export-service.cjs', root).pathname.slice(1));
const {buildExportRequest, videoExportArguments} = await import(new URL('src/export-request.mjs', root));
const {encodeNativeVideo} = await import(new URL('src/native-video-export.mjs', root));

const escape = value => String(value).replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n');
const record = fields => Object.entries(fields).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${escape(value)}`).join('\t');
const outcome = run => {try {return {value: run()};} catch (error) {return {error: error.messageKey ?? error.message};}};

// ---------------------------------------------------------------------------------------------------------------------
// FFmpeg arguments: validateConfig -> encoderArguments, and the second (audio) pass.

const FORMATS = {webm: ['vp9'], mp4: ['h264', 'mpeg4'], avi: ['mpeg4', 'ffv1', 'rawvideo'], wmv: ['wmv2']};
const pairs = Object.entries(FORMATS).flatMap(([format, codecs]) => codecs.map(codec => [format, codec]));
const QUALITIES = [0, 0.3, 0.55, 0.8, 0.95, 1];
const BITRATES = [undefined, 1000, 250000, 5e6, 8e6, 1234567.5, 2e8];
const SIZES = [[1, 1], [3, 3], [4, 4], [161, 91], [64, 36], [65, 33], [3, 64], [1920, 1080], [3840, 2160]];
const FPS = [1, 16, 23.976, 24, 29.97, 60, 1000];
const FRAMES = [1, 48, 1000000];
const MAXES = [undefined, 1024, 2 ** 30];

const configs = [];
const add = config => configs.push(config);
for (const [format, codec] of pairs) for (const quality of QUALITIES) for (const bitrate of BITRATES)
  add({format, codec, width: 161, height: 91, fps: 24, totalFrames: 48, quality, bitrate});
for (const [format, codec] of pairs) for (const [width, height] of SIZES) for (const fps of FPS)
  add({format, codec, width, height, fps, totalFrames: 48, quality: 0.8});
for (const [format, codec] of pairs) for (const totalFrames of FRAMES) for (const maxBytes of MAXES) for (const audio of [false, true])
  add({format, codec, width: 64, height: 36, fps: 24, totalFrames, quality: 0.8, maxBytes, audio});
add({format: 'webm', width: 64, height: 36, fps: 24, totalFrames: 4});
add({format: 'mp4', width: 64, height: 36, fps: 24, totalFrames: 4, quality: undefined});
// A deterministic spread over everything at once.
let seed = 20261106;
const pick = list => list[(seed = (seed * 1103515245 + 12345) % 2147483648) % list.length];
for (let n = 0; n < 1500; n++) {
  const [format, codec] = pick(pairs);
  add({format, codec, width: pick(SIZES)[0], height: pick(SIZES)[1], fps: pick(FPS), totalFrames: pick(FRAMES), quality: pick(QUALITIES), bitrate: pick(BITRATES), maxBytes: pick(MAXES), audio: pick([false, true])});
}
// Values the validation refuses.
for (const bad of [{width: 0}, {width: 16385}, {height: 1.5}, {width: 5000, height: 5000}, {fps: 0.5}, {fps: 1001}, {fps: NaN}, {totalFrames: 0}, {totalFrames: 1000001},
  {quality: -0.1}, {quality: 1.1}, {bitrate: 999}, {bitrate: 2e8 + 1}, {maxBytes: 1023}, {maxBytes: 2 ** 30 + 1}, {codec: 'ffv1'}, {format: 'mov'}, {audio: 'yes'},
  {audio: true, totalFrames: 3601 * 24}])
  add({format: 'mp4', codec: 'h264', width: 64, height: 36, fps: 24, totalFrames: 48, quality: 0.8, ...bad});

const argumentLines = [];
for (const config of configs) {
  const input = record({format: config.format, codec: config.codec, width: config.width, height: config.height, fps: config.fps, totalFrames: config.totalFrames,
    quality: config.quality, bitrate: config.bitrate, maxBytes: config.maxBytes, audio: config.audio});
  const result = outcome(() => {
    const validated = validateConfig(config);
    const output = `OUT.${{webm: 'webm', mp4: 'mp4', avi: 'avi', wmv: 'wmv'}[validated.format]}`;
    const args = encoderArguments(validated, output);
    let mux;
    if (validated.audio) {
      spawned = [];
      const service = new VideoExportService({encoderPath: 'C:\\ffmpeg.exe', tempRoot: 'C:\\temp'});
      const expected = Math.round(validated.totalFrames / validated.fps * 48000) * 8;
      const job = {config: validated, output: `V/video.${validated.format === 'wmv' ? 'wmv' : validated.format}`, directory: 'V', audioPath: 'V/mix.f32', audioBytes: expected, audioHandle: {close: async () => {}}};
      return service.muxAudio(job).then(() => ({validated, args, mux: spawned[0]}));
    }
    return {validated, args, mux};
  });
  const settled = result.value ? await result.value : undefined;
  if (result.error || !settled) {
    argumentLines.push(`${input}\terror=${escape(result.error)}`);
    continue;
  }
  const {validated, args, mux} = settled;
  argumentLines.push(`${input}\tencodedWidth=${validated.encodedWidth}\tencodedHeight=${validated.encodedHeight}\targs=${escape(args.join('\u001f'))}${mux ? `\tmux=${escape(mux.join('\u001f'))}` : ''}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// The job an export request becomes: videoExportArguments (FFmpeg provider) -> encodeNativeVideo's checks -> validateConfig.

const jobLines = [];
const CLIPS = {none: [], inside: [{start: 0.5, duration: 1}], outside: [{start: 10, duration: 1}]};
const serializeClips = clips => clips.map(clip => `${clip.start}:${clip.duration}`).join(',');
const JOB_FORMATS = ['mp4', 'webm', 'avi', 'wmv'];
const codecsFor = format => format === 'mp4' ? ['h264', 'mpeg4', ''] : format === 'avi' ? ['mpeg4', 'ffv1', 'rawvideo', ''] : [''];
const jobSizes = [[960, 540], [1280, 720], [1, 1], [65, 33], [161, 91], [3840, 2160], [5000, 5000], [0, 10], [16385, 1], [4096, 4096]];
const jobRanges = [[1, 48], [3, 9], [9, 3], [1, 49], [0, 5], [10, 10]];
const jobFps = [24, 29.97, 60, 1000, 0.5];
const NAMES = ['Kick combo', '', 'a:b', 'CON', 'dot.', 'x'.repeat(12)];

async function addJob(fields, context) {
  const input = record({format: fields.format, width: fields.width, height: fields.height, from: fields.from, to: fields.to, smoothing: fields.smoothing,
    videoQuality: fields.videoQuality, bitrateMode: fields.bitrateMode, bitrateMbps: fields.bitrateMbps, codecMp4: fields.codecs.mp4, codecAvi: fields.codecs.avi,
    audio: fields.audio, name: fields.name ?? undefined, totalFrames: context.totalFrames, fps: context.fps, clips: serializeClips(context.audioClips), nameContext: context.name});
  const request = buildExportRequest(fields, {canvasWidth: 960, canvasHeight: 540, totalFrames: context.totalFrames});
  const planned = outcome(() => videoExportArguments(request, {...context, provider: 'FFmpeg', canvasWidth: 960, canvasHeight: 540}));
  if (planned.error) {
    jobLines.push(`${input}\tstage=request\terror=${escape(planned.error)}`);
    return;
  }
  const plan = planned.value;
  let begun;
  const desktop = {beginVideoExport: async config => {begun = config; const validated = validateConfig(config); throw Object.assign(new Error('stop'), {validated});},
    beginVideoFrame() {}, writeVideoChunk() {}, endVideoFrame() {}, finishVideoExport() {}, readVideoChunk() {}, cancelVideoExport: async () => {}, writeVideoAudioChunk() {}};
  let stage = 'ok', key, validated;
  try {
    await encodeNativeVideo({...plan.encode, desktop, renderNativeFrame: () => {}, audioChunks: plan.includeAudio ? (async function* () {})() : undefined});
  } catch (error) {
    if (error.message === 'stop' && error.validated) validated = error.validated;
    else {
      stage = begun ? 'service' : 'native';
      key = error.messageKey ?? error.message;
    }
  }
  const {options} = plan;
  const common = {'o.width': options.width, 'o.height': options.height, 'o.start': options.start, 'o.end': options.end, 'o.quality': options.quality, 'o.smoothing': options.smoothing,
    'o.fps': plan.fps, 'o.ticks': plan.ticks, 'o.codec': plan.codec, 'o.extension': plan.extension, 'o.filename': plan.filename, 'o.includeAudio': plan.includeAudio,
    'o.rateQuality': plan.videoQuality.quality, 'o.rateBitrate': plan.videoQuality.bitrate};
  if (stage !== 'ok') {
    jobLines.push(`${input}\tstage=${stage}\terror=${escape(key)}\t${record(common)}`);
    return;
  }
  jobLines.push(`${input}\tstage=ok\t${record(common)}\t${record({'c.format': validated.format, 'c.codec': validated.codec, 'c.width': validated.width, 'c.height': validated.height,
    'c.encodedWidth': validated.encodedWidth, 'c.encodedHeight': validated.encodedHeight, 'c.fps': validated.fps, 'c.totalFrames': validated.totalFrames, 'c.quality': validated.quality,
    'c.maxBytes': validated.maxBytes, 'c.bitrate': validated.bitrate, 'c.audio': validated.audio ?? false})}`);
}

const jobs = [];
for (const format of JOB_FORMATS) for (const codec of codecsFor(format)) for (const preset of ['recommended', 'small', 'high', '']) for (const [mode, bitrate] of
  [['auto', 8], ['manual', 8], ['manual', 0.25], ['manual', 0], ['manual', 250], ['manual', 0.1], ['bogus', 8]]) {
  jobs.push([{format, width: 960, height: 540, from: 1, to: 48, smoothing: 'edges', videoQuality: preset, bitrateMode: mode, bitrateMbps: bitrate, codecs: {mp4: codec, avi: codec}, audio: false}, {totalFrames: 48, fps: 24, name: 'Kick combo', audioClips: []}]);
}
for (const format of JOB_FORMATS) for (const codec of codecsFor(format)) for (const [width, height] of jobSizes) for (const [from, to] of jobRanges) for (const fps of jobFps)
  jobs.push([{format, width, height, from, to, smoothing: 'edges', videoQuality: 'recommended', bitrateMode: 'auto', bitrateMbps: 8, codecs: {mp4: codec, avi: codec}, audio: false}, {totalFrames: 48, fps, name: 'Kick combo', audioClips: []}]);
for (const format of JOB_FORMATS) for (const clips of Object.keys(CLIPS)) for (const audio of [true, false]) for (const [from, to] of jobRanges) for (const fps of [24, 0.5])
  jobs.push([{format, width: 640, height: 360, from, to, smoothing: 'edges', videoQuality: 'recommended', bitrateMode: 'auto', bitrateMbps: 8, codecs: {mp4: '', avi: ''}, audio}, {totalFrames: 48, fps, name: 'Kick combo', audioClips: CLIPS[clips]}]);
for (const format of JOB_FORMATS) for (const name of NAMES) for (const fieldName of [undefined, 'Take 2', ' padded ', 'a/b', 'NUL.txt'])
  jobs.push([{format, width: 640, height: 360, from: 1, to: 48, smoothing: 'edges', videoQuality: 'recommended', bitrateMode: 'auto', bitrateMbps: 8, codecs: {mp4: '', avi: ''}, audio: false, name: fieldName}, {totalFrames: 48, fps: 24, name, audioClips: []}]);
for (const format of JOB_FORMATS) for (const smoothing of ['edges', 'none', 'sprites', 'blur', ''])
  jobs.push([{format, width: 640, height: 360, from: 1, to: 48, smoothing, videoQuality: 'recommended', bitrateMode: 'auto', bitrateMbps: 8, codecs: {mp4: '', avi: ''}, audio: false}, {totalFrames: 48, fps: 24, name: 'Kick combo', audioClips: []}]);
for (const [fields, context] of jobs) await addJob(fields, context);

const write = (path, lines) => {
  const file = new URL(path, root);
  mkdirSync(new URL('./', file), {recursive: true});
  writeFileSync(file, `${lines.join('\n')}\n`);
  console.log(`${path}: ${lines.length} records`);
};
write('engine/crates/styk-platform/tests/fixtures/ffmpeg-arguments.tsv', argumentLines);
write('engine/crates/styk-core/tests/fixtures/video-export-jobs.tsv', jobLines);
