/**
 * Drawing: painting on a drawing layer (docs/DRAWING.md, docs/engine/drawing.md), the operations a person repeats.
 *
 * Every scenario opens the Draw workspace and makes a new drawing layer with the rail's + (real clicks) in `setup`,
 * and in `teardown` undoes everything it added and goes back to Animate, so the document is the workload's again.
 * A stroke reaches the page as a pen (pointer type pen, pressure rising and falling, perf/lib/input.mjs) through the
 * same input path as a tablet's.
 *
 * How far the ink trails the pointer: the drawing controller draws the stroke's not yet rasterized part ("wet ink",
 * src/drawing-controller.mjs `drawWet`) on the overlay in the pointer handler or the next animation frame, so the
 * capture's input to frame (`input.p95`) is the time from a pen sample to the frame that shows its ink. The worker
 * then rasterizes the dabs into the cel's tiles in batches and the stage presents them; how far that falls behind
 * shows as `stroke.landed`, the time from the pen's release until the stroke is committed and nothing is in flight.
 */
import {LIMITS} from '../lib/metrics.mjs';

/**
 * The brush every scenario starts from: the Ink preset's round hard tip with no smoothing, so the ink follows the pen
 * exactly, in a colour no figure of a workload has. Scenarios change the size and hardness.
 */
const BRUSH = {preset: 'ink', size: 8, hardness: 1, opacity: 1, flow: 1, stabilization: 0, texture: 0, pressureSize: true, pressureOpacity: false, color: '#c0208a', resolution: 2};
/** The pen's pressure along a stroke: light at the ends, firm in the middle, as a hand presses. */
const PRESSURE = t => .25 + .6 * Math.sin(Math.PI * t);

const STROKE_METRICS = {
  'stroke.landed': {title: 'Pen lifted to stroke committed', short: 'landed', unit: 'ms', better: 'lower', digits: 0},
  'stroke.dabs': {title: 'Dabs the stroke stamped', unit: '', better: 'lower', digits: 0},
  'stroke.batches': {title: 'Batches sent to the stroke worker', unit: '', better: 'lower', digits: 0},
  'stroke.queue': {title: 'Batches in flight at most', unit: '', better: 'lower', digits: 0},
};
/** A stroke is judged as a gesture (smooth, ink close to the pen) and on how soon it lands once the pen lifts. */
const STROKE_JUDGE = [{metric: 'frame.felt', limits: LIMITS.frame}, {metric: 'input.p95', limits: LIMITS.input}, {metric: 'stroke.landed', limits: LIMITS.response}];

/**
 * Waits in the page, frame by frame, until the drawing has nothing in flight (no gesture, no wet ink waiting for its
 * tiles, no pixel operation) and the document's revision is past `revision`; returns how long that took (ms, from
 * when the wait began). Polling in the page keeps the answer to a frame; from here it would be to a round trip.
 */
