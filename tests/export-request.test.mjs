import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {
  EXPORT_CATEGORIES, EXPORT_DEFAULT_QUALITY, EXPORT_ELEMENT_IDS, EXPORT_FIELD_IDS, EXPORT_FORMATS, buildExportRequest, defaultExportFormat,
  entireAnimationPatch, exportCodecChoices, exportEncodingSummary, exportFieldVisibility, exportFileName, exportFormatStates, exportJob,
  exportNameError, exportOptionsFromRequest, exportPlayedFramesNote, exportPreferencesFromRequest, exportPrimaryLabel, exportSummary,
  exportTransparency, exportWorkingPoseNote, formatChoices, formatForAction, frameExportArguments, imageExportArguments,
  initialExportRequest, legacyExportFields, lockedSide, normalizeExportPreferences, presetSize, reconcileExportCodecs, resolveExportCodec,
  resolveFormatChoice, sameShape, sizePresetChoices, updateExportRequest, validateExportRequest, vfwEncodeOptions, videoExportArguments,
} from '../src/export-request.mjs';
import {legacyExport} from './fixtures/export-legacy.mjs';
import {EXPORT_MAX_PIXELS, normalizeExportSmoothing} from '../src/export-sampling.mjs';
import {videoQualityOptions} from '../src/export-video-quality.mjs';
import {defaultGIFDither} from '../src/gif-options.mjs';
import {exportFormat} from '../src/export-capabilities.mjs';
import {VfwExportControls} from '../src/vfw-export-controls.mjs';
import {COMMAND_BY_ID} from '../src/ui/command-catalog.mjs';
import {actionKeys, readActionSources} from './helpers/source-scan.mjs';

const root = new URL('../', import.meta.url);
const source = file => (existsSync(new URL(file, root)) ? readFileSync(new URL(file, root), 'utf8') : '');
const outcome = run => {try {return {value: run()};} catch (error) {return {error: error.message};}};
const product = (...lists) => lists.reduce((rows, list) => rows.flatMap(row => list.map(item => [...row, item])), [[]]);

test('the dialog ids the browser tests query stay in one map', () => {
  if (!source('src/export-panel.mjs')) {
    // The export dialog takes each id from the maps; the Windows codec fields and the progress keep their literal ids.
    const sheet = source('src/export-sheet.mjs'), literal = ['src/vfw-export-controls.mjs', 'src/export-progress.mjs'].map(source).join('\n');
    assert.match(sheet, /EXPORT_FIELD_IDS as FIELD, EXPORT_ELEMENT_IDS as ELEMENT/);
    for (const [key, id] of Object.entries(EXPORT_FIELD_IDS)) assert.ok(sheet.includes(`FIELD.${key}`) || literal.includes(`id="${id}"`), `${id} is a dialog id`);
    for (const [key, id] of Object.entries(EXPORT_ELEMENT_IDS)) assert.ok(sheet.includes(`ELEMENT.${key}`) || literal.includes(`id="${id}"`), `${id} is a dialog id`);
    return;
  }
  const homes = ['src/app.mjs', 'src/export-flow.mjs', 'src/export-panel.mjs', 'src/vfw-export-controls.mjs', 'src/export-progress.mjs'].map(source).join('\n');
  for (const id of [...Object.values(EXPORT_FIELD_IDS), ...Object.values(EXPORT_ELEMENT_IDS)]) assert.ok(homes.includes(`id="${id}"`), `${id} is a dialog id`);
});

