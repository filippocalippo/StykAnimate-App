/**
 * The timeline: moving through the animation's frames, the timeline's own view, frame edits, and playback with the
 * interface following.
 *
 * Everything but the frame steps works on the Advanced timeline, the one a new profile shows (settings.mjs
 * `timelineMode`): its ruler, its grid of layer cells and its header (docs/TIMELINE.md). The Simple timeline is a strip
 * of cards with no ruler to drag; a scenario that needs the Advanced one skips with that reason.
 */
import {respond} from '../lib/response.mjs';
import {scrubTrail, seekLatency, shownTicks} from '../lib/latency.mjs';
import {LIMITS} from '../lib/metrics.mjs';
import {play} from './playback.mjs';

/** How many times the next-frame key is pressed, and over how long: twenty a second, what a held key gives. */
const STEPS = 30, STEP_MS = 1500;

export const step = {
  id: 'timeline.step', area: 'timeline', title: 'Step through frames', kind: 'gesture',
  description: 'Presses the next-frame key 30 times in 1.5 s, as a held key does. Each press is a seek: the engine evaluates the frame, the stage draws it, the interface follows.',
  // Smooth is not enough here: each press must show its own frame before the next press comes.
  judge: [{metric: 'frame.felt', limits: LIMITS.frame}, {metric: 'seek.p95', limits: [50, 100, 250]}],
  metrics: {
    'seek.p50': {title: 'Key press to its frame, median', short: 'key to frame p50', unit: 'ms', better: 'lower', digits: 0},
    'seek.p95': {title: 'Key press to its frame, 95th percentile', short: 'key to frame', unit: 'ms', better: 'lower', digits: 0},
    'seek.unanswered': {title: 'Key presses whose frame never showed', unit: '', better: 'lower', digits: 0},
  },
  when: async context => ((await context.state()).document.totalTicks < 2 ? 'the document has one frame' : undefined),
  setup: async context => ({presses: Math.min(STEPS, (await context.state()).document.totalTicks - 1)}),
  run: (context, {presses}) => context.input.keys('Period', {count: presses, durationMs: STEP_MS * presses / STEPS}),
  measure(context, {presses}, summary) {
    const waits = seekLatency(summary.shown, {firstTick: 0, lastTick: presses, endMs: summary.ms});
    return {'seek.p50': waits.p50, 'seek.p95': waits.p95, 'seek.unanswered': waits.unanswered};
  },
  reset: context => context.request('seek', {tick: 0}),
};

export const jump = {
  id: 'timeline.jump', area: 'timeline', title: 'Jump to a far frame', kind: 'operation',
  description: 'Seeks from the first frame to the middle of the animation and waits for its picture: one cold frame, nothing prepared around it.',
  judge: {metric: 'duration', limits: LIMITS.response},
  when: async context => ((await context.state()).document.totalTicks < 4 ? 'the document is too short' : undefined),
  async run(context) {
    const ticks = (await context.state()).document.totalTicks;
    const shown = await context.request('seek', {tick: Math.floor(ticks / 2)});
    return {metrics: {duration: shown.presentedMs ?? NaN}};
  },
  reset: context => context.request('seek', {tick: 0}),
};

/** Why a scenario of the Advanced timeline cannot run here, or undefined when it can. */
async function advanced(context, {ticks = 10} = {}) {
  const shown = await context.evaluate(() => ({mode: globalThis.styk.state.settings.timelineMode, mounted: Boolean(globalThis.styk.timeline?.scroll?.isConnected), ticks: globalThis.styk.editor.totalTicks}));
  if (shown.mode !== 'advanced' || !shown.mounted) return 'the Simple timeline is on show: it has no ruler or layer grid';
  if (shown.ticks < ticks) return `the document has fewer than ${ticks} frames`;
  return undefined;
}

