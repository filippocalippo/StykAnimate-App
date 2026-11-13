/**
 * Projects: several open at once, as tabs in the top band (docs/PROJECT-TABS.md). One project is live; the others
 * rest, holding their document and history but no renderer state, playback workers or thumbnails. Bringing one to the
 * front reloads those from its document, as after opening a file; that is what a person waits for at each switch.
 *
 * Every scenario here works through the band with real clicks (the tab, its New button, a middle click to close), which
 * the desktop and the browser share. The measured stretch ends when the project in front has its frame drawn
 * (`document.mark` and `document.wait` of the control channel: another document is on show, nothing is importing, the
 * stage presented it).
 */
import {copyFileSync} from 'node:fs';
import {scratchFolder} from '../lib/files.mjs';
import {LIMITS} from '../lib/metrics.mjs';
import {file} from '../workloads.mjs';
import {closeFrontUntil} from './export.mjs';

const tab = id => `#project-tabs .project-tab[data-project="${id}"]`;
const front = context => context.evaluate(() => globalThis.styk.projects.tabs.activeId);

/** Runs `act` (a click), then waits until another document is in front and drawn. Returns the wait in ms, from just before `act`. */
async function untilShown(context, act) {
  const {token} = await context.request('document.mark');
  await act();
  return (await context.request('document.wait', {token, timeoutMs: 120000})).ms;
}

/**
 * Opens a second project beside the one in front: a copy of the workload's file under another name, so that the two
 * are separate projects of the same size. Returns its id.
 */
async function openSecond(context, files) {
  const copy = files.file('second.json');
  copyFileSync(file(context.workload).path, copy);
  await context.app.open(copy);
  await context.app.quiet();
  return front(context);
}

export const newProject = {
  id: 'project.new', area: 'projects', title: 'Start a new project', kind: 'operation',
  description: 'The band\'s New button: the project in front goes to rest (its session detached, its stage state dropped) and a new animation opens in a tab of its own, drawn.',
  judge: {metric: 'duration', limits: LIMITS.response},
  setup: async context => ({first: await front(context)}),
  async run(context, {first}) {
    const ms = await untilShown(context, () => context.press('#project-tabs [data-action="new"]'));
    // The app's untouched starting animation gives its place to the new one instead of resting beside it.
    if (!context.workload.builtin && await front(context) === first) throw new Error('No new project came to the front.');
    return {metrics: {duration: ms}};
  },
  // The new project, untouched, closes without a question; the first comes back.
  reset: (context, {first}) => closeFrontUntil(context, first),
};

export const closeProject = {
  id: 'project.close', area: 'projects', title: 'Close a project', kind: 'operation',
  description: 'A middle click on the tab of an untouched new project in front: its session is discarded and the project used before it, the workload, comes back to the front and is drawn.',
  judge: {metric: 'duration', limits: LIMITS.response},
  when: context => (context.workload.builtin ? 'the starting animation, untouched, gives its place to the next project: there is no second one to go back to' : undefined),
  async setup(context) {
    const first = await front(context);
    await untilShown(context, () => context.press('#project-tabs [data-action="new"]'));
    return {first, closing: await front(context)};
  },
  async run(context, state) {
    const ms = await untilShown(context, () => context.press(tab(state.closing), {button: 'middle'}));
    const [now, open] = await context.evaluate(id => [globalThis.styk.projects.tabs.activeId, Boolean(globalThis.styk.projects.tabs.get(id))], state.closing);
    if (open || now !== state.first) throw new Error(open ? 'The project did not close.' : 'Another project than the one used before came to the front.');
    return {metrics: {duration: ms}};
  },
  async reset(context, state) {
    await untilShown(context, () => context.press('#project-tabs [data-action="new"]'));
    state.closing = await front(context);
  },
  teardown: (context, {first}) => closeFrontUntil(context, first),
};

export const openSecondProject = {
  id: 'project.open-second', area: 'projects', title: 'Open a second project', kind: 'operation',
  description: 'Opens a copy of the workload\'s file while the workload is open: the project in front goes to rest and the file opens in a tab beside it. Two documents of this size are then held at once.',
  judge: {metric: 'duration', limits: [1000, 3000, 10000]},
  when: context => (context.workload.builtin ? 'the new project has no file to open a copy of' : undefined),
  setup: async context => ({first: await front(context), files: scratchFolder('projects')}),
  async run(context, {files}) {
    const copy = files.file('second.json');
    copyFileSync(file(context.workload).path, copy);
    const opened = await context.app.open(copy);
    return {metrics: {duration: opened.ms}};
  },
  reset: (context, {first}) => closeFrontUntil(context, first),
  teardown: (context, {files}) => files.remove(),
};

export const switchProject = {
  id: 'project.switch', area: 'projects', title: 'Switch between two projects', kind: 'operation',
  description: 'A click on the other project\'s tab, two projects of the workload\'s size open: the one in front goes to rest, the other comes forward and its playback workers, thumbnails and stage are made again from its document.',
  judge: {metric: 'duration', limits: LIMITS.response},
  when: context => (context.workload.builtin ? 'the starting animation, untouched, gives its place to the next project: there is no second one to go back to' : undefined),
  async setup(context) {
    const files = scratchFolder('switch'), first = await front(context);
    const second = await openSecond(context, files);
    if (second === first) throw new Error('The second project did not open in a tab of its own.');
    return {files, first, second};
  },
  // Each pass goes to the other project: the two are the same size, so every pass measures the same switch.
  async run(context, {first, second}) {
    const target = await front(context) === first ? second : first;
    const ms = await untilShown(context, () => context.press(tab(target)));
    if (await front(context) !== target) throw new Error('The clicked project did not come to the front.');
    return {metrics: {duration: ms}};
  },
  async teardown(context, {files, first, second}) {
    await context.evaluate(async ({first, second}) => { const {projects} = globalThis.styk; await projects.close(second); if (projects.tabs.activeId !== first) await projects.activate(first); }, {first, second});
    await context.app.quiet();
    await context.settle();
    files.remove();
  },
};

export default [newProject, closeProject, openSecondProject, switchProject];