test('the catalogue matches today\'s categories, commands and encoder descriptions', t => {
  const panel = source('src/export-panel.mjs');
  const actions = category => category.formats.map(id => EXPORT_FORMATS.find(format => format.id === id).action);
  // The one deliberate difference: Project lists revision 4's four types in its order, .stykmov included.
  assert.deepEqual(actions(EXPORT_CATEGORIES.find(category => category.id === 'editable')), ['export-piv', 'export-stkz', 'export-stk', 'export-stykmov']);
  if (panel) {
    const today = [...panel.matchAll(/\['(\w+)', '([^']+)', \[([^\]]+)\]\]/g)].map(([, id, label, list]) => ({id, label, actions: list.match(/export-[\w-]+/g)}));
    const editable = today.find(category => category.id === 'editable');
    assert.deepEqual(editable.actions, ['export-stkz', 'export-piv', 'export-stk'], 'today\'s dialog: update the deviation above if this changes');
    editable.actions = ['export-piv', 'export-stkz', 'export-stk', 'export-stykmov'];
    assert.deepEqual(EXPORT_CATEGORIES.map(category => ({id: category.id, label: category.label, actions: actions(category)})), today);
  } else t.diagnostic('export-panel.mjs is gone; categories are checked against the command catalogue only');
  for (const format of EXPORT_FORMATS) {
    assert.ok(COMMAND_BY_ID.has(format.action), `${format.action} is a command`);
    assert.equal(formatForAction(format.action), format.id);
    const description = exportFormat(format.id);
    if (description) assert.deepEqual([description.label, description.extension], [format.label, format.extension], format.id);
  }
  // Every export command is registered in the actions map (app.mjs and the modules it passes the map to, export-flow.mjs).
  const registered = actionKeys(readActionSources());
  for (const format of EXPORT_FORMATS) assert.ok(registered.has(format.action), `${format.action} is a registered action`);
});

// ---------------------------------------------------------------------------
// A stand-in for today's export dialog: showExport's fields after
// mountExportFlow, with the quality label hidden unless the JPEG sequence is
// chosen (export-panel.mjs updateSettings). Closed: no fields at all, as when
// a palette command runs an export directly.

function dialog({action, open = true, values = {}}) {
  if (!open) return () => null;
  const elements = new Map();
  const add = (id, value, {checked, hidden = false} = {}) => elements.set(id, {id, value, checked, closest: () => ({hidden})});
  const defaults = {width: '960', height: '540', aspect: true, start: '1', end: '48', quality: '94', smoothing: 'edges', 'gif-dither': false,
    resolution: 'original', 'video-quality': 'recommended', 'bitrate-mode': 'auto', 'video-bitrate': '8', 'mp4-codec': 'h264', 'avi-codec': 'mpeg4', audio: true};
  for (const [id, value] of Object.entries({...defaults, ...values})) {
    if (typeof value === 'boolean') add(`export-${id}`, 'on', {checked: value});
    else add(`export-${id}`, value, {hidden: id === 'quality' && action !== 'export-jpeg-sequence'});
  }
  return id => elements.get(id) ?? null;
}

const REPORT = {canvas_width: 960, canvas_height: 540, fps: 24, frame_delay_ms: 0, backgrounds: [], figure_types: []};
const named = name => Object.defineProperty(() => {}, 'name', {value: name});
const ENCODERS = {encodeVfwVideo: named('vfw'), encodeWebM: named('webcodecs'), encodeNativeVideo: named('native')};

function legacy({$, report = REPORT, totalTicks = 48, name = 'Kick combo', loop = true, simple = false, provider, vfw} = {}) {
  return legacyExport({
    $, editor: {report, totalTicks, name}, state: {settings: {timelineMode: simple ? 'simple' : 'advanced'}, loop},
    document: {querySelector: selector => (selector === '[data-action="export-video"]' && $('export-width') ? {dataset: provider === undefined ? {} : {provider}} : null)},
    vfwExportControls: {getOptions: () => vfw()}, videoQualityOptions,
    materializeSimpleFrameDraftForPivot: value => ({...value, frame_delay_ms: 125}), audibleClips: clips => clips, audioState: value => value.audioClips ?? [],
    ...ENCODERS, defaultGIFDither, normalizeExportSmoothing, EXPORT_MAX_PIXELS,
  });
}
/** The request side's context, from the same editor state the legacy code reads. */
function context({report = REPORT, totalTicks = 48, name = 'Kick combo', loop = true, simple = false, provider, open = true} = {}) {
  const played = simple ? {...report, frame_delay_ms: 125} : report;
  return {canvasWidth: report.canvas_width, canvasHeight: report.canvas_height, totalFrames: totalTicks, defaultDither: defaultGIFDither(report),
    fps: played.frame_delay_ms ? 1000 / played.frame_delay_ms : played.fps, loop, name, provider: open ? provider : undefined, audioClips: played.audioClips ?? []};
}
const requestFor = ($, format, ctx) => buildExportRequest(legacyExportFields($, format), ctx);

// ---------------------------------------------------------------------------
// exportOptions(): exact equivalence, errors included.

const PIXEL_FORMATS = EXPORT_FORMATS.filter(format => format.category !== 'editable').map(format => format.id);

test('exportOptionsFromRequest equals exportOptions for every format, quality, smoothing and dither', () => {
  let cases = 0;
  for (const [format, open, quality, smoothing, dither] of product(PIXEL_FORMATS, [true, false], ['94', '50', '100', '1', '0', '', '101', '94.5'],
    ['edges', 'none', 'sprites', '', 'bogus'], [true, false])) {
    const action = EXPORT_FORMATS.find(entry => entry.id === format).action, animation = !['png', 'svg'].includes(format);
    const $ = dialog({action, open, values: {quality, smoothing, 'gif-dither': dither}}), ctx = context();
    assert.deepEqual(outcome(() => exportOptionsFromRequest(requestFor($, format, ctx), ctx, {animation})),
      outcome(() => legacy({$}).exportOptions({animation})), `${format} open=${open} quality=${quality} smoothing=${smoothing} dither=${dither}`);
    cases++;
  }
  assert.equal(cases, 2080);
});

test('exportOptionsFromRequest equals exportOptions for sizes, ranges and empty animations', () => {
  const sizes = [['960', '540'], ['1920', '1080'], ['0', '540'], ['12.5', '540'], ['', '540'], ['16385', '10'], ['9000', '9000'], ['1', '1']];
  const ranges = [['1', '48'], ['5', '12'], ['0', '48'], ['12', '5'], ['1', '49'], ['', ''], ['3', '3'], ['4', '4'], ['0', '0'], ['2.5', '9']];
  for (const [format, [width, height], [start, end], totalTicks, open] of product(PIXEL_FORMATS, sizes, ranges, [48, 0, 1], [true, false])) {
    const action = EXPORT_FORMATS.find(entry => entry.id === format).action, animation = !['png', 'svg'].includes(format);
    const $ = dialog({action, open, values: {width, height, start, end}}), ctx = context({totalTicks});
    assert.deepEqual(outcome(() => exportOptionsFromRequest(requestFor($, format, ctx), ctx, {animation})),
      outcome(() => legacy({$, totalTicks}).exportOptions({animation})), `${format} ${width}×${height} ${start}–${end} of ${totalTicks} open=${open}`);
  }
});

test('a stale value in the hidden quality field never reaches another format', () => {
  // Before 0.5.6 exportOptions() read the hidden field: 50 typed for a JPEG
  // sequence gave a PNG sequence quality 0.5, and an empty field blocked it
  // ("Quality must be between 1 and 100 percent."). 0.5.6 made the hidden
  // label mean 0.94; the request makes the format decide, with the same result.
  for (const stale of ['50', '0', '', '101']) {
    const $ = dialog({action: 'export-png-sequence', values: {quality: stale}}), ctx = context();
    assert.equal(legacy({$}).exportOptions().quality, EXPORT_DEFAULT_QUALITY);
    assert.equal(exportOptionsFromRequest(requestFor($, 'png-sequence', ctx), ctx).quality, EXPORT_DEFAULT_QUALITY);
  }
  const jpeg = buildExportRequest({format: 'jpeg-sequence', jpegQuality: '50'}, context());
  assert.equal(exportOptionsFromRequest(jpeg, context()).quality, 0.5);
  assert.equal(exportOptionsFromRequest(updateExportRequest(jpeg, {format: 'png-sequence'}), context()).quality, EXPORT_DEFAULT_QUALITY);
  // A palette command without the dialog: 0.94 even for the JPEG sequence, as today.
  assert.equal(legacy({$: dialog({open: false})}).exportOptions().quality, 0.94);
  assert.equal(exportOptionsFromRequest(buildExportRequest({format: 'jpeg-sequence'}, context()), context()).quality, 0.94);
});

test('the content-based dither default applies only when no choice was made', () => {
  const report = {...REPORT, backgrounds: [{kind: 1}]}, ctx = context({report});
  assert.equal(ctx.defaultDither, true);
  for (const [open, checked, expected] of [[false, undefined, true], [true, false, false], [true, true, true]]) {
    const $ = dialog({action: 'export-gif', open, values: checked === undefined ? {} : {'gif-dither': checked}});
    assert.equal(legacy({$, report}).exportOptions().dither, expected);
    assert.equal(exportOptionsFromRequest(requestFor($, 'gif', ctx), ctx).dither, expected);
  }
});

// ---------------------------------------------------------------------------
// exportVideo() and exportImages(): the arguments they derive.

const CLIPS = {none: [], inside: [{start: 0.5, duration: 1}], outside: [{start: 10, duration: 1}]};

test('videoExportArguments equals exportVideo\'s derivation for FFmpeg, WebCodecs and every quality control', () => {
  let cases = 0;
  const combos = product(['mp4', 'webm', 'avi', 'wmv'], [true, false], ['FFmpeg', 'WebCodecs', '', undefined], ['recommended', 'small', 'high', ''],
    ['auto', 'manual'], ['8', '0.25', '', '0', '250'], [true, false], Object.keys(CLIPS), [false, true]);
  for (const [format, open, provider, preset, mode, bitrate, audio, clips, simple] of combos) {
    // MP4 from WebCodecs is the browser's MP4, which the legacy derivation predates; it is planned below.
    if (format === 'mp4' && provider === 'WebCodecs') continue;
    for (const codec of format === 'mp4' ? ['h264', 'mpeg4', ''] : format === 'avi' ? ['mpeg4', 'ffv1', 'rawvideo', ''] : ['']) {
      const report = {...REPORT, audioClips: CLIPS[clips]};
      const values = {'video-quality': preset, 'bitrate-mode': mode, 'video-bitrate': bitrate, audio, [`${format === 'avi' ? 'avi' : 'mp4'}-codec`]: codec};
      const $ = dialog({action: EXPORT_FORMATS.find(entry => entry.id === format).action, open, values}), ctx = context({report, simple, provider, open});
      const today = outcome(() => {
        const result = legacy({$, report, simple, provider}).videoArguments(format);
        return {vfw: result.vfw, codec: result.codec, nativeWebm: result.nativeWebm, options: result.options, ticks: result.ticks, fps: result.fps,
          extension: result.extension, filename: result.filename, videoQuality: result.videoQuality, encoder: result.encode.name, includeAudio: result.includeAudio};
      });
      const request = outcome(() => {
        const result = videoExportArguments(requestFor($, format, ctx), ctx);
        return {vfw: result.vfw, codec: result.codec, nativeWebm: result.nativeWebm, options: result.options, ticks: result.ticks, fps: result.fps,
          extension: result.extension, filename: result.filename, videoQuality: result.videoQuality, encoder: result.encoder, includeAudio: result.includeAudio};
      });
      assert.deepEqual(request, today, JSON.stringify({format, open, provider, preset, mode, bitrate, audio, clips, simple, codec}));
      cases++;
    }
  }
  assert.ok(cases > 30000);
});

test('MP4 is planned for the browser encoder only when its provider is WebCodecs', () => {
  const plan = (provider, fields = {}, ctx = context({provider})) => videoExportArguments(buildExportRequest({format: 'mp4', ...fields}, ctx), ctx);
  const browser = plan('WebCodecs');
  assert.equal(browser.encoder, 'webcodecs'); assert.equal(browser.extension, 'mp4'); assert.match(browser.filename, /\.mp4$/);
  assert.equal(typeof browser.videoQuality.bitrate, 'number', 'WebCodecs needs a rate target');
  for (const provider of ['FFmpeg', undefined]) {
    const desktop = plan(provider);
    assert.equal(desktop.encoder, 'native'); assert.equal(desktop.videoQuality.bitrate, undefined);
  }
  const withSound = context({provider: 'WebCodecs'});
  withSound.audioClips = CLIPS.inside;
  assert.throws(() => plan('WebCodecs', {audio: true}, withSound), /desktop FFmpeg/);
});

test('manual bitrate keeps the hidden preset\'s quality beside the rate, as today', () => {
  const ctx = context({provider: 'FFmpeg'});
  for (const preset of ['small', 'high']) {
    const $ = dialog({action: 'export-video', values: {'video-quality': preset, 'bitrate-mode': 'manual', 'video-bitrate': '4'}});
    const today = legacy({$, provider: 'FFmpeg'}).videoArguments('webm').videoQuality;
    assert.deepEqual(videoExportArguments(requestFor($, 'webm', ctx), ctx).videoQuality, today);
    assert.equal(today.bitrate, 4e6);
    assert.equal(today.quality, preset === 'small' ? 0.55 : 0.95);
  }
});

test('imageExportArguments equals exportImages\'s derivation', () => {
  const formats = ['gif', 'apng', 'png-sequence', 'jpeg-sequence', 'gif-sequence', 'svg-sequence'];
  for (const [format, open, loop, smoothing, simple, name, quality, [start, end]] of product(formats, [true, false], [true, false],
    ['edges', 'none', 'sprites'], [false, true], ['Kick combo', ''], ['50', '94', '0'], [['1', '48'], ['3', '9'], ['9', '3']])) {
    const $ = dialog({action: `export-${format}`, open, values: {smoothing, quality, start, end}}), ctx = context({loop, simple, name});
    const pick = ({options, ticks, fps, extension, filename, loop: repeat}) => ({options, ticks, fps, extension, filename, loop: repeat});
    assert.deepEqual(outcome(() => pick(imageExportArguments(requestFor($, format, ctx), ctx))),
      outcome(() => pick(legacy({$, loop, simple, name}).imageArguments(format))), `${format} open=${open} loop=${loop} ${smoothing} simple=${simple}`);
  }
});

test('frame and project exports keep today\'s options and file names', () => {
  const ctx = {...context(), tick: 4, objectName: 'Bubble', movieclip: false};
  const $ = dialog({action: 'export-svg', values: {smoothing: 'sprites', start: '0', end: '0'}});
  const svg = frameExportArguments(requestFor($, 'svg', ctx), ctx);
  assert.deepEqual(svg.options, {...legacy({$}).exportOptions({animation: false}), smoothing: 'edges'});
  assert.equal(svg.filename, 'Kick combo-frame-5.svg');
  const png = frameExportArguments(requestFor(dialog({action: 'export-png', values: {smoothing: 'sprites'}}), 'png', ctx), ctx);
  assert.equal(png.options.smoothing, 'sprites');
  assert.equal(png.filename, 'Kick combo-frame-5.png');
  const job = format => exportJob(buildExportRequest({format}, ctx), ctx);
  assert.deepEqual(job('piv'), {kind: 'project', action: 'export-piv', format: 'piv', filename: 'Kick combo.piv'});
  assert.deepEqual(job('stkz'), {kind: 'project', action: 'export-stkz', format: 'stkz', filename: 'Bubble.stkz'});
  assert.deepEqual(exportJob(buildExportRequest({format: 'stkz'}, ctx), {...ctx, movieclip: true}), {kind: 'project', action: 'export-stkz', format: 'stykmov', filename: 'Bubble.stykmov'});
  assert.equal(exportJob(buildExportRequest({format: 'piv'}, ctx), {...ctx, name: ''}).filename, 'Untitled.piv');
  assert.equal(job('stk').filename, 'Bubble.stk');
  assert.equal(job('png-sequence').filename, 'Kick combo-png-sequence.zip');
  assert.throws(() => job('vfw'), /Wait for the installed codec check/);
  const codec = {id: 'vfw:x86:6376696d', supported: true, quality: true, keyframes: false, dataRate: false};
  const vfw = exportJob(buildExportRequest({format: 'vfw', vfw: {codecId: codec.id, quality: '75'}}, ctx), {...ctx, vfw: {codec}});
  assert.deepEqual([vfw.kind, vfw.encoder, vfw.filename, vfw.videoQuality, vfw.encode.quality, vfw.encode.codecId], ['video', 'vfw', 'Kick combo.avi', {}, 0.75, codec.id]);
  assert.equal(exportFileName(buildExportRequest({format: 'vfw', name: 'take 2'}, ctx), ctx), 'take 2.avi');
  assert.equal(exportFileName(buildExportRequest({format: 'png', name: 'poster'}, ctx), ctx), 'poster.png');
});

test('vfwEncodeOptions equals VfwExportControls.getOptions', () => {
  const getOptions = VfwExportControls.prototype.getOptions;
  const codec = (flags = {}) => ({id: 'vfw:x64:63766964', supported: true, quality: true, keyframes: true, dataRate: true, ...flags});
  const flagSets = [{}, {quality: false}, {keyframes: false, dataRate: false}, {supported: false}];
  const states = [{}, {disposed: true}, {hidden: true}, {stale: true}, {configuring: true}, {missing: true}];
  for (const [flags, state, quality, keyframes, bitrate] of product(flagSets, states, ['90', '', '101', '50.5', ' 7 ', 'x'], ['0', '12', '1.5', '-1', ''], ['0', '2.5', '201', ''])) {
    const entry = codec(flags), selected = state.missing ? 'vfw:x64:00000000' : entry.id;
    const controls = {disposed: Boolean(state.disposed), element: {hidden: Boolean(state.hidden)}, codecs: [entry], select: {value: selected},
      loadedKey: '960:540', _currentKey: () => (state.stale ? '1280:720' : '960:540'), configuring: Boolean(state.configuring),
      quality: {value: quality}, keyframes: {value: keyframes}, bitrate: {value: bitrate},
      configurations: new Map([[`${selected}|960:540`, 'cfg-1']]), _configurationKey() {return `${this.select.value}|${this.loadedKey}`;}};
    const request = buildExportRequest({format: 'vfw', vfw: {codecId: selected, quality, keyframes, bitrateMbps: bitrate, configurationId: 'cfg-1'}}, context());
    assert.deepEqual(outcome(() => vfwEncodeOptions(request.vfw, {codec: controls.codecs.find(item => item.id === selected) ?? null,
      ready: !state.stale && !state.configuring, available: !state.disposed && !state.hidden})),
    outcome(() => getOptions.call(controls)), JSON.stringify({flags, state, quality, keyframes, bitrate}));
    // What the export flow passes: the controls' own requestContext(), with its configuration in the request.
    const vfwContext = VfwExportControls.prototype.requestContext.call(controls);
    const flowRequest = buildExportRequest({format: 'vfw', vfw: {codecId: selected, quality, keyframes, bitrateMbps: bitrate, configurationId: vfwContext.configurationId}}, context());
    assert.deepEqual(outcome(() => vfwEncodeOptions(flowRequest.vfw, vfwContext)), outcome(() => getOptions.call(controls)), `requestContext ${JSON.stringify({flags, state})}`);
  }
});

// ---------------------------------------------------------------------------
// Sizes, the linked fields and remembered choices.

test('size presets and Lock ratio write the same width and height as today\'s dialog', () => {
  // export-panel.mjs's preset handler, then app.mjs's input handler that its input event runs.
  const today = (preset, w, h, lock) => {
    const shortSide = preset === 'original' ? Math.min(w, h) : Number(preset), scale = shortSide / Math.min(w, h);
    let width = Math.round(w * scale), height = Math.round(h * scale);
    if (lock && width > 0) height = Math.max(1, Math.round(width / (w / h)));
    return {width, height};
  };
  for (let w = 1; w <= 2000; w += 37) for (let h = 1; h <= 2000; h += 41) for (const preset of ['original', '720', '1080', '2160']) for (const lock of [true, false])
    assert.deepEqual(presetSize(preset, {canvasWidth: w, canvasHeight: h}, lock), today(preset, w, h, lock), `${preset} ${w}×${h} ${lock}`);
  assert.deepEqual(presetSize('720', {canvasWidth: 1080, canvasHeight: 1920}), {width: 720, height: 1280});
  assert.throws(() => presetSize('custom', {canvasWidth: 10, canvasHeight: 10}), /size preset/);
  assert.equal(lockedSide('width', 1280, {canvasWidth: 960, canvasHeight: 540}), 720);
  assert.equal(lockedSide('height', 1, {canvasWidth: 1, canvasHeight: 1000}), 1);
  assert.equal(lockedSide('width', 0, {canvasWidth: 960, canvasHeight: 540}), null);
});

test('updateExportRequest applies today\'s linked-field rules', () => {
  const ctx = context(), start = buildExportRequest({format: 'mp4'}, ctx);
  assert.deepEqual([start.sizePreset, start.width, start.height, start.from, start.to], ['original', 960, 540, 1, 48]);
  const hd = updateExportRequest(start, {sizePreset: '1080'}, ctx);
  assert.deepEqual([hd.sizePreset, hd.width, hd.height], ['1080', 1920, 1080]);
  const typed = updateExportRequest(hd, {width: '1280'}, ctx);
  assert.deepEqual([typed.sizePreset, typed.width, typed.height], ['custom', 1280, 720]);
  const unlocked = updateExportRequest({...typed, lockRatio: false}, {height: 100}, ctx);
  assert.deepEqual([unlocked.width, unlocked.height], [1280, 100]);
  assert.deepEqual(updateExportRequest(typed, {sizePreset: 'custom'}, ctx), {...typed, sizePreset: 'custom'});
  const gif = updateExportRequest(start, {format: 'gif', codecs: {avi: 'ffv1'}}, ctx);
  assert.deepEqual([gif.category, gif.codecs], ['animated', {mp4: '', avi: 'ffv1'}]);
  assert.throws(() => updateExportRequest(start, {format: 'mov'}, ctx), /Unknown export format/);
  assert.equal(start.codecs === gif.codecs, false, 'a request is never mutated');
});

test('preferences remember the type and size, start on Original and drop what they cannot use', () => {
  const ctx = context();
  assert.deepEqual(normalizeExportPreferences(undefined).sizePreset, 'original');
  assert.deepEqual(normalizeExportPreferences({format: 'mov', sizePreset: 'huge', jpegQuality: 0, bitrateMbps: 900, codecs: {mp4: '<b>'}, smoothing: 'blur'}),
    normalizeExportPreferences({}));
  assert.equal(normalizeExportPreferences({format: 'stykmov'}).format, 'stykmov', 'Project lists the movieclip type');
  const states = exportFormatStates({totalFrames: 48});
  const first = initialExportRequest({states, context: ctx});
  assert.deepEqual([first.format, first.sizePreset, first.width, first.height, first.from, first.to, first.dither, first.audio],
    ['webm', 'original', 960, 540, 1, 48, null, true], 'today\'s dialog opens on WebM at the artboard size');
  const chosen = updateExportRequest(updateExportRequest(first, {format: 'mp4', sizePreset: '720', videoQuality: 'high', audio: false}, ctx), {from: 3}, ctx);
  const stored = exportPreferencesFromRequest(chosen, {encodingOpen: true});
  assert.deepEqual(stored, {...normalizeExportPreferences({}), format: 'mp4', sizePreset: '720', videoQuality: 'high', encodingOpen: true});
  const reopened = initialExportRequest({preferences: JSON.parse(JSON.stringify(stored)), states, context: {canvasWidth: 540, canvasHeight: 960, totalFrames: 12}});
  assert.deepEqual([reopened.format, reopened.width, reopened.height, reopened.from, reopened.to, reopened.videoQuality, reopened.audio],
    ['mp4', 720, 1280, 1, 12, 'high', true], 'MP4 is kept while the probe runs; the range and Include audio are not remembered');
  const custom = exportPreferencesFromRequest(updateExportRequest(first, {width: 640}, ctx));
  assert.deepEqual([custom.sizePreset, custom.width, custom.height], ['custom', 640, 360]);
  assert.deepEqual(initialExportRequest({preferences: custom, states, context: ctx}).width, 640);
  assert.deepEqual(initialExportRequest({states, context: {...ctx, totalFrames: 0}}).from, 0);
});

// ---------------------------------------------------------------------------
// Availability, validation and the words the sheet shows.

const CAPABILITIES = {width: 960, height: 540, fps: 24, formats: [
  {id: 'webm', supported: true, provider: 'FFmpeg', codec: 'VP9 with transparency'},
  {id: 'mp4', supported: true, provider: 'FFmpeg', defaultCodec: 'h264', codecs: [{id: 'h264', label: 'H.264', supported: true}, {id: 'mpeg4', label: 'MPEG-4 Part 2', supported: true, notice: 'Pivot compatible'}]},
  {id: 'avi', supported: true, provider: 'FFmpeg', defaultCodec: 'mpeg4', codecs: [{id: 'mpeg4', label: 'MPEG-4 Part 2', supported: true},
    {id: 'ffv1', label: 'FFV1 (lossless)', supported: true, lossless: true}, {id: 'rawvideo', label: 'Uncompressed RGB', supported: false, lossless: true}]},
  {id: 'wmv', supported: false, reason: 'This native video encoder is unavailable.'},
  {id: 'gif', supported: false, reason: 'Animated GIF supports 1–50 fps. Choose APNG or video for this frame rate.'},
  {id: 'apng', supported: true, provider: 'Portable worker'},
  {id: 'png-sequence', supported: true}, {id: 'jpeg-sequence', supported: true}, {id: 'gif-sequence', supported: true}, {id: 'svg-sequence', supported: true},
]};

test('format states follow today\'s buttons before and after the capability probe', () => {
  const opening = exportFormatStates({totalFrames: 48, vfw: {listed: false}});
  assert.deepEqual(formatChoices('video', opening).map(choice => [choice.id, choice.disabled]), [['mp4', true], ['webm', false], ['avi', true], ['wmv', true]]);
  assert.equal(defaultExportFormat(opening), 'webm');
  assert.deepEqual(formatChoices('editable', opening).map(choice => [choice.type, choice.reason]), [['Pivot animation (.piv)', ''],
    ['StykAnimate figure (.stkz) · Unavailable', 'Select a figure to export it.'], ['Pivot figure (.stk) · Unavailable', 'Select a figure to export it.'],
    ['StykAnimate movieclip (.stykmov) · Unavailable', 'Select a figure to export it.']]);
  const probed = exportFormatStates({capabilities: CAPABILITIES, totalFrames: 48, hasObject: true, movieclip: true, vfw: {listed: true, ready: true}, codecs: {avi: 'rawvideo'}});
  assert.deepEqual(probed.get('mp4'), {id: 'mp4', label: 'MP4 video', listed: true, pending: false, disabled: false, reason: '', provider: 'FFmpeg', codec: 'h264', codecLabel: 'H.264', padded: null});
  assert.equal(probed.get('avi').codec, 'mpeg4', 'an unsupported codec falls back to the first supported one');
  assert.deepEqual([probed.get('wmv').disabled, probed.get('wmv').reason], [true, 'This native video encoder is unavailable.']);
  assert.deepEqual(formatChoices('editable', probed).map(choice => [choice.id, choice.disabled, choice.reason]),
    [['piv', false, ''], ['stkz', true, 'A movieclip exports as .stykmov.'], ['stk', false, ''], ['stykmov', false, '']], 'a movieclip is its own type');
  const figure = exportFormatStates({capabilities: CAPABILITIES, totalFrames: 48, hasObject: true, vfw: {listed: false}});
  assert.deepEqual(['stkz', 'stykmov'].map(id => [figure.get(id).disabled, figure.get(id).reason]), [[false, ''], [true, 'Select a movieclip to export it.']]);
  assert.equal(resolveFormatChoice('webm', 'video', probed), 'webm', 'the chosen type is kept');
  assert.equal(resolveFormatChoice('wmv', 'video', probed), 'wmv', 'even while unavailable: Export says why instead');
  assert.equal(resolveFormatChoice('gif', 'video', probed), 'mp4');
  assert.equal(resolveFormatChoice(null, 'animated', probed), 'apng');
  assert.equal(resolveExportCodec(CAPABILITIES.formats[1], 'mpeg4'), 'mpeg4');
  assert.equal(resolveExportCodec({codecs: []}, 'h264'), '');
  const empty = exportFormatStates({capabilities: CAPABILITIES, totalFrames: 0, hasObject: true, vfw: {listed: true, ready: true}});
  for (const id of ['mp4', 'webm', 'gif', 'png-sequence', 'vfw']) assert.deepEqual([empty.get(id).disabled, empty.get(id).reason], [true, 'Add a frame to export an animation.'], id);
  for (const id of ['png', 'svg', 'piv', 'stk']) assert.equal(empty.get(id).disabled, false, id);
  const failed = exportFormatStates({capabilityError: new Error('Probe failed.'), totalFrames: 48});
  assert.deepEqual(['webm', 'mp4', 'avi', 'wmv'].map(id => failed.get(id).reason), Array(4).fill('Probe failed.'));
});

test('validation reports today\'s messages in today\'s order', () => {
  const states = exportFormatStates({capabilities: CAPABILITIES, totalFrames: 48, hasObject: true, vfw: {listed: true, ready: true}});
  const base = {states, totalFrames: 48, fps: 24, audioClips: [], audioSupported: true, deviceMemory: 8};
  const check = (fields, extra = {}) => validateExportRequest(buildExportRequest(fields, context()), {...base, ...extra});
  assert.deepEqual(check({format: 'mp4'}), {error: '', notice: '', invalid: [], canExport: true});
  assert.deepEqual(check({format: 'png-sequence', width: '0', from: '9', to: '3'}), {error: `Enter whole-pixel dimensions, up to ${Math.round(EXPORT_MAX_PIXELS / 1e6)} million pixels per frame.`,
    notice: `Enter whole-pixel dimensions, up to ${Math.round(EXPORT_MAX_PIXELS / 1e6)} million pixels per frame.`, invalid: ['width', 'height', 'from', 'to'], canExport: false});
  assert.equal(check({format: 'png', from: '9', to: '3'}).canExport, true, 'a single frame has no range');
  assert.deepEqual(check({format: 'jpeg-sequence', jpegQuality: '94.5'}).invalid, ['jpegQuality']);
  assert.deepEqual(check({format: 'png-sequence', jpegQuality: '0'}).invalid, [], 'the JPEG quality only counts for the JPEG sequence');
  assert.deepEqual(check({format: 'mp4', bitrateMode: 'manual', bitrateMbps: '0'}), {error: 'Enter a value between 0.1 and 200.', notice: 'Enter a value between 0.1 and 200.', invalid: ['bitrateMbps'], canExport: false});
  assert.equal(check({format: 'avi', codecs: {avi: 'ffv1'}, bitrateMode: 'manual', bitrateMbps: '0'}).canExport, true, 'lossless AVI ignores the bitrate');
  assert.equal(check({format: 'gif'}, {fps: 60}).error, 'GIF supports up to 50 fps. Choose Animated PNG or Video for this animation.');
  assert.equal(check({format: 'wmv'}).notice, 'This native video encoder is unavailable.');
  assert.equal(check({format: 'wmv'}).canExport, false);
  const sound = {audioClips: [{start: 0, duration: 1}]};
  assert.equal(check({format: 'mp4'}, sound).canExport, true);
  assert.equal(check({format: 'mp4'}, {...sound, audioSupported: false}).error, 'Choose a desktop FFmpeg video format to include sound, or turn off Include audio for a silent export.');
  assert.equal(check({format: 'vfw'}, sound).canExport, false);
  assert.equal(check({format: 'vfw', audio: false}, sound).canExport, true);
  assert.equal(check({format: 'mp4', from: '30', to: '48'}, {audioClips: [{start: 0, duration: 1}], audioSupported: false}).canExport, true, 'sound outside the range');
  assert.deepEqual(check({format: 'png-sequence', from: '1', to: '70000'}, {totalFrames: 70000}).invalid, ['from', 'to']);
  assert.deepEqual(check({format: 'piv', width: '0'}).invalid, [], 'project files have no size');
  assert.deepEqual(check({format: 'mp4', name: 'a/b'}).invalid, ['name']);
  assert.deepEqual(check({format: 'png-sequence', width: '8200', height: '100', smoothing: 'sprites'}).invalid, ['width', 'height'], 'the memory plan');
  assert.deepEqual(check({format: 'svg-sequence', width: '8200', height: '100', smoothing: 'sprites'}).invalid, [], 'vector output has no memory plan');
});

test('visibility, transparency, summary and the primary follow the chosen type', () => {
  const visible = (fields, clips) => exportFieldVisibility(buildExportRequest(fields, context()), {audioClips: clips});
  assert.deepEqual(visible({format: 'mp4'}, []), {settings: true, size: true, range: true, smoothing: true, jpegQuality: false, dither: false, videoQuality: true,
    bitrateMode: true, bitrateMbps: false, mp4Codec: true, aviCodec: false, encoding: true, vfw: false, audio: false});
  assert.deepEqual([visible({format: 'mp4', bitrateMode: 'manual'}).videoQuality, visible({format: 'mp4', bitrateMode: 'manual'}).bitrateMbps], [false, true]);
  assert.deepEqual([visible({format: 'avi', codecs: {avi: 'rawvideo'}}).bitrateMode, visible({format: 'gif'}).dither, visible({format: 'svg'}).smoothing], [false, true, false]);
  assert.equal(visible({format: 'webm'}, [{start: 0, duration: 1}]).audio, true);
  assert.equal(visible({format: 'piv'}).settings, false);
  assert.deepEqual(exportTransparency('webm', {provider: 'FFmpeg'}), {transparent: true, alpha: 'full'});
  assert.equal(exportTransparency('webm', {provider: 'WebCodecs'}).reason, 'Browser WebM exports do not preserve transparency.');
  assert.deepEqual([exportTransparency('gif').alpha, exportTransparency('jpeg-sequence').matte, exportTransparency('mp4').matte, exportTransparency('piv')], ['binary', 'white', 'black', null]);
  const ctx = context();
  // The default interface locale is English, independent of the machine's ICU locale.
  assert.deepEqual(exportSummary(buildExportRequest({format: 'gif', width: '1920', height: '1080'}, ctx), {fps: 24}), {size: `${(1920).toLocaleString('en')} × ${(1080).toLocaleString('en')} px`, time: '48 frames · 2s at 24 fps'});
  assert.deepEqual(exportSummary(buildExportRequest({format: 'png'}, ctx), {currentFrame: 5}), {size: '960 × 540 px', time: 'Current frame · 5'});
  assert.equal(exportSummary(buildExportRequest({format: 'mp4', to: '4800'}, ctx), {fps: 24}).time, `${(4800).toLocaleString('en')} frames · 3m 20s at 24 fps`);
  assert.deepEqual(exportSummary(buildExportRequest({format: 'piv'}, ctx)), {size: '', time: ''});
  assert.deepEqual(['mp4', 'webm', 'vfw', 'gif', 'png-sequence', 'piv'].map(format => exportPrimaryLabel({format})),
    ['Export MP4', 'Export WebM', 'Export AVI', 'Export GIF', 'Export PNG sequence', 'Export PIV']);
  assert.equal(exportPrimaryLabel({format: 'stkz'}, {movieclip: true}), 'Export STYKMOV');
  assert.throws(() => buildExportRequest({format: 'mov'}), /Unknown export format/);
});

// ---------------------------------------------------------------------------
// What the sheet relies on: shown codecs, names, remembered sizes, request
// shape, required context, reasons and the words it shows.

const OPEN = {totalFrames: 48, hasObject: true, vfw: {listed: false}};
const withCodecs = (id, codecs) => ({...CAPABILITIES, formats: CAPABILITIES.formats.map(format => (format.id === id ? {...format, codecs} : format))});

test('the request exports the codec its select shows, not an unsupported default or remembered one', () => {
  const ctx = context({provider: 'FFmpeg'}), opening = exportFormatStates(OPEN);
  // MP4's default (H.264) is unsupported here: the select shows MPEG-4.
  const noH264 = withCodecs('mp4', [{id: 'h264', label: 'H.264', supported: false}, {id: 'mpeg4', label: 'MPEG-4 Part 2', supported: true}]);
  let request = initialExportRequest({preferences: {format: 'mp4'}, states: opening, context: ctx});
  assert.equal(request.codecs.mp4, '', 'nothing is shown before the probe');
  let states = exportFormatStates({...OPEN, capabilities: noH264, codecs: request.codecs});
  assert.equal(states.get('mp4').codec, 'mpeg4');
  assert.equal(exportJob(request, ctx).encode.codec, undefined, 'unreconciled: the native service would fall back to H.264');
  request = reconcileExportCodecs(request, states);
  assert.equal(exportJob(request, ctx).encode.codec, 'mpeg4');
  // FFV1 is remembered but unsupported now: the select shows MPEG-4, so the export is lossy and shows its bitrate row.
  const noFfv1 = withCodecs('avi', CAPABILITIES.formats[2].codecs.map(codec => ({...codec, supported: codec.id === 'mpeg4'})));
  request = initialExportRequest({preferences: {format: 'avi', codecs: {avi: 'ffv1'}}, states: opening, context: ctx});
  assert.equal(request.codecs.avi, 'ffv1', 'kept until a probe describes AVI');
  states = exportFormatStates({...OPEN, capabilities: noFfv1, codecs: request.codecs});
  request = reconcileExportCodecs(request, states);
  const job = exportJob(request, ctx);
  assert.deepEqual([request.codecs.avi, job.codec, job.videoQuality, exportFieldVisibility(request).bitrateMode], ['mpeg4', 'mpeg4', {quality: 0.8}, true], 'not lossless {quality: 1}');
  assert.equal(reconcileExportCodecs(request, states), request, 'the same request when nothing changes');
  assert.equal(initialExportRequest({preferences: {format: 'avi', codecs: {avi: 'ffv1'}}, states, context: ctx}).codecs.avi, 'mpeg4', 'opening after a probe reconciles at once');
  const failed = exportFormatStates({...OPEN, capabilityError: new Error('Probe failed.')});
  assert.equal(reconcileExportCodecs(request, failed), request, 'a failed probe describes no codec');
});

test('the typed name is trimmed, a blank one means the default, and unsavable names are refused', () => {
  const ctx = context(), start = buildExportRequest({format: 'mp4'}, ctx);
  const states = exportFormatStates({...OPEN, capabilities: CAPABILITIES});
  assert.equal(updateExportRequest(start, {name: '  take 2 '}, ctx).name, 'take 2');
  for (const blank of ['', '   ', null]) {
    const request = updateExportRequest(updateExportRequest(start, {name: 'x'}, ctx), {name: blank}, ctx);
    assert.deepEqual([request.name, exportFileName(request, ctx)], [null, 'Kick combo.mp4'], JSON.stringify(blank));
  }
  for (const [name, message] of [['a/b', /cannot contain/], ['CON', /reserves/], ['nul', /reserves/], ['com1.backup', /reserves/], ['LPT9', /reserves/], ['take.', /end with a dot/]]) {
    const request = updateExportRequest(start, {name}, ctx);
    assert.match(exportNameError(request.name), message, name);
    assert.deepEqual(validateExportRequest(request, {states, totalFrames: 48, fps: 24, deviceMemory: 8}).invalid, ['name'], name);
    assert.throws(() => exportFileName(request, ctx), message, name);
    assert.throws(() => exportJob(request, ctx), message, name);
  }
  for (const name of ['console', 'con-take', 'Kick combo v2', 'comet', 'take 2.final']) assert.equal(exportNameError(name), '', name);
  assert.throws(() => exportFileName({...start, name: ''}, ctx), /Enter a file name/, 'a hand-built blank name');
  assert.throws(() => exportFileName({...start, name: 'take '}, ctx), /end with a dot or a space/);
});

test('a remembered Custom size opens as Original on an artboard of another shape', () => {
  const states = exportFormatStates({totalFrames: 48}), landscape = context();
  const stored = exportPreferencesFromRequest(updateExportRequest(buildExportRequest({format: 'mp4'}, landscape), {width: 640}, landscape));
  assert.deepEqual([stored.sizePreset, stored.width, stored.height, stored.lockRatio], ['custom', 640, 360, true]);
  const portrait = initialExportRequest({preferences: stored, states, context: {canvasWidth: 1080, canvasHeight: 1920, totalFrames: 48}});
  assert.deepEqual([portrait.sizePreset, portrait.width, portrait.height], ['original', 1080, 1920], 'never 640 × 360 squashed onto a portrait artboard');
  const wide = initialExportRequest({preferences: stored, states, context: {canvasWidth: 1920, canvasHeight: 1080, totalFrames: 48}});
  assert.deepEqual([wide.sizePreset, wide.width, wide.height], ['custom', 640, 360], 'an artboard of the same shape keeps it');
  assert.equal(initialExportRequest({preferences: {...stored, width: null}, states, context: landscape}).sizePreset, 'original');
  // Every size Lock ratio writes counts as the artboard's shape.
  for (let w = 100; w <= 2000; w += 53) for (let h = Math.ceil(w / 10); h <= Math.min(2000, w * 10); h += 59) for (const typed of [100, 333, 1280]) {
    const board = {canvasWidth: w, canvasHeight: h};
    assert.ok(sameShape({width: typed, height: lockedSide('width', typed, board)}, board), `${w}×${h} width ${typed}`);
    assert.ok(sameShape({width: lockedSide('height', typed, board), height: typed}, board), `${w}×${h} height ${typed}`);
  }
});

test('updateExportRequest keeps the request in shape and needs the artboard for size changes', () => {
  const ctx = context(), start = buildExportRequest({format: 'gif'}, ctx);
  const odd = updateExportRequest(start, {dither: 'yes', audio: 'no', repeat: 'twice', category: 'video', lockRatio: 'on', from: '3', extra: 1}, ctx);
  assert.deepEqual([odd.dither, odd.audio, odd.repeat, odd.category, odd.lockRatio, odd.from], [null, true, null, 'animated', true, 3]);
  assert.deepEqual(Object.keys(odd), Object.keys(start), 'no stray fields');
  assert.equal(exportOptionsFromRequest(odd, ctx).dither, ctx.defaultDither, 'an unusable dither means the content-based default');
  assert.equal(updateExportRequest(start, {format: 'mp4', category: 'editable'}, ctx).category, 'video', 'the category follows the format');
  assert.throws(() => updateExportRequest(start, {sizePreset: '1080'}), TypeError);
  assert.throws(() => updateExportRequest(start, {width: 1280}), TypeError);
  assert.equal(updateExportRequest({...start, lockRatio: false}, {width: 1280}).width, 1280, 'an unlocked side needs no artboard');
  assert.equal(updateExportRequest(start, {format: 'png'}).format, 'png');
});

test('exports refuse a context without the frame count or the frame rate', () => {
  const ctx = context(), without = key => Object.fromEntries(Object.entries(ctx).filter(([name]) => name !== key));
  const video = buildExportRequest({format: 'mp4'}, ctx), gif = buildExportRequest({format: 'gif'}, ctx);
  assert.throws(() => exportOptionsFromRequest(video, without('totalFrames')), TypeError);
  assert.throws(() => exportJob(video, without('totalFrames')), TypeError);
  assert.throws(() => exportJob(video, without('fps')), TypeError);
  assert.throws(() => exportJob(gif, without('fps')), TypeError);
  assert.doesNotThrow(() => exportJob(buildExportRequest({format: 'png'}, ctx), without('totalFrames')), 'a single frame has no range');
  assert.doesNotThrow(() => exportJob(buildExportRequest({format: 'piv'}, ctx), {name: 'Kick combo'}));
});

test('a disabled type always says why', () => {
  const opening = exportFormatStates({totalFrames: 48, vfw: {listed: true, ready: false}});
  for (const [id, reason] of [['mp4', 'Checking video encoders…'], ['avi', 'Checking video encoders…'], ['wmv', 'Checking video encoders…'],
    ['vfw', 'Checking installed codecs…'], ['stkz', 'Select a figure to export it.'], ['stk', 'Select a figure to export it.'], ['stykmov', 'Select a figure to export it.']])
    assert.deepEqual([opening.get(id).disabled, opening.get(id).reason], [true, reason], id);
  assert.equal(exportFormatStates({totalFrames: 48, vfw: {listed: true, ready: false, reason: 'No installed codec accepts this canvas size.'}}).get('vfw').reason,
    'No installed codec accepts this canvas size.');
  const check = validateExportRequest(buildExportRequest({format: 'mp4'}, context()), {states: opening, totalFrames: 48, fps: 24, deviceMemory: 8});
  assert.deepEqual([check.notice, check.canExport], ['Checking video encoders…', false]);
  for (const states of [opening, exportFormatStates({capabilities: CAPABILITIES, totalFrames: 48, hasObject: true, vfw: {listed: true, ready: true}}),
    exportFormatStates({capabilities: CAPABILITIES, totalFrames: 0, vfw: {listed: true}})])
    for (const state of states.values()) if (state.disabled) assert.ok(state.reason, state.id);
});

test('codec choices, the encoding summary and size presets give the sheet its words', () => {
  // Today's refreshCapabilities() option markup, transcribed (its lines are checked against app.mjs above).
  const today = format => ({disabled: !(format.codecs || []).some(codec => codec.supported), options: (format.codecs || []).map(codec => ({id: codec.id,
    label: `${codec.label}${codec.lossless && !/lossless|uncompressed/i.test(codec.label) ? ' · Lossless' : ''}`, disabled: !codec.supported}))});
  const installed = {codecs: [{id: 'x', label: 'Lagarith', supported: true, lossless: true}, {id: 'y', label: 'Old', supported: false}]};
  for (const format of [...CAPABILITIES.formats, installed, {codecs: [{id: 'z', label: 'Z', supported: false}]}, {}]) assert.deepEqual(exportCodecChoices(format), today(format));
  assert.deepEqual(exportCodecChoices(CAPABILITIES.formats[2]).options.map(option => option.label), ['MPEG-4 Part 2', 'FFV1 (lossless)', 'Uncompressed RGB']);
  assert.equal(exportCodecChoices(installed).options[0].label, 'Lagarith · Lossless');

  const ctx = context(), states = exportFormatStates({capabilities: CAPABILITIES, totalFrames: 48, vfw: {listed: false}});
  const summary = fields => {
    const request = buildExportRequest(fields, ctx), shown = exportFormatStates({capabilities: CAPABILITIES, totalFrames: 48, vfw: {listed: false}, codecs: request.codecs});
    return exportEncodingSummary(reconcileExportCodecs(request, shown), shown);
  };
  assert.equal(summary({format: 'mp4'}), 'H.264 · automatic bitrate');
  assert.equal(summary({format: 'mp4', bitrateMode: 'manual', bitrateMbps: '4.5'}), `H.264 · ${(4.5).toLocaleString('en')} Mbit/s`);
  assert.equal(summary({format: 'avi', codecs: {avi: 'ffv1'}}), 'FFV1 (lossless)');
  assert.equal(summary({format: 'webm'}), 'VP9 with transparency · automatic bitrate');
  assert.equal(summary({format: 'gif'}), '');
  assert.equal(exportEncodingSummary(buildExportRequest({format: 'vfw'}, ctx), states, {vfwCodec: {label: 'Cinepak'}}), 'Cinepak');
  const padded = exportFormatStates({totalFrames: 48, capabilities: {width: 961, height: 541, formats: [{id: 'mp4', supported: true, provider: 'FFmpeg',
    encodedWidth: 962, encodedHeight: 542, defaultCodec: 'h264', codecs: [{id: 'h264', label: 'H.264', supported: true}]}]}});
  assert.equal(exportEncodingSummary(buildExportRequest({format: 'mp4'}, ctx), padded), 'H.264 · automatic bitrate · 962 × 542 (padded)', 'today\'s padding note');

  assert.deepEqual(sizePresetChoices({canvasWidth: 960, canvasHeight: 540}).map(choice => [choice.label, choice.disabled]),
    [['Original · 960 × 540', false], ['1080p · 1920 × 1080', false], ['720p · 1280 × 720', false], ['4K · 3840 × 2160', false], ['Custom…', false]]);
  const board = {canvasWidth: 100, canvasHeight: 1000, totalFrames: 48}, tall = sizePresetChoices(board);
  const uhd = tall.find(choice => choice.id === '2160');
  assert.deepEqual([uhd.width, uhd.height, uhd.disabled], [2160, 21600, true]);
  assert.match(uhd.reason, /larger than an export allows/);
  // Disabled exactly when choosing it would fail the size check.
  for (const choice of tall.filter(option => option.id !== 'custom')) {
    const request = updateExportRequest(buildExportRequest({format: 'svg'}, board), {sizePreset: choice.id}, board);
    assert.equal(validateExportRequest(request, {states: exportFormatStates(OPEN), totalFrames: 48, fps: 24}).invalid.includes('width'), choice.disabled, choice.id);
  }
  assert.throws(() => sizePresetChoices({}), TypeError);
  assert.deepEqual(formatChoices('video', states).map(choice => choice.type), ['MP4 (.mp4)', 'WebM (.webm)', 'AVI (.avi)', 'WMV (.wmv) · Unavailable']);
  assert.deepEqual(formatChoices('frames', states).map(choice => choice.type).slice(0, 3), ['PNG frame (.png)', 'SVG frame (.svg)', 'PNG sequence (.zip)']);
});

test('the dialog\'s notes and Use entire animation keep today\'s words', () => {
  assert.equal(exportPlayedFramesNote(8, 48), 'Export counts every frame that plays. Your 8 timeline frames play as 48 with inbetweens.');
  assert.equal(exportPlayedFramesNote(1, 6), 'Export counts every frame that plays. Your 1 timeline frame plays as 6 with inbetweens.');
  for (const stored of [48, null, undefined]) assert.equal(exportPlayedFramesNote(stored, 48), '');
  assert.equal(exportWorkingPoseNote({mode: 'add', dirty: true}, 4), 'Add the working pose as a frame to include it in animation exports. Your .styk project keeps the working pose.');
  for (const [draft, total] of [[{mode: 'add', dirty: false}, 4], [{mode: 'edit', dirty: true}, 4], [{mode: 'add', dirty: true}, 0], [null, 4]])
    assert.equal(exportWorkingPoseNote(draft, total), '', JSON.stringify({draft, total}));
  const ctx = context(), narrowed = updateExportRequest(buildExportRequest({format: 'gif'}, ctx), {from: 5, to: 9}, ctx);
  const whole = updateExportRequest(narrowed, entireAnimationPatch(48), ctx);
  assert.deepEqual([whole.from, whole.to], [1, 48]);
});
