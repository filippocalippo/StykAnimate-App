/** Single command catalog for dispatch, preferences, help and shortcut hints.
 * Bindings use physical KeyboardEvent.code values. Mod means Ctrl on Windows /
 * Linux and Command on macOS. More specific scopes override general commands.
 * [] explicitly disables a command; missing entries inherit future defaults.
 */
const commands = [];
function group(category, rows, scope = 'global') {
  for (const [id, label, keys = [], options = {}] of rows)
    commands.push(Object.freeze({id, label, category, scope, ...options, defaults: Object.freeze(keys)}));
}
group('Project & editing', [
  ['new', 'New animation', ['Mod+KeyN']], ['open', 'Open project', ['Mod+KeyO']],
  ['save', 'Save project', ['Mod+KeyS']], ['save-as', 'Save project as', ['Mod+Shift+KeyS']],
  ['export', 'Export', ['Mod+Shift+KeyE']], ['import', 'Import figures'],
  ['settings', 'Settings', ['Mod+Comma']], ['help', 'Keyboard shortcuts', ['Shift+Slash']],
  ['command-palette', 'Search commands', ['Mod+KeyP', 'Mod+Shift+KeyP', 'F1']],
  ['undo', 'Undo', ['Mod+KeyZ']], ['redo', 'Redo', ['Mod+Shift+KeyZ', 'Mod+KeyY']],
  ['copy', 'Copy selection / frames', ['Mod+KeyC']], ['cut', 'Cut selection / frames', ['Mod+KeyX']],
  ['paste', 'Paste selection / frames', ['Mod+KeyV']],
  ['paste-in-place', 'Paste in place', ['Mod+Shift+KeyV']], ['select-all', 'Select all', ['Mod+KeyA']],
  ['duplicate', 'Duplicate selection', ['Mod+KeyD']], ['delete', 'Delete selection / frames', ['Delete', 'Backspace']],
  ['cancel', 'Cancel current gesture', ['Escape']],
]);
group('Tools', [
  ['tool-select', 'Select tool', ['KeyV']], ['tool-pose', 'Pose tool', ['KeyP']],
  ['tool-line', 'Line tool', ['KeyL']], ['tool-circle', 'Circle tool', ['KeyC']],
  ['tool-hand', 'Pan tool', ['KeyH']], ['tool-rig', 'Edit shared rig'], ['tool-polygon', 'Polygon tool'],
  ['add-text', 'Create text', ['KeyT']],
  ['handle-edit-hold', 'Hold to edit handles', ['KeyR'], {hold: true}],
  ['isolate-hold', 'Hold to isolate joint', ['CapsLock'], {hold: true, extraShift: true}],
  ['depth-hold', 'Hold to pose 3D parts in depth', ['KeyD'], {hold: true, extraShift: true}],
  ['toggle-isolate', 'Toggle joint isolation'],
  ['toggle-selection-origins', 'Rectangle selects figure origins'],
  ['toggle-range-edit', 'Edit together'],
  ['join-figure', 'Join / unjoin figure', ['KeyJ']],
]);
group('Animation', [
  ['insert-copied-key', 'Insert copied key at playhead', []],
  ['insert-blank-key', 'Insert blank key at playhead', ['F7']],
  ['play-pan', 'Play / pause; hold to pan', ['Space'], {hold: true}],
  ['play', 'Play / pause immediately'],
  ['add-frame', 'Add Frame', ['KeyA']],
  ['extend-keyframe', 'Extend keyframe', ['Shift+KeyA']],
  ['delete-frame', 'Delete frames'],
  ['previous-frame', 'Previous frame', ['Comma'], {repeat: true}],
  ['next-frame', 'Next frame', ['Period'], {repeat: true}],
  ['previous-keyframe', 'Jump to previous keyframe', ['Shift+Comma'], {repeat: true}],
  ['next-keyframe', 'Jump to next keyframe', ['Shift+Period'], {repeat: true}],
  ['first-frame', 'First frame', ['Home']], ['last-frame', 'Last frame', ['End']],
  ['toggle-loop', 'Toggle playback loop'], ['toggle-onion', 'Toggle onion skin', ['KeyO']],
  ['toggle-auto-key', 'Toggle auto key', ['KeyK']],
  ['camera-follow', 'Follow selected figures with the camera'],
]);
group('Timeline', [
  ['remove-frames', 'Remove frames', ['Shift+F5']],
  ['clear-keys', 'Remove keyframes', ['Shift+F6']],
  ['timeline-layer-up', 'Select layer above', ['ArrowUp'], {repeat: true, extraShift: true}],
  ['timeline-layer-down', 'Select layer below', ['ArrowDown'], {repeat: true, extraShift: true}],
], 'timeline');
group('Filmstrip', [
  ['previous-exposure', 'Previous exposure', [], {repeat: true, extraShift: true}],
  ['next-exposure', 'Next exposure', [], {repeat: true, extraShift: true}],
], 'simple');
group('View & camera', [
  ['zoom-in', 'Zoom in', ['Equal', 'Shift+Equal']], ['zoom-out', 'Zoom out', ['Minus']],
  ['zoom-reset', 'Fit canvas', ['Shift+Digit1']], ['zoom-selection', 'Fit selection', ['Shift+Digit2']],
  ['toggle-handles', 'Show / hide joints', ['Shift+KeyJ']],
  ['toggle-motion-paths', 'Show / hide motion paths', ['KeyM']],
  ['toggle-grid', 'Show / hide grid', ['Mod+Quote']],
  ['toggle-unselected-handles', 'Show / hide unselected handles', ['Mod+KeyH']],
  ['toggle-camera', 'Show / hide camera', ['Mod+KeyK']], ['camera-reset', 'Reset camera', ['Mod+Alt+KeyK']],
  ['camera-center', 'Center camera', ['F8']], ['camera-align-view', 'Align camera to view', ['F10']],
  ['camera-copy', 'Copy camera', ['F11']], ['camera-paste', 'Paste camera', ['F12']],
  ['mirror', 'Flip horizontally', ['Shift+KeyH']], ['mirror-vertical', 'Flip vertically', ['Shift+KeyV']],
]);
group('Canvas', [
  ['segment-values', 'Segment editor', ['KeyI']],
  ...['left', 'right', 'up', 'down'].map(direction => [
    `handle-${direction}`, `Nudge handle ${direction} (Shift: align)`, [`Arrow${direction[0].toUpperCase()}${direction.slice(1)}`],
    {hold: true, repeat: true, extraShift: true},
  ]),
  ['previous-figure', 'Select previous figure', ['Mod+ArrowLeft'], {repeat: true}],
  ['next-figure', 'Select next figure', ['Mod+ArrowRight'], {repeat: true}],
], 'canvas');
group('Canvas', ['left', 'right', 'up', 'down'].map(direction => [
  `move-${direction}`, `Move selection ${direction} (Shift: 10 pixels)`, [`Alt+Arrow${direction[0].toUpperCase()}${direction.slice(1)}`],
  {repeat: true, extraShift: true},
]));
group('Hovered handle', [
  ['locate-previous', 'Locate handle in previous frame', ['KeyL']],
  ['locate-next', 'Locate handle in next frame', ['Shift+KeyL']],
], 'hover');
group('Figure builder', [
  ['split-segment', 'Split segment / branch', ['KeyS'], {extraShift: true}],
  ['toggle-builder-branch', 'Toggle branch scope', ['KeyB']],
  ['builder-canvas-color', 'Construction background color', ['F9']],
  ['builder-static-handles', 'Show static handles', ['F10']],
  ['builder-highlight', 'Highlight selected segment', ['F12']],
  ['unsplit-segment', 'Remove joint, keep endpoints', ['Mod+Delete', 'Mod+Backspace']],
  ['delete-segment', 'Delete branch', ['Shift+Delete', 'Shift+Backspace']],
], 'builder');
group('Polygon', [['finish-polygon', 'Finish polygon', ['Enter']]], 'polygon');
group('Drawing', [
  ['drawing-brush','Brush',['KeyB']],['drawing-eraser','Eraser',['KeyE']],['drawing-fill','Fill',['KeyG']],
  ['drawing-lasso','Select pixels',['KeyL']],['drawing-shape','Shapes',['KeyU']],
  ['drawing-smaller','Smaller brush',['BracketLeft'],{repeat:true}],['drawing-larger','Larger brush',['BracketRight'],{repeat:true}],
  ['drawing-softer','Softer brush',['Shift+BracketLeft'],{repeat:true}],['drawing-harder','Harder brush',['Shift+BracketRight'],{repeat:true}],
  // Photoshop's opacity keys: 1 = 10% … 9 = 90%, 0 = 100%.
  ...[1,2,3,4,5,6,7,8,9,10].map(n=>[`drawing-opacity-${n*10}`,`Brush opacity ${n*10}%`,[`Digit${n%10}`]]),
  ['drawing-apply','Apply pixel selection',['Enter']],
  // Krita's selection shortcuts; the drawing scope takes precedence while painting.
  ['drawing-select-all','Select all pixels',['Mod+KeyA']],['drawing-deselect','Deselect pixels',['Mod+Shift+KeyA']],
  ['drawing-invert-selection','Invert pixel selection',['Mod+Shift+KeyI']],['drawing-fill-selection','Fill pixel selection',['Shift+Backspace']],
  ['drawing-mirror','Toggle mirror painting',['Shift+KeyM']],['drawing-swap-colors','Swap drawing colors',['KeyX']],['drawing-flip-view','Flip view horizontally',['KeyM']],
], 'drawing');
group('Library', [['library-open', 'Open / insert library item', ['Enter']], ['library-rename', 'Rename library item', ['F2']]], 'library');
/** The project tabs' keys work in the desktop app only: a browser keeps Ctrl+W, Ctrl+Tab and Ctrl+Page Up/Down for its own tabs. */
export const DESKTOP_PROJECT_KEYS = Object.freeze({
  'close-project': Object.freeze(['Mod+KeyW']),
  // Command+Tab belongs to macOS; Control+Tab is what its apps use for tabs.
  'recent-project': Object.freeze([isMacPlatform() ? 'Ctrl+Tab' : 'Mod+Tab']),
  'next-project': Object.freeze(['Mod+PageDown']), 'previous-project': Object.freeze(['Mod+PageUp']),
});
const projectKeys = id => (globalThis.stykDesktop ? DESKTOP_PROJECT_KEYS[id] : []);
group('Projects', [
  ['close-project', 'Close project', projectKeys('close-project')],
  ['recent-project', 'Last used project', projectKeys('recent-project'), {repeat: true}],
  ['next-project', 'Next project', projectKeys('next-project')],
  ['previous-project', 'Previous project', projectKeys('previous-project')],
  ['save-all', 'Save all projects'],
]);
/** Ctrl+1–4 show and fold the panels in the desktop app only: a browser keeps them for its tabs. */
export const DESKTOP_PANEL_KEYS = Object.freeze({
  'panel-toggle-properties': Object.freeze(['Mod+Digit1']), 'panel-toggle-vfx': Object.freeze(['Mod+Digit2']),
  'panel-toggle-library': Object.freeze(['Mod+Digit3']), 'panel-toggle-timeline': Object.freeze(['Mod+Digit4']),
});
const panelKeys = id => (globalThis.stykDesktop ? DESKTOP_PANEL_KEYS[id] : []);
group('Panels & layout', [
  ['panel-toggle-properties', 'Show or fold Properties', panelKeys('panel-toggle-properties')],
  ['panel-toggle-vfx', 'Show or fold VFX', panelKeys('panel-toggle-vfx')],
  ['panel-toggle-library', 'Show or fold Library', panelKeys('panel-toggle-library')],
  ['panel-toggle-timeline', 'Show or fold the timeline', panelKeys('panel-toggle-timeline')],
  ['layout-focus', 'Focus mode', ['Mod+Backslash']],
  ['layout-arrange', 'Move the focused panel', ['Mod+Alt+KeyM']],
  ['layout-menu', 'Layout…', ['Mod+Alt+KeyL']],
  ['focus-next-region', 'Next region', ['F6']],
  ['focus-previous-region', 'Previous region', ['Mod+F6']],
]);

