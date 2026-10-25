import {replaceLocalized, localizedText, localizedAttribute, appendLocalized} from '../localization-bindings.mjs';

import {t as interfaceText, messageText} from '../localization.mjs';

/**
 * Quick actions: the selection's most used commands, one quiet row of 28px
 * buttons under the inspector's name (components.md "Quick actions",
 * experience.md §5.1, architecture.md §3.13). The row is the same component in
 * every context; each button is a registry command whose context menus list
 * it too (experience.md §8, rule 10: a visible home plus menu aliases), and it
 * runs through the app's [data-action] click delegation like any other
 * control.
 *
 * Budget: at most five defaults in at most three groups (separated by space,
 * never dividers), plus a sixth slot kept for a pin. A second pin takes the
 * last default's place; a displaced default stays in the context's menu, so
 * nothing is lost. Words where glyphs are hard to tell apart: an entry may
 * ask for its word ("To front"), a command without a glyph shows its word,
 * and when two glyphs in one row are the same drawing the later ones become
 * words. A label that belongs to glyphs shares one sunken tile with them
 * ("Match ◀ ▶").
 *
 * Entries are command metadata with a `quick` placement (one object or a
 * list, for a command in several contexts):
 *   {id, quick: {context, group, order, word, wordKey, label, labelKey,
 *                tile, tileKey, shift, shiftHint, shiftHintKey, menu}}
 *   context    the selection kind ('figure', 'joint', 'part', …; QUICK_CONTEXTS)
 *   group      the cluster it sits in; groups follow QUICK_CONTEXTS' order
 *   word       true or the word to show instead of the glyph
 *   label      the accessible name when it differs from the command's label
 *   tile       the quiet label of a tile shared with the next entries of the tile
 *   shift      data-shift-action; shiftHint says what Shift does ("one step")
 *   menu       the button opens a menu (a chevron after its word)
 * QUICK_ACTIONS holds today's defaults; features add entries, not layout.
 *
 * resolveQuickActions() is pure; createQuickActions() is the thin DOM half
 * (the inspector kit's `.ui-quick` slot, or a row of its own).
 */
import {installRovingFocus} from './roving-focus.mjs';

export const QUICK_LIMITS = Object.freeze({defaults: 5, slots: 6, groups: 3});
/** The group pinned commands form, after the defaults. */
export const PIN_GROUP = 'pins';

export function quickText(t, key, fallback = null, params = {}) {
  return key ? messageText(t, key, params) : fallback ?? '';
}

/**
 * The contexts and their group order. `label` names the row (its toolbar's
 * accessible name). Several figures, text and images use the figure's row.
 */
export const QUICK_CONTEXTS = Object.freeze({
  figure: Object.freeze({labelKey: 'quick.figure', groups: Object.freeze(['flip', 'order', 'edit'])}),
  figures: Object.freeze({labelKey: 'quick.figure', groups: Object.freeze(['flip', 'order', 'edit'])}),
  text: Object.freeze({labelKey: 'quick.text', groups: Object.freeze(['flip', 'order', 'edit'])}),
  image: Object.freeze({labelKey: 'quick.image', groups: Object.freeze(['flip', 'order', 'edit'])}),
  joint: Object.freeze({labelKey: 'quick.joint', groups: Object.freeze(['order', 'flip'])}),
  movieclip: Object.freeze({labelKey: 'quick.movieclip', groups: Object.freeze(['clip', 'edit'])}),
  part: Object.freeze({labelKey: 'quick.part', groups: Object.freeze(['make', 'flip', 'delete'])}),
  // Build with the figure itself selected (no part): add an image part, start from an example, fit the figure.
  build: Object.freeze({labelKey: 'quick.build', groups: Object.freeze(['add', 'rig', 'view'])}),
  // Level and Centre · Reset · Motion ▾ (the Motion menu joins when it is a registry entry).
  camera: Object.freeze({labelKey: 'quick.camera', groups: Object.freeze(['frame', 'reset', 'motion'])}),
  // The Advanced timeline's frame range: Copy frames, Paste frames · Remove keys, Delete frames.
  range: Object.freeze({labelKey: 'quick.range', groups: Object.freeze(['clipboard', 'remove'])}),
});

