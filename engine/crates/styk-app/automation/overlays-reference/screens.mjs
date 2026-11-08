// The references for the overlay screens (docs/native/screens/limits.toml, `menu-*`, `select-open`, `tooltip`, `toasts`, `dialog`,
// `parts`): today's menus, tooltip, messages, dialog and panel parts, drawn by today's stylesheets and today's own modules in
// Playwright's bundled Chromium (LCD text on, opaque surfaces), the way engine/crates/xtask/fonts-chromium.mjs captures.
//
//   node engine/crates/styk-app/automation/overlays-reference/screens.mjs [--scale 2] [--out dir] [--only menu-root,dialog-dark]
//
// By default it writes docs/native/screens/overlays/<id>.png at device scale 1 (what the screen guard compares); `--scale 2 --out
// artifacts/native-screens/overlays-reference-2` writes the 200 % references the checks of the chunk compare by hand.
//
// Menus are opened by today's `openMenu` (src/ui/ui-menu.mjs) with the same rows the native scene opens, so the placement, the
// rows, the submenu's hover intent and the focus rules are today's own. The pointer in these pages is Playwright's, inside the
// headless page: the hover that opens a submenu and the fill under the pointer are real browser events. Today's native
// <select> list is an operating-system popup the page cannot capture, so the select's reference is today's menu stylesheet
// anchored under today's select field: the list the native select now draws. Messages are today's `.ui-toast` markup as
// `render()` in src/ui/ui-toast.mjs writes it; the dialog is today's `createDialog` opened with `showModal()`.
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {mkdir, readFile} from 'node:fs/promises';
import {extname, join, normalize, resolve} from 'node:path';

