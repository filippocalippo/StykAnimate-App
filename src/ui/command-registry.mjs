import {messageError} from '../localized-error.mjs';
/**
 * The runtime command registry: one view of every command for menus, the
 * command palette, the rail and tooltips, so none of them hand-writes a label,
 * glyph, shortcut or enabled state again.
 *
 * Ids are the existing `actions` keys and HOTKEY_COMMANDS ids, enumerated at
 * run time (actions added later are found too). Metadata merges, weakest
 * first: HOTKEY_COMMANDS (label, scope), command-catalog.mjs (label, glyph,
 * category, keywords, conditions), then define() from the modules that add
 * commands. Live parts are computed on every get(): the shortcut from the
 * user's bindings, availability from the app's `requirements` and
 * `availability` hooks for the current context, and the checked state of
 * toggles. The registry holds no editor state and runs commands only through
 * the app's own dispatch wrapper, so telemetry and gesture guards are unchanged.
 *
 * Shortcuts are shown the way HotkeyManager.match resolves them: in a
 * workspace whose own hotkey scope claims a key (F10 in Build, M in Draw),
 * the general command bound to the same key shows no shortcut there.
 */
import {hotkeyLabelMessage} from '../hotkey-labels.mjs';
import {HOTKEY_COMMANDS, formatBinding, isMacPlatform} from '../hotkeys.mjs';
import {COMMAND_CATALOG, COMMAND_CATEGORIES} from './command-catalog.mjs';
import {kitText, translator} from './ui-strings.mjs';

// The scopes app.mjs (hotkeyScopes) hands to HotkeyManager.match, in its order; 'global' is tried last.
const SCOPE_ORDER = Object.freeze(['drawing', 'polygon', 'hover', 'canvas', 'builder', 'timeline', 'simple', 'library', 'global']);
// The scopes a workspace keeps active whatever has focus: painting in Draw, the figure builder in Build.
export const MODE_SCOPES = Object.freeze({draw: Object.freeze(['drawing']), rig: Object.freeze(['builder'])});
const ARIA_KEYS = Object.freeze({Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']',
  Minus: '-', Equal: '=', Backquote: '`'});
const physical = (binding, mac) => binding.replace('Mod', mac ? 'Meta' : 'Ctrl').split('+').sort().join('+');

/** A binding ('Mod+Shift+KeyZ') in aria-keyshortcuts form ('Control+Shift+Z'). */
export function ariaKeyShortcut(binding, mac = isMacPlatform()) {
  return String(binding).split('+').map(part => (part === 'Mod' ? (mac ? 'Meta' : 'Control') : part === 'Ctrl' ? 'Control'
    : ARIA_KEYS[part] ?? part.replace(/^Key|^Digit|^Numpad/, ''))).join('+');
}

const HOTKEY_CATEGORY = Object.freeze({
  'Project & editing': 'edit', Tools: 'tools', Animation: 'animation', Timeline: 'animation', Filmstrip: 'animation',
  'View & camera': 'view', Canvas: 'canvas', 'Hovered handle': 'figure', 'Figure builder': 'build', Polygon: 'figure',
  Drawing: 'drawing', Library: 'canvas',
});

