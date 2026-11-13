/**
 * The interface around the stage: the inspector, the workspaces, the dock's panels, tabs and dividers, the window's
 * size, onion skins, the main menu and the command palette (docs/DOCKING.md, docs/hotkeys.md).
 *
 * Menus are aimed at by their items' message keys (`data-i18n`), never by their text, so a scenario works in every
 * language. A scenario that rearranges the dock checks that the arrangement is byte-equal to the one it found.
 */
import {LIMITS} from '../lib/metrics.mjs';
import {respond} from '../lib/response.mjs';
import {dragJoint} from './pose.mjs';

/** The dock's arrangement as stored (`window.styk.workspace.layout`), as text to compare. */
const arrangement = context => context.evaluate(() => JSON.stringify(globalThis.styk.workspace.layout));

/** Throws unless the dock is arranged as `before`: what a scenario changed in the layout, it must have put back. */
async function sameArrangement(context, before, what) {
  if (await arrangement(context) !== before) throw new Error(`${what} did not put the panels back as they were.`);
}

/** The middle of the visible menu item whose label has the message key `key` (an open menu's `[data-i18n]`). */
async function menuItem(context, key) {
  const found = await context.evaluate(wanted => {
    for (const label of document.querySelectorAll('[role^="menuitem"] [data-i18n]')) {
      const item = label.closest('[role^="menuitem"]'), box = item.getBoundingClientRect();
      if (label.dataset.i18n === wanted && box.width > 0) return {x: box.left + box.width / 2, y: box.top + box.height / 2};
    }
    return null;
  }, key);
  if (!found) throw new Error(`The open menu has no item ${key}.`);
  return found;
}

/** Opens the menu of the element matching `selector` with a right click, and returns the middle of its item `key`. */
async function contextMenu(context, selector, key) {
  const {centre} = await context.rect(selector);
  await context.input.click(centre.x, centre.y, {button: 'right'});
  await context.until(wanted => [...document.querySelectorAll('[role^="menuitem"] [data-i18n]')].some(label => label.dataset.i18n === wanted && label.getBoundingClientRect().width > 0),
    {argument: key, what: `the menu of ${selector}`});
  return menuItem(context, key);
}

/** The stage's width in window pixels (runs in the page). */
const stageWidth = () => document.getElementById('viewport').getBoundingClientRect().width;

export const inspectorDrag = {
  id: 'interface.inspector-drag', area: 'interface', title: 'Drag a value in the inspector', kind: 'gesture',
  description: 'With a figure selected, drags the inspector\'s Angle label sideways for 1.5 s (the property controls\' drag adjustment). '
    + 'Each move previews the figure\'s new angle through the engine and the stage redraws; the release commits one edit.',
  async setup(context) {
    const {uid} = await context.request('target.handle', {kind: 'move'});
    await context.request('select', {uid});
    const {centre} = await context.rect('#inspector [data-property-scrub][data-i18n="inspectorView.angle"]');
    return centre;
  },
  async run(context, label) {
    const before = (await context.state()).document.revision;
    await context.input.stroke(t => ({x: label.x + Math.sin(t * Math.PI * 1.5) * 120, y: label.y}), {durationMs: 1500});
    await context.settle();
    if ((await context.state()).document.revision === before) throw new Error('The drag on the Angle label did not change the figure.');
  },
  reset: context => context.request('undo'),
  teardown: context => context.request('select', {uid: null}),
};

/** Whether the workspace `mode` is on and its button pressed (runs in the page). */
const inWorkspace = mode => globalThis.styk.shell.mode === mode && Boolean(document.querySelector(`[data-workspace-mode="${mode}"][aria-pressed="true"]`));

