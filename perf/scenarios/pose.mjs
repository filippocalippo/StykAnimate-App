/**
 * Posing: the edits an animator makes all day, a joint dragged and a figure moved.
 */
import {LIMITS} from '../lib/metrics.mjs';
import {respond} from '../lib/response.mjs';

/** Finds a handle of the figure with the most joints, selects that figure and returns where to press (window pixels). */
async function handle(context, kind) {
  const first = await context.request('target.handle', {kind});
  await context.request('select', {uid: first.uid});
  const target = await context.request('target.handle', {kind});
  if (!target.onStage) throw new Error('Something covers the stage where the handle is: the drag cannot start.');
  return target;
}

/** A drag of 1.5 s that ends away from where it began, then the release. The edit must have reached the engine. */
async function drag(context, target) {
  const before = (await context.state()).document.revision;
  await context.input.stroke(context.paths.sweep(target, 70, 45), {durationMs: 1500});
  await context.settle();
  if ((await context.state()).document.revision === before) throw new Error('The press did not start a drag: the document did not change.');
}

export const dragJoint = {
  id: 'pose.drag-joint', area: 'posing', title: 'Drag a joint', kind: 'gesture',
  description: 'Selects the figure with the most joints and drags one joint for 1.5 s. Each move is an edit the engine applies and the stage redraws.',
  setup: context => handle(context, 'pose'),
  run: drag,
  reset: context => context.request('undo'),
};

export const moveFigure = {
  id: 'pose.move-figure', area: 'posing', title: 'Move a figure', kind: 'gesture',
  description: 'Drags a whole figure by its origin for 1.5 s. The geometry stays; only the figure\'s place changes until the release commits it.',
  setup: context => handle(context, 'move'),
  run: drag,
  reset: context => context.request('undo'),
};

/** Whether the stage shows a document other than the one at revision `before` (runs in the page). */
const revised = before => { const {editor, state} = globalThis.styk; return editor.revision !== before && state.lastEditingPresentation?.revision === editor.revision; };

export const undo = {
  id: 'history.undo', area: 'posing', title: 'Undo and redo an edit', kind: 'operation',
  description: 'Undoes a joint drag with Ctrl+Z and redoes it with Ctrl+Shift+Z: each key press to the frame that shows the document as it was. One command of the engine\'s history, then the stage and the interface repaint.',
  judge: {metric: 'duration', limits: LIMITS.response},
  metrics: {'history.redo': {title: 'Redo', unit: 'ms', better: 'lower', digits: 0}},
  async setup(context) {
    const target = await handle(context, 'pose');
    await drag(context, target);
    return target;
  },
  async run(context) {
    const revision = async () => (await context.state()).document.revision;
    const undone = await respond(context, () => context.input.key('Z', {ctrl: true}), revised, {argument: await revision(), what: 'the undo'});
    const redone = await respond(context, () => context.input.key('Z', {ctrl: true, shift: true}), revised, {argument: await revision(), what: 'the redo'});
    return {metrics: {duration: undone, 'history.redo': redone}};
  },
  teardown: context => context.request('undo'),
};

export default [dragJoint, moveFigure, undo];