const FIGURES = ['figure', 'figures', 'text', 'image'];
const place = (contexts, placement) => contexts.map(context => Object.freeze({context, ...placement}));
const entry = (id, quick) => Object.freeze({id, quick: Object.freeze(Array.isArray(quick) ? quick : [Object.freeze(quick)])});

/**
 * Today's quick actions per context (experience.md §5.1), keyed by the
 * existing command ids. Commands that are not registry entries yet (the
 * layer row's moves and Delete layer, the camera's Motion menu, motion clips,
 * Build fills) join when their owners register them.
 *
 * Glyphs the icon set still owes (icons.mjs; experience.md §5.1 and §5.12):
 * Exact values uses `sliders`, which draws as `settings` (revision 4.3 asks
 * for a ruler with a typed angle), and Copy shares Duplicate's drawing
 * (Duplicate is to be the copy with a plus). Each row here still has distinct
 * drawings, which the budget test checks.
 */
/** The one short word under a glyph command's tile (its tooltip and accessible name keep the whole name). */
const SHORT_WORDS = Object.freeze({
  mirror: interfaceText("quickActions.flip"), duplicate: interfaceText("quickActions.duplicate"), delete: "Delete", 'segment-values': interfaceText("quickActions.values"), 'mirror-segment': interfaceText("quickActions.flipH"),
  'mirror-segment-vertical': interfaceText("quickActions.flipV"), 'delete-single-segment': "Delete", 'camera-reset': interfaceText("quickActions.reset"), copy: interfaceText("quickActions.copy"), paste: interfaceText("quickActions.paste"),
  'delete-frame': "Delete",
});
/** Commands that remove something: their tile turns red on hover. */
const SHORT_WORD_KEYS = Object.freeze({mirror:'quickActions.flip', duplicate:'common.duplicate', delete:'common.delete', 'segment-values':'quickActions.values', 'mirror-segment':'quickActions.flipH', 'mirror-segment-vertical':'quickActions.flipV', 'delete-single-segment':'common.delete', 'camera-reset':'common.reset', copy:'common.copy', paste:'common.paste', 'delete-frame':'common.delete'});
const DANGER = new Set(['delete', 'delete-single-segment', 'delete-frame', 'clear-keys']);
const shortWord = item => SHORT_WORDS[item.id] ?? (item.label.length <= 10 ? item.label : item.label.split(' ')[0]);

