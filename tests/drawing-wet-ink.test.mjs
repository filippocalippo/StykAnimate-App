import test from 'node:test';
import assert from 'node:assert/strict';
import {WetInk} from '../src/drawing-wet-ink.mjs';

/** A viewport and the wet-ink canvas it receives, recording every size the canvas is given. */
function stage() {
  const sizes = [], observers = [];
  let width = 300, height = 150;
  const rect = {width: 800, height: 600};
  const ctx = new Proxy({}, {get: (target, name) => target[name] ?? (() => {}), set: (target, name, value) => { target[name] = value; return true; }});
  const canvas = {
    style: {}, parentElement: null, setAttribute() {}, getContext: () => ctx, remove() {},
    get width() { return width; }, set width(value) { sizes.push(`width ${value}`); width = value; },
    get height() { return height; }, set height(value) { sizes.push(`height ${value}`); height = value; },
  };
  const viewport = {getBoundingClientRect: () => rect, insertBefore(child) { child.parentElement = viewport; }};
  return {sizes, observers, rect, canvas, viewport};
}

test('wet ink is sized when it next draws, not each time the stage resizes', () => {
  const {sizes, observers, rect, canvas, viewport} = stage();
  const saved = {document: globalThis.document, ResizeObserver: globalThis.ResizeObserver};
  globalThis.document = {createElement: () => canvas};
  globalThis.ResizeObserver = class { constructor(callback) { observers.push(callback); } observe() {} disconnect() {} };
  try {
    const ink = new WetInk(viewport, null);
    assert.deepEqual(sizes, [], 'created empty: nothing to size yet');
    // A divider drag between strokes: every step resizes the stage, and the empty wet ink follows none of them.
    for (const width of [780, 760, 740]) { rect.width = width; observers[0](); }
    assert.deepEqual(sizes, []);
    const stroke = [[{x: 10, y: 10, r: 2}, {x: 30, y: 12, r: 2}]];
    ink.draw(stroke, {color: 'black'});
    assert.deepEqual(sizes, ['width 740', 'height 600'], 'the stroke sizes it to the viewport as it is now');
    ink.draw(stroke, {color: 'black'});
    assert.deepEqual(sizes, ['width 740', 'height 600'], 'and only once');
    rect.width = 900;
    observers[0]();
    ink.draw(stroke, {color: 'black'});
    assert.deepEqual(sizes.slice(2), ['width 900'], 'a resize during a stroke reaches its next draw, along the axis that changed');
  } finally { Object.assign(globalThis, saved); }
});
