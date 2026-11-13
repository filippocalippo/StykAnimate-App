import {replaceLocalized, descriptorAttributes, localizedAttribute, localizedMarkup, appendLocalized} from '../localization-bindings.mjs';

import {t as interfaceText} from '../localization.mjs';

/**
 * The stage's modifier buttons (docs/TOUCH.md): what the right mouse button
 * and the Shift, Ctrl and Alt keys do during a drag, for fingers and pens.
 *
 * A small column in the stage's corner under the thumb, named for what each
 * does with the current tool (MODIFIER_SETS): in Animate, Bend is the right
 * button, Stretch is Ctrl, Add is Shift and Transform is Alt; Draw's brush has
 * Line, Pick and Size. Tap a button to latch it (it stays on until tapped
 * again, or until the tool changes); hold it while another finger drags for a
 * one-off. The column folds to one round button; while anything is on, that
 * button shows it.
 *
 * While a modifier is on, the stage's touch and pen events are sent on as the
 * editor's desktop handlers expect them: the right button pressed, the keys
 * held. The trusted event is stopped at #viewport (capture) and a copy with
 * the modifiers goes to the same target, so posing, bending, stretching,
 * selecting and drawing keep one implementation. A held key without a mouse
 * equivalent (Handles: hold R) runs through `setHeld(command, down)`.
 * A mouse keeps its own buttons and keys.
 */
import {icon} from '../icons.mjs';
import {setAttr, setHidden, setText} from '../ui/dom-write.mjs';

/** A modifier: what it adds to the stage's events ({button: 2} or a key), its name and glyph. */
const MODIFIERS = Object.freeze({
  bend: {secondary: true, label: interfaceText("modifierDock.bend"), labelKey: "modifierDock.bend", icon: 'bend', hint: interfaceText("modifierDock.dragAJointToBendItTheRight")},
  stretch: {ctrl: true, label: interfaceText("modifierDock.stretch"), labelKey: "modifierDock.stretch", icon: 'stretch-horizontal', hint: interfaceText("modifierDock.dragAJointToChangeItsLengthCtrl")},
  add: {shift: true, label: interfaceText("modifierDock.add"), labelKey: "modifierDock.add", icon: 'plus', hint: interfaceText("modifierDock.tapFiguresToAddThemToTheSelection")},
  transform: {alt: true, label: interfaceText("modifierDock.transform"), labelKey: "modifierDock.transform", icon: 'transform', hint: interfaceText("modifierDock.dragAJointToRotateAndScaleThe")},
  handles: {held: 'handle-edit-hold', label: interfaceText("modifierDock.handles"), labelKey: "modifierDock.handles", icon: 'nodes', hint: interfaceText("modifierDock.dragJointsToMoveTheirHandlesHoldR")},
  depth: {held: 'depth-hold', label: interfaceText("modifierDock.depth"), labelKey: "modifierDock.depth", icon: 'depth', hint: interfaceText("modifierDock.dragA3dPartTowardOrAwayFrom")},
  line: {shift: true, label: interfaceText("modifierDock.line"), labelKey: "modifierDock.line", icon: 'line', hint: interfaceText("modifierDock.aStraightLineFromTheLastStrokeShift")},
  pick: {alt: true, label: interfaceText("modifierDock.pick"), labelKey: "modifierDock.pick", icon: 'eyedropper', hint: interfaceText("modifierDock.pickAColourFromTheCanvasAlt")},
  size: {ctrl: true, label: interfaceText("modifierDock.size"), labelKey: "modifierDock.size", icon: 'maximize', hint: interfaceText("modifierDock.dragToResizeTheBrushCtrl")},
  subtract: {alt: true, label: interfaceText("modifierDock.subtract"), labelKey: "modifierDock.subtract", icon: 'minus', hint: interfaceText("modifierDock.removeFromTheSelectionAlt")},
  snap: {shift: true, label: interfaceText("modifierDock.snap"), labelKey: "modifierDock.snap", icon: 'magnet', hint: interfaceText("modifierDock.snapAnglesTo15Shift")},
});

/**
 * The buttons each workspace's tool shows, in order. Tools missing here (Pan)
 * show none.
 */
export const MODIFIER_SETS = Object.freeze({
  animate: {select: ['bend', 'stretch', 'add', 'transform', 'handles'], pose: ['bend', 'stretch', 'add', 'transform', 'handles'],
    tweener: ['add'], rig: ['bend', 'stretch']},
  rig: {select: ['bend', 'stretch', 'add'], rig: ['bend', 'stretch', 'add'], line: ['bend', 'add'], chain: ['bend', 'add'],
    circle: ['bend', 'add'], polygon: ['add']},
  draw: {'drawing-brush': ['line', 'pick', 'size'], 'drawing-eraser': ['line', 'size'], 'drawing-fill': ['pick'],
    'drawing-lasso': ['add', 'subtract'], 'drawing-shape': ['snap'], 'drawing-transform': ['add']},
});