export const QUICK_ACTIONS = Object.freeze([
  entry('mirror', [...place(FIGURES, {group: 'flip'}), Object.freeze({context: 'joint', group: 'flip', label: interfaceText("quickActions.flipLimb"), labelKey: 'quick.flipLimb'})]),
  entry('layer-front', place(FIGURES, {group: 'order', word: interfaceText("quickActions.front"), wordKey: 'quick.front', shift: 'layer-up', shiftHint: 'one step', shiftHintKey: 'quick.oneStep'})),
  entry('layer-back', place(FIGURES, {group: 'order', word: interfaceText("quickActions.back"), wordKey: 'quick.back', shift: 'layer-down', shiftHint: 'one step', shiftHintKey: 'quick.oneStep'})),
  entry('movieclip-edit', {context: 'movieclip', group: 'clip', word: interfaceText("quickActions.editClip"), wordKey: 'quick.editClip'}),
  entry('movieclip-unique', {context: 'movieclip', group: 'clip', word: interfaceText("quickActions.makeUnique"), wordKey: 'quick.makeUnique'}),
  entry('duplicate', place([...FIGURES, 'movieclip'], {group: 'edit'})),
  entry('delete', place([...FIGURES, 'movieclip'], {group: 'edit'})),
  entry('selection-front', {context: 'joint', group: 'order', word: interfaceText("quickActions.front"), wordKey: 'quick.front',
    shift: 'selection-up', shiftHint: 'one step', shiftHintKey: 'quick.oneStep'}),
  entry('selection-back', {context: 'joint', group: 'order', word: interfaceText("quickActions.back"), wordKey: 'quick.back',
    shift: 'selection-down', shiftHint: 'one step', shiftHintKey: 'quick.oneStep'}),
  entry('split-segment', {context: 'part', group: 'make', word: interfaceText("quickActions.split"), wordKey: 'quick.split'}),
  entry('duplicate-segment', {context: 'part', group: 'make', word: interfaceText("quickActions.duplicate"), wordKey: 'quick.duplicatePart',
    shift: 'duplicate-branch', shiftHint: 'the branch', shiftHintKey: 'quick.theBranch'}),
  entry('mirror-segment', {context: 'part', group: 'flip', shift: 'mirror-branch', shiftHint: 'the branch', shiftHintKey: 'quick.theBranch'}),
  entry('mirror-segment-vertical', {context: 'part', group: 'flip', shift: 'mirror-branch-vertical', shiftHint: 'the branch', shiftHintKey: 'quick.theBranch'}),
  entry('delete-single-segment', {context: 'part', group: 'delete', shift: 'delete-segment', shiftHint: 'the branch', shiftHintKey: 'quick.theBranch'}),
  entry('add-sprite-segment', {context: 'build', group: 'add', word: interfaceText("quickActions.image"), wordKey: 'quick.imagePart'}),
  entry('auto-rig-image', {context: 'build', group: 'add', word: 'Auto-Rig'}),
  entry('rig-connect', {context: 'build', group: 'rig', word: interfaceText("quickActions.connect"), wordKey: 'quick.connect'}),
  entry('rig-examples', {context: 'build', group: 'add', word: interfaceText("quickActions.examples"), wordKey: 'quick.examples'}),
  entry('zoom-selection', {context: 'build', group: 'view', word: interfaceText("quickActions.fit"), wordKey: 'quick.fit'}),
  entry('camera-level', {context: 'camera', group: 'frame', word: interfaceText("quickActions.level"), wordKey: 'quick.level'}),
  entry('camera-center', {context: 'camera', group: 'frame', word: interfaceText("quickActions.center"), wordKey: 'quick.center'}),
  entry('camera-reset', {context: 'camera', group: 'reset'}),
  entry('copy', {context: 'range', group: 'clipboard', label: interfaceText("quickActions.copyFrames"), labelKey: 'quick.copyFrames'}),
  entry('paste', {context: 'range', group: 'clipboard', label: interfaceText("quickActions.pasteFrames"), labelKey: 'quick.pasteFrames'}),
  // Labelled: the poses go and the time stays; Delete frames (the trash) takes the time too.
  entry('clear-keys', {context: 'range', group: 'remove', word: interfaceText("quickActions.removeKeys"), wordKey: 'quick.removeKeys'}),
  entry('delete-frame', {context: 'range', group: 'remove'}),
]);

/** An entry's quick placements as a list (a command may sit in several contexts). */
export function quickPlacements(item) {
  const quick = item?.quick;
  if (!quick) return [];
  return (Array.isArray(quick) ? quick : [quick]).filter(placement => placement && typeof placement.context === 'string');
}

/**
 * A context's declared quick actions in row order: groups in the context's
 * order (QUICK_CONTEXTS), then in order of first declaration; inside a group
 * by `order`, then declaration.
 */
export function quickDefaults(entries = [], context, {contexts = QUICK_CONTEXTS} = {}) {
  const rows = [];
  entries.forEach((item, position) => {
    for (const placement of quickPlacements(item)) if (placement.context === context) rows.push({...placement, id: item.id, position});
  });
  const declared = contexts?.[context]?.groups ?? [];
  const groupRank = new Map(declared.map((group, index) => [group, index]));
  for (const row of rows) {
    const group = row.group ?? row.id;
    if (!groupRank.has(group)) groupRank.set(group, groupRank.size + declared.length);
  }
  return rows.sort((a, b) => groupRank.get(a.group ?? a.id) - groupRank.get(b.group ?? b.id)
    || (a.order ?? 0) - (b.order ?? 0) || a.position - b.position);
}