export const workspace = {
  id: 'interface.workspace', area: 'interface', title: 'Switch workspace', kind: 'operation',
  description: 'Clicks Draw in the top band, then Animate, then Build, then Animate: each click to the frame that shows the workspace, its panels laid out and the stage resized.',
  judge: {metric: 'duration', limits: LIMITS.response},
  metrics: {
    'workspace.animate': {title: 'Draw back to Animate', unit: 'ms', better: 'lower', digits: 0},
    'workspace.build': {title: 'Animate to Build', unit: 'ms', better: 'lower', digits: 0},
    'workspace.fromBuild': {title: 'Build back to Animate', unit: 'ms', better: 'lower', digits: 0},
  },
  async setup(context) {
    if (!await context.evaluate(inWorkspace, 'animate')) throw new Error('The app is not in the Animate workspace.');
    return {layout: await arrangement(context)};
  },
  async run(context) {
    const {revision} = (await context.state()).document, took = [];
    for (const mode of ['draw', 'animate', 'rig', 'animate']) {
      took.push(await respond(context, () => context.press(`[data-workspace-mode="${mode}"]`), inWorkspace, {argument: mode, what: `the ${mode} workspace`}));
    }
    if ((await context.state()).document.revision !== revision) throw new Error('Switching workspaces changed the document.');
    return {metrics: {duration: took[0], 'workspace.animate': took[1], 'workspace.build': took[2], 'workspace.fromBuild': took[3]}};
  },
  reset: (context, {layout}) => sameArrangement(context, layout, 'Switching workspaces'),
};

export const panelFold = {
  id: 'interface.panel-fold', area: 'interface', title: 'Fold a panel to a strip and back', kind: 'operation',
  description: 'Folds the Properties panel\'s group to a strip of icons (Collapse in its tab\'s menu), then opens it again (Expand in its strip icon\'s menu): '
    + 'each click to the frame that shows the panels laid out again and the stage resized.',
  judge: {metric: 'duration', limits: LIMITS.response},
  metrics: {'panel.expand': {title: 'Expand the panel again', unit: 'ms', better: 'lower', digits: 0}},
  setup: async context => ({layout: await arrangement(context), width: await context.evaluate(stageWidth)}),
  async run(context, {layout, width}) {
    const collapse = await contextMenu(context, '#properties-tab', 'dockTabs.collapse');
    const folded = await respond(context, () => context.input.click(collapse.x, collapse.y), before => document.getElementById('viewport').getBoundingClientRect().width > before + 100, {argument: width, what: 'the folded panel'});
    const expand = await contextMenu(context, '.shell-strip-button[data-panel="properties"]', 'dockTabs.expand');
    const expanded = await respond(context, () => context.input.click(expand.x, expand.y), stored => JSON.stringify(globalThis.styk.workspace.layout) === stored && Boolean(document.querySelector('#properties-tab')?.getBoundingClientRect().width),
      {argument: layout, what: 'the panel expanded as it was'});
    return {metrics: {duration: folded, 'panel.expand': expanded}};
  },
  reset: (context, {layout}) => sameArrangement(context, layout, 'Folding a panel and expanding it'),
};

export const panelClose = {
  id: 'interface.panel-close', area: 'interface', title: 'Close a panel and bring it back', kind: 'operation',
  description: 'Closes the Properties panel (Close in its tab\'s menu), then brings it back with Ctrl+1: each to the frame that shows it. The next tab of its group takes its place while it is closed.',
  judge: {metric: 'duration', limits: LIMITS.response},
  metrics: {'panel.reopen': {title: 'Bring it back (Ctrl+1)', unit: 'ms', better: 'lower', digits: 0}},
  // Ctrl+1 to Ctrl+4 are the desktop app's: a browser keeps them for its own tabs (docs/hotkeys.md).
  when: context => (context.app.kind !== 'desktop' ? 'Ctrl+1 brings a panel back only in the desktop app' : undefined),
  setup: async context => ({layout: await arrangement(context)}),
  async run(context, {layout}) {
    const close = await contextMenu(context, '#properties-tab', 'dockTabs.close');
    const closed = await respond(context, () => context.input.click(close.x, close.y), () => globalThis.styk.workspace.layout.closed.some(panel => panel.id === 'properties') && !document.querySelector('#properties-tab')?.getBoundingClientRect().width,
      {what: 'the closed panel'});
    const reopened = await respond(context, () => context.input.key('1', {ctrl: true}), stored => JSON.stringify(globalThis.styk.workspace.layout) === stored && Boolean(document.querySelector('#properties-tab')?.getBoundingClientRect().width),
      {argument: layout, what: 'the panel back where it was'});
    return {metrics: {duration: closed, 'panel.reopen': reopened}};
  },
  reset: (context, {layout}) => sameArrangement(context, layout, 'Closing a panel and bringing it back'),
};

