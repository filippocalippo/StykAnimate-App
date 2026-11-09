// Today's application menus as the application builds them, for the native menus' tests (an independent oracle, never an
// input to the native build or runtime). Three states: nothing selected on the packaged desktop, a figure with one joint
// selected on it, and nothing selected in the browser (no desktop). Each state holds the six menus (`applicationMenuItems`
// through the conversion of `menuItems`/`menuShortcut`, `appMenuItems` of src/app.mjs) and the mark's rows, which are the
// text of `showMenu` itself, run against stubs for what it reads.
import {readFileSync} from 'node:fs';

globalThis.stykDesktop = {};
Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {platform: 'Win32'}});
const {applicationMenuItems} = await import('../../../../../src/application-menu.mjs');
const {HOTKEY_BY_ID, shortcutLabel} = await import('../../../../../src/hotkeys.mjs');
const {messageTuple} = await import('../../../../../src/localization-bindings.mjs');
const {t: interfaceText} = await import('../../../../../src/localization.mjs');

const app = readFileSync(new URL('../../../../../src/app.mjs', import.meta.url), 'utf8');
const body = name => {
  const start = app.indexOf(`function ${name}(`);
  const open = app.indexOf('{', app.indexOf(')', start));
  let depth = 0;
  for (let at = open; at < app.length; at += 1) {
    if (app[at] === '{') depth += 1;
    if (app[at] === '}' && --depth === 0) return app.slice(open + 1, at);
  }
  throw new Error(`no ${name} in src/app.mjs`);
};
const aliases = Function(`return ${app.match(/const MENU_KEY_ALIASES = (\{[^}]*\});/)[1]}`)();
const danger = new Set(app.match(/const DANGER_COMMANDS = new Set\(\[([^\]]*)\]\)/)[1].match(/"([^"]+)"/g).map(text => text.slice(1, -1)));

const shortcut = (command, text = '') => {
  let id = aliases[command] ?? command;
  if (id === 'play' && !shortcutLabel(undefined, 'play')) id = 'play-pan';
  return HOTKEY_BY_ID.has(id) ? shortcutLabel(undefined, id).split(' / ')[0] : text;
};
const rows = list => list.map(row => {
  if (!Array.isArray(row)) return row && Array.isArray(row.submenu) ? {...row, submenu: rows(row.submenu)} : row ?? null;
  const [command, icon, label, key = '', disabled = false] = row;
  return {command, icon, label, shortcut: shortcut(command, key), disabled: Boolean(disabled), danger: danger.has(command)};
});

const TOGGLES = {'toggle-handles': true, 'toggle-motion-paths': false, 'toggle-grid': false, 'toggle-onion': true, 'toggle-loop': true};
const PANELS = [['properties', 'app.properties', 'inspector'], ['vfx', null, 'fx'], ['library', 'app.library', 'library'], ['structure', 'app.structure', 'structure'], ['timeline', 'app.timeline', 'timeline']];
const clean = item => item && {command: item.command, label: item.label, icon: item.icon, shortcut: item.shortcut, disabled: Boolean(item.disabled), danger: Boolean(item.danger),
  ...(item.checked === undefined ? {} : {checked: item.checked}), ...(item.submenu ? {submenu: item.submenu.map(clean)} : {})};

function state(editor, desktop) {
  const appMenu = name => {
    const items = rows(applicationMenuItems(name, editor, desktop)).map(item => item?.command in TOGGLES ? {...item, checked: TOGGLES[item.command]} : item);
    if (name === 'view') {
      const panels = {label: interfaceText('app.panels'), icon: 'layout', submenu: PANELS.map(([id, key, icon]) => ({label: key ? interfaceText(key) : 'VFX', icon, checked: false, shortcut: shortcut(`panel-toggle-${id}`)}))};
      items.splice(items.findIndex(item => item?.command === 'layout-focus'), 0, panels);
    }
    return items;
  };
  const menus = Object.fromEntries(['file', 'edit', 'view', 'editor', 'animation', 'help'].map(name => [name, appMenu(name).map(clean)]));
  // `showMenu`, as written, with what it reads supplied.
  let shown = [];
  const names = {file: 'File', edit: 'Edit', view: 'View', editor: 'Joint', animation: 'Animation', help: 'Help'};
  const commands = {label: () => interfaceText('overlays.palette.open'), shortcut: id => shortcut(id), keyShortcuts: () => ''};
  new Function('foldedMenubarItems', 'openProjectsMenu', 'commands', 'messageTuple', 'interfaceText', 'desktop', 'showCommandMenu', 'anchor', body('showMenu'))(
    () => [...Object.entries(names).map(([name, label]) => ({label, submenu: appMenu(name)})), null], () => [], commands, messageTuple, interfaceText, desktop, items => { shown = items; }, null);
  return {menus, mark: rows(shown.map(item => item?.command === 'command-palette' ? [item.command, item.icon, item.label, item.shortcut] : item)).map(item => item?.submenu ? {...item, submenu: item.submenu.map(clean)} : clean(item))};
}

const full = {newWindow: () => {}, listRecentFiles: () => {}, sendTelemetryFeedback: () => {}, getUpdateState: () => {}, getTelemetryState: () => {}};
const figure = {object: {}, selectedJoint: 2, selectedUids: new Set([1]), figure: {_styk: {}}};
const nothing = {object: null, selectedJoint: -1, selectedUids: new Set(), figure: null};
console.log(JSON.stringify({bare: state(nothing, full), figure: state(figure, full), web: state(nothing, undefined)}));