/**
 * The row for `context`: {context, items, groups, displaced, overflow,
 * problems}. `describe(id)` returns the registry's description of a command
 * in this context ({label, icon, shortcut, keyshortcuts, enabled, reason,
 * hidden, toggle, checked}) or null for an unknown command; `drawing(icon)`
 * says what a glyph draws (the DOM layer compares SVG content, so two names for
 * one drawing count as one glyph). Hidden commands
 * leave the row (the next default does not move up past the five). `pins`
 * are this context's pinned ids, oldest first. Items carry {id, group,
 * pinned, kind: 'glyph' | 'word' | 'tile', label, word, tile, icon, shift,
 * shiftHint, menu, shortcut, keyshortcuts, enabled, reason, toggle, checked}.
 * `displaced` lists defaults a pin took the place of, `overflow` defaults over
 * the budget; `problems` explains budget and glyph violations for audits.
 */
export function resolveQuickActions({entries = QUICK_ACTIONS, context, pins = [], describe = () => null, t = null, limits = QUICK_LIMITS,
  contexts = QUICK_CONTEXTS, drawing = icon => icon} = {}) {
  const problems = [];
  const info = id => { try { return describe(id) ?? null; } catch { return null; } };
  const declared = quickDefaults(entries, context, {contexts});
  const known = new Set(entries.map(item => item.id));
  const defaults = [], overflow = [];
  for (const row of declared) {
    const command = info(row.id);
    if (command?.hidden) continue;
    if (defaults.length >= limits.defaults) { overflow.push(row.id); continue; }
    defaults.push({row, command});
  }
  if (overflow.length) problems.push(`${context}: more than ${limits.defaults} quick actions; ${overflow.join(', ')} stay in the menu`);
  const groupCount = new Set(defaults.map(({row}) => row.group ?? row.id)).size;
  if (groupCount > limits.groups) problems.push(`${context}: ${groupCount} groups; at most ${limits.groups}`);

  const shown = new Set(defaults.map(({row}) => row.id)), pinned = [];
  for (const id of pins ?? []) {
    if (pinned.length >= limits.slots) break;
    if (typeof id !== 'string' || shown.has(id)) continue;   // a pinned default is already in the row
    const command = info(id);
    if ((!command && !known.has(id)) || command?.hidden) continue;   // removed since it was pinned, or not for this selection
    shown.add(id);
    pinned.push({row: {id, group: PIN_GROUP}, command, pinned: true});
  }
  const keep = Math.max(0, Math.min(defaults.length, limits.slots - pinned.length));
  const displaced = defaults.slice(keep).map(({row}) => row.id);

  const items = [...defaults.slice(0, keep), ...pinned].map(({row, command, pinned: isPinned = false}) => {
    const label = row.label || row.labelKey ? quickText(t, row.labelKey, row.label) : command?.label ?? row.id;
    const word = typeof row.word === 'string' || row.wordKey ? quickText(t, row.wordKey, typeof row.word === 'string' ? row.word : label) : null;
    const icon = row.icon ?? command?.icon ?? null;
    const kind = row.tile ? 'tile' : row.word || !icon ? 'word' : 'glyph';
    return {
      labelKey: row.labelKey ?? command?.labelKey, labelParams: row.labelParams, wordKey: row.wordKey ?? SHORT_WORD_KEYS[row.id] ?? row.labelKey ?? command?.labelKey, wordParams: row.wordParams,
      id: row.id, group: row.group ?? row.id, pinned: isPinned, kind, label, word: kind === 'word' ? word ?? label : null,
      tile: row.tile ? quickText(t, row.tileKey, row.tile) : null, icon, menu: Boolean(row.menu),
      shift: row.shift ?? null, shiftHint: row.shift ? quickText(t, row.shiftHintKey, row.shiftHint ?? info(row.shift)?.label ?? row.shift) : null,
      shortcut: command?.shortcut ?? '', keyshortcuts: command?.keyshortcuts ?? '', enabled: command ? command.enabled !== false : true,
      reason: command?.reason ?? '', toggle: Boolean(command?.toggle), checked: command?.checked,
    };
  });

  // One glyph per concept in a row: the later copies of a drawing become words.
  const seen = new Map();
  for (const item of items) {
    if (item.kind === 'word') continue;
    let key = item.icon;
    try { key = drawing(item.icon) ?? item.icon; } catch { /* compare by name */ }
    const first = seen.get(key);
    if (!first) { seen.set(key, item); continue; }
    problems.push(`${context}: ${first.id} and ${item.id} share the glyph ${item.icon}`);
    if (item.kind === 'glyph') { item.kind = 'word'; item.word = item.label; }
  }

  const groups = [];
  for (const item of items) {
    const last = groups.at(-1);
    if (last && last[0].group === item.group) last.push(item); else groups.push([item]);
  }
  return {context, items, groups, displaced, overflow, problems};
}