export const focusMode = {
  id: 'interface.focus-mode', area: 'interface', title: 'Focus mode on and off', kind: 'operation',
  description: 'Presses Ctrl+\\ to fold every panel and give the stage the window, then again to restore them: each press to the frame that shows the panels laid out and the stage resized.',
  judge: {metric: 'duration', limits: LIMITS.response},
  metrics: {'focus.restore': {title: 'Restore the panels', unit: 'ms', better: 'lower', digits: 0}},
  async setup(context) {
    await context.evaluate(() => document.getElementById('viewport').focus());
    return {layout: await arrangement(context), width: await context.evaluate(stageWidth)};
  },
  async run(context, {layout, width}) {
    const on = await respond(context, () => context.input.key('Backslash', {ctrl: true}), before => globalThis.styk.workspace.focusMode === true && document.getElementById('viewport').getBoundingClientRect().width > before + 100,
      {argument: width, what: 'Focus mode'});
    const off = await respond(context, () => context.input.key('Backslash', {ctrl: true}), stored => globalThis.styk.workspace.focusMode === false && JSON.stringify(globalThis.styk.workspace.layout) === stored,
      {argument: layout, what: 'the panels restored'});
    return {metrics: {duration: on, 'focus.restore': off}};
  },
  reset: (context, {layout}) => sameArrangement(context, layout, 'Focus mode'),
};

/** Whether the panel `panel`'s tab is the selected one of its group and the panel is on show (runs in the page). */
const tabShown = panel => document.querySelector(`[role="tab"][data-panel="${panel}"]`)?.getAttribute('aria-selected') === 'true' && JSON.stringify(globalThis.styk.workspace.layout).includes(`"active":"${panel}"`);

export const dockTab = {
  id: 'interface.dock-tab', area: 'interface', title: 'Switch a panel tab', kind: 'operation',
  description: 'Clicks the VFX tab beside Properties, then the Properties tab again: each click to the frame that shows the panel\'s contents.',
  judge: {metric: 'duration', limits: LIMITS.response},
  metrics: {'tab.back': {title: 'Back to Properties', unit: 'ms', better: 'lower', digits: 0}},
  async setup(context) {
    await context.rect('#vfx-tab');
    if (!await context.evaluate(tabShown, 'properties')) throw new Error('Properties is not the panel on show in its group.');
    return {layout: await arrangement(context)};
  },
  async run(context) {
    const away = await respond(context, () => context.press('#vfx-tab'), tabShown, {argument: 'vfx', what: 'the VFX panel'});
    const back = await respond(context, () => context.press('#properties-tab'), tabShown, {argument: 'properties', what: 'the Properties panel'});
    return {metrics: {duration: away, 'tab.back': back}};
  },
  reset: (context, {layout}) => sameArrangement(context, layout, 'Switching tabs'),
};

/** The Properties group's divider beside the stage (its name is the message key of its label). */
const DIVIDER = '.shell-splitter[data-i18n-aria-label="dockHost.resizePropertiesPanel"]';

export const dockResize = {
  id: 'interface.dock-resize', area: 'interface', title: 'Resize a panel by its divider', kind: 'gesture',
  description: 'Drags the divider between the stage and the Properties panel 160 pixels toward the stage and back over 1.5 s: '
    + 'the dock is solved again each frame and the stage and its canvas resize with the pointer. A double click on the divider then restores the default width.',
  async setup(context) {
    const {centre} = await context.rect(DIVIDER);
    return {divider: centre, layout: await arrangement(context), width: await context.evaluate(stageWidth)};
  },
  async run(context, {divider, width}) {
    // Out, held, then back: the stage's width is read at the turn, so a drag that never took hold fails.
    await context.input.stroke(t => ({x: divider.x - Math.sin(t * Math.PI / 2) * 160, y: divider.y}), {durationMs: 750, release: false});
    const narrowed = await context.evaluate(stageWidth);
    await context.input.stroke(t => ({x: divider.x - Math.cos(t * Math.PI / 2) * 160, y: divider.y}), {durationMs: 750, button: null});
    await context.input.up('left');
    if (!(narrowed < width - 100)) throw new Error(`The divider did not move: the stage stayed ${Math.round(narrowed)} pixels wide.`);
  },
  async reset(context, {divider, layout}) {
    await context.input.click(divider.x, divider.y, {count: 2});
    await context.until(stored => JSON.stringify(globalThis.styk.workspace.layout) === stored, {argument: layout, what: 'the double click to restore the panel\'s default width'});
  },
};

