import test from 'node:test';
import assert from 'node:assert/strict';
import {createInvalidator, UI_REASONS} from '../src/ui/ui-invalidation.mjs';
import {setAttr, setFlag, setHidden, setMarkup, setProp, setText, setVar} from '../src/ui/dom-write.mjs';

function harness({playing = false} = {}) {
  const frames = [], timers = [], log = [];
  const clock = {time: 0, playing, passes: 0};
  const ui = createInvalidator({
    schedule: callback => frames.push(callback), delay: (callback, ms) => timers.push({at: clock.time + ms, callback}),
    now: () => clock.time, isPlaying: () => clock.playing, afterPass: () => log.push('render'),
  });
  const frame = () => { const pending = frames.splice(0); clock.passes += pending.length; for (const callback of pending) callback(); };
  /** Moves the clock to `time`, firing the timers that come due on the way. */
  const advance = time => {
    for (const timer of timers.filter(timer => timer.at <= time).sort((a, b) => a.at - b.at)) {
      timers.splice(timers.indexOf(timer), 1);
      clock.time = timer.at;
      timer.callback();
    }
    clock.time = time;
  };
  const surface = (name, options = {}) => ui.surface(name, {on: ['all-of-them'].includes(name) ? [] : ['selection'], ...options, update: () => log.push(name)});
  return {ui, frames, timers, log, clock, frame, advance, surface};
}

test('an invalidation schedules one pass that updates the marked surfaces in declaration order', () => {
  const {ui, frames, log, frame, surface} = harness();
  surface('title', {on: ['document']});
  surface('inspector', {on: ['selection', 'revision']});
  surface('shell', {on: ['mode', 'selection']});
  ui.invalidate('selection');
  ui.invalidate('selection', 'revision');
  assert.equal(frames.length, 1, 'one pass per frame');
  frame();
  assert.deepEqual(log, ['inspector', 'shell', 'render']);
  ui.invalidate('all');
  frame();
  assert.deepEqual(log.slice(3), ['title', 'inspector', 'shell', 'render']);
  assert.equal(ui.invalidate('playback'), false, 'a reason no surface listens for schedules nothing');
  assert.equal(frames.length, 0);
});

test('quiet surfaces wait for playback to stop, and the transport updates at most every 200 ms while playing', () => {
  const {ui, log, clock, frame, advance, surface} = harness({playing: true});
  surface('transport', {on: ['tick'], playbackInterval: 200});
  surface('inspector', {on: ['selection'], quiet: true});
  for (let t = 0; t <= 1000; t += 1000 / 24) { advance(t); ui.invalidate('all'); frame(); }
  const updates = log.filter(entry => entry === 'transport').length;
  assert.ok(updates >= 5 && updates <= 6, `transport updated ${updates} times in one second`);
  assert.equal(log.includes('inspector'), false, 'quiet while playing');
  assert.equal(ui.isDirty('inspector'), true);
  clock.playing = false;
  ui.invalidate('all');
  frame();
  assert.equal(log.filter(entry => entry === 'inspector').length, 1, 'updated once playback stopped');
  assert.equal(ui.isDirty('inspector'), false);
});

test('a throttled surface keeps its mark and runs when its time comes', () => {
  const {ui, frames, timers, log, clock, frame, advance, surface} = harness({playing: true});
  surface('transport', {on: ['tick'], playbackInterval: 200});
  ui.update('transport');
  clock.time = 50;
  assert.equal(ui.update('transport'), false, 'too soon while playing');
  assert.equal(frames.length, 0, 'no pass while it waits');
  assert.deepEqual(timers.map(timer => timer.at), [200], 'one wake-up for when it is due');
  ui.invalidate('tick');
  frame();
  assert.equal(log.filter(entry => entry === 'transport').length, 1);
  assert.equal(timers.length, 1, 'waiting again sets no second wake-up');
  advance(150);
  assert.equal(frames.length, 0);
  advance(210);
  assert.equal(frames.length, 1, 'the wake-up schedules one pass');
  frame();
  assert.equal(log.filter(entry => entry === 'transport').length, 2, 'the waiting update ran once due');
  assert.equal(ui.isDirty('transport'), false);
  clock.playing = false;
  clock.time = 215;
  assert.equal(ui.update('transport'), true, 'no interval outside playback');
});