export const HOTKEY_COMMANDS = Object.freeze(commands);
export const HOTKEY_BY_ID = new Map(commands.map(command => [command.id, command]));
export const HOTKEY_SCOPES = Object.freeze({global: 'Editor', canvas: 'Canvas focused', hover: 'Handle hovered', builder: 'Figure builder', timeline: 'Advanced timeline focused', simple: 'Simple timeline mode', polygon: 'Drawing polygon', library: 'Library focused',drawing:'Drawing workspace'});
export const DEFAULT_HOTKEYS = Object.freeze(Object.fromEntries(commands.map(c => [c.id, c.defaults])));
const codePattern = /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4])|Arrow(Left|Right|Up|Down)|Space|Enter|Escape|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|CapsLock|Comma|Period|Slash|Backslash|Semicolon|Quote|BracketLeft|BracketRight|Minus|Equal|Backquote|Numpad[0-9]|Numpad(Add|Subtract|Multiply|Divide|Decimal|Enter))$/;
const modifierOrder = ['Mod', 'Ctrl', 'Meta', 'Alt', 'Shift'];
export function normalizeBinding(value) {
  if (typeof value !== 'string' || value.length > 80) return null;
  const parts = value.split('+'), code = parts.pop();
  if (!codePattern.test(code) || new Set(parts).size !== parts.length || parts.some(p => !modifierOrder.includes(p)) || (parts.includes('Mod') && parts.some(p => p === 'Ctrl' || p === 'Meta'))) return null;
  return [...modifierOrder.filter(p => parts.includes(p)), code].join('+');
}
export function isMacPlatform() { return /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || ''); }
export function eventBinding(event, mac = isMacPlatform()) {
  if (event.isComposing || event.keyCode === 229 || event.getModifierState?.('AltGraph')) return null;
  let code = event.code;
  if (!code) code = /^[a-z]$/i.test(event.key) ? `Key${event.key.toUpperCase()}` : event.key === ' ' ? 'Space' : event.key;
  if (!codePattern.test(code)) return null;
  return [...((mac ? event.metaKey : event.ctrlKey) ? ['Mod'] : []), ...((mac ? event.ctrlKey : event.metaKey) ? [mac ? 'Ctrl' : 'Meta'] : []), ...(event.altKey ? ['Alt'] : []), ...(event.shiftKey ? ['Shift'] : []), code].join('+');
}
function physical(binding, mac) { return binding.replace('Mod', mac ? 'Meta' : 'Ctrl').split('+').sort().join('+'); }
function variants(command, binding) { return command.extraShift && !binding.includes('Shift+') ? [binding, `Shift+${binding}`] : [binding]; }
export function findHotkeyConflicts(bindings, id, candidate, mac = isMacPlatform()) {
  const command = HOTKEY_BY_ID.get(id);
  if (!command) return [];
  // Scoped shortcuts deliberately take precedence over general shortcuts.
  return commands.filter(other => other.id !== id && other.scope === command.scope &&
    (bindings[other.id] ?? other.defaults).some(binding => variants(other, binding).some(a => variants(command, candidate).some(b => physical(a, mac) === physical(b, mac)))));
}
export function normalizeHotkeys(value, mac = isMacPlatform()) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  // Migrate the retired commands from full preference snapshots. Preserve an
  // explicit Add Frame customization; otherwise carry over the old A action.
  const legacy = Object.hasOwn(input, 'duplicate-frame-after');
  const migrated = {...input};
  // Upgrade the old navigation defaults once; retain custom and disabled keys.
  if (!Object.hasOwn(input, 'next-keyframe') && !Object.hasOwn(input, 'previous-keyframe')) {
    for (const [id, oldKey, newKeys] of [
      ['previous-frame', 'ArrowLeft', ['Comma']], ['next-frame', 'ArrowRight', ['Period']],
      ['previous-exposure', 'Comma', []], ['next-exposure', 'Period', []],
    ]) if (JSON.stringify(input[id]) === JSON.stringify([oldKey])) migrated[id] = newKeys;
  }
  // Old full preference snapshots stored J for visibility. Only migrate that
  // exact old default; preserve custom assignments and explicit unassignments.
  if (!Object.hasOwn(input, 'join-figure') && JSON.stringify(input['toggle-handles']) === '["KeyJ"]')
    migrated['toggle-handles'] = ['Shift+KeyJ'];
  if (legacy && (!Array.isArray(input['add-frame']) || JSON.stringify(input['add-frame']) === '["F6"]'))
    migrated['add-frame'] = input['duplicate-frame-after'];
  const result = {}, customized = new Set();
  for (const command of commands) {
    const candidate = migrated[command.id];
    const valid = Array.isArray(candidate) && candidate.length <= 4 && candidate.every(key => normalizeBinding(key));
    result[command.id] = [...new Set(valid ? candidate.map(normalizeBinding) : command.defaults)];
    if (valid && JSON.stringify(result[command.id]) !== JSON.stringify(command.defaults)) customized.add(command.id);
  }
  // Deterministic recovery from corrupt/old preferences: custom bindings win
  // over defaults, then catalog order breaks ties. Never execute two commands.
  const accepted = Object.fromEntries(commands.map(c => [c.id, []]));
  for (const command of [...commands.filter(c => customized.has(c.id)), ...commands.filter(c => !customized.has(c.id))])
    accepted[command.id] = result[command.id].filter(binding => !findHotkeyConflicts(accepted, command.id, binding, mac).length);
  return accepted;
}
const keyLabels = {Space: 'Space', Escape: 'Esc', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Minus: '−', Equal: '=', Backquote: '`', CapsLock: 'Caps Lock'};
export function formatBinding(binding, mac = isMacPlatform()) {
  return binding.split('+').map(part => part === 'Mod' ? (mac ? 'Cmd' : 'Ctrl') : part === 'Meta' ? (mac ? 'Cmd' : 'Meta') : keyLabels[part] || part.replace(/^Key|^Digit/, '').replace(/^Numpad/, 'Num ')).join('+');
}
export function shortcutLabel(bindings, id, mac = isMacPlatform()) { return (bindings?.[id] ?? DEFAULT_HOTKEYS[id] ?? []).map(key => formatBinding(key, mac)).join(' / '); }
export function isHotkeyInput(target) { return Boolean(target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]')); }

/** Resolves and tracks held keys independently of DOM/event-listener ordering. */
export class HotkeyManager {
  constructor({bindings, run = () => {}, release = () => {}, mac = isMacPlatform()} = {}) {
    this.mac = mac; this.run = run; this.release = release; this.held = new Map(); this.setBindings(bindings);
  }
  setBindings(bindings) { this.releaseAll(); this.bindings = normalizeHotkeys(bindings, this.mac); }
  match(event, scopes = []) {
    const key = eventBinding(event, this.mac);
    if (!key) return null;
    for (const scope of [...scopes, 'global']) {
      const candidates = commands.filter(c => c.scope === scope);
      // Exact bindings win over the optional Shift gesture modifier, including
      // when a command has both a plain and a shifted alternative.
      for (const extraShift of [false, true]) for (const command of candidates) {
        const binding = this.bindings[command.id].find(b => (!extraShift || (command.extraShift && !b.includes('Shift+'))) &&
          physical(extraShift ? `Shift+${b}` : b, this.mac) === physical(key, this.mac));
        if (binding) return {command, binding, shift: command.extraShift ? extraShift : Boolean(event.shiftKey)};
      }
    }
    return null;
  }
  resolve(event, scopes = []) { return this.match(event, scopes)?.command ?? null; }
  keydown(event, scopes = [], allow = () => true) {
    if (event.defaultPrevented) return false;
    const match = this.match(event, scopes);
    if (!match) return false;
    const {command} = match;
    event.preventDefault();
    if (!allow(command) || (event.repeat && !command.repeat)) return true;
    const code = event.code || event.key;
    if (command.hold) {
      if (this.held.has(code) && !command.repeat) return true;
      this.held.set(code, command);
    }
    this.run(command.id, event, {shift: match.shift});
    return true;
  }
  keyup(event) {
    const code = event.code || event.key, command = this.held.get(code);
    if (!command) return false;
    this.held.delete(code); this.release(command.id, event); return true;
  }
  releaseAll() {
    if (!this.held) return;
    const held = [...this.held.values()]; this.held.clear();
    for (const command of held) this.release(command.id, {cancelled: true});
  }
  label(id) { return shortcutLabel(this.bindings, id, this.mac); }
}