/**
 * The modifier names a workspace's tool offers ([] for none). `spatial`: the selected figure has 3D parts, which
 * Animate's posing tools can move in depth.
 */
export function modifiersFor(workspace, tool, {spatial = false} = {}) {
  const names = [...(MODIFIER_SETS[workspace]?.[tool] ?? [])];
  if (spatial && workspace === 'animate' && (tool === 'select' || tool === 'pose')) names.push('depth');
  return names;
}

/**
 * The event properties a set of active modifier names adds: {secondary, shift,
 * ctrl, alt} (pure).
 */
export function combinedModifiers(names) {
  const result = {secondary: false, shift: false, ctrl: false, alt: false};
  for (const name of names) {
    const modifier = MODIFIERS[name];
    if (!modifier) continue;
    for (const key of ['secondary', 'shift', 'ctrl', 'alt']) if (modifier[key]) result[key] = true;
  }
  return result;
}

/**
 * The init of a PointerEvent copy of `event` with `modifiers` applied (pure
 * over the event's properties): the keys held; with `secondary`, the right
 * button for the press and release and the right button held while it moves.
 */
export function shapedPointerInit(event, modifiers) {
  const init = {};
  for (const key of ['bubbles', 'cancelable', 'composed', 'clientX', 'clientY', 'screenX', 'screenY', 'movementX', 'movementY', 'pointerId',
    'pointerType', 'isPrimary', 'pressure', 'tangentialPressure', 'tiltX', 'tiltY', 'twist', 'width', 'height', 'detail', 'view'])
    if (event[key] !== undefined) init[key] = event[key];
  init.shiftKey = Boolean(event.shiftKey || modifiers.shift);
  init.ctrlKey = Boolean(event.ctrlKey || modifiers.ctrl);
  init.metaKey = Boolean(event.metaKey);
  init.altKey = Boolean(event.altKey || modifiers.alt);
  init.button = event.button;
  init.buttons = event.buttons;
  if (modifiers.secondary) {
    if (event.type === 'pointerdown' || event.type === 'pointerup') init.button = event.button === 0 ? 2 : event.button;
    if (event.buttons & 1) init.buttons = (event.buttons & ~1) | 2;
  }
  return init;
}

const SHAPED = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'];

/**
 * installModifierDock({touch, workspace, viewport, host, context, setHeld})
 *   touch     the touch mode: the dock shows only while it is on
 *   host      where the dock goes (the workspace grid; layout/touch.css places it on the stage)
 *   context() {workspace: 'animate' | 'draw' | 'rig', tool, spatial (the selection has 3D parts)}
 *   setHeld(command, down)  a held key without a mouse equivalent
 * Returns {sync(), active, destroy()}; call sync() when the selection changes (its 3D parts offer Depth).
 */
