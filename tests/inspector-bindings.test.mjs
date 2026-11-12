import test from 'node:test';
import assert from 'node:assert/strict';
import {applyInspectorChange, inspectorBindings} from '../src/inspector-bindings.mjs';

// A changed control: `matches` understands the selectors the bindings use.
function control({id = '', name = '', dataset = {}, value = '', checked = false} = {}) {
  const attribute = key => key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  return {
    id, name, dataset, value, checked,
    get valueAsNumber() { return Number(this.value); },
    matches(selector) {
      if (selector.startsWith('#')) return id === selector.slice(1);
      const named = /^\[name="([^"]+)"\]$/.exec(selector);
      if (named) return name === named[1];
      const data = /^\[data-([\w-]+)\]$/.exec(selector);
      if (data) return dataset[attribute(data[1])] !== undefined;
      throw new Error(`unexpected selector ${selector}`);
    },
  };
}

function setup({builder = false} = {}) {
  const calls = [];
  const record = name => (...args) => { calls.push([name, ...args]); };
  const editor = new Proxy({activeLayerId: 'layer-1', selectedUids: new Set([1]), object: {root_x: 10, root_y: 20}}, {
    get: (target, key) => key in target ? target[key] : record(key),
  });
  const state = {rigMode: 'move', applyRange: false};
  const ctx = {
    editor, state, stats: {feature: record('stats.feature')}, guarded: fn => fn, pause: record('pause'),
    finishCurrentEdit: record('finishCurrentEdit'), queueUI: record('queueUI'), requestRender: record('requestRender'), fit: record('fit'),
    changeFigureLayer: async () => true, timeline: () => null, builderActive: () => builder, usesBuilderBranch: () => false,
    updateBuilderStyle: record('updateBuilderStyle'), rangeFrames: () => undefined, selectionBounds: () => ({minX: 0, minY: 0, maxX: 10, maxY: 10}),
    moveSelected: record('moveSelected'), updateSelection: record('updateSelection'), showDialog: record('showDialog'), closeDialog: record('closeDialog'),
  };
  const change = target => applyInspectorChange(inspectorBindings(ctx), {target}, {pause: ctx.pause});
  return {calls, state, change};
}

test('a change pauses playback, then the first binding that matches applies it', () => {
  const {calls, change} = setup();
  change(control({id: 'figure-name', value: 'Bubble'}));
  assert.deepEqual(calls, [['pause'], ['updateFigureStyle', {name: 'Bubble'}]]);
});

test('numeric fields go through the editor command for their key', () => {
  const {calls, change} = setup();
  change(control({dataset: {field: 'scale'}, value: '150'}));
  change(control({dataset: {field: 'root_x'}, value: '42'}));
  assert.deepEqual(calls.filter(([name]) => name !== 'pause'), [['updateObject', {scale: 1.5}], ['updateObject', {root_x: 42}]]);
  assert.throws(() => change(control({dataset: {field: 'scale'}, value: 'x'})), /Enter a finite number/);
});

test('earlier bindings win over the numeric field binding, as before the move', () => {
  const {calls, change} = setup();
  change(control({id: 'segment-color', dataset: {field: 'thickness'}, value: '#ff0000'}));
  assert.deepEqual(calls.filter(([name]) => name !== 'pause').map(([name, patch]) => [name, patch]), [['updateBuilderStyle', {color: '#ff0000'}]]);
});

test('controls that only mean something in Build pass the change on outside it', () => {
  const outside = setup();
  outside.change(control({id: 'builder-joint-name', value: '  Arm  '}));
  assert.deepEqual(outside.calls, [['pause']]);
  const inside = setup({builder: true});
  inside.change(control({id: 'builder-joint-name', value: '  Arm  '}));
  assert.deepEqual(inside.calls, [['pause'], ['updateSegment', {name: 'Arm'}]]);
});

test('state-only controls write the editor state the next render reads', () => {
  const {calls, state, change} = setup();
  change(control({id: 'rig-mode', value: 'rotate'}));
  change(control({id: 'apply-range-movement', checked: true}));
  assert.equal(state.rigMode, 'rotate');
  assert.equal(state.applyRange, true);
  assert.deepEqual(calls.filter(([name]) => name === 'queueUI').length, 1);
});

test('IK controls use their field names and ids', () => {
  const {calls, change} = setup();
  change(control({id: 'node-ik-pinned', checked: true}));
  change(control({name: 'node-ik-bend', value: '-1'}));
  assert.deepEqual(calls.filter(([name]) => name !== 'pause'),
    [['stats.feature', 'ik'], ['setNodeIK', {pinned: true}], ['setNodeIK', {bendDirection: -1}]]);
});

test('a control no binding takes changes nothing but the playback state', () => {
  const {calls, change} = setup();
  assert.equal(change(control({id: 'something-else'})), undefined);
  assert.deepEqual(calls, [['pause']]);
});
