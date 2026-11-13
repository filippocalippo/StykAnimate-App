/**
 * Roving tabindex: a toolbar, rail, tab list or menubar is one tab stop and the
 * arrow keys move inside it. nextRovingIndex() is the pure key model;
 * installRovingFocus() keeps tabindex in step with the focused item.
 */
import {setAttr} from './dom-write.mjs';

const KEYS = Object.freeze({
  horizontal: {ArrowRight: 1, ArrowLeft: -1},
  vertical: {ArrowDown: 1, ArrowUp: -1},
  both: {ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1},
});

/**
 * The index a key moves to, or null when the key is not a navigation key for
 * this orientation. `skip(index)` excludes items (hidden or disabled); `loop`
 * wraps at the ends. Returns the current index when nothing else is reachable.
 */
export function nextRovingIndex(key, index, count, {orientation = 'horizontal', loop = true, skip = () => false} = {}) {
  if (count <= 0) return null;
  const available = i => i >= 0 && i < count && !skip(i);
  const scan = (from, step) => {
    for (let i = from, seen = 0; seen < count; seen++, i += step) {
      if (loop) i = (i % count + count) % count; else if (i < 0 || i >= count) return null;
      if (available(i)) return i;
    }
    return null;
  };
  if (key === 'Home') return scan(0, 1);
  if (key === 'End') return scan(count - 1, -1);
  const step = KEYS[orientation]?.[key];
  if (!step) return null;
  const found = scan(index < 0 ? (step > 0 ? 0 : count - 1) : index + step, step);
  return found ?? (available(index) ? index : null);
}

/**
 * Makes the items of `container` one tab stop. `items` is a selector or a
 * function returning the elements (read on every key, so items may change).
 * Hidden, disabled and inert items are skipped. Returns {refresh, focus, index}.
 */
export function installRovingFocus(container, {items = 'button', orientation = 'horizontal', loop = true, signal, onMove = null} = {}) {
  const list = () => (typeof items === 'function' ? [...items()] : [...container.querySelectorAll(items)]);
  const skipped = element => element.disabled || element.hidden || Boolean(element.closest?.('[hidden],[inert]'));
  let current = null;
  const activate = (element, focus = false) => {
    const all = list();
    if (!all.includes(element)) return;
    current = element;
    // Refreshed on every chrome update: an item that already has its tabindex is not written again.
    for (const item of all) setAttr(item, 'tabindex', item === element ? '0' : '-1');
    if (focus) element.focus({preventScroll: true});
  };
  const refresh = () => {
    const all = list();
    const keep = all.includes(current) && !skipped(current) ? current : all.find(item => !skipped(item));
    if (keep) activate(keep); else current = null;
  };
  container.addEventListener('focusin', event => {
    const item = list().find(element => element === event.target || element.contains(event.target));
    if (item && item !== current) activate(item);
  }, {signal});
  container.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const all = list(), index = all.findIndex(element => element === event.target || element.contains(event.target));
    if (index < 0) return;
    const next = nextRovingIndex(event.key, index, all.length, {orientation, loop, skip: i => skipped(all[i])});
    if (next === null || next === index) return;
    event.preventDefault();
    activate(all[next], true);
    onMove?.(all[next], next, event);
  }, {signal});
  refresh();
  return {
    refresh,
    focus(target = current) {
      const element = typeof target === 'number' ? list()[target] : target;
      if (element) activate(element, true);
    },
    get index() { return list().indexOf(current); },
    get current() { return current; },
  };
}