/** Steps of the window's size over the gesture: twelve a second, as a window edge dragged by hand reports. */
const RESIZE_STEPS = 18, RESIZE_MS = 1500;

export const windowResize = {
  id: 'interface.window-resize', area: 'interface', title: 'Resize the window', kind: 'gesture',
  description: 'Makes the page 30% narrower and 15% shorter and back over 1.5 s in 18 steps, as dragging the window\'s corner does: '
    + 'each step lays the dock out again and resizes the stage, its canvas and the timeline. The page is resized through the inspector protocol\'s screen emulation, '
    + 'because the desktop app\'s protocol cannot resize its window.',
  // The browser host already fixes the page's size by the same emulation (perf/lib/app.mjs).
  when: context => (context.app.kind !== 'desktop' ? 'the browser host fixes the page\'s size' : undefined),
  async setup(context) {
    const send = (method, params = {}) => context.app.inspector.send(method, params, context.app.page);
    const base = await context.evaluate(() => ({width: innerWidth, height: innerHeight}));
    // The emulation's size is not always in CSS pixels (Electron scales it by the display's factor): measure its unit once.
    await send('Emulation.setDeviceMetricsOverride', {width: base.width, height: base.height, deviceScaleFactor: 0, mobile: false});
    const seen = await context.evaluate(() => innerWidth);
    await send('Emulation.clearDeviceMetricsOverride');
    return {base, unit: base.width / seen, layout: await arrangement(context)};
  },
  async run(context, {base, unit}) {
    const send = (method, params = {}) => context.app.inspector.send(method, params, context.app.page);
    const before = await context.evaluate(stageWidth), started = Date.now();
    let narrowest = before;
    try {
      for (let step = 1; step <= RESIZE_STEPS; step++) {
        const wait = started + step * RESIZE_MS / RESIZE_STEPS - Date.now();
        if (wait > 0) await context.sleep(wait);
        const shrink = Math.sin(step / RESIZE_STEPS * Math.PI);
        await send('Emulation.setDeviceMetricsOverride', {width: Math.round(base.width * (1 - .3 * shrink) * unit), height: Math.round(base.height * (1 - .15 * shrink) * unit), deviceScaleFactor: 0, mobile: false});
        if (step === RESIZE_STEPS / 2) narrowest = await context.evaluate(stageWidth);
      }
    } finally { await send('Emulation.clearDeviceMetricsOverride'); }
    if (!(narrowest < before - 100)) throw new Error(`The page did not get narrower: the stage stayed ${Math.round(narrowest)} pixels wide.`);
  },
  reset: (context, {layout}) => sameArrangement(context, layout, 'Resizing the window'),
  teardown: context => context.app.inspector.send('Emulation.clearDeviceMetricsOverride', {}, context.app.page),
};

/** Whether onion skins are `on` (runs in the page). */
const onionShown = on => globalThis.styk.state.onion === on;

/** Seeks to 40% of the animation, so onion skins have poses on both sides. */
async function middle(context) {
  const {totalTicks} = (await context.state()).document;
  await context.request('seek', {tick: Math.floor(totalTicks * .4)});
}

export const onionToggle = {
  id: 'interface.onion-toggle', area: 'interface', title: 'Turn onion skins off and on', kind: 'operation',
  description: 'In the middle of the animation, presses O on the stage to turn onion skins off, then on again: each press to the frame that shows the stage with or without the neighbouring poses.',
  judge: {metric: 'duration', limits: LIMITS.response},
  metrics: {'onion.off': {title: 'Turn them off', unit: 'ms', better: 'lower', digits: 0}},
  when: async context => ((await context.state()).document.totalTicks < 4 ? 'the document is too short to have onion skins' : undefined),
  async setup(context) {
    await middle(context);
    await context.evaluate(() => document.getElementById('viewport').focus());
    return {was: await context.evaluate(() => globalThis.styk.state.onion)};
  },
  async run(context, {was}) {
    // From the state the app was in, both ways; `duration` is always turning them on.
    const first = await respond(context, () => context.input.key('O'), onionShown, {argument: !was, what: `onion skins ${was ? 'off' : 'on'}`});
    const second = await respond(context, () => context.input.key('O'), onionShown, {argument: was, what: `onion skins ${was ? 'on' : 'off'}`});
    return {metrics: was ? {'onion.off': first, duration: second} : {duration: first, 'onion.off': second}};
  },
  reset: (context, {was}) => context.until(on => globalThis.styk.state.onion === on, {argument: was, what: 'onion skins as they were'}),
};

