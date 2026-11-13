/**
 * Selection: clicking figures, a selection rectangle, select all and moving many figures at once (docs/SCENE-EDITING.md).
 * Every scenario starts from the runner's rest: nothing selected, the whole scene in view.
 */
import {LIMITS} from '../lib/metrics.mjs';
import {respond} from '../lib/response.mjs';
import {moveFigure} from './pose.mjs';

/**
 * The origins of the figures on show in window pixels, where a click reaches the stage (nothing covers it), nearest the
 * stage's middle first. Read through the app's own handle geometry, as the control channel's `target.handle` does.
 */
const origins = context => context.evaluate(async () => {
  const {getPivotHandles} = await import('/src/canvas-interactions.mjs');
  const {worldToScreen} = await import('/src/renderer-geometry.mjs');
  const {editor, state} = globalThis.styk, rect = document.getElementById('viewport').getBoundingClientRect(), found = [];
  const handles = getPivotHandles(editor.geometry, {frame: editor.evaluatedFrame, selectedUid: null, selectedUids: new Set(), showUnselected: true, viewScale: state.view.scale});
  for (const handle of handles) {
    if (handle.action !== 'move' || handle.g?.obj?.join) continue;
    const point = worldToScreen(handle.point, {report: editor.report, frame: editor.evaluatedFrame, view: state.view, cameraEnabled: false});
    const x = rect.left + point.x, y = rect.top + point.y;
    if (document.elementFromPoint(x, y)?.id === 'overlay') found.push({uid: handle.uid, x, y, distance: Math.hypot(point.x - rect.width / 2, point.y - rect.height / 2)});
  }
  return found.sort((a, b) => a.distance - b.distance);
});

/**
 * Two places on the stage with no figure under them, near opposite corners, for a press that selects nothing (a click
 * that deselects, a selection rectangle). Read through the app's own hit test: the place must reach the stage and
 * pick no figure.
 */
const emptyCorners = context => context.evaluate(async () => {
  const {editor, state} = globalThis.styk, rect = document.getElementById('viewport').getBoundingClientRect();
  const {getPivotHandles} = await import('/src/canvas-interactions.mjs');
  const {worldToScreen} = await import('/src/renderer-geometry.mjs');
  // A place is empty when no figure's handle is within 24 pixels of it and it reaches the stage.
  const handles = getPivotHandles(editor.geometry, {frame: editor.evaluatedFrame, selectedUid: null, selectedUids: new Set(), showUnselected: true, viewScale: state.view.scale})
    .map(handle => worldToScreen(handle.point, {report: editor.report, frame: editor.evaluatedFrame, view: state.view, cameraEnabled: false}));
  const empty = (x, y) => document.elementFromPoint(rect.left + x, rect.top + y)?.id === 'overlay' && handles.every(point => Math.hypot(point.x - x, point.y - y) > 24);
  const corner = (fromX, fromY, stepX, stepY) => {
    for (let inset = 12; inset < Math.min(rect.width, rect.height) / 3; inset += 6) {
      const x = fromX + stepX * inset, y = fromY + stepY * inset;
      if (empty(x, y)) return {x: rect.left + x, y: rect.top + y};
    }
    return null;
  };
  return {start: corner(0, 0, 1, 1), end: corner(rect.width, rect.height, -1, -1)};
});

/** Whether exactly the figure `uid` is selected (runs in the page). */
const selectedOnly = uid => { const selected = globalThis.styk.editor.selectedUids; return selected?.size === 1 && selected.has(uid); };
/** How many figures are selected (runs in the page). */
const selectedCount = () => globalThis.styk.editor.selectedUids?.size ?? 0;

export const click = {
  id: 'selection.click', area: 'selection', title: 'Click to select a figure', kind: 'operation',
  description: 'Clicks a figure near the middle of the stage to select it, then another figure: each press to the frame that shows the new selection (its joints, the inspector and the timeline\'s layer).',
  judge: {metric: 'duration', limits: LIMITS.response},
  metrics: {'select.other': {title: 'Click another figure', unit: 'ms', better: 'lower', digits: 0}},
  when: async context => ((await origins(context)).length < 2 ? 'fewer than two figures can be clicked' : undefined),
  async setup(context) {
    const found = await origins(context), first = found[0];
    // The second figure far enough from the first that the click cannot reach the first one's handles.
    const second = found.find(point => point.uid !== first.uid && Math.hypot(point.x - first.x, point.y - first.y) > 40);
    if (!second) throw new Error('No second figure stands apart from the first.');
    return {first, second};
  },
  async run(context, {first, second}) {
    const one = await respond(context, () => context.input.click(first.x, first.y), selectedOnly, {argument: first.uid, what: 'the selection of the first figure'});
    const other = await respond(context, () => context.input.click(second.x, second.y), selectedOnly, {argument: second.uid, what: 'the selection of the second figure'});
    return {metrics: {duration: one, 'select.other': other}};
  },
  reset: context => context.request('select', {uid: null}),
};