/** The row's accessible name for a context. */
export function quickLabel(context, {t = null, contexts = QUICK_CONTEXTS} = {}) {
  const meta = contexts?.[context];
  return meta ? quickText(t, meta.labelKey, meta.label) : quickText(t, null, interfaceText("quickActions.actions"));
}

/** Pins as stored per workspace ({context: [ids]}): `id` pinned last in `context`, at most `max` kept (the newest). */
export function pinQuickAction(pins = {}, context, id, {max = QUICK_LIMITS.slots} = {}) {
  const list = [...(pins?.[context] ?? []).filter(other => other !== id), id].slice(-max);
  return {...pins, [context]: list};
}

/** Pins without `id` in `context`; a context left with none is dropped. */
export function unpinQuickAction(pins = {}, context, id) {
  const list = (pins?.[context] ?? []).filter(other => other !== id);
  const next = {...pins};
  if (list.length) next[context] = list; else delete next[context];
  return next;
}

/**
 * Budget problems of a set of entries, per context (≤ 5 defaults, ≤ 3 groups,
 * one glyph per concept): a list of messages, empty when the set is within it.
 */
export function quickBudgetProblems(entries = QUICK_ACTIONS, {describe = () => null, contexts = QUICK_CONTEXTS, limits = QUICK_LIMITS, drawing} = {}) {
  const names = new Set(entries.flatMap(item => quickPlacements(item).map(placement => placement.context)));
  return [...names].flatMap(context => resolveQuickActions({entries, context, describe, contexts, limits, drawing}).problems);
}

// ---------------------------------------------------------------------------
// DOM

function setAttribute(element, name, value) {
  if (value === null || value === undefined || value === false || value === '') { if (element.hasAttribute(name)) element.removeAttribute(name); return; }
  const text = value === true ? '' : String(value);
  if (element.getAttribute(name) !== text) element.setAttribute(name, text);
}

const rowKey = resolved => JSON.stringify(resolved.items.map(item => [item.id, item.kind, item.group, item.label, item.word, item.tile, item.icon,
  item.pinned, item.menu, item.shift]));

/**
 * The tooltip's key text for a control: `keys` (the registry's shortcut; default
 * data-hotkey-hint) and what Shift does (data-shift-hint: "Delete · Shift: the
 * branch"). The app's tooltip `shortcut` callback wraps its own lookup with it:
 * the Shift hint lives in its own attribute because refreshHotkeyHints()
 * rewrites data-hotkey-hint in the inspector on every render.
 */
export function withShiftHint(element, keys = element?.dataset?.hotkeyHint) {
  return [keys, element?.dataset?.shiftHint].filter(Boolean).join(' · ');
}

/**
 * createQuickActions({host, context, label, entries, pins, registry,
 * commandContext, icon, t, document}) → {element, update({context, label,
 * pins, entries}), refresh(), resolved, destroy()}.
 *
 *   host            an existing `.ui-quick` element (the inspector kit's slot,
 *                   data-quick-context); otherwise a row is created. The kit
 *                   renders one slot per context (data-inspector-owned=
 *                   quick-<context>), so the owner creates one instance per
 *                   slot element and destroys it with that slot; update({context})
 *                   is for a row the instance created itself
 *   registry        the command registry: labels, glyphs, shortcuts, enabled
 *                   and checked states in `commandContext()`
 *   pins            this context's pinned ids (the layout store's `pins`)
 *
 * The buttons carry data-action (and data-shift-action, with data-shift-hint
 * for the tooltip: withShiftHint), so the app's click delegation runs them; a
 * disabled button's tooltip says why. refresh() writes enabled and checked states without
 * rebuilding the row; a different set of buttons rebuilds it. The row is one
 * tab stop; the arrow keys move between its buttons. It never wraps or cuts a
 * button: when pinned words leave too little room at the inspector's width,
 * the last defaults give up their places (resolved.displaced; they stay in
 * the context's menu).
 */