/** 'zoom-25' → 'Zoom 25': a readable label for an id nothing describes yet. */
export function humanizeId(id) {
  const text = String(id).replace(/[-_]+/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// One folded unit per code point, so match indices are also indices into Array.from(text).
const fold = text => Array.from(String(text), character => (character.normalize('NFD')[0] || character).toLowerCase()[0]);
const isWordStart = (chars, index) => index === 0 || /[\s\-_/(.·,:]/.test(chars[index - 1]);

/**
 * Matches `query` against `text`: whole words and substrings first, then
 * word-start abbreviations ("fh" → "Flip horizontally"). Case- and accent-
 * insensitive. Returns {score, ranges} with ranges as [start, end) code-point
 * indices into `text`, or null when it does not match.
 */
export function fuzzyMatch(query, text) {
  const needle = fold(String(query).trim()), haystack = fold(text);
  if (!needle.length) return {score: 0, ranges: []};
  if (!haystack.length) return null;
  const source = haystack.join(''), words = needle.join('').split(/\s+/).filter(Boolean);
  // Every word of the query as a substring, in any order.
  let score = 0;
  const ranges = [];
  for (const word of words) {
    let at = -1, best = -1;
    while ((at = source.indexOf(word, at + 1)) >= 0) { if (best < 0 || (isWordStart(haystack, at) && !isWordStart(haystack, best))) best = at; if (isWordStart(haystack, at)) break; }
    if (best < 0) { score = -1; break; }
    score += 10 * word.length + (best === 0 ? 30 : isWordStart(haystack, best) ? 20 : 0);
    ranges.push([best, best + word.length]);
  }
  if (score >= 0) return {score: score + (words.length === 1 && needle.length === haystack.length ? 40 : 0) - haystack.length * 0.05, ranges: mergeRanges(ranges)};
  // An abbreviation: the query's characters in order, mostly at word starts or in runs.
  const compact = needle.filter(character => character.trim());
  const found = [];
  let index = 0, bonus = 0;
  for (const character of compact) {
    let at = -1;
    for (let i = index; i < haystack.length; i++) if (haystack[i] === character && isWordStart(haystack, i)) { at = i; break; }
    if (at < 0) at = haystack.indexOf(character, index);
    if (at < 0) return null;
    bonus += isWordStart(haystack, at) ? 6 : found.length && found.at(-1) === at - 1 ? 4 : 0;
    found.push(at);
    index = at + 1;
  }
  if (bonus < compact.length * 3) return null;
  // A short query (four letters or fewer) is an abbreviation only of word starts and runs from them:
  // "fl" finds "Flip layer", never letters scattered over "Make movieclip from frames".
  if (compact.length <= 4 && !found.every((at, index) => isWordStart(haystack, at) || (index > 0 && found[index - 1] === at - 1))) return null;
  return {score: bonus - haystack.length * 0.05, ranges: mergeRanges(found.map(at => [at, at + 1]))};
}

function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]), merged = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]); else merged.push([...range]);
  }
  return merged;
}

export class CommandRegistry extends EventTarget {
  #meta = new Map();
  #runners = new Map();
  #recent = [];
  #missing = new Set();

  /**
   * actions        the app's actions map (read at run time)
   * dispatch       (id, element, event) => result: the app's guarded wrapper; default calls actions[id]
   * runHotkey      (id, event) => result: runs hotkey-only commands (tools, holds, nudges)
   * hotkeys        the HotkeyManager (its bindings are the user's shortcuts)
   * localization   anything with t(key, params): labels, reasons and category names
   * context        () => the UI context (mode, selection, …) that requirements read;
   *                `hotkeyScopes` in it overrides the scopes derived from the mode
   * requirements   {name: context => true | false | 'reason'}: evaluates catalog `requires`
   *                (CATALOG_REQUIREMENTS); a name it lacks makes the command unavailable
   *                and is reported once through onError
   * availability   (id, context) => boolean | {enabled, reason, hidden, label}: a final say per command
   * checked        (id, context) => boolean | undefined: the state of toggle commands
   * formatBinding  shortcut text for one binding (hotkeys.mjs formatBinding)
   */
  constructor({actions = {}, dispatch = null, runHotkey = null, hotkeys = null, localization = null, catalog = COMMAND_CATALOG,
    hotkeyCommands = HOTKEY_COMMANDS, context = () => ({}), requirements = {}, availability = null, checked = null,
    formatBinding: format = binding => formatBinding(binding, hotkeys?.mac ?? isMacPlatform()), maxRecent = 8, onError = error => globalThis.reportError?.(error)} = {}) {
    super();
    Object.assign(this, {actions, dispatch, runHotkey, hotkeys, localization, context, requirements, availability, checkedState: checked,
      format, maxRecent, onError});
    this.t = translator(localization);
    this.hotkeyCommands = new Map(hotkeyCommands.map(command => [command.id, command]));
    // The catalog sets the index order; hotkey metadata only fills what it leaves out.
    for (const entry of catalog) this.#merge(entry.id, entry);
    for (const command of hotkeyCommands)
      this.#meta.set(command.id, {label: command.label, category: HOTKEY_CATEGORY[command.category] ?? 'app', scope: command.scope,
        ...(command.hold ? {palette: false} : {}), ...(hotkeyLabelMessage(command.id)?{labelKey:hotkeyLabelMessage(command.id).key,labelParams:hotkeyLabelMessage(command.id).params}:{}), ...this.#meta.get(command.id), id: command.id});
  }