const root = resolve(import.meta.dirname, '../../../../..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1]; };
const scale = Number(option('--scale', '1'));
const out = resolve(root, option('--out', 'docs/native/screens/overlays'));
const only = option('--only', '').split(',').filter(Boolean);

export const SCENES = {
  'menu-root': [360, 540], 'menu-submenu': [560, 300], 'menu-context': [420, 300], 'select-open': [320, 220],
  tooltip: [320, 140], toasts: [520, 430], dialog: [520, 400], parts: [938, 1270],
};

const MIME = {'.css': 'text/css', '.mjs': 'text/javascript', '.js': 'text/javascript', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.html': 'text/html'};
const esc = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const FORCE = {hover: ['hover'], pressed: ['hover', 'active'], focus: ['focus', 'focus-visible', 'focus-within'], 'focus-within': ['focus-within']};

function shell(theme, [width, height]) {
  return `<!doctype html><html lang="en" data-theme="${theme}"><head><meta charset="utf-8"><link rel="stylesheet" href="/src/styles/app.css"><style>
    html, body { margin: 0; background: var(--surface); }
    body { position: relative; width: ${width}px; height: ${height}px; overflow: hidden; color: var(--text-1); font: var(--type-ui); }
    .t { position: absolute; left: 24px; top: 24px; }
    /* Animations stand still at their first frame and transitions are over: a loop at time zero, a popover already shown. */
    *, *::before, *::after { animation-play-state: paused !important; transition: none !important; }
  </style></head><body><div id="page"></div></body></html>`;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const match = /^\/scene\/([a-z-]+)\/(light|dark)$/.exec(url.pathname);
  if (match) { response.writeHead(200, {'content-type': 'text/html'}); response.end(shell(match[2], SCENES[match[1]])); return; }
  const file = normalize(join(root, decodeURIComponent(url.pathname)));
  if (!file.startsWith(root)) { response.writeHead(403); response.end(); return; }
  try { const data = await readFile(file); response.writeHead(200, {'content-type': MIME[extname(file)] ?? 'application/octet-stream'}); response.end(data); }
  catch { response.writeHead(404); response.end(); }
}).listen(0);
await new Promise(resolvePromise => server.once('listening', resolvePromise));
const base = `http://127.0.0.1:${server.address().port}`;

// ---- the rows of each menu: the same as engine/crates/styk-ui/src/overlay_sheet.rs, with the shortcut text the registry gives.
const APP_MENU = [
  {label: 'Edit'},
  {command: 'undo', label: 'Undo', icon: 'undo', shortcut: 'Ctrl+Z'},
  {command: 'redo', label: 'Redo', icon: 'redo', shortcut: 'Ctrl+Shift+Z'},
  '-',
  {command: 'copy', label: 'Copy', icon: 'duplicate', shortcut: 'Ctrl+C', disabled: true, reason: 'Select a figure first'},
  {command: 'paste', label: 'Paste', icon: 'clipboard', shortcut: 'Ctrl+V'},
  {command: 'duplicate', label: 'Duplicate', icon: 'dup', shortcut: 'Ctrl+D'},
  '-',
  {label: 'View'},
  {command: 'toggle-grid', label: 'Grid', checked: true, keepOpen: true, shortcut: "Ctrl+'"},
  {command: 'zoom-100', label: 'Zoom 100%', radio: true, checked: true, group: 'zoom', keepOpen: true, shortcut: false},
  {command: 'zoom-200', label: 'Zoom 200%', radio: true, checked: false, group: 'zoom', keepOpen: true, shortcut: false},
  '-',
  {label: 'More', icon: 'more', submenu: [{command: 'select-all', label: 'Select all'}]},
  '-',
  {command: 'delete', label: 'Delete', icon: 'trash', danger: true, shortcut: 'Delete'},
];
const SUBMENU_ROOT = [
  {command: 'undo', label: 'Undo', icon: 'undo', shortcut: 'Ctrl+Z'},
  {command: 'redo', label: 'Redo', icon: 'redo', shortcut: 'Ctrl+Shift+Z'},
  '-',
  {label: 'Transform', icon: 'move', submenu: [
    {command: 'mirror', label: 'Flip horizontal', shortcut: 'Shift+H'},
    {command: 'mirror-vertical', label: 'Flip vertical', shortcut: 'Shift+V'},
    '-',
    {command: 'rotate', label: 'Rotate 90°', shortcut: false},
  ]},
  {label: 'Export as', icon: 'export', submenu: [{command: 'save', label: 'Video', shortcut: 'Ctrl+S'}]},
];
const CONTEXT_MENU = [
  {command: 'copy', label: 'Copy', icon: 'duplicate', shortcut: 'Ctrl+C'},
  {command: 'paste', label: 'Paste', icon: 'clipboard', shortcut: 'Ctrl+V'},
  {command: 'duplicate', label: 'Duplicate', icon: 'dup', shortcut: 'Ctrl+D'},
  '-',
  {command: 'delete', label: 'Delete', icon: 'trash', danger: true, shortcut: 'Delete'},
];
const SELECT_OPTIONS = [
  {command: 'linear', label: 'Linear', shortcut: false}, {command: 'hold', label: 'Hold', shortcut: false},
  {command: 'ease-in', label: 'Ease in', shortcut: false}, {command: 'bounce', label: 'Bounce', shortcut: false, disabled: true},
];

/** Runs in the page: opens a menu with today's `openMenu`. */
async function openMenu(page, {items, anchor, point, focus = 'first', pointer = false}) {
  await page.evaluate(async ({items, anchor, point, focus, pointer}) => {
    const {openMenu} = await import('/src/ui/ui-menu.mjs');
    const {icon} = await import('/src/icons.mjs');
    // A menu a pointer opened focuses its row without the ring (ui-menu.mjs `quiet`): the overlay manager says who opened it.
    const overlays = pointer ? {register: () => null, openedByPointer: () => true} : undefined;
    openMenu({items, anchor: anchor ? document.querySelector(anchor) : undefined, point, icon: name => icon(name, 'ui-icon'), focus, overlays});
  }, {items, anchor, point, focus, pointer});
  await page.waitForTimeout(450);
}

async function rowCenter(page, selector, nth = 0) {
  return page.evaluate(({selector, nth}) => {
    const rect = document.querySelectorAll(selector)[nth].getBoundingClientRect();
    return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
  }, {selector, nth});
}

async function forcePseudo(page, context, selectorStates) {
  const session = await context.newCDPSession(page);
  await session.send('DOM.enable'); await session.send('CSS.enable');
  const {root: documentNode} = await session.send('DOM.getDocument', {depth: 0});
  for (const [selector, state] of selectorStates) {
    const {nodeIds} = await session.send('DOM.querySelectorAll', {nodeId: documentNode.nodeId, selector});
    for (const nodeId of nodeIds) await session.send('CSS.forcePseudoState', {nodeId, forcedPseudoClasses: FORCE[state]});
  }
}


const scenes = {
  async 'menu-root'(page) {
    await page.evaluate(async () => { const {icon} = await import('/src/icons.mjs'); document.querySelector('#page').innerHTML = `<button type="button" id="trigger" class="ui-icon-button t" aria-label="More">${icon('more', '')}</button>`; });
    await page.keyboard.press('Shift');
    await openMenu(page, {items: APP_MENU, anchor: '#trigger'});
  },
  async 'menu-submenu'(page) {
    await page.evaluate(async () => { const {icon} = await import('/src/icons.mjs'); document.querySelector('#page').innerHTML = `<button type="button" id="trigger" class="ui-icon-button t" aria-label="More">${icon('more', '')}</button>`; });
    // The person pressed the menu button with the pointer: Chromium remembers the last focus came from the mouse.
    await page.click('#trigger');
    await openMenu(page, {items: SUBMENU_ROOT, anchor: '#trigger', pointer: true});
    const row = await rowCenter(page, '.ui-menu-item', 2);
    await page.mouse.move(row.x - 30, row.y - 10);
    await page.mouse.move(row.x, row.y);
    await page.waitForTimeout(700);
  },
  async 'menu-context'(page) {
    await page.evaluate(() => { document.querySelector('#page').innerHTML = '<div id="surface" tabindex="0" style="position:absolute;left:0;top:0;width:100%;height:100%;outline:none"></div>'; });
    await page.mouse.click(380, 280);
    await openMenu(page, {items: CONTEXT_MENU, point: {x: 150, y: 90}, pointer: true});
    const row = await rowCenter(page, '.ui-menu-item', 2);
    await page.mouse.move(row.x - 20, row.y - 10);
    await page.mouse.move(row.x, row.y);
    await page.waitForTimeout(300);
  },
  async 'select-open'(page, context) {
    await page.evaluate(async () => {
      const {icon} = await import('/src/icons.mjs');
      document.querySelector('#page').innerHTML = `<label class="ui-field t" id="field" data-select style="width:200px"><span class="ui-field-label">Easing</span><select class="ui-field-input"><option>Linear</option><option selected>Hold</option><option>Ease in</option><option disabled>Bounce</option></select>${icon('chevron-down', 'ui-icon ui-field-chev')}</label>`;
    });
    await page.click('#field');
    await openMenu(page, {items: SELECT_OPTIONS, anchor: '#field', focus: 1, pointer: true});
    const row = await rowCenter(page, '.ui-menu-item', 1);
    await page.mouse.move(row.x - 20, row.y - 10);
    await page.mouse.move(row.x, row.y);
    await page.waitForTimeout(300);
  },
  async tooltip(page, context) {
    await page.evaluate(async () => {
      const {icon} = await import('/src/icons.mjs');
      const {placeFloating} = await import('/src/ui/anchor-position.mjs');
      document.querySelector('#page').innerHTML = `<button type="button" id="b" class="ui-icon-button" aria-label="Undo" style="position:absolute;left:144px;top:70px">${icon('undo', '')}</button>
        <div class="ui-tooltip" id="ui-tooltip" popover="manual"><span class="ui-tooltip-label">Undo</span><span class="ui-tooltip-sep">·</span><span class="ui-tooltip-key">Ctrl+Z</span></div>`;
      const tip = document.querySelector('#ui-tooltip');
      tip.showPopover();
      placeFloating(tip, document.querySelector('#b'), {placement: 'top', offset: 6, fit: false, overlap: false, topInset: 0, sheet: false});
    });
    await forcePseudo(page, context, [['#b', 'hover']]);
    await page.waitForTimeout(400);
  },
  async toasts(page) {
    await page.evaluate(async () => {
      const {icon} = await import('/src/icons.mjs');
      const toast = ({tone, variant, icon: glyph, title, text, progress, action, close}) => `<div class="ui-toast"${tone ? ` data-tone="${tone}"` : ''}${variant ? ` data-variant="${variant}"` : ''}>${glyph ? icon(glyph, 'ui-icon ui-toast-icon') : ''}<span class="ui-toast-text">${title ? `<b>${title}</b> ` : ''}${text}</span>${progress ? '<div class="ui-toast-progress" role="progressbar" data-indeterminate></div>' : ''}${action ? `<button type="button" class="ui-button ui-toast-action" data-variant="ghost" data-size="sm">${action}</button>` : ''}${close ? `<button type="button" class="ui-icon-button ui-toast-close" data-size="sm" aria-label="Dismiss">${icon('close', 'ui-icon')}</button>` : ''}</div>`;
      document.querySelector('#page').innerHTML = `<div style="display:flex;flex-direction:column;gap:12px;padding:24px">${[
        toast({tone: 'success', icon: 'check', title: 'Saved', text: 'Rooftop fight'}),
        toast({tone: 'warning', icon: 'warning', title: 'Deleted', text: '3 figures', action: 'Undo'}),
        toast({tone: 'danger', icon: 'alert', title: 'Couldn’t save', text: 'The disk is full.', close: true}),
        toast({variant: 'task', text: 'Exporting video…', progress: true}),
        toast({variant: 'mode', text: 'Click a joint to pick it'}),
        toast({tone: 'warning', variant: 'quiet', icon: 'warning', text: 'Slow · 14 of 24 fps'}),
      ].map(html => `<div style="display:flex">${html}</div>`).join('')}</div>`;
    });
    await page.waitForTimeout(300);
  },
  async dialog(page) {
    await page.evaluate(async () => {
      const {icon} = await import('/src/icons.mjs');
      const {createDialog} = await import('/src/ui/ui-dialog.mjs');
      document.querySelector('#page').innerHTML = `<div style="position:absolute;left:32px;top:32px"><div style="font:var(--type-title)">Rooftop fight</div><div style="margin-top:4px;font:var(--type-body);color:var(--text-2)">24 fps, 3 s, 960 × 540</div></div>`;
      const body = document.createElement('div');
      body.style.cssText = 'display:grid;gap:8px';
      body.innerHTML = `<label class="ui-field" data-select><span class="ui-field-label">Format</span><select class="ui-field-input"><option>MP4 video</option><option>GIF</option></select>${icon('chevron-down', 'ui-icon ui-field-chev')}</label>
        <label class="ui-field" data-switch-field><span class="ui-field-label">Include audio</span><input type="checkbox" class="ui-switch" role="switch" checked></label>`;
      const dialog = createDialog({size: 'sm', title: 'Export', description: 'Choose how to save this animation.', body, actions: [{label: 'Cancel', cancel: true, variant: 'ghost'}, {label: 'Export', value: 'export', variant: 'primary'}], icon: name => icon(name, 'ui-icon'), pointer: true, mount: document.body});
      dialog.setMeta('24 fps · 3 s');
      dialog.showModal();
    });
    await page.waitForTimeout(500);
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.waitForTimeout(300);
  },
  async parts(page, context) {
    await page.evaluate(async () => {
      const {icon} = await import('/src/icons.mjs');
      const g = (name, cls = 'ui-icon') => icon(name, cls);
      const cells = (...items) => items.map(item => `<div class="cell">${item}</div>`).join('');
      const row = (label, content, height = 52) => `<div class="row" style="height:${height}px"><div class="lab">${label}</div>${content}</div>`;
      const head = text => `<h2 class="head">${text}</h2>`;
      const listRow = (selected, hidden, level, force) => `<div class="ui-list-row" ${force ? 'data-force="hover"' : ''} tabindex="0"${selected ? ' aria-selected="true"' : ''}${hidden ? ' data-hidden="true"' : ''}${level ? ` style="--level:${level}"` : ''}><span class="ui-list-row-lead">${g('layers')}</span><span class="ui-list-row-label">Bubble</span><span class="ui-list-row-meta">1</span><div class="ui-list-row-actions"></div></div>`;
      const stepper = state => `<div class="ui-stepper" ${state === 'focus' ? 'data-force="focus-within"' : ''}><button type="button" class="ui-icon-button" data-size="xs" aria-label="Fewer"${state === 'off' ? ' disabled' : ''}>${g('minus', '')}</button><input class="ui-stepper-input" type="text" value="3"${state === 'off' ? ' disabled' : ''}><button type="button" class="ui-icon-button" data-size="xs" aria-label="More"${state === 'off' ? ' disabled' : ''}>${g('plus', '')}</button></div>`;
      const split = (force, pressed, expanded) => `<div class="ui-split" role="group" ${force ? 'data-force="hover"' : ''}><button type="button" class="ui-icon-button" ${pressed ? 'aria-pressed="true"' : 'aria-pressed="false"'} aria-label="Grid">${g('grid', '')}</button><button type="button" class="ui-split-more"${expanded ? ' aria-expanded="true"' : ''} aria-label="Grid options">${g('chevron-down', '')}</button></div>`;
      const dots = (...items) => `<span style="display:flex;gap:8px;align-items:center">${items.join('')}</span>`;
      const dot = attrs => `<span class="ui-dot" ${attrs}></span>`;
      const sections = [
        head('Small parts'),
        row('Keycaps', cells('<span class="ui-shortcut"><kbd class="ui-kbd">Ctrl</kbd><kbd class="ui-kbd">Shift</kbd><kbd class="ui-kbd">Z</kbd></span>', '<kbd class="ui-kbd">Esc</kbd>')),
        row('Dots', cells(dots(dot('data-tone="neutral"'), dot('data-tone="success"'), dot('data-tone="warning"'), dot('data-tone="danger"')), dots(dot('data-tint="select"'), dot('data-tint="library"'), dot('data-tint="draw"'), dot('data-tone="danger" data-hollow')))),
        row('Divider', cells('<div style="width:132px;height:1px;background:var(--line-1)"></div>')),
        row('Crumb', `<div class="cell" style="width:${148 * 3}px;gap:40px"><nav class="ui-crumb"><button type="button" class="ui-crumb-item"><span>Scene 1</span></button><span class="ui-crumb-sep">›</span><span class="ui-crumb-here"><span>Punch</span></span></nav><nav class="ui-crumb"><button type="button" class="ui-crumb-item" data-force="hover">${g('layers')}<span>Scene</span><span class="ui-crumb-meta">960 × 540</span></button><button type="button" class="ui-crumb-swatch" aria-label="Background"><span class="ui-crumb-chip" style="--swatch:#ffffff"></span></button></nav></div>`),
        head('Lists and sections'),
        row('List row', cells(listRow(false, false, 0, false), listRow(false, false, 0, true), listRow(true, false, 0, false), listRow(false, true, 1, false)).replaceAll('class="cell"', 'class="cell" style="width:148px"')),
        row('Section head', cells(`<div class="ui-section-head" style="width:132px;margin:0"><span class="ui-section-badge" data-tint="fx">${g('layers')}</span><h3 class="ui-section-title">Looks</h3></div>`,
          `<div class="ui-section" data-collapsible style="width:132px;padding:0"><div class="ui-section-head"><button type="button" class="ui-section-toggle" aria-expanded="false" style="margin:0"><span class="ui-section-title">Camera</span>${g('chevron-right', 'ui-icon ui-section-chev')}</button></div></div>`,
          `<div class="ui-section" data-collapsible data-open style="width:132px;padding:0"><div class="ui-section-head"><button type="button" class="ui-section-toggle" aria-expanded="true" style="margin:0"><span class="ui-section-title">Camera</span>${g('chevron-right', 'ui-icon ui-section-chev')}</button></div></div>`)),
        row('Island', cells('<div class="ui-island" style="width:132px;height:88px"><div class="ui-island-head"><div class="ui-island-title">Library</div></div></div>'), 108),
        head('Switches and steppers'),
        row('Tabs', cells('<div class="ui-tabs" role="tablist"><button type="button" class="ui-tab" role="tab" aria-selected="true">Props</button><button type="button" class="ui-tab" role="tab" aria-selected="false">Effects</button></div>', '<div class="ui-tabs" role="tablist" data-variant="rule"><button type="button" class="ui-tab" role="tab" aria-selected="true">Props</button><button type="button" class="ui-tab" role="tab" aria-selected="false">Effects</button></div>')),
        row('Stepper', cells(stepper('rest'), stepper('focus'), stepper('off'))),
        row('Split button', cells(split(false, false, false), split(true, false, false), split(false, true, false), split(false, false, true))),
        head('Progress'),
        row('Bar', cells('<div class="ui-progress" style="--_p:40%;width:132px"></div>', '<div class="ui-progress" data-indeterminate style="width:132px"></div>', '<div class="ui-progress" data-tone="danger" style="--_p:70%;width:132px"></div>')),
        row('Spinner', cells('<span class="ui-spinner" style="color:var(--text-2)"></span>')),
        row('Empty state', `<div class="cell" style="width:${148 * 4}px;align-items:flex-start"><div class="ui-empty" style="width:100%">${g('layers', 'ui-icon ui-empty-glyph')}<h3 class="ui-empty-title">No effects</h3><p class="ui-empty-text">Add one from the list below.</p><div class="ui-empty-actions"><button type="button" class="ui-button" data-variant="outline">Add effect</button></div></div></div>`, 200),
      ];
      const style = document.createElement('style');
      style.textContent = `#table { box-sizing: border-box; width: 938px; padding: 24px; }
        .head { box-sizing: border-box; margin: 0; height: 36px; display: flex; align-items: flex-end; padding-block-end: 4px; font: var(--type-emphasis); color: var(--text-1); }
        .row { display: flex; }
        .lab { flex: none; width: 150px; display: flex; align-items: center; font: var(--type-small); color: var(--text-3); }
        .ui-section-head { margin-block-end: 0 !important; }
        .cell { flex: none; width: 148px; box-sizing: border-box; padding-inline-start: 8px; display: flex; align-items: center; }`;
      document.head.append(style);
      document.querySelector('#page').innerHTML = `<div id="table">${sections.join('')}</div>`;
    });
    await forcePseudo(page, context, [['[data-force="hover"]', 'hover'], ['[data-force="focus-within"]', 'focus-within']]);
    await page.waitForTimeout(400);
  },
};

await mkdir(out, {recursive: true});
const browser = await chromium.launch();
for (const [id, size] of Object.entries(SCENES)) {
  for (const theme of ['light', 'dark']) {
    const name = theme === 'light' ? id : `${id}-dark`;
    if (only.length && !only.includes(name)) continue;
    const context = await browser.newContext({viewport: {width: size[0], height: size[1]}, deviceScaleFactor: scale, locale: 'en-US', timezoneId: 'UTC', colorScheme: theme});
    const page = await context.newPage();
    await page.goto(`${base}/scene/${id}/${theme}`, {waitUntil: 'load'});
    await page.evaluate(async () => { await document.fonts.ready; });
    await scenes[id](page, context);
    await page.evaluate(() => { for (const element of document.querySelectorAll('*')) element.style.caretColor = 'transparent'; });
    const path = join(out, `${name}.png`);
    await page.screenshot({path, clip: {x: 0, y: 0, width: size[0], height: size[1]}, animations: 'allow', caret: 'hide'});
    console.log(name, size.join('x'), path);
    await context.close();
  }
}
await browser.close();
server.close();