/**
 * The Advanced timeline's grid in window pixels, from the timeline's own layout: its box, the ruler's height, the zoom
 * (pixels per frame) and scroll, and the row of the first figure layer (its id and the middle of its row). `x(tick)` is
 * the middle of a frame's column.
 */
async function grid(context) {
  const found = await context.evaluate(() => {
    const timeline = globalThis.styk.timeline, box = timeline.scroll.getBoundingClientRect(), layout = timeline.layout;
    const row = timeline.tracks.findIndex(track => track.kind === 'layer');
    // A row's place as the timeline's own hit test reads it: pinned rows (Camera, Scene) do not scroll, the others do.
    const rowY = row < 0 ? null : box.top + layout.header + layout.top(row) - (layout.pinned && row < layout.system ? 0 : timeline._offsetY()) + layout.size(row) / 2;
    return {left: box.left, top: box.top, width: timeline.scroll.clientWidth, height: timeline.scroll.clientHeight, ruler: layout.header, pxPerTick: timeline.pxPerTick,
      offsetX: timeline._offsetX(), scrollLeft: timeline.scroll.scrollLeft, scrollWidth: timeline.scroll.scrollWidth, layer: row < 0 ? null : timeline.tracks[row].id, rowY, ticks: globalThis.styk.editor.totalTicks};
  });
  return {...found, x: tick => found.left + (tick + .5) * found.pxPerTick - found.offsetX};
}

/** The timeline's zoom and scroll, to put back: a scenario that changes the view leaves it as it found it. */
const viewOf = async context => { const {pxPerTick, scrollLeft} = await grid(context); return {pxPerTick, scrollLeft}; };
const restoreView = (context, view) => context.evaluate(({pxPerTick, scrollLeft}) => {
  const timeline = globalThis.styk.timeline;
  timeline.setZoom(pxPerTick, 0);
  timeline.scroll.scrollLeft = scrollLeft;
}, view);

/** Presses Fit timeline in the timeline's header and waits until the whole animation is in the grid's width. */
async function fit(context) {
  await context.press('.tl-fit');
  await context.until(() => { const timeline = globalThis.styk.timeline; return timeline.pxPerTick * globalThis.styk.editor.totalTicks <= timeline.scroll.clientWidth + 1 && timeline.scroll.scrollLeft === 0; },
    {what: 'Fit timeline to show the whole animation'});
  return grid(context);
}

export const scrub = {
  id: 'timeline.scrub', area: 'timeline', title: 'Scrub the playhead along the ruler', kind: 'gesture',
  description: 'Drags the playhead along the Advanced timeline\'s ruler from 5% to 95% of the animation in 1.5 s, the whole animation fitted in view. '
    + 'Each tick the pointer crosses is a seek the stage shows: the exact editing frame in a light scene, frames the engine\'s threads prepare in a dense one (docs/TIMELINE.md "Scrubbing a dense scene").',
  // Smooth is not enough: the picture must keep up with the hand.
  judge: [{metric: 'frame.felt', limits: LIMITS.frame}, {metric: 'scrub.trail', limits: LIMITS.input}],
  metrics: {
    'scrub.trail': {title: 'Picture behind the pointer, 95th percentile', short: 'picture behind', unit: 'ms', better: 'lower', digits: 0},
    'scrub.trailP50': {title: 'Picture behind the pointer, median', unit: 'ms', better: 'lower', digits: 0},
    'scrub.behind': {title: 'Frames the pointer was ahead, 95th percentile', unit: '', better: 'lower', digits: 0},
    'scrub.ticks': {title: 'Different frames shown during the drag', unit: '', better: 'higher', digits: 0},
    'scrub.perSecond': {title: 'Different frames shown per second', unit: '/s', better: 'higher', digits: 1},
    'scrub.prepared': {title: 'Pictures from frames the engine prepared', unit: '', better: 'higher', digits: 0},
    'scrub.release': {title: 'Release to the exact frame', unit: 'ms', better: 'lower', digits: 0},
  },
  when: context => advanced(context),
  async setup(context) {
    const view = await viewOf(context), at = await fit(context);
    const from = Math.round(at.ticks * .05), to = Math.min(at.ticks - 1, Math.round(at.ticks * .95)), y = at.top + at.ruler / 2;
    const onRuler = await context.evaluate(({x, y}) => Boolean(document.elementFromPoint(x, y)?.closest('.sheet-scroll')), {x: at.x(from), y});
    if (!onRuler) throw new Error('Something covers the timeline\'s ruler: the drag cannot start.');
    return {view, from, to, start: {x: at.x(from), y}, end: {x: at.x(to), y}};
  },
  async run(context, {to, start, end}) {
    await context.input.stroke(context.paths.line(start, end), {durationMs: 1500});
    await context.settle();
    const {tick} = (await context.state()).document;
    if (tick !== to) throw new Error(`The drag along the ruler left the playhead at ${tick}, not at ${to}: it did not scrub.`);
  },
  measure(context, {from, to}, summary) {
    const trail = scrubTrail(summary.shown, {fromTick: from, toTick: to});
    if (!trail) return {};
    return {'scrub.trail': trail.trail.p95, 'scrub.trailP50': trail.trail.p50, 'scrub.behind': trail.behind.p95, 'scrub.ticks': trail.ticks, 'scrub.perSecond': trail.perSecond,
      'scrub.prepared': shownTicks(summary.shown).prepared, ...(trail.releaseMs === null ? {} : {'scrub.release': trail.releaseMs})};
  },
  reset: context => context.request('seek', {tick: 0}),
  teardown: (context, {view}) => restoreView(context, view),
};