export function installModifierDock({touch, host, viewport, context, setHeld = () => {}, document: doc = viewport.ownerDocument,
  window: win = doc.defaultView ?? globalThis} = {}) {
  const abort = new AbortController(), signal = abort.signal;
  const latched = new Set(), held = new Set();
  let offered = [], expanded = false, lastKey = '';

  const dock = doc.createElement('div');
  dock.className = 'touch-modifiers';
  dock.setAttribute('role', 'toolbar');
  localizedAttribute(dock, 'aria-label', "modifierDock.modifiers", {});
  dock.setAttribute('aria-orientation', 'vertical');
  dock.hidden = true;
  const list = doc.createElement('div');
  list.className = 'touch-modifiers-list';
  const toggle = doc.createElement('button');
  toggle.type = 'button';
  toggle.className = 'touch-modifiers-toggle';
  toggle.setAttribute('aria-expanded', 'false');
  localizedAttribute(toggle, 'aria-label', "modifierDock.modifiers", {});
  localizedMarkup(toggle, `${icon('modifiers')}<span class="touch-modifiers-state"></span>`);
  appendLocalized(dock, list, toggle);
  appendLocalized(host, dock);
  const stateLabel = toggle.querySelector('.touch-modifiers-state');

  const active = () => new Set([...latched, ...held]);
  const buttons = new Map();
  function button(name) {
    if (buttons.has(name)) return buttons.get(name);
    const spec = MODIFIERS[name];
    const node = doc.createElement('button');
    node.type = 'button';
    node.className = 'touch-modifier';
    node.dataset.modifier = name;
    node.setAttribute('aria-pressed', 'false');
    node.dataset.tooltip = spec.hint;
    localizedMarkup(node, `${icon(spec.icon)}<span${descriptorAttributes(spec, "label")}>${spec.label}</span>`);
    node.setAttribute('aria-label', spec.label);
    // Tap latches; a press held while another finger works on the stage is a one-off.
    let press = null;
    node.addEventListener('pointerdown', event => {
      event.preventDefault();
      press = {id: event.pointerId, time: event.timeStamp, used: false};
      try { node.setPointerCapture(event.pointerId); } catch { /* the pointer already left */ }
      held.add(name);
      if (MODIFIERS[name].held) setHeld(MODIFIERS[name].held, true);
      render();
    }, {signal});
    const release = event => {
      if (press?.id !== event.pointerId) return;
      const quick = event.type === 'pointerup' && event.timeStamp - press.time < 350 && !press.used;
      press = null;
      held.delete(name);
      if (quick) { if (latched.has(name)) latched.delete(name); else latched.add(name); }
      if (MODIFIERS[name].held && !latched.has(name)) setHeld(MODIFIERS[name].held, false);
      render();
    };
    node.addEventListener('pointerup', release, {signal});
    node.addEventListener('pointercancel', release, {signal});
    // A click without a pointer (the keyboard, assistive technology) latches too.
    node.addEventListener('click', event => {
      if (event.detail !== 0) return;
      if (latched.has(name)) latched.delete(name); else latched.add(name);
      if (MODIFIERS[name].held) setHeld(MODIFIERS[name].held, latched.has(name));
      render();
    }, {signal});
    node._press = () => press;
    buttons.set(name, node);
    return node;
  }

  function render() {
    const on = active();
    for (const [name, node] of buttons) setAttr(node, 'aria-pressed', String(on.has(name)));
    const names = offered.filter(name => on.has(name)).map(name => MODIFIERS[name].label);
    setText(stateLabel, names.join(' · '));
    setAttr(toggle, 'data-active', names.length > 0);
    localizedAttribute(toggle, 'aria-label', (names.length ? 'modifierDock.modifiersValue' : "modifierDock.modifiers"), (names.length ? {value: names.join(', ')} : {}));
    setAttr(dock, 'data-expanded', expanded);
    setAttr(toggle, 'aria-expanded', String(expanded));
    setHidden(list, !expanded);
  }

  function clear() {
    for (const name of latched) if (MODIFIERS[name]?.held) setHeld(MODIFIERS[name].held, false);
    latched.clear();
  }

  /** Follows the workspace and tool: the offered buttons change, and a latched modifier ends with its tool. */
  function sync() {
    const {workspace, tool, spatial = false} = context?.() ?? {};
    const names = touch?.active ? modifiersFor(workspace, tool, {spatial}) : [];
    const key = `${workspace}|${tool}|${names.join(',')}`;
    if (key !== lastKey) {
      if (lastKey) clear();
      lastKey = key;
      offered = names;
      replaceLocalized(list, ...names.map(button));
    }
    setHidden(dock, !names.length);
    render();
  }

  toggle.addEventListener('click', () => { expanded = !expanded; render(); }, {signal});

  // The stage's events, shaped while a modifier is on (see the module comment).
  const shape = event => {
    if (!event.isTrusted || event.pointerType === 'mouse' || !touch?.active) return;
    const on = active();
    if (!on.size) return;
    // A finger on a modifier button is its own; the stage's other fingers are the ones shaped.
    for (const node of buttons.values()) { const press = node._press(); if (press) press.used = true; }
    const modifiers = combinedModifiers(on);
    event.stopImmediatePropagation();
    const copy = new win.PointerEvent(event.type, shapedPointerInit(event, modifiers));
    const cancelled = !event.target.dispatchEvent(copy);
    if (cancelled && event.cancelable) event.preventDefault();
  };
  for (const type of SHAPED) viewport.addEventListener(type, shape, {capture: true, signal});

  // The workspace's mode and the rail's current tool (its `.active` button) say which buttons to offer.
  const workspaceElement = host.closest?.('.workspace') ?? host;
  const observer = new win.MutationObserver(() => sync());
  observer.observe(workspaceElement, {attributes: true, attributeFilter: ['data-mode']});
  const rail = workspaceElement.querySelector?.('.shell-rail');
  if (rail) observer.observe(rail, {attributes: true, attributeFilter: ['class'], subtree: true});
  const stop = touch?.on?.(() => sync());
  sync();

  return {
    sync,
    element: dock,
    /** The modifier names on now (latched or held). */
    get active() { return [...active()]; },
    /** Latches or releases a modifier, as a tap on its button does. */
    set(name, on) { if (on) latched.add(name); else latched.delete(name); render(); },
    destroy() { abort.abort(); observer.disconnect(); stop?.(); clear(); dock.remove(); },
  };
}
