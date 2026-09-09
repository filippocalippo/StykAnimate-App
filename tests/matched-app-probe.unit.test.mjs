import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

// Execute the actual injected probe with a minimal renderer. This catches
// diagnostic-only failures before reserving a real native/Electron GPU trial.
const harness = await readFile(new URL('./matched-app-interaction.mjs', import.meta.url), 'utf8');
const probeSource = harness.slice(harness.indexOf('async function installProbe('), harness.indexOf('async function startTrace('))
  .replace("const {cameraMatrix} = await import('/src/renderer.mjs');", 'const cameraMatrix = () => [1, 0, 0, 1, 0, 0];');

async function fixture() {
  const listeners = new Map();
  const report = {keyframes: [{objects: []}], figure_types: []};
  const queue = {submit() {}, async onSubmittedWorkDone() {}};
  const renderer = {device: {queue}, stats: {}, width: 1120, height: 652, dpr: 1, layout: [],
    ready: true, expectedBackgrounds: 1, backgroundsReady() {return this.ready;},
    backgroundAssets() {return Array(this.expectedBackgrounds).fill({});},
    render() {queue.submit([]);}};
  const editor = {report, frameIndex: 0, tick: 0, async loadAsync(value) {this.report = value;},
    poseJoint() {}, _emit() {}, selectFrame(index) {this.frameIndex = index;}};
  const state = {renderer, settings: {}, view: {}, importing: false, playing: false};
  const window = {styk: {editor, state}, addEventListener(type, listener) {listeners.set(type, listener);}};
  const context = vm.createContext({window, performance, structuredClone, clearTimeout,
    document: {getElementById() {return {addEventListener() {}};}},
    requestAnimationFrame() {}, PerformanceObserver: class {observe() {}},
  });
  const install = vm.runInContext(`(${probeSource})`, context);
  await install({frameIndex: 0, importView: null});
  const probe = window.__matchedInput;
  probe.trial = 'probe-unit'; probe.imports.push({id: probe.trial, eventAt: performance.now()});
  await editor.loadAsync(report);
  return {renderer, editor, report, probe, listeners,
    async render() {renderer.render({report, frame: report.keyframes[0]}); await Promise.all(probe.pending);}};
}

test('mixed layout keys do not throw and only texture-backed backgrounds qualify', async () => {
  const f = await fixture();
  f.renderer.layout = [{key: 460616, texture: {}}, {key: undefined}, {key: 'figure-1'}, {key: 'background-0'}];
  await f.render();
  const initial = f.probe.imports[0].firstSubmit;
  assert.equal(initial.backgroundLayoutEntries, 1);
  assert.equal(initial.backgroundTextureEntries, 0);
  assert.equal(initial.sceneAssetsReady, false);
  assert.equal(f.probe.imports[0].matchedLastFrameFirstSubmit, undefined);

  f.renderer.layout.at(-1).texture = {};
  await f.render();
  const ready = f.probe.imports[0].matchedLastFrameFirstSubmit;
  assert.ok(ready?.queueCallbackAt);
  assert.equal(ready.backgroundTextureEntries, 1);
  assert.equal(ready.sceneAssetsReady, true);
  assert.notEqual(ready.id, initial.id, 'A partial first submit must not become the ready-frame metric.');
});

test('a texture entry cannot mark the scene complete while image decoding is unfinished', async () => {
  const f = await fixture();
  f.renderer.layout = [{key: 'background-0', texture: {}}];
  f.renderer.ready = false;
  await f.render();
  assert.equal(f.probe.imports[0].firstSubmit.sceneAssetsReady, false);
  assert.equal(f.probe.imports[0].matchedLastFrameFirstSubmit, undefined);
});

test('uncaught errors and rejected promises become explicit probe failures', async () => {
  const f = await fixture();
  f.listeners.get('error')({message: 'layout failed'});
  assert.equal(f.probe.fatalError, 'layout failed');
  f.listeners.get('unhandledrejection')({reason: new Error('decode failed')});
  assert.match(f.probe.fatalError, /decode failed/);
  assert.equal((harness.match(/if \(__matchedInput\.fatalError\) throw new Error\(__matchedInput\.fatalError\);/g) || []).length, 2);
});
