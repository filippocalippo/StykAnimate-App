// The references for the application-menu screens (docs/native/screens/limits.toml, `app-menu*`): the mark's StykAnimate menu and
// the six application menus it leads with, drawn by today's own modules in Playwright's bundled Chromium (LCD text on, opaque
// surfaces), the way engine/crates/xtask/fonts-chromium.mjs captures.
//
//   node engine/crates/styk-app/automation/menus-reference/screens.mjs [--scale 2] [--out dir] [--only app-menu-file,app-menu-dark]
//
// By default it writes docs/native/screens/menus/<id>.png at device scale 1 (what the screen guard compares); `--scale 2 --out
// artifacts/native-screens/menus-reference-2` writes the 200 % references the chunk compares by hand.
//
// The rows are today's, not copies: each menu is `applicationMenuItems(name, editor, desktop)` from src/application-menu.mjs, the
// mark's rows are `showMenu` in src/app.mjs (rebuilt here with the same calls, since app.mjs is the whole application), the
// conversion to menu rows is `menuItems`/`menuShortcut` (src/app.mjs) and the menu is today's `openMenu` (src/ui/ui-menu.mjs). The
// state is a window with nothing selected, on the packaged desktop (`stykDesktop` is set, so the desktop-only keys show), with the
// stage's flags at their starting state (Joints, Onion skin and Loop on) and no more than one project open.
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {mkdir, readFile} from 'node:fs/promises';
import {extname, join, normalize, resolve} from 'node:path';