export function createQuickActions({host = null, context = null, label = null, entries = QUICK_ACTIONS, pins = [], registry = null, commandContext = null,
  icon = null, t = null, contexts = QUICK_CONTEXTS, document: doc = host?.ownerDocument ?? globalThis.document} = {}) {
  const controller = new AbortController(), {signal} = controller;
  const created = !host;
  const element = host ?? doc.createElement('div');
  element.classList.add('ui-quick');
  element.setAttribute('role', 'toolbar');
  let current = {context: context ?? element.dataset.quickContext ?? null, label, pins: [...(pins ?? [])], entries};
  let resolved = null, key = '';

  const describe = id => {
    if (!registry?.get || (registry.has && !registry.has(id))) return null;
    try { return registry.get(id, typeof commandContext === 'function' ? commandContext() : undefined); } catch { return null; }
  };
  function appendGlyph(parent, name, className = 'ui-icon') {
    if (!name || typeof icon !== 'function') return false;
    const glyph = icon(name, className);
    if (typeof glyph === 'string' && glyph) parent.insertAdjacentHTML('beforeend', glyph);
    else if (glyph?.nodeType) appendLocalized(parent, glyph);
    else return false;
    return true;
  }
  // What a glyph draws: two icon names with one drawing are one glyph (components.md: one glyph per concept, by SVG content).
  const drawing = name => {
    if (typeof icon !== 'function') return name;
    const glyph = icon(name, '');
    return typeof glyph === 'string' ? glyph : glyph?.outerHTML ?? name;
  };
  function button(item, {small = false} = {}) {
    const word = item.kind === 'word';
    const control = doc.createElement('button');
    control.type = 'button';
    // A tile in the row: its glyph over one short word, so what it does is visible (a tile's halves stay glyphs).
    control.className = small ? 'ui-icon-button' : 'ui-button ui-quick-word';
    if (small) control.dataset.size = 'sm';
    else { control.dataset.size = 'sm'; control.dataset.variant = 'ghost'; }
    if (DANGER.has(item.id)) control.dataset.tone = 'danger';
    control.dataset.action = item.id;
    if (item.shift) control.dataset.shiftAction = item.shift;
    control.dataset.concept = item.id;
    if (item.pinned) control.dataset.pinned = '';
    if (small) {
      if (!appendGlyph(control, item.icon)) control.textContent = item.label;
      control.setAttribute('aria-label', item.label);
    } else {
      appendGlyph(control, item.icon);
      const text = doc.createElement('span');
      text.className = 'ui-label';
      text.textContent = word ? item.word : shortWord(item);
      if (item.wordKey) localizedText(text, item.wordKey, item.wordParams);
      appendLocalized(control, text);
      // A glyph command keeps its whole name as its accessible name; a word command is named by its word.
      if (!word) control.setAttribute('aria-label', item.label);
      if (item.menu) { control.setAttribute('aria-haspopup', 'menu'); appendGlyph(control, 'chevron-down', 'ui-icon ui-button-chev'); }
    }
    if (item.labelKey && (small || !word)) localizedAttribute(control, 'aria-label', item.labelKey, item.labelParams);
    sync(control, item);
    return control;
  }
  function sync(control, item) {
    setAttribute(control, 'data-hotkey-hint', item.shortcut);
    setAttribute(control, 'data-shift-hint', item.shift ? quickText(t, 'quick.shift', null, {action: item.shiftHint}) : null);
    setAttribute(control, 'aria-keyshortcuts', item.keyshortcuts);
    if (item.toggle) setAttribute(control, 'aria-pressed', String(Boolean(item.checked))); else setAttribute(control, 'aria-pressed', null);
    const disabled = !item.enabled;
    if (control.disabled !== disabled) control.disabled = disabled;
    // The tooltip names the whole command (a word may be shorter) and, while it is unavailable, why.
    const tip = disabled && item.reason ? quickText(t, 'quick.unavailable', null, {label: item.label, reason: item.reason})
      : item.label;
    setAttribute(control, 'data-tooltip', tip);
    if (item.labelKey) localizedAttribute(control, 'data-tooltip', disabled && item.reason ? 'quick.unavailable' : item.labelKey, disabled && item.reason ? {label: {messageKey: item.labelKey, messageParams: item.labelParams}, reason: item.reason} : item.labelParams);
  }

  function render() {
    const focused = element.contains(doc.activeElement) ? doc.activeElement.dataset.action : null;
    const children = [];
    resolved.groups.forEach((group, index) => {
      if (index) {
        const sep = doc.createElement('span');
        sep.className = 'ui-quick-sep';
        sep.setAttribute('aria-hidden', 'true');
        children.push(sep);
      }
      let tile = null;
      for (const item of group) {
        if (item.kind !== 'tile') { tile = null; children.push(button(item)); continue; }
        if (!tile || tile.dataset.tile !== item.tile) {
          tile = doc.createElement('span');
          tile.className = 'ui-quick-tile';
          tile.dataset.tile = item.tile;
          tile.setAttribute('role', 'group');
          tile.setAttribute('aria-label', item.tile);
          const text = doc.createElement('span');
          text.className = 'ui-quick-label';
          text.setAttribute('aria-hidden', 'true');
          text.textContent = item.tile;
          appendLocalized(tile, text);
          children.push(tile);
        }
        appendLocalized(tile, button(item, {small: true}));
      }
    });
    replaceLocalized(element, ...children);
    element.hidden = resolved.items.length === 0;
    roving.refresh();
    if (focused) [...element.querySelectorAll('button')].find(control => control.dataset.action === focused)?.focus({preventScroll: true});
  }

  // The row never wraps, scrolls or cuts a button: when pinned words leave too little room, the last defaults
  // give up their places (they stay in the context's menu) until it fits. A wider inspector tries the full row.
  let slots = QUICK_LIMITS.slots, width = -1, frame = 0;
  const overflowing = () => element.isConnected && element.getClientRects().length > 0 && element.scrollWidth > element.clientWidth + 0.5;

  function resolve({fit = true} = {}) {
    resolved = resolveQuickActions({entries: current.entries, context: current.context, pins: current.pins, describe, t, contexts, drawing,
      limits: {...QUICK_LIMITS, slots}});
    setAttribute(element, 'aria-label', current.label ?? quickLabel(current.context, {t, contexts}));
    setAttribute(element, 'data-quick-context', current.context);
    const next = rowKey(resolved), rebuilt = next !== key;
    if (rebuilt) { key = next; render(); } else {
      const controls = [...element.querySelectorAll('button[data-action]')];
      resolved.items.forEach((item, index) => { if (controls[index]) sync(controls[index], item); });
      roving.refresh();
    }
    // Only a new set of buttons can change the row's width (a resize refits through refit()), so a refresh of
    // states reads no layout.
    if (fit && rebuilt) while (slots > 1 && overflowing()) { slots--; resolve({fit: false}); }
  }
  function refit() {
    frame = 0;
    const now = element.clientWidth;
    if (now === width || !element.getClientRects().length) return;
    width = now;
    slots = QUICK_LIMITS.slots;
    resolve();
  }

  const roving = installRovingFocus(element, {items: () => element.querySelectorAll('button'), orientation: 'horizontal', signal});
  const view = doc.defaultView ?? globalThis;
  const resize = view.ResizeObserver ? new view.ResizeObserver(() => { frame ||= view.requestAnimationFrame(refit); }) : null;
  resize?.observe(element);
  signal.addEventListener('abort', () => { resize?.disconnect(); if (frame) view.cancelAnimationFrame(frame); }, {once: true});
  resolve();
  return {
    element,
    /** A new context, label, pins or entries (only the fields given change; pins are per context, so a new context without them has none). */
    update(next = {}) {
      const moved = next.context !== undefined && next.context !== current.context;
      current = {...current, ...Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined))};
      if (next.pins) current.pins = [...next.pins];
      else if (moved) current.pins = [];
      slots = QUICK_LIMITS.slots;
      resolve();
    },
    /** States only: after the selection or a toggle changed what the commands can do. */
    refresh() { resolve(); },
    get resolved() { return resolved; },
    destroy() {
      controller.abort();
      if (created) element.remove(); else replaceLocalized(element);
    },
  };
}