  /** Adds or extends metadata; `run` registers an executor for an id outside `actions`. */
  define(id, {run, ...meta} = {}) {
    this.#merge(id, meta);
    if (run) this.#runners.set(id, run);
    this.dispatchEvent(new CustomEvent('change', {detail: {id}}));
    return this;
  }

  #merge(id, meta) {
    const current = this.#meta.get(id) ?? {id};
    this.#meta.set(id, {...current, ...Object.fromEntries(Object.entries(meta).filter(([, value]) => value !== undefined)), id});
  }

  has(id) { return this.#meta.has(id) || Object.hasOwn(this.actions, id) || this.#runners.has(id); }

  /** Every known id: catalog, hotkeys, defined commands and the actions present now. */
  ids() { return [...new Set([...this.#meta.keys(), ...Object.keys(this.actions), ...this.#runners.keys()])]; }

  /** The HOTKEY_COMMANDS id whose bindings a command shows, if any. */
  hotkeyId(id) {
    const hotkey = this.#meta.get(id)?.hotkey ?? id;
    return this.hotkeyCommands.has(hotkey) ? hotkey : null;
  }

  #bindings(hotkey) { return this.hotkeys?.bindings?.[hotkey] ?? this.hotkeyCommands.get(hotkey)?.defaults ?? []; }

  /**
   * The bindings that run the command in `context`: the user's, less those a
   * scope the workspace keeps active claims first (HotkeyManager.match tries
   * the active scopes in order, then 'global').
   */
  bindings(id, context = this.#context()) {
    const hotkey = this.hotkeyId(id);
    if (!hotkey) return [];
    const own = this.hotkeyCommands.get(hotkey), mac = this.hotkeys?.mac ?? isMacPlatform();
    const active = context?.hotkeyScopes ?? MODE_SCOPES[context?.mode] ?? [];
    const rank = scope => { const index = SCOPE_ORDER.indexOf(scope); return index < 0 ? SCOPE_ORDER.length : index; };
    const rivals = [...this.hotkeyCommands.values()].filter(other => other.id !== hotkey && other.scope !== own.scope && active.includes(other.scope)
      && rank(other.scope) < rank(own.scope));
    if (!rivals.length) return [...this.#bindings(hotkey)];
    const claimed = new Set();
    for (const other of rivals)
      for (const binding of this.#bindings(other.id)) {
        claimed.add(physical(binding, mac));
        if (other.extraShift && !binding.includes('Shift+')) claimed.add(physical(`Shift+${binding}`, mac));
      }
    return this.#bindings(hotkey).filter(binding => !claimed.has(physical(binding, mac)));
  }

  /** The command's shortcuts in `context`, formatted: ['Ctrl+Shift+Z', 'Ctrl+Y']. */
  shortcutParts(id, context = this.#context()) { return this.bindings(id, context).map(binding => this.format(binding)); }

  /** The first shortcut as display text, '' when the command has none in `context`. */
  shortcut(id, context = this.#context()) { return this.shortcutParts(id, context)[0] ?? ''; }

  /** The shortcuts for aria-keyshortcuts ('Control+Shift+Z Control+Y'). */
  keyShortcuts(id, context = this.#context()) {
    const mac = this.hotkeys?.mac ?? isMacPlatform();
    return this.bindings(id, context).map(binding => ariaKeyShortcut(binding, mac)).join(' ');
  }

  label(id) {
    const meta = this.#meta.get(id);
    if (meta?.labelKey && this.t) {
      const text = this.t(meta.labelKey,meta.labelParams);
      if (text && text !== meta.labelKey) return text;
    }
    return meta?.label ?? humanizeId(id);
  }

  /** A category's name (COMMAND_CATEGORIES), translated when the localization knows its key. */
  categoryLabel(category) {
    const entry = COMMAND_CATEGORIES.find(item => item.id === category);
    if (!entry) return humanizeId(category);
    return entry.labelKey ? kitText(this.t, entry.labelKey) : entry.label;
  }

  /** "In Build": why a command of another workspace is not available here. */
  modeReason(mode) {
    const key = `overlays.mode.${mode}`, name = kitText(this.t, key);
    return kitText(this.t, 'overlays.inMode', {mode: name === key ? humanizeId(mode) : name});
  }

  /** True when running the command would reach an implementation. */
  runnable(id) {
    return typeof this.actions[id] === 'function' || this.#runners.has(id) || Boolean(this.runHotkey && this.hotkeyCommands.has(id));
  }

  /**
   * Everything a surface needs to show a command in `context` (default: the
   * registry's context()): {id, label, icon, category, keywords, shortcut,
   * shortcutParts, keyshortcuts, enabled, reason, hidden, mode, checked,
   * toggle, danger, palette, aliasOf}. `hidden` means it makes no sense here (menus leave it
   * out); a disabled command keeps a reason.
   */
  get(id, context = this.#context()) {
    const meta = this.#meta.get(id) ?? {id};
    const parts = this.shortcutParts(id, context);
    const result = {
      id, label: this.label(id), labelKey: meta.labelKey, icon: meta.icon ?? null, category: meta.category ?? 'app', keywords: meta.keywords ?? [],
      shortcut: parts[0] ?? '', shortcutParts: parts, keyshortcuts: parts.length ? this.keyShortcuts(id, context) : '',
      enabled: true, reason: '', hidden: false, mode: null,
      checked: undefined, toggle: Boolean(meta.toggle), danger: Boolean(meta.danger), palette: meta.palette !== false,
      aliasOf: meta.aliasOf ?? null,
    };
    const disable = reason => { if (result.enabled) { result.enabled = false; result.reason = reason || ''; } };
    if (!this.runnable(id)) disable('');
    if (meta.modes?.length && context?.mode && !meta.modes.includes(context.mode)) {
      result.hidden = true;
      result.mode = meta.modes[0];
      disable(this.modeReason(result.mode));
    }
    for (const name of meta.requires ?? []) {
      const test = this.requirements?.[name];
      let outcome = false;
      // A requirement the app does not answer (or that fails) reads as unavailable: never offer a desktop-only command on the web.
      if (typeof test !== 'function') this.#reportMissing(name);
      else try { outcome = test(context); } catch (error) { this.onError(error); outcome = false; }
      if (outcome === false || typeof outcome === 'string') { disable(typeof outcome === 'string' ? outcome : ''); break; }
    }
    for (const hook of [this.availability ? () => this.availability(id, context) : null, meta.when ? () => meta.when(context) : null]) {
      if (!hook) continue;
      let outcome;
      try { outcome = hook(); } catch (error) { this.onError(error); continue; }
      if (outcome === false) disable('');
      else if (outcome && typeof outcome === 'object') {
        if (outcome.enabled === false) disable(outcome.reason);
        if (outcome.hidden) result.hidden = true;
        if (typeof outcome.label === 'string') result.label = outcome.label;
        if (typeof outcome.checked === 'boolean') result.checked = outcome.checked;
      }
    }
    if (result.toggle && result.checked === undefined) {
      try {
        const state = meta.checked ? meta.checked(context) : this.checkedState?.(id, context);
        if (typeof state === 'boolean') result.checked = state;
      } catch (error) { this.onError(error); }
    }
    return result;
  }

  /**
   * Runs a command the way a click on its control would. `source` is 'menu',
   * 'palette', 'rail', 'hotkey' or 'native'. Returns {ran, reason, result};
   * unavailable commands do not run.
   */
  run(id, {event = null, element = null, source = 'menu', context} = {}) {
    const command = this.get(id, context ?? this.#context());
    if (!command.enabled) return {ran: false, reason: command.reason};
    if (source !== 'hotkey') this.recordRecent(command.aliasOf ?? id);
    let result;
    try {
      if (typeof this.actions[id] === 'function') result = this.dispatch ? this.dispatch(id, element, event) : this.actions[id](element, event);
      else if (this.#runners.has(id)) result = this.#runners.get(id)({event, element, source});
      else result = this.runHotkey(id, event);
    } catch (error) { this.onError(error); return {ran: true, reason: '', result: undefined, error}; }
    if (result && typeof result.then === 'function') result.then(undefined, this.onError);
    return {ran: true, reason: '', result};
  }

  /** Ids of a category in index order, for the app-menu submenus and the palette. */
  commandsIn(category) {
    return this.ids().filter(id => (this.#meta.get(id)?.category ?? 'app') === category);
  }

  /**
   * Palette rows: palette-visible, runnable commands (aliases fold into their
   * target) that match `query`, best first. Without a query the recent
   * commands come first, then every command in category order. Commands
   * outside the current mode stay listed, disabled, with the mode as reason.
   */
  list({query = '', context = this.#context(), limit = Infinity} = {}) {
    const order = new Map(COMMAND_CATEGORIES.map((category, index) => [category.id, index]));
    const ids = this.ids(), position = new Map(ids.map((id, index) => [id, index]));
    const rows = [];
    for (const id of ids) {
      const meta = this.#meta.get(id);
      if (meta?.palette === false || meta?.aliasOf || !this.runnable(id)) continue;
      const command = this.get(id, context);
      if (!query) { rows.push({...command, match: null, score: 0}); continue; }
      let match = fuzzyMatch(query, command.label);
      if (!match) {
        // A keyword on its own, or words spread over the label and keywords ("flip mirror").
        const best = [...command.keywords, [command.label, ...command.keywords].join(' ')].map(text => fuzzyMatch(query, text))
          .filter(Boolean).sort((x, y) => y.score - x.score)[0];
        if (best) match = {score: best.score * 0.6, ranges: []};
      }
      // Commands that cannot run here (another workspace, nothing selected) stay findable, below those that can.
      if (match) rows.push({...command, match, score: (command.enabled ? match.score : match.score / 2) + (this.#recent.includes(id) ? 8 : 0)});
    }
    const recency = id => { const index = this.#recent.indexOf(id); return index < 0 ? Infinity : index; };
    rows.sort(query
      ? (a, b) => b.score - a.score || recency(a.id) - recency(b.id) || position.get(a.id) - position.get(b.id)
      : (a, b) => recency(a.id) - recency(b.id) || (order.get(a.category) ?? 99) - (order.get(b.category) ?? 99) || position.get(a.id) - position.get(b.id));
    return rows.slice(0, limit);
  }

  /**
   * Menu items (ui-menu.mjs) from a model of ids: 'undo', null (separator),
   * {label: 'Group'} (group label), {command, ...overrides} and
   * {label, icon, submenu: model | () => model}. Commands hidden in this context
   * are left out; the rest carry their label, glyph, shortcut, checked state and
   * reason.
   */
  items(model, context = this.#context()) {
    const items = [];
    for (const item of model) {
      if (item === null || item === '-') { items.push(null); continue; }
      const spec = typeof item === 'string' ? {command: item} : item;
      if (spec.submenu) {
        const submenu = spec.submenu;
        items.push({...spec, submenu: typeof submenu === 'function' ? () => this.items(submenu(), this.#context()) : this.items(submenu, context)});
        continue;
      }
      if (!spec.command) { items.push(spec); continue; }
      const command = this.get(spec.command, context);
      if (command.hidden && spec.hidden !== false) continue;
      items.push({
        command: command.id, label: command.label, icon: command.icon, shortcut: command.shortcut, danger: command.danger,
        ...(command.keyshortcuts ? {keyshortcuts: command.keyshortcuts} : {}),
        disabled: !command.enabled, reason: command.reason,
        ...(command.toggle ? {checked: Boolean(command.checked)} : {}),
        ...spec,
      });
    }
    return items;
  }

  /** Remembers a command for the palette's recent group (most recent first). */
  recordRecent(id) {
    this.#recent = [id, ...this.#recent.filter(other => other !== id)].slice(0, this.maxRecent);
    this.dispatchEvent(new CustomEvent('recent-change', {detail: {recent: this.recent()}}));
  }

  recent() { return [...this.#recent]; }

  /** Restores saved recents (unknown ids are dropped). */
  setRecent(ids = []) { this.#recent = [...new Set(ids)].filter(id => this.has(id)).slice(0, this.maxRecent); }

  #context() {
    try { return this.context?.() ?? {}; } catch (error) { this.onError(error); return {}; }
  }

  #reportMissing(name) {
    if (this.#missing.has(name)) return;
    this.#missing.add(name);
    this.onError(messageError(new Error(''), "errors.commandRegistry.theCommandRequirementHasNoTestInThe", {name: name}));
  }
}

export function createCommandRegistry(options) { return new CommandRegistry(options); }