test('playback at display rate repaints only after a pass that updated something', () => {
  // The render loop at 144 Hz playing 24 fps for 2 s: each new animation frame seeks (queueUI marks
  // everything) and every 200 ms the loop updates the readout itself. The transport waits between its
  // updates and every other surface is quiet, so a pass that finds only waiting surfaces must not repaint.
  const {ui, log, clock, frame, advance, surface} = harness({playing: true});
  surface('title', {on: ['document'], quiet: true});
  surface('transport', {on: ['tick'], playbackInterval: 200});
  surface('inspector', {on: ['selection', 'tick'], quiet: true});
  let nextTick = 0, lastReadout = -Infinity;
  for (let t = 0; t < 2000; t += 1000 / 144) {
    advance(t);
    if (t >= nextTick) { ui.invalidate('all'); nextTick += 1000 / 24; }
    if (t - lastReadout > 200) { ui.update('transport'); lastReadout = t; }
    frame();
  }
  const updates = log.filter(entry => entry === 'transport').length, renders = log.filter(entry => entry === 'render').length;
  assert.ok(updates >= 9 && updates <= 11, `transport updated ${updates} times in 2 s`);
  assert.ok(renders <= updates, `afterPass ran ${renders} times for ${updates} transport updates`);
  assert.ok(clock.passes <= 48 + updates + 2, `${clock.passes} passes in 2 s for 48 animation frames`);
  assert.equal(log.includes('inspector') || log.includes('title'), false, 'quiet while playing');
});

test('hidden surfaces stay marked and update when shown', () => {
  const {ui, log, frame, surface} = harness();
  let visible = false;
  surface('vfx', {on: ['selection'], visible: () => visible});
  ui.invalidate('selection');
  frame();
  assert.deepEqual(log, [], 'a pass that updated nothing does not repaint');
  assert.equal(ui.isDirty('vfx'), true);
  visible = true;
  ui.show('vfx');
  assert.deepEqual(log, ['vfx']);
  ui.show('vfx');
  assert.deepEqual(log, ['vfx'], 'nothing to do once clean');
});

test('a full refresh updates every surface, quiet ones included', () => {
  const {ui, log, clock, surface} = harness();
  surface('title', {on: ['document']});
  surface('inspector', {on: ['selection'], quiet: true});
  clock.playing = true;
  assert.equal(ui.flushAll(), true);
  assert.deepEqual(log, ['title', 'inspector', 'render'], 'a full refresh ignores quiet');
  assert.deepEqual(ui.stats(), {title: 1, inspector: 1});
});

test('surfaces are declared once with known reasons', () => {
  const {ui} = harness();
  ui.surface('title', {on: ['document'], update() {}});
  assert.throws(() => ui.surface('title', {on: [], update() {}}), /already declared/);
  assert.throws(() => ui.surface('other', {on: ['nonsense'], update() {}}), /Unknown invalidation reason/);
  assert.ok(UI_REASONS.includes('tick') && UI_REASONS.includes('selection'));
});