export const marquee = {
  id: 'selection.marquee', area: 'selection', title: 'Drag a selection rectangle', kind: 'gesture',
  description: 'Drags a selection rectangle from an empty corner of the stage to the opposite one in 1.5 s, across the whole scene; the release selects every figure it meets.',
  metrics: {'select.count': {title: 'Figures selected', unit: '', better: 'higher', digits: 0}},
  async setup(context) {
    const corners = await emptyCorners(context);
    if (!corners.start || !corners.end) throw new Error('No empty place near the stage\'s corners to start the rectangle.');
    return {...corners, figures: await context.evaluate(() => globalThis.styk.editor.geometry.objects.size)};
  },
  async run(context, {start, end, figures}) {
    const before = (await context.state()).document.revision;
    await context.input.stroke(context.paths.line(start, end), {durationMs: 1500});
    await context.settle();
    const [count, revision] = await Promise.all([context.evaluate(selectedCount), context.state().then(state => state.document.revision)]);
    if (revision !== before) throw new Error('The press moved something: it did not start on empty stage.');
    if (count < Math.min(2, figures)) throw new Error(`The rectangle selected ${count} of ${figures} figures.`);
    return {metrics: {'select.count': count}};
  },
  reset: context => context.request('select', {uid: null}),
};

export const moveMany = {
  id: 'selection.move-many', area: 'selection', title: 'Move many figures', kind: 'gesture',
  description: 'Selects every figure (Ctrl+A) and drags one of them by its origin for 1.5 s: all of them move together, one edit committed on release. '
    + 'pose.move-figure is the same drag with one figure selected.',
  metrics: {'select.count': {title: 'Figures moved', unit: '', better: 'higher', digits: 0}},
  async setup(context) {
    const target = await moveFigure.setup(context);
    // The keys go to the stage, as after a click on it.
    await context.evaluate(() => document.getElementById('viewport').focus());
    await context.input.key('A', {ctrl: true});
    await context.until(() => globalThis.styk.editor.selectedUids?.size > 1, {what: 'Ctrl+A to select every figure'});
    return target;
  },
  async run(context, target) {
    const count = await context.evaluate(selectedCount);
    if (count < 2) throw new Error(`Only ${count} figure is selected before the drag.`);
    await moveFigure.run(context, target);
    return {metrics: {'select.count': count}};
  },
  reset: context => context.request('undo'),
  teardown: context => context.request('select', {uid: null}),
};

export const selectAll = {
  id: 'selection.select-all', area: 'selection', title: 'Select all and deselect', kind: 'operation',
  description: 'Presses Ctrl+A on the stage to select every figure, then clicks empty stage to select none: each to the frame that shows it.',
  judge: {metric: 'duration', limits: LIMITS.response},
  metrics: {'select.none': {title: 'Click empty stage to deselect', unit: 'ms', better: 'lower', digits: 0}},
  async setup(context) {
    const {start} = await emptyCorners(context);
    if (!start) throw new Error('No empty place on the stage to click.');
    const figures = await context.evaluate(() => globalThis.styk.editor.geometry.objects.size);
    // A click there gives the stage the keyboard and selects nothing.
    await context.input.click(start.x, start.y);
    return {empty: start, figures};
  },
  async run(context, {empty, figures}) {
    const all = await respond(context, () => context.input.key('A', {ctrl: true}), count => globalThis.styk.editor.selectedUids?.size === count, {argument: figures, what: `the selection of all ${figures} figures`});
    const none = await respond(context, () => context.input.click(empty.x, empty.y), () => globalThis.styk.editor.selectedUids?.size === 0, {what: 'the empty selection'});
    return {metrics: {duration: all, 'select.none': none}};
  },
};

export default [click, marquee, moveMany, selectAll];