export const zoom = {
  id: 'timeline.zoom', area: 'timeline', title: 'Zoom the timeline', kind: 'gesture',
  description: 'Turns the wheel with Ctrl held over the Advanced timeline\'s grid, from the whole animation in view: in for 0.75 s, back out for 0.75 s. '
    + 'Each notch zooms under the pointer and repaints the ruler, the layer cells and the playhead.',
  when: context => advanced(context),
  async setup(context) {
    const view = await viewOf(context), at = await fit(context);
    return {view, fitted: at.pxPerTick, point: {x: at.left + at.width / 2, y: at.top + at.ruler + (at.height - at.ruler) / 2}};
  },
  async run(context, {fitted, point}) {
    await context.input.wheel(point.x, point.y, {notches: 10, deltaY: -100, durationMs: 750, ctrl: true});
    const zoomed = (await grid(context)).pxPerTick;
    await context.input.wheel(point.x, point.y, {notches: 10, deltaY: 100, durationMs: 750, ctrl: true});
    if (!(zoomed > fitted * 1.5)) throw new Error(`The wheel did not zoom the timeline (${fitted.toFixed(1)} to ${zoomed.toFixed(1)} pixels a frame).`);
  },
  // Back to the fitted zoom: the zoom stops at its largest, so the way out does not end where the way in began.
  reset: (context, {fitted}) => restoreView(context, {pxPerTick: fitted, scrollLeft: 0}),
  teardown: (context, {view}) => restoreView(context, view),
};