// dom-write: a minimal element that records writes.
function element() {
  const writes = [];
  const attributes = new Map(), classes = new Set(), style = new Map();
  let text = '', hidden = false, html = '';
  return {
    writes,
    get textContent() { return text; }, set textContent(value) { writes.push('text'); text = value; },
    get hidden() { return hidden; }, set hidden(value) { writes.push('hidden'); hidden = value; },
    get innerHTML() { return html; }, set innerHTML(value) { writes.push('html'); html = value; },
    value: '24',
    hasAttribute: name => attributes.has(name), getAttribute: name => attributes.get(name) ?? null,
    setAttribute(name, value) { writes.push(`@${name}`); attributes.set(name, value); },
    removeAttribute(name) { writes.push(`-@${name}`); attributes.delete(name); },
    classList: {contains: name => classes.has(name), toggle(name, on) { writes.push(`.${name}`); if (on) classes.add(name); else classes.delete(name); }},
    style: {getPropertyValue: name => style.get(name) ?? '', setProperty(name, value) { writes.push(`style ${name}`); style.set(name, value); }, removeProperty(name) { writes.push(`unstyle ${name}`); style.delete(name); }},
  };
}

// A DOM-like host whose child list can be observed: removing and inserting a node
// is what makes the browser re-evaluate :has() rules, so a lone text node must
// keep its identity when a readout changes.
function textHost(...children) {
  const host = {replaced: 0, children,
    get firstChild() { return this.children[0] ?? null; }, get lastChild() { return this.children.at(-1) ?? null; },
    get textContent() { return this.children.map(child => child.nodeType === 3 ? child.data : '').join(''); },
    set textContent(value) { this.replaced++; this.children = value === '' ? [] : [{nodeType: 3, data: value}]; }};
  return host;
}

test('setText rewrites a lone text node in place and replaces every other shape', () => {
  const host = textHost();
  assert.equal(setText(host, 'FRAME 01'), true);
  const node = host.firstChild;
  assert.equal(host.replaced, 1, 'the first text creates the node');
  assert.equal(setText(host, 'FRAME 02'), true);
  assert.equal(setText(host, 'FRAME 03'), true);
  assert.equal(host.replaced, 1, 'later readouts do not remove or insert nodes');
  assert.equal(host.firstChild, node); assert.equal(node.data, 'FRAME 03'); assert.equal(host.textContent, 'FRAME 03');
  assert.equal(setText(host, 'FRAME 03'), false);
  assert.equal(setText(host, ''), true);
  assert.deepEqual(host.children, [], 'clearing removes the node');
  const mixed = textHost({nodeType: 1}, {nodeType: 3, data: 'x'});
  assert.equal(setText(mixed, 'y'), true);
  assert.equal(mixed.replaced, 1, 'an element with other children is replaced as before');
  assert.equal(mixed.textContent, 'y');
  const element = textHost({nodeType: 1});
  assert.equal(setText(element, 'z'), true);
  assert.equal(element.replaced, 1, 'a lone element child is replaced, not treated as text');
});

test('dom-write writes only what differs', () => {
  const node = element();
  assert.equal(setText(node, '00:01'), true);
  assert.equal(setText(node, '00:01'), false);
  assert.equal(setAttr(node, 'aria-pressed', 'true'), true);
  assert.equal(setAttr(node, 'aria-pressed', 'true'), false);
  assert.equal(setAttr(node, 'disabled', true), true);
  assert.equal(setAttr(node, 'disabled', false), true);
  assert.equal(setAttr(node, 'disabled', null), false);
  assert.equal(setFlag(node, 'active', true), true);
  assert.equal(setFlag(node, 'active', 1), false);
  assert.equal(setHidden(node, false), false);
  assert.equal(setHidden(node, true), true);
  assert.equal(setProp(node, 'value', '24'), false);
  assert.equal(setProp(node, 'value', '30'), true);
  assert.equal(setVar(node, '--x', '4px'), true);
  assert.equal(setVar(node, '--x', '4px'), false);
  assert.equal(setVar(node, '--x', null), true);
  assert.equal(setMarkup(node, '<svg></svg>'), true);
  assert.equal(setMarkup(node, '<svg></svg>'), false);
  assert.equal(setText(null, 'x'), false);
  assert.deepEqual(node.writes, ['text', '@aria-pressed', '@disabled', '-@disabled', '.active', 'hidden', 'style --x', 'unstyle --x', 'html']);
});