const root = resolve(import.meta.dirname, '../../../../..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1]; };
const scale = Number(option('--scale', '1'));
const out = resolve(root, option('--out', 'docs/native/screens/menus'));
const only = option('--only', '').split(',').filter(Boolean);

/** The window of each scene (the mark's menu, then each application menu open beside the row that leads to it). */
export const SCENES = {
  'app-menu': [360, 900],
  'app-menu-file': [640, 900], 'app-menu-edit': [640, 900], 'app-menu-view': [640, 900],
  'app-menu-joint': [640, 900], 'app-menu-animation': [640, 900], 'app-menu-help': [640, 900],
};
const MENU_OF = {'app-menu-file': ['file', 0], 'app-menu-edit': ['edit', 1], 'app-menu-view': ['view', 2], 'app-menu-joint': ['editor', 3], 'app-menu-animation': ['animation', 4], 'app-menu-help': ['help', 5]};

const MIME = {'.css': 'text/css', '.mjs': 'text/javascript', '.js': 'text/javascript', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.html': 'text/html'};

function shell(theme, [width, height]) {
  return `<!doctype html><html lang="en" data-theme="${theme}"><head><meta charset="utf-8"><link rel="stylesheet" href="/src/styles/app.css"><style>
    html, body { margin: 0; background: var(--surface); }
    body { position: relative; width: ${width}px; height: ${height}px; overflow: hidden; color: var(--text-1); font: var(--type-ui); }
    .t { position: absolute; left: 24px; top: 24px; }
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

/** Runs in the page: builds today's rows and opens the mark's menu with today's `openMenu`. */
async function openMark(page) {
  await page.evaluate(async () => {
    const {applicationMenuItems} = await import('/src/application-menu.mjs');
    const {HOTKEY_BY_ID, shortcutLabel} = await import('/src/hotkeys.mjs');
    const {t: interfaceText} = await import('/src/localization.mjs');
    const {openMenu} = await import('/src/ui/ui-menu.mjs');
    const {icon} = await import('/src/icons.mjs');
    // A window with nothing selected on the packaged desktop.
    const editor = {object: null, selectedJoint: -1, selectedUids: new Set(), figure: null};
    const desktop = {newWindow: () => {}, listRecentFiles: () => {}, sendTelemetryFeedback: () => {}, getUpdateState: () => {}, getTelemetryState: () => {}};
    const TOGGLES = {'toggle-handles': true, 'toggle-motion-paths': false, 'toggle-grid': false, 'toggle-onion': true, 'toggle-loop': true};
    const DANGER = new Set(['delete', 'delete-segment', 'delete-single-segment', 'delete-frame', 'clear-keys', 'builder-context-delete-fill']);
    const ALIASES = {'delete-single-segment': 'delete', 'duplicate-segment': 'duplicate', 'mirror-segment': 'mirror', 'mirror-segment-vertical': 'mirror-vertical'};
    // `menuShortcut`, `menuItems` and `appMenuItems` of src/app.mjs.
    const hotkeyOf = id => { const key = ALIASES[id] ?? id; return key === 'play' && !shortcutLabel(undefined, 'play') ? 'play-pan' : key; };
    const shortcut = (command, text = '') => HOTKEY_BY_ID.has(hotkeyOf(command)) ? shortcutLabel(undefined, hotkeyOf(command)).split(' / ')[0] : text;
    const rows = list => list.map(row => {
      if (!Array.isArray(row)) return row && Array.isArray(row.submenu) ? {...row, submenu: rows(row.submenu)} : row ?? null;
      const [command, glyph, label, key = '', disabled = false] = row;
      return {command, icon: glyph, label, shortcut: shortcut(command, key), disabled: Boolean(disabled), danger: DANGER.has(command)};
    });
    const panels = {label: interfaceText('app.panels'), icon: 'layout', submenu: [
      ['properties', interfaceText('app.properties'), 'inspector'], ['vfx', 'VFX', 'fx'], ['library', interfaceText('app.library'), 'library'],
      ['structure', interfaceText('app.structure'), 'structure'], ['timeline', interfaceText('app.timeline'), 'timeline'],
    ].map(([id, label, glyph]) => ({label, icon: glyph, checked: true, shortcut: shortcut(`panel-toggle-${id}`)}))};
    const appMenu = name => {
      const items = rows(applicationMenuItems(name, editor, desktop)).map(item => item?.command && item.command in TOGGLES ? {...item, checked: TOGGLES[item.command]} : item);
      if (name === 'view') items.splice(items.findIndex(item => item?.command === 'layout-focus'), 0, panels);
      return items;
    };
    const names = {file: 'File', edit: 'Edit', view: 'View', editor: 'Joint', animation: 'Animation', help: 'Help'};
    const tuple = (id, glyph, key, text = '') => [id, glyph, interfaceText(key), text];
    const items = [
      ...Object.entries(names).map(([name, label]) => ({label, submenu: appMenu(name)})), null,
      {command: 'command-palette', icon: 'search', label: interfaceText('overlays.palette.open'), shortcut: shortcut('command-palette')},
      null,
      ...rows([
        tuple('new', 'plus', 'app.newAnimation', 'Ctrl N'), tuple('open', 'folder', 'app.openProject', 'Ctrl O'), tuple('open-recent', 'clock', 'app.openRecent'),
        tuple('save', 'save', 'common.save', 'Ctrl S'), tuple('save-as', 'save', 'common.saveAs', 'Ctrl Shift S'), null,
        tuple('undo', 'undo', 'common.undo', 'Ctrl Z'), tuple('redo', 'redo', 'common.redo', 'Ctrl Shift Z'), null,
        tuple('import', 'import', 'app.importFigures'), tuple('import-sprite', 'frame', 'app.importSpriteImage'), tuple('import-background', 'frame', 'app.importBackgroundImage'),
        tuple('add-text', 'text', 'app.createText', 'T'), tuple('export', 'export', 'common.export'), null,
        tuple('settings', 'settings', 'app.settings', 'Ctrl ,'), tuple('help', 'help', 'app.keyboardShortcuts', '?'), tuple('performance', 'activity', 'app.performance'),
      ]),
    ];
    // A menu a pointer opened focuses its first row without the ring (ui-menu.mjs `quiet`).
    const overlays = {register: () => null, openedByPointer: () => true};
    openMenu({items, anchor: document.querySelector('#trigger'), icon: name => icon(name, 'ui-icon'), focus: 'first', overlays});
  });
  await page.waitForTimeout(450);
}

async function rowCenter(page, nth) {
  return page.evaluate(nth => {
    const rect = document.querySelectorAll('.ui-menu-item')[nth].getBoundingClientRect();
    return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
  }, nth);
}

const open = async (page, hoverRow) => {
  await page.evaluate(async () => { const {icon} = await import('/src/icons.mjs'); document.querySelector('#page').innerHTML = `<button type="button" id="trigger" class="ui-icon-button t" aria-label="More">${icon('more', '')}</button>`; });
  // The person pressed the menu button with the pointer: Chromium remembers the last focus came from the mouse.
  await page.click('#trigger');
  await openMark(page);
  if (hoverRow === undefined) return;
  const row = await rowCenter(page, hoverRow);
  await page.mouse.move(row.x - 30, row.y - 10);
  await page.mouse.move(row.x, row.y);
  await page.waitForTimeout(700);
};

const scenes = Object.fromEntries([['app-menu', page => open(page)], ...Object.entries(MENU_OF).map(([id, [, row]]) => [id, page => open(page, row)])]);

await mkdir(out, {recursive: true});
const browser = await chromium.launch();
for (const [id, size] of Object.entries(SCENES)) {
  for (const theme of ['light', 'dark']) {
    const name = theme === 'light' ? id : `${id}-dark`;
    if (only.length && !only.includes(name)) continue;
    const context = await browser.newContext({viewport: {width: size[0], height: size[1]}, deviceScaleFactor: scale, locale: 'en-US', timezoneId: 'UTC', colorScheme: theme});
    const page = await context.newPage();
    // The packaged desktop: its own bindings (Close project, New window) are in the registry's hints.
    await page.addInitScript(() => { globalThis.stykDesktop = {}; });
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