export const scroll = {
  id: 'timeline.scroll', area: 'timeline', title: 'Scroll the timeline', kind: 'gesture',
  description: 'Turns the wheel with Shift held over the Advanced timeline\'s grid, zoomed in so the animation is several grids wide: '
    + 'forward through the frames for 0.75 s, back for 0.75 s. Each notch scrolls the grid and repaints the frames that come into view.',
  when: context => advanced(context),
  async setup(context) {
    const view = await viewOf(context);
    let at = await grid(context);
    const point = {x: at.left + at.width / 2, y: at.top + at.ruler + (at.height - at.ruler) / 2};
    // Zoomed in until the frames are wider than the scroll the gesture takes (15 notches of 100 pixels each way).
    for (let turn = 0; turn < 4 && at.scrollWidth - at.width < 1600; turn++) {
      await context.input.wheel(point.x, point.y, {notches: 6, deltaY: -100, durationMs: 200, ctrl: true});
      at = await grid(context);
    }
    if (at.scrollWidth - at.width < 1600) throw new Error(`The timeline cannot scroll far enough: its frames are ${Math.round(at.scrollWidth)} pixels wide in a ${Math.round(at.width)}-pixel grid at the largest zoom.`);
    const zoomed = {pxPerTick: at.pxPerTick, scrollLeft: 0};
    await restoreView(context, zoomed);
    return {view, zoomed, point};
  },
  async run(context, {point}) {
    await context.input.wheel(point.x, point.y, {notches: 15, deltaY: 100, durationMs: 750, shift: true});
    const scrolled = (await grid(context)).scrollLeft;
    await context.input.wheel(point.x, point.y, {notches: 15, deltaY: -100, durationMs: 750, shift: true});
    if (!(scrolled > 500)) throw new Error(`The wheel did not scroll the timeline (${Math.round(scrolled)} pixels).`);
  },
  reset: (context, {zoomed}) => restoreView(context, zoomed),
  teardown: (context, {view}) => restoreView(context, view),
};

/**
 * A cell of the first figure layer near 40% of the animation, selected with a real click (the playhead goes there):
 * `on: 'key'` the cell of a key, `on: 'exposure'` the cell after it, inside the key's exposure. Returns the cell.
 */
async function selectCell(context, on) {
  const keys = await context.evaluate(() => {
    const {editor, timeline} = globalThis.styk, layer = timeline.tracks.find(track => track.kind === 'layer')?.id;
    return layer ? {layer, ticks: editor.layerFrameKeys(layer).map(key => key.tick), total: editor.totalTicks} : null;
  });
  if (!keys) throw new Error('The timeline has no figure layer.');
  // A key with room after it, nearest 40% of the animation.
  const ends = [...keys.ticks.slice(1), keys.total];
  const candidates = keys.ticks.map((tick, index) => ({tick, length: ends[index] - tick})).filter(key => key.length >= 2);
  if (!candidates.length) throw new Error('The figure layer has no key held for two frames or more.');
  const key = candidates.reduce((best, candidate) => (Math.abs(candidate.tick - keys.total * .4) < Math.abs(best.tick - keys.total * .4) ? candidate : best));
  const tick = on === 'key' ? key.tick : key.tick + 1;
  // A seek pages the grid so the playhead is in view; the click then lands on the cell.
  await context.request('seek', {tick});
  const at = await grid(context), x = at.x(tick);
  if (x < at.left + 4 || x > at.left + at.width - 4) throw new Error(`Frame ${tick + 1} is not in the timeline's view.`);
  await context.input.click(x, at.rowY);
  await context.until(({layer, tick}) => { const timeline = globalThis.styk.timeline; return timeline.selectedTrackId === layer && timeline.start === tick && timeline.end === tick && document.activeElement === timeline.scroll; },
    {argument: {layer: keys.layer, tick}, what: `the click to select frame ${tick + 1} of the figure layer`});
  return {layer: keys.layer, tick};
}

/** Whether the stage shows an edit made after revision `before` (runs in the page). */
const edited = before => { const {editor, state} = globalThis.styk; return editor.revision !== before && state.lastEditingPresentation?.revision === editor.revision; };

/** A frame edit by a key on a selected cell: the key press to the stage showing the edited document. Undone after each pass. */
function frameEdit({id, title, on, key, held, description}) {
  return {
    id, area: 'timeline', title, kind: 'operation', description,
    judge: {metric: 'duration', limits: LIMITS.response},
    when: context => advanced(context),
    setup: context => selectCell(context, on),
    async run(context, cell) {
      const {revision} = (await context.state()).document;
      return {metrics: {duration: await respond(context, () => context.input.key(key, held), edited, {argument: revision, what: `${title.toLowerCase()} at frame ${cell.tick + 1}`})}};
    },
    async reset(context) {
      await context.request('undo');
      await selectCell(context, on);
    },
  };
}

