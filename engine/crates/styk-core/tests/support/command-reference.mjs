// Read today's executable catalogues, including their computed rows. This is an
// independent test oracle, never an input to the native build or runtime.
import {readFileSync} from 'node:fs';
import {COMMAND_CATALOG} from '../../../../../src/ui/command-catalog.mjs';
import {hotkeyLabelMessage} from '../../../../../src/hotkey-labels.mjs';

const root = new URL('../../../../../', import.meta.url);
const app = readFileSync(new URL('src/app.mjs', root), 'utf8');
const home = readFileSync(new URL('src/home/home.mjs', root), 'utf8');
const strings = text => [...text.matchAll(/["']([^"']+)["']/g)].map(m => m[1]);
const array = (source, name) => {
  const match = source.match(new RegExp(`(?:const|export const) ${name} = (?:Object.freeze\\()?new Set\\(\\[([\\s\\S]*?)\\]`));
  if (!match) throw new Error(`Missing reference set ${name}`);
  return strings(match[1]);
};

globalThis.stykDesktop = {};
Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {platform: 'Win32'}});
const windows = await import('../../../../../src/hotkeys.mjs?command-reference-windows');
Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {platform: 'MacIntel'}});
const apple = await import('../../../../../src/hotkeys.mjs?command-reference-apple');
const {CommandRegistry} = await import('../../../../../src/ui/command-registry.mjs');
const macById = new Map(apple.HOTKEY_COMMANDS.map(row => [row.id, row]));
const catalog = new Map(COMMAND_CATALOG.map(row => [row.id, row]));
const all = new Map(COMMAND_CATALOG.map(row => [row.id, {...row}]));
for (const hotkey of windows.HOTKEY_COMMANDS) {
  const label = hotkeyLabelMessage(hotkey.id);
  all.set(hotkey.id, {label: hotkey.label, ...(label ? {labelKey: label.key, labelParams: label.params} : {}), ...all.get(hotkey.id),
    id: hotkey.id, keys: hotkey.defaults, macKeys: macById.get(hotkey.id).defaults, scope: hotkey.scope,
    hold: !!hotkey.hold, repeat: !!hotkey.repeat, extraShift: !!hotkey.extraShift,
    hotkeyOrder: windows.HOTKEY_COMMANDS.indexOf(hotkey)});
}
const desktopIds = [...Object.keys(windows.DESKTOP_PROJECT_KEYS), ...Object.keys(windows.DESKTOP_PANEL_KEYS)];
const polygonActions = array(app, 'polygonSafeActions');
const polygonKeys = array(app, 'polygonCommands');
const homeActions = array(home, 'HOME_COMMANDS');
const commands = [...all.values()].map(row => ({...row, desktop: desktopIds.includes(row.id), catalogOrder: COMMAND_CATALOG.findIndex(c => c.id === row.id)}));
// Every default chord is resolved by the real reference manager, not by a copy
// of its matching algorithm. Modifier changes and key-up get native tests too.
const cases = [];
for (const [mac, module] of [[false, windows], [true, apple]]) {
  const manager = new module.HotkeyManager({mac});
  for (const command of module.HOTKEY_COMMANDS) for (const binding of command.defaults) {
    for (const extra of command.extraShift && !binding.includes('Shift+') ? [false, true] : [false]) {
      const parts = (extra ? `Shift+${binding}` : binding).replace('Mod', mac ? 'Meta' : 'Ctrl').split('+');
      const event = {code: parts.at(-1), ctrlKey: parts.includes('Ctrl'), metaKey: parts.includes('Meta'), altKey: parts.includes('Alt'), shiftKey: parts.includes('Shift')};
      const result = manager.match(event, [command.scope]);
      cases.push({mac, binding, extra, scope: command.scope, event, id: result?.command.id, shift: result?.shift});
    }
  }
}
// Menu hints go through the reference registry, including aliases and workspace conflicts.
const hints = [];
for (const [mac, module] of [[false, windows], [true, apple]]) {
  const registry = new CommandRegistry({hotkeys: new module.HotkeyManager({mac}),
    hotkeyCommands: module.HOTKEY_COMMANDS, formatBinding: binding => module.formatBinding(binding, mac)});
  for (const [id, scopes] of [
    ['undo', []], ['redo', []], ['play', []], ['delete-single-segment', ['builder']],
    ['tool-line', []], ['tool-line', ['drawing']], ['cancel', []], ['zoom-out', []],
    ['recent-project', []], ['menu', []], ['home', []], ['handle-left', ['canvas']],
  ]) {
    const context = {hotkeyScopes: scopes};
    hints.push({id, mac, scopes, text: registry.shortcut(id, context), aria: registry.keyShortcuts(id, context)});
  }
}
process.stdout.write(JSON.stringify({commands, cases, hints, polygonActions, polygonKeys, homeActions,
  fieldCommands: array(app, 'SHELL_FIELD_KEYS'), requirements: [...new Set([...catalog.values()].flatMap(row => row.requires ?? []))]}));