function landed(context, revision) {
  return context.evaluate(async before => {
    const {styk} = globalThis, drawing = styk.drawing, started = performance.now();
    while (drawing.gesture || drawing.wetSession || drawing.operation || styk.editor.revision === before) {
      if (performance.now() - started > 30000) throw new Error('The drawing did not commit within 30 s.');
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    return performance.now() - started;
  }, revision);
}

/** The document's revision and the length of its undo history. */
async function history(context) {
  const {document} = await context.state();
  return {revision: document.revision, depth: document.history.undo};
}

/**
 * Fills the drawing layer's cel at the first frame with an opaque, noisy picture over the whole canvas (every 64-pixel
 * tile different, at the brush's resolution): the cel of a finished background painting. Painting that many tiles
 * stroke by stroke would take minutes, so this commits them as one edit through the editor's own drawing command, as
 * a paste does (`commitDrawingPixels`, one undo step). Returns how many tiles it painted.
 */
function paintBusyCel(context) {
  return context.evaluate(async () => {
    const {styk} = globalThis, editor = styk.editor, drawing = styk.drawing, resolution = drawing.settings.resolution;
    const target = editor.prepareDrawingCel({pixelsPerUnit: resolution, world: {x: 0, y: 0}});
    await drawing.owner.surface(target.figure);
    const columns = Math.ceil(editor.report.canvas_width * resolution / 64), rows = Math.ceil(editor.report.canvas_height * resolution / 64), tiles = [];
    for (let ty = 0; ty < rows; ty++) {
      for (let tx = 0; tx < columns; tx++) {
        const after = new Uint8ClampedArray(64 * 64 * 4);
        for (let index = 0; index < after.length; index += 4) {
          const noise = ((index >> 2) * 2654435761 + tx * 97 + ty * 131) >>> 0;
          after[index] = 40 + (tx * 5 & 63) + (noise & 7); after[index + 1] = 120 + (ty * 3 & 63) + (noise >> 8 & 7); after[index + 2] = 60 + (noise >> 16 & 7); after[index + 3] = 255;
        }
        tiles.push({tx, ty, before: null, after});
      }
    }
    editor.commitDrawingPixels(target, tiles, 'Busy cel');
    await drawing.owner.flush();
    return tiles.length;
  });
}

/**
 * Opens Draw, makes a drawing layer with the rail's +, sets the brush (`brush` over BRUSH), optionally paints the busy
 * cel and picks the tool by its key. Returns what `leave` needs to put everything back.
 */
async function enter(context, {brush = {}, busy = false, tool = 'b'} = {}) {
  const start = await history(context);
  await context.press('[data-workspace-mode="draw"]');
  // The rail's + appears once the workspace has laid out, which on a slow machine is frames after Draw is active.
  await context.until(() => globalThis.styk.drawing.active && [...document.querySelectorAll('[data-draw-action="new"]')].some(button => button.getBoundingClientRect().width > 0),
    {what: 'the Draw workspace and its new-layer button'});
  await context.press('[data-draw-action="new"]');
  await context.until(depth => globalThis.styk.editor._undo.length > depth && globalThis.styk.editor.undoLabel === 'New drawing layer', {argument: start.depth, what: 'the new drawing layer'});
  const settings = await context.evaluate(wanted => {
    const settings = globalThis.styk.drawing.settings, kept = Object.fromEntries(Object.keys(wanted).map(key => [key, settings[key]]));
    Object.assign(settings, wanted);
    return kept;
  }, {...BRUSH, ...brush});
  const state = {start, settings, tiles: 0};
  // The first stroke after Draw opens starts the stroke worker and prepares the stage's drawing path (a frame of
  // 150 ms and more here): a short stroke, undone, so a pass measures drawing as it goes on, not its first touch.
  const {x, y, width, height} = await context.stage(), {revision} = await history(context);
  await context.input.stroke(context.paths.line({x: x + width * .85, y: y + height * .85}, {x: x + width * .9, y: y + height * .8}), {durationMs: 200, pressure: PRESSURE});
  await landed(context, revision);
  await context.request('undo');
  if (busy) state.tiles = await paintBusyCel(context);
  await context.input.key(tool);
  await context.settle();
  return state;
}

/** Undoes everything since `enter`, puts the brush back and returns to Animate. */
async function leave(context, state) {
  for (let left = 64; left > 0 && (await history(context)).depth > state.start.depth; left--) await context.request('undo');
  await context.evaluate(kept => Object.assign(globalThis.styk.drawing.settings, kept), state.settings);
  await context.input.key('b');
  await context.press('[data-workspace-mode="animate"]');
  await context.until(() => !globalThis.styk.drawing.active, {what: 'the Animate workspace'});
  if ((await history(context)).depth !== state.start.depth) throw new Error('The drawing scenario could not undo all it added.');
}

/** A wavy stroke across the middle of the stage, from a fifth of its width to four fifths. */
async function across(context, {y = .5} = {}) {
  const {x, y: top, width, height} = await context.stage();
  return context.paths.wave({x: x + width * .2, y: top + height * y}, {x: x + width * .8, y: top + height * y}, Math.min(80, height / 8));
}

/**
 * Draws `path` with the pen for 1.5 s, waits for it to land, checks it became one undo step, and returns its metrics.
 * The stroke worker's counters (`strokeStats`) only add up, so the scenario reads them before and after; the deepest
 * queue is a maximum, so it is set back to 0 first (a counter of the drawing's own diagnostics, nothing it draws by).
 */
async function stroke(context, path, label) {
  const before = await context.evaluate(() => { const stats = globalThis.styk.drawing.strokeStats; stats.maxQueueDepth = 0; return {...stats, revision: globalThis.styk.editor.revision}; });
  await context.input.stroke(path, {durationMs: 1500, pressure: PRESSURE});
  const landedMs = await landed(context, before.revision);
  const after = await context.evaluate(() => ({...globalThis.styk.drawing.strokeStats, label: globalThis.styk.editor.undoLabel}));
  if (after.label !== label) throw new Error(`The stroke did not commit as one "${label}" step (the last step is "${after.label}").`);
  return {metrics: {'stroke.landed': landedMs, 'stroke.dabs': (after.dabs ?? 0) - (before.dabs ?? 0), 'stroke.batches': after.batches - before.batches, 'stroke.queue': after.maxQueueDepth}};
}

const undo = context => context.request('undo');

export const brush = {
  id: 'drawing.brush', area: 'drawing', title: 'Draw a brush stroke', kind: 'gesture',
  description: 'Draws a wavy pen stroke with pressure across an empty drawing layer for 1.5 s (Ink, 8 px). The ink shows on the overlay at once; the stroke worker rasterizes it into the cel\'s tiles behind the pen.',
  judge: STROKE_JUDGE, metrics: STROKE_METRICS,
  setup: context => enter(context),
  run: async context => stroke(context, await across(context), 'Brush stroke'),
  reset: undo,
  teardown: leave,
};

export const largeBrush = {
  id: 'drawing.brush-large', area: 'drawing', title: 'Draw with a large soft brush', kind: 'gesture',
  description: 'The same pen stroke with a 200 px brush of half hardness: each dab covers dozens of tiles and the soft edge is blended into every one.',
  judge: STROKE_JUDGE, metrics: STROKE_METRICS,
  setup: context => enter(context, {brush: {size: 200, hardness: .5}}),
  run: async context => stroke(context, await across(context), 'Brush stroke'),
  reset: undo,
  teardown: leave,
};

export const eraser = {
  id: 'drawing.eraser', area: 'drawing', title: 'Erase with a stroke', kind: 'gesture',
  description: 'Erases a wavy pen stroke 48 px wide for 1.5 s across a cel painted over the whole canvas: every dab takes paint out of tiles that hold some.',
  judge: STROKE_JUDGE, metrics: STROKE_METRICS,
  setup: context => enter(context, {brush: {size: 48}, busy: true, tool: 'e'}),
  run: async context => stroke(context, await across(context), 'Erase stroke'),
  reset: undo,
  teardown: leave,
};

export const busyCel = {
  id: 'drawing.brush-busy-cel', area: 'drawing', title: 'Draw on a painted cel', kind: 'gesture',
  description: 'The brush stroke of drawing.brush on a cel already painted over the whole canvas: the stroke blends into tiles that hold paint and the stage draws the full cel under it.',
  judge: STROKE_JUDGE, metrics: STROKE_METRICS,
  setup: context => enter(context, {busy: true}),
  run: async context => stroke(context, await across(context), 'Brush stroke'),
  reset: undo,
  teardown: leave,
};

export const fill = {
  id: 'drawing.fill', area: 'drawing', title: 'Fill an outline', kind: 'operation',
  description: 'Clicks with the fill tool inside a closed brush outline: the pixel worker finds the region, closes gaps and paints it, and the cel takes the new tiles as one step.',
  judge: {metric: 'duration', limits: LIMITS.response},
  async setup(context) {
    const state = await enter(context, {brush: {size: 6}});
    const {centre, height} = await context.stage(), radius = Math.min(160, height / 3);
    // The outline, drawn as a person draws it; the fill then clicks in its middle.
    const before = (await history(context)).revision;
    await context.input.stroke(context.paths.circle(centre, radius, 1.05), {durationMs: 1200});
    await landed(context, before);
    await context.input.key('g');
    return {...state, inside: {x: centre.x - radius / 3, y: centre.y}};
  },
  async run(context, {inside}) {
    const {revision} = await history(context), started = performance.now();
    await context.input.click(inside.x, inside.y);
    await landed(context, revision);
    const label = await context.evaluate(() => globalThis.styk.editor.undoLabel);
    if (label !== 'Fill drawing') throw new Error(`The click did not fill (the last step is "${label}").`);
    return {metrics: {duration: performance.now() - started}};
  },
  reset: undo,
  teardown: leave,
};

export const undoStroke = {
  id: 'drawing.undo', area: 'drawing', title: 'Undo and redo a stroke', kind: 'operation',
  description: 'Undoes a brush stroke and redoes it: each puts the stroke\'s tiles back into the cel as they were and redraws the stage.',
  judge: {metric: 'duration', limits: LIMITS.response},
  metrics: {'history.redo': {title: 'Redo', unit: 'ms', better: 'lower', digits: 0}},
  async setup(context) {
    const state = await enter(context);
    await stroke(context, await across(context), 'Brush stroke');
    return state;
  },
  async run(context) {
    const started = performance.now();
    await context.request('undo');
    const undone = performance.now();
    await context.request('redo');
    return {metrics: {duration: undone - started, 'history.redo': performance.now() - undone}};
  },
  teardown: leave,
};

export const lasso = {
  id: 'drawing.lasso-move', area: 'drawing', title: 'Select pixels with the lasso and move them', kind: 'gesture',
  description: 'On a cel painted over the whole canvas, draws a lasso round a circle of it (0.7 s), drags the selection away (0.8 s) and presses Enter: the pixels are lifted, follow the pointer, and are put down as one step.',
  metrics: {'selection.apply': {title: 'Enter to the moved pixels committed', unit: 'ms', better: 'lower', digits: 0}},
  judge: [{metric: 'frame.felt', limits: LIMITS.frame}, {metric: 'input.p95', limits: LIMITS.input}, {metric: 'selection.apply', limits: LIMITS.response}],
  setup: context => enter(context, {busy: true, tool: 'l'}),
  async run(context) {
    const {centre, height} = await context.stage(), radius = Math.min(140, height / 4), {revision} = await history(context);
    await context.input.stroke(context.paths.circle(centre, radius, 1.02), {durationMs: 700});
    await context.until(() => Boolean(globalThis.styk.drawing.selection || globalThis.styk.drawing.marquee), {what: 'the lasso selection'});
    await context.input.stroke(context.paths.line(centre, {x: centre.x + radius * .8, y: centre.y + radius * .4}), {durationMs: 800});
    await context.input.key('Enter');
    const applied = await landed(context, revision);
    const label = await context.evaluate(() => globalThis.styk.editor.undoLabel);
    if (label !== 'Transform selected pixels') throw new Error(`The selection did not move (the last step is "${label}").`);
    return {metrics: {'selection.apply': applied}};
  },
  reset: undo,
  teardown: leave,
};

export default [brush, largeBrush, eraser, busyCel, fill, undoStroke, lasso];