export const addFrame = frameEdit({
  id: 'timeline.add-frame', title: 'Add a key', on: 'exposure', key: 'A',
  description: 'Presses Add Frame (A) on a cell inside a key\'s exposure of the figure layer near 40% of the animation: a new key there, later keys stay. '
    + 'One edit of the engine\'s document, then the timeline and the stage repaint.',
});
export const duplicateFrame = frameEdit({
  id: 'timeline.duplicate-frame', title: 'Duplicate a frame', on: 'key', key: 'A',
  description: 'Presses Add Frame (A) on a key\'s cell of the figure layer near 40% of the animation: the key\'s pose is copied into the next frame and every later key moves one frame on.',
});
export const removeFrame = frameEdit({
  id: 'timeline.remove-frame', title: 'Remove a frame', on: 'exposure', key: 'F5', held: {shift: true},
  description: 'Presses Remove frames (Shift+F5) on a cell of the figure layer near 40% of the animation: the frame is taken out of the layer and its later keys move one frame back.',
});

/** Counts the changes the interface makes to the inspector and to the timeline's playhead: a read, by two mutation observers. */
const FOLLOW = () => {
  const watched = globalThis.__stykPerfFollow ??= {inspector: 0, playhead: 0, since: performance.now(), observers: []};
  for (const [key, selector] of [['inspector', '#inspector'], ['playhead', '.sheet-playhead-clip']]) {
    const element = document.querySelector(selector);
    if (!element) continue;
    const observer = new MutationObserver(() => { watched[key]++; });
    observer.observe(element, {subtree: true, childList: true, attributes: true, characterData: true});
    watched.observers.push(observer);
  }
  return watched.observers.length;
};

export const playSelected = {
  id: 'timeline.play-selected', area: 'timeline', title: 'Play with a figure selected', kind: 'gesture',
  description: 'Clicks a figure to select it, then plays from the first frame as playback.play does, with the inspector showing the figure and the timeline on show. '
    + 'What playback costs when the interface around the stage follows it.',
  judge: play.judge,
  metrics: {...play.metrics,
    'follow.inspector': {title: 'Inspector changes per second', unit: '/s', better: 'lower', digits: 1},
    'follow.playhead': {title: 'Timeline playhead changes per second', unit: '/s', better: 'higher', digits: 1}},
  async setup(context) {
    const target = await context.request('target.handle', {kind: 'move'});
    if (!target.onStage) throw new Error('Something covers the stage where the figure is: the click cannot select it.');
    await context.input.click(target.x, target.y);
    await context.until(uid => globalThis.styk.editor.selectedUids?.has(uid), {argument: target.uid, what: 'the click to select a figure'});
    await context.rect('#inspector');
    if (await context.evaluate(FOLLOW) < 2) throw new Error('The inspector or the timeline\'s playhead is not in the page.');
    return target;
  },
  async run(context) {
    await context.evaluate(() => Object.assign(globalThis.__stykPerfFollow, {inspector: 0, playhead: 0, since: performance.now()}));
    const played = await play.run(context);
    const follow = await context.evaluate(() => { const watched = globalThis.__stykPerfFollow, seconds = (performance.now() - watched.since) / 1000; return {inspector: watched.inspector / seconds, playhead: watched.playhead / seconds}; });
    return {metrics: {...played.metrics, 'follow.inspector': follow.inspector, 'follow.playhead': follow.playhead}};
  },
  reset: context => context.request('seek', {tick: 0}),
  async teardown(context) {
    await context.evaluate(() => { for (const observer of globalThis.__stykPerfFollow?.observers ?? []) observer.disconnect(); delete globalThis.__stykPerfFollow; });
    await context.request('select', {uid: null});
  },
};

export default [step, jump, scrub, zoom, scroll, addFrame, duplicateFrame, removeFrame, playSelected];
