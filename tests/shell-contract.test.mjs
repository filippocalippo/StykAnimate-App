/**
 * Editor shell contract. index.html is static markup that src/ modules query at
 * load time without null checks, and that about 300 local browser tests drive.
 * Browser tests do not run in CI, so this unit test is the CI guard for the
 * markup: restyle and restructure freely, but keep every hook listed here.
 *
 * Remove or rename a hook only in the commit that changes its last reader, and
 * update this list in that commit. Comments name the readers of each group.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {actionKeys, parseHtml, readActionSources} from './helpers/source-scan.mjs';

export const SHELL_CONTRACT = Object.freeze({
  // Static ids. Each must appear exactly once in index.html.
  ids: {
    // app.mjs (resize, worldPoint, pointer input, placeArtboard), builder-mode,
    // sprite-placement-dialog, tweener-controls. #scene is replaced by id on GPU recovery.
    canvas: ['viewport', 'scene', 'overlay', 'artboard'],
    // app.mjs; tests call setInputFiles on #file-input.
    inputs: ['file-input', 'media-input'],
    // app.mjs dialogs, menus and toasts; builder-mode, rig-test-ui, movieclip-ui and
    // studio-shell (insert dialog). The two titles are aria-labelledby targets.
    hosts: ['dialog', 'dialog-content', 'menu', 'toast', 'insert-dialog', 'insert-title',
      'insert-movieclip-title', 'asset-list', 'sample-list', 'close-insert'],
    // app.mjs, studio-shell, property-controls, drawing-controller, user-library,
    // vfx-inspector, layer-timeline, builder-mode (#builder-outliner).
    panels: ['inspector', 'inspector-context', 'object-actions', 'vfx-panel', 'timeline',
      'animation-timeline', 'builder-outliner'],
    // The open projects (src/shell/project-tabs-view.mjs renders the tabs into its .project-tabs-list;
    // app.mjs anchors Ctrl+Tab's board to it).
    projects: ['project-tabs'],
    // Home (src/home/home.mjs builds its page into #home, the workspace's last child; docs/HOME.md).
    home: ['home'],
    // The dock host (src/shell/dock-host.mjs): the Properties panel's root, the
    // Library's empty host (user-library fills it) and the tabs tests click
    // (#library-tab, #properties-tab, [data-vfx-tab]); it places them in islands it makes.
    shell: ['properties-panel', 'user-library', 'properties-tab', 'vfx-tab', 'library-tab'],
    // app.mjs, layer-timeline, audio-timeline, studio-shell and
    // localization-bindings (#fps, #timeline-zoom, #play-button, #loop-button).
    transport: ['play-button', 'loop-button', 'time-display', 'fps', 'timeline-zoom', 'range-edit',
      'onion-button', 'onion-settings-button', 'timeline-audio', 'expand-timeline',
      'timeline-workflow', 'timeline-summary', 'selection-summary'],
    // Controllers constructed with these elements in app.mjs (the stage header's view cluster and the Grid
    // split's settings chevron, CanvasGuides' trigger); studio-shell (#open-insert); localization-bindings
    // (#zoom-label); the crumb's background chip (the colour picker's resolver in app.mjs).
    canvasView: ['zoom-label', 'handles-button', 'paths-button', 'canvas-guides-button', 'guides-options-button',
      'vfx-preview', 'tweener-button', 'open-insert', 'crumb-background'],
    // The band's Done in Build (studio-shell binds its data-workspace-mode). Build's part commands left the second
    // toolbar row for Properties, the menus and the stage header (revision 5): see builderCommands.
    builder: ['builder-done'],
    // app.mjs; builder-construction (#chain-*); studio-shell and tweener-controls (#viewport-hint).
    stage: ['viewport-hint', 'canvas-empty', 'renderer-error', 'playback-fps', 'preview-quality',
      'preview-badge', 'chain-controls', 'chain-count', 'chain-finish', 'chain-cancel',
      'polygon-controls', 'polygon-count', 'finish-polygon'],
    // app.mjs and localization-bindings (#window-controls); base/document.css hides #app
    // while the theme is pending.
    status: ['app', 'stage-size', 'status', 'status-dot',
      'renderer-label', 'render-time', 'object-count', 'window-controls'],
    // Reader-bound: read only by studio-shell.mjs (no null checks) and app.mjs.
    // They may be removed together with that reader.
    readerBound: ['leave-rig', 'tool-context', 'edit-scope', 'frame-badge'],
  },
  // data-action values in index.html. Each is a key of the actions map in
  // app.mjs, and the same names are hotkey ids (hotkeys.mjs), native menu
  // commands (desktop/main.cjs), statistics' command counts (src/stats/session.mjs),
  // localization menu keys and hotkey hints. Never rename one.
  actions: {
    // The band: New beside the tabs, its history, Save and Export, and a session's Cancel, Test rig and Done
    // (camera-done, movieclip-*). Rename is a tab's double-click and File › Rename project.
    titlebar: ['menu', 'home', 'new', 'undo', 'redo', 'save', 'export', 'movieclip-cancel', 'rig-test', 'movieclip-done',
      'camera-done', 'minimize', 'maximize', 'close'],
    // The stage header: the crumb, the view cluster (Build's Handles, Highlight, Isolate and construction
    // background too), zoom and Fit, and the polygon's own controls. The rail holds tools only.
    canvas: ['scene-settings', 'toggle-handles', 'toggle-motion-paths', 'toggle-grid', 'zoom-menu', 'zoom-reset',
      'finish-polygon', 'cancel-polygon', 'builder-static-handles', 'builder-highlight', 'builder-canvas-color'],
    transport: ['first-frame', 'previous-frame', 'play', 'next-frame', 'toggle-loop',
      'toggle-range-edit', 'toggle-onion'],
    insert: ['add-figure', 'add-text', 'import-sprite', 'import', 'movieclip-new', 'movieclip-create',
      'movieclip-range'],
    status: ['performance'],
    // src/shell/shell-commands.mjs: the band's Properties button (compact width) and Timeline… (a folded timeline).
    shell: ['panel-toggle-properties', 'timeline-sheet'],
  },
  // Shift-click routes to data-shift-action (app.mjs click delegation). None is static any more: Build's
  // shift commands ride on its quick tiles (Delete part, Shift: Delete branch).
  shiftActions: [],
  // Build's part commands: Properties' quick tiles and ⋯ menu, the right-click menu and the stage header's tool
  // options render them (revision 5 removed the second toolbar row). Each stays an actions entry in app.mjs.
  builderCommands: ['split-segment', 'duplicate-segment', 'mirror-segment', 'mirror-segment-vertical',
    'copy-builder-appearance', 'paste-builder-appearance', 'rig-connect', 'rig-examples',
    'unsplit-segment', 'origin-segment', 'segment-values', 'add-sprite-segment', 'edit-text',
    'delete-single-segment', 'delete-segment', 'segment-order-front', 'segment-order-up',
    'segment-order-down', 'segment-order-back', 'toggle-builder-branch', 'toggle-isolate', 'duplicate-branch', 'mirror-branch', 'mirror-branch-vertical'],
  // app.mjs setTool, studio-shell (.tool-dock [data-tool]), builder-mode, drawing-view, hotkey-hints.
  tools: ['select', 'rig', 'tweener', 'line', 'chain', 'circle', 'polygon', 'hand', 'drawing-brush',
    'drawing-eraser', 'drawing-fill', 'drawing-lasso', 'drawing-shape', 'drawing-transform'],
  // studio-shell binds every [data-workspace-mode] once at startup, including #builder-done.
  workspaceModes: ['animate', 'draw', 'rig'],
  // app.mjs queries [data-app-menu] once at module evaluation.
  appMenus: ['file', 'edit', 'view', 'editor', 'animation', 'help'],
  // studio-shell listens for [data-timeline-mode] clicks on #timeline-workflow.
  timelineModes: ['simple', 'advanced'],
  // Static accessible names that tests query with getByRole.
  accessibleNames: ['Onion skin settings', 'Audio', 'Timeline zoom', 'Undo', 'Redo', 'Play'],
  // Changing the policy is a security review, never a side effect of a redesign.
  csp: "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; media-src 'self' blob: data:; object-src 'none'",
});

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
// app.mjs owns the actions map and passes it to modules that register more.
const actionSources = readActionSources();

const {root, all} = parseHtml(html);
const byId = new Map();
for (const element of all) if ('id' in element.attrs) byId.set(element.attrs.id, [...(byId.get(element.attrs.id) || []), element]);
const values = name => all.filter(element => name in element.attrs).map(element => element.attrs[name]);
const classes = element => (element.attrs.class || '').split(/\s+/).filter(Boolean);
// Supports `#id`, `.class` and `[name="value"]`, which is all this contract needs.
const matches = (element, selector) => {
  if (selector.startsWith('#')) return element.attrs.id === selector.slice(1);
  if (selector.startsWith('.')) return classes(element).includes(selector.slice(1));
  const [, name, value] = /^\[([\w-]+)="([^"]*)"\]$/.exec(selector);
  return element.attrs[name] === value;
};
const find = (selector, scope = root) => {
  const found = [];
  const walk = node => { for (const child of node.children) { if (matches(child, selector)) found.push(child); walk(child); } };
  walk(scope);
  return found;
};
const one = (selector, scope) => {
  const found = find(selector, scope);
  assert.equal(found.length, 1, `${selector} appears exactly once${scope ? ' in its container' : ''}`);
  return found[0];
};
const flat = groups => Object.values(groups).flat();

test('Every shell id appears exactly once and ids stay unique', () => {
  const ids = flat(SHELL_CONTRACT.ids);
  assert.equal(new Set(ids).size, ids.length, 'contract ids are listed once');
  for (const id of ids) assert.equal(byId.get(id)?.length, 1, `#${id} appears exactly once in index.html`);
  for (const [id, elements] of byId) assert.equal(elements.length, 1, `#${id} is unique`);
});

test('Every data-action in the shell is a registered action and none disappeared', () => {
  const keys = actionKeys(actionSources);
  assert.ok(keys.size > 100, `actions map was scanned (${keys.size} keys)`);
  const present = new Set(values('data-action'));
  for (const action of flat(SHELL_CONTRACT.actions)) assert.ok(present.has(action), `[data-action="${action}"] is still in index.html`);
  for (const action of present) assert.ok(keys.has(action), `[data-action="${action}"] has an actions entry in app.mjs`);
  for (const action of new Set(values('data-shift-action'))) assert.ok(keys.has(action), `[data-shift-action="${action}"] has an actions entry in app.mjs`);
  for (const action of SHELL_CONTRACT.builderCommands) assert.ok(keys.has(action), `Build's "${action}" keeps its actions entry in app.mjs`);
});

test('Tool, mode, menu and timeline values are unchanged', () => {
  const same = (name, expected) => assert.deepEqual([...new Set(values(name))].sort(), [...expected].sort(), `${name} values`);
  same('data-shift-action', SHELL_CONTRACT.shiftActions);
  same('data-workspace-mode', SHELL_CONTRACT.workspaceModes);
  same('data-app-menu', SHELL_CONTRACT.appMenus);
  same('data-timeline-mode', SHELL_CONTRACT.timelineModes);
  const dock = one('.tool-dock');
  for (const tool of SHELL_CONTRACT.tools) assert.equal(find(`[data-tool="${tool}"]`, dock).length, 1, `.tool-dock has [data-tool="${tool}"]`);
  assert.deepEqual([...new Set(values('data-tool'))].sort(), [...SHELL_CONTRACT.tools].sort());
  assert.equal(one('#builder-done').attrs['data-workspace-mode'], 'animate');
  const workflow = one('#timeline-workflow');
  for (const mode of SHELL_CONTRACT.timelineModes) assert.equal(find(`[data-timeline-mode="${mode}"]`, workflow).length, 1, `#timeline-workflow has ${mode}`);
});

test('Structural hooks that modules dereference without null checks are intact', () => {
  const viewport = one('#viewport');
  for (const id of ['scene', 'overlay']) {
    assert.equal(byId.get(id)[0].parent, viewport, `#${id} is a direct child of #viewport`);
    assert.equal(byId.get(id)[0].tag, 'canvas', `#${id} is a canvas`);
  }
  // The band (experience.md §2): three clusters, where (the mark with its menu, the open projects as tabs), the
  // workspace switch, and the actions. The menubar stays in the markup as the source of the mark's menus
  // (app.mjs reads its [data-app-menu] buttons) and never shows. localization-bindings binds
  // `.titlebar [data-action=save|export]` and the window controls; tests click `.titlebar [data-action=export]`,
  // so the band keeps one Export (quiet in a session) and one Save. topbar.mjs shows a session's buttons
  // ([data-band-session]) and hides the rest.
  const titlebar = one('.titlebar');
  const clusters = titlebar.children.map(child => classes(child).find(name => /^band-(start|center|end)$/.test(name)));
  assert.deepEqual(clusters, ['band-start', 'band-center', 'band-end'], 'the band is three clusters');
  const [start, center, end] = titlebar.children;
  for (const selector of ['[data-action="menu"]', '.app-menubar', '#project-tabs']) one(selector, start);
  // The tabs' list is an empty tablist the view fills; New sits beside it, inside the strip.
  const tabs = one('#project-tabs', start), list = one('.project-tabs-list', tabs);
  assert.equal(list.attrs.role, 'tablist');
  assert.equal(list.children.length, 0, 'the tab list is empty in the markup');
  assert.equal(one('[data-action="new"]', tabs).parent, tabs, 'New is the strip\'s own button');
  assert.ok('data-band-reserve' in tabs.attrs, 'the band measures the strip by its reserve, not by its tabs');
  one('.workspace-switch', center);
  for (const mode of SHELL_CONTRACT.workspaceModes) one(`[data-workspace-mode="${mode}"]`, one('.workspace-switch'));
  for (const action of ['save', 'export']) assert.equal(find(`[data-action="${action}"]`, titlebar).length, 1, `one .titlebar [data-action="${action}"]`);
  const history = one('[aria-label="Edit history"]', end);
  assert.equal(history.attrs.role, 'toolbar', 'Undo and Redo are the band Edit history toolbar');
  for (const action of ['undo', 'redo']) one(`[data-action="${action}"]`, history);
  for (const [selector, session] of [['[data-action="movieclip-cancel"]', 'movieclip'], ['[data-action="rig-test"]', 'build'],
    ['[data-action="movieclip-done"]', 'movieclip'], ['[data-action="camera-done"]', 'camera'], ['#builder-done', 'build']]) {
    const button = one(selector, end);
    assert.equal(button.attrs['data-band-session'], session, `${selector} shows in the ${session} session`);
    assert.ok('hidden' in button.attrs, `${selector} is hidden at rest`);
  }
  const controls = one('#window-controls', titlebar);
  for (const action of ['minimize', 'maximize', 'close']) one(`[data-action="${action}"]`, controls);
  assert.ok(classes(one('[data-action="menu"]')).includes('brand'), '.brand[data-action="menu"] anchors the main menu');
  // studio-shell, builder-mode and the dock host read .workspace; app.mjs mounts the
  // movieclip breadcrumb before .context-strip (movieclip-ui's mountBreadcrumb seam). The dock host places the
  // stage island (.center, around #viewport) in the workspace grid's one area, the rail on it, and every group
  // (the timeline island among them) by its rectangle; panels it has not placed wait in .shell-parking.
  const workspace = one('.workspace');
  for (const selector of ['.center', '.studio-rail', '.context-strip']) one(selector, workspace);
  for (const selector of ['.studio-rail', '.center', '.timeline-panel', '.shell-parking'])
    assert.equal(one(selector, workspace).parent, workspace, `${selector} is a direct child of .workspace`);
  assert.ok('hidden' in one('.shell-parking').attrs, 'the parking is hidden');
  one('#viewport', one('.center'));
  // The stage header (§3.12, stage-head.mjs): the stage island's first row, above #viewport and never inside
  // it (only the hidden context strip sits between them), with the start (crumb, or
  // the tool's options), message and end (view cluster, zoom) slots. Nothing interactive is left in #viewport.
  const stageHead = one('.stage-head', one('.center'));
  const stageChildren = one('.center').children;
  assert.equal(stageChildren[0], stageHead, ".stage-head is the stage island's first row");
  assert.deepEqual(stageChildren.slice(stageChildren.indexOf(stageHead) + 1, stageChildren.indexOf(byId.get('viewport')[0])).map(child => child.attrs.id ?? classes(child)[0]),
    ['context-strip'], 'only the context strip sits between the stage header and #viewport');
  assert.equal(stageHead.attrs.role, 'toolbar');
  assert.ok(!('hidden' in stageHead.attrs), 'the stage header shows');
  for (const [name, className] of [['stage-start', 'stage-head-start'], ['stage-message', 'stage-head-msg'], ['stage-end', 'stage-head-end']])
    assert.equal(one(`[data-slot="${name}"]`, stageHead).parent, stageHead, `.stage-head has its ${className} slot`);
  const stageStart = one('[data-slot="stage-start"]', stageHead), stageEnd = one('[data-slot="stage-end"]', stageHead);
  one('[data-action="scene-settings"]', one('.ui-crumb', stageStart));
  for (const id of ['#stage-size', '#crumb-background', '#chain-controls', '#polygon-controls']) one(id, stageStart);
  for (const id of ['#handles-button', '#paths-button', '#canvas-guides-button', '#guides-options-button', '#vfx-preview']) one(id, one('[data-view=""]', stageEnd));
  for (const selector of ['#zoom-label', '[data-action="zoom-reset"]']) one(selector, one('[data-zoom=""]', stageEnd));
  const buttons = node => node.children.reduce((count, child) => count + (child.tag === 'button') + buttons(child), 0);
  assert.equal(buttons(byId.get('viewport')[0]), 0, 'no button inside #viewport');
  for (const selector of ['.stage-head', '.canvas-view-controls', '.canvas-toolbar', '.drawing-quickbar', '.polygon-controls'])
    assert.equal(find(selector, byId.get('viewport')[0]).length, 0, `no ${selector} inside #viewport`);
  assert.equal(find('#viewport', one('.timeline-panel')).length, 0, 'the timeline is its own island, outside the stage');
  one('#builder-outliner', one('.shell-parking'));
  const panel = one('.timeline-panel', workspace);
  assert.equal(panel.attrs.id, 'animation-timeline');
  for (const selector of ['.timeline-toolbar', '.timeline-title', '#timeline']) one(selector, panel);
  // timeline-host.mjs hides $("timeline-zoom").closest(".timeline-actions").
  one('#timeline-zoom', one('.timeline-actions', panel));
  // The timeline header's static slots (§3.14; timeline-header.mjs renders into them in M5): the three
  // clusters, start, transport and end, and the ruler's tools, each holding today's controls.
  const toolbar = one('.timeline-toolbar', panel);
  const slot = name => {
    const element = one(`[data-slot="${name}"]`, toolbar);
    assert.equal(element.parent, toolbar, `[data-slot="${name}"] is a direct child of .timeline-toolbar`);
    return element;
  };
  one('#timeline-workflow', slot('start'));
  for (const id of ['#play-button', '#loop-button', '#time-display', '#fps']) one(id, slot('transport'));
  for (const id of ['#range-edit', '#onion-button', '#onion-settings-button', '#timeline-audio']) one(id, slot('end'));
  for (const id of ['#expand-timeline', '#timeline-zoom']) one(id, slot('ruler-tools'));
  const parking = one('.shell-parking');
  for (const selector of ['.inspector-header', '#inspector', '#vfx-panel', '#user-library']) one(selector, parking);
  // Static tabs (the dock host moves them into its islands' tab lists), each naming the panel it shows; the Library host is empty.
  const tablist = one('#properties-tab').parent;
  assert.equal(tablist, parking);
  for (const [tab, target] of [['properties-tab', 'properties-panel'], ['vfx-tab', 'vfx-panel'], ['library-tab', 'user-library']]) {
    const element = one(`#${tab}`, tablist);
    assert.equal(element.attrs.role, 'tab');
    assert.equal(element.attrs['aria-controls'], target, `#${tab} controls #${target}`);
    assert.equal(one(`#${target}`).attrs.role, 'tabpanel');
  }
  assert.equal(one('#vfx-tab').attrs['data-vfx-tab'], 'vfx');
  assert.equal(one('#user-library').children.length, 0, '#user-library is an empty host the Library fills');
  for (const selector of ['.inspector-header', '#inspector']) one(selector, one('#properties-panel'));
  // The inspector's header block (M4, inspector-header.mjs): the target (name and its one menu) and,
  // between it and the sections, the host of the scope line and the quick actions row, empty until
  // the kit renders into it (inspector-kit.mjs renderInspectorHead, syncQuickHost).
  const target = one('[data-slot="inspector-target"]', one('#properties-panel'));
  assert.ok(classes(target).includes('inspector-header'));
  for (const id of ['#inspector-context', '#object-actions']) one(id, target);
  const head = one('[data-slot="inspector-head"]', one('#properties-panel'));
  assert.equal(head.children.length, 0, 'the inspector head host is empty in the markup');
  const panelChildren = one('#properties-panel').children;
  assert.ok(panelChildren.indexOf(target) < panelChildren.indexOf(head) && panelChildren.indexOf(head) < panelChildren.indexOf(byId.get('inspector')[0]),
    'the head host sits between the target and #inspector');
  one('[data-action="panel-toggle-properties"]', one('.titlebar'));
  one('[data-action="timeline-sheet"]', one('.timeline-toolbar'));
  // The rail (src/shell/rail.mjs): the + (#open-insert) and every tool in .tool-dock; the tools with variants and the +
  // declare the list their corner tick opens. Isolate is no rail tool (Caps Lock, the selection and Build menus).
  const dock = one('.tool-dock');
  one('#open-insert', dock);
  for (const [selector, menu] of [['#open-insert', 'add'], ['[data-tool="drawing-lasso"]', 'lasso'], ['[data-tool="drawing-shape"]', 'shape']])
    assert.equal(one(selector, dock).attrs['data-rail-menu'], menu, `${selector} lists ${menu}`);
  assert.equal(find('[data-action="toggle-isolate"]', dock).length, 0);
  // The floating tool bar holds tools only.
  assert.equal(find('.rail-order').length, 0, 'no stacking buttons in the tool bar');
  // The canvas toolbar and the floating view pill are gone: the stage header holds their controls.
  for (const selector of ['.canvas-toolbar', '.canvas-view-controls']) assert.equal(find(selector).length, 0, `no ${selector}`);
  // Modals are native dialogs: hotkeys and startup prompts key off dialog[open].
  for (const id of ['dialog', 'insert-dialog']) assert.equal(byId.get(id)[0].tag, 'dialog', `#${id} is a <dialog>`);
  assert.equal(byId.get('dialog-content')[0].parent, byId.get('dialog')[0]);
  const menu = byId.get('menu')[0], toast = byId.get('toast')[0];
  assert.ok(menu.attrs.role === 'menu' && 'hidden' in menu.attrs, '#menu is a hidden role=menu host');
  assert.ok(toast.attrs.role === 'status' && 'hidden' in toast.attrs, '#toast is a hidden status host');
  for (const id of ['file-input', 'media-input']) assert.equal(byId.get(id)[0].attrs.type, 'file');
  assert.equal(byId.get('fps')[0].attrs.type, 'number');
  assert.equal(byId.get('timeline-zoom')[0].attrs.type, 'range');
});

test('The static accessible names that tests query still exist', () => {
  const labels = new Set(values('aria-label'));
  for (const name of SHELL_CONTRACT.accessibleNames) assert.ok(labels.has(name), `aria-label="${name}"`);
});

test('The content security policy is unchanged and the markup needs no inline code', () => {
  const csp = all.filter(element => element.tag === 'meta' && element.attrs['http-equiv']?.toLowerCase() === 'content-security-policy');
  assert.equal(csp.length, 1);
  assert.equal(csp[0].attrs.content, SHELL_CONTRACT.csp);
  assert.equal(all.filter(element => element.tag === 'style').length, 0, 'no <style> element');
  for (const script of all.filter(element => element.tag === 'script')) {
    assert.ok(script.attrs.src, 'scripts are external');
    assert.equal(script.text.trim(), '', 'no inline script body');
  }
  for (const element of all)
    for (const name of Object.keys(element.attrs)) assert.ok(!/^on/.test(name), `<${element.tag} ${name}> has no inline handler`);
  for (const element of all.filter(element => 'style' in element.attrs))
    assert.match(element.attrs.style, /^(\s*--[\w-]+\s*:[^;]*;?)*\s*$/, 'inline styles hold only custom properties');
});

test('index.html links one layered stylesheet whose imports all resolve', () => {
  const links = all.filter(element => element.tag === 'link' && element.attrs.rel === 'stylesheet').map(element => element.attrs.href);
  assert.deepEqual(links, ['./src/styles/app.css'], 'src/styles/app.css imports every other sheet');
  // A sheet imported without layer() would be unlayered and beat every layer.
  for (const sheet of ['src/styles/app.css', 'src/styles/support-bridge.css']) {
    const base = new URL(`../${sheet}`, import.meta.url);
    const css = readFileSync(base, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const imports = [...css.matchAll(/@import\s+url\("([^"]+)"\)\s*([^;]*);/g)];
    assert.ok(imports.length > 0 && imports.length === (css.match(/@import/g) ?? []).length, `${sheet}: every @import uses url("…")`);
    for (const [, href, layer] of imports) {
      assert.ok(existsSync(new URL(href, base)), `${sheet} imports ${href}, which exists`);
      if (sheet.endsWith('support-bridge.css') || href.startsWith('./legacy/')) assert.equal(layer.trim(), 'layer(legacy)', `${href} loads into the legacy layer`);
    }
    if (sheet.endsWith('app.css'))
      assert.match(css.trimStart(), /^@layer legacy, reset, tokens, base, layout, components, features, states, utilities;/, 'the layer order is declared before any import');
  }
});

test('Every local stylesheet, script and image resolves inside the served web root', () => {
  // desktop/web-host.cjs serves src/, vendor/ and assets/, plus root .html/.css/.svg/.png/.ico files.
  const references = all.flatMap(element => ['href', 'src'].filter(name => element.attrs[name]).map(name => element.attrs[name]))
    .filter(reference => !/^[a-z]+:/i.test(reference) && !reference.startsWith('#'));
  assert.ok(references.length > 3);
  for (const reference of references) {
    const relative = reference.replace(/^\.\//, '');
    const parts = relative.split('/');
    assert.ok(parts.length === 1 ? /\.(html|css|svg|png|ico)$/i.test(relative) : ['src', 'vendor', 'assets'].includes(parts[0]),
      `${reference} is inside a served location`);
    assert.ok(existsSync(new URL(`../${relative}`, import.meta.url)), `${reference} exists`);
  }
});