export const onionDrag = {
  id: 'interface.onion-drag', area: 'interface', title: 'Drag a joint with onion skins on', kind: 'gesture',
  description: 'Turns onion skins on (O) if they are off, then drags a joint in the middle of the animation as pose.drag-joint does: '
    + 'each move redraws the figure and the neighbouring poses around it. A new profile has onion skins on; pose.drag-joint runs on the first frame, where there are fewer.',
  when: onionToggle.when,
  async setup(context) {
    await middle(context);
    await context.evaluate(() => document.getElementById('viewport').focus());
    const was = await context.evaluate(() => globalThis.styk.state.onion);
    if (!was) {
      await context.input.key('O');
      await context.until(onionShown, {argument: true, what: 'O to turn onion skins on'});
    }
    return {was, target: await dragJoint.setup(context)};
  },
  run: (context, {target}) => dragJoint.run(context, target),
  reset: context => context.request('undo'),
  async teardown(context, {was}) {
    if (was) return;
    await context.evaluate(() => document.getElementById('viewport').focus());
    await context.input.key('O');
    await context.until(onionShown, {argument: false, what: 'O to turn onion skins off'});
  },
};

/** Whether the main menu is open with its items laid out (runs in the page). */
const mainMenuShown = () => Boolean(document.querySelector('#menu.ui-menu:popover-open [role^="menuitem"]')?.getBoundingClientRect().width);

export const menu = {
  id: 'interface.menu', area: 'interface', title: 'Open the main menu', kind: 'operation',
  description: 'Clicks the StykAnimate menu in the top band: the click to the frame that shows the menu. Escape closes it after each pass.',
  judge: {metric: 'duration', limits: LIMITS.response},
  run: async context => ({metrics: {duration: await respond(context, () => context.press('.brand.shell-mark'), mainMenuShown, {what: 'the main menu'})}}),
  async reset(context) {
    await context.input.key('Escape');
    await context.until(() => !document.querySelector('#menu.ui-menu:popover-open'), {what: 'Escape to close the main menu'});
  },
};

/** Whether the command palette is open and lists commands; with a query, that its input holds it and the list shows `command` (runs in the page). */
const paletteShown = ({query, command}) => {
  const palette = document.querySelector('dialog.ui-palette[open]');
  if (!palette || !palette.querySelector('[role="option"]')) return false;
  return !query || (palette.querySelector('input')?.value === query && Boolean(palette.querySelector(`[role="option"][data-command="${command}"]`)));
};

export const palette = {
  id: 'interface.palette', area: 'interface', title: 'Open the command palette and search', kind: 'operation',
  description: 'Presses Ctrl+P on the stage to open the command palette, then types "onion": the key press to the palette listing commands, and the typing to the list narrowed to Onion skin. Escape closes it.',
  judge: {metric: 'duration', limits: LIMITS.response},
  metrics: {'palette.search': {title: 'Type a search to its results', unit: 'ms', better: 'lower', digits: 0}},
  setup: context => context.evaluate(() => { document.getElementById('viewport').focus(); }),
  async run(context) {
    const opened = await respond(context, () => context.input.key('P', {ctrl: true}), paletteShown, {argument: {}, what: 'the command palette'});
    const typed = await respond(context, async () => { for (const letter of 'onion') await context.input.key(letter); }, paletteShown, {argument: {query: 'onion', command: 'toggle-onion'}, what: 'the search for onion'});
    return {metrics: {duration: opened, 'palette.search': typed}};
  },
  async reset(context) {
    await context.input.key('Escape');
    await context.until(() => !document.querySelector('dialog.ui-palette[open]'), {what: 'Escape to close the command palette'});
    await context.evaluate(() => { document.getElementById('viewport').focus(); });
  },
};

export default [inspectorDrag, workspace, panelFold, panelClose, focusMode, dockTab, dockResize, windowResize, onionToggle, onionDrag, menu, palette];
