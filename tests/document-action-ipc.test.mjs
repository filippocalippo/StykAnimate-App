import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const main = await readFile(new URL('../desktop/main.cjs', import.meta.url), 'utf8');
const guard = main.slice(main.indexOf('function documentActionCurrent('), main.indexOf('function registerIpc('));
const windowHandler = main.slice(main.indexOf("handle('styk:window',"), main.indexOf("handle('styk:window-state',"));
const restartHandler = main.slice(main.indexOf("handle('styk:update-restart',"), main.indexOf('  const withStats ='));

function host() {
  const state = {revision: 'document:1:0:3', dirty: false, name: 'Animation'}, calls = {closed: 0, restarted: 0, updateRequests: 0, actions: []};
  const hooks = {stage: async () => {}, stats: async () => {}, dialog: async () => ({response: 1})};
  const handlers = new Map();
  const context = vm.createContext({documentState: state,
    handle(channel, handler) {handlers.set(channel, handler);}, trusted() {}, t: key => key,
    sendAction(action) {calls.actions.push(action);}, messageError: error => error,
    window: {close() {calls.closed++;}}, windowState: () => ({closed: calls.closed > 0}),
    dialog: {showMessageBox: () => hooks.dialog()}, stats: {close: () => hooks.stats()},
    updates: {async restart(prepare) {calls.updateRequests++; await hooks.stage(); if (!await prepare()) return false; calls.restarted++; return true;}},
  });
  vm.runInContext(`let statsClosed = false, quitting = false; ${guard}\n${windowHandler}\n${restartHandler}`, context);
  return {state, calls, hooks, close: checkpoint => handlers.get('styk:window')({}, 'close', checkpoint),
    restart: checkpoint => handlers.get('styk:update-restart')({}, checkpoint)};
}

test('saved-document close accepts only the exact published clean checkpoint', () => {
  const a = host(), checkpoint = {revision: a.state.revision, saved: true};
  assert.equal(a.close({...checkpoint, revision: 'older'}), false); assert.equal(a.calls.closed, 0);
  a.state.dirty = true; assert.equal(a.close(checkpoint), false); assert.equal(a.calls.closed, 0);
  a.state.dirty = false; a.close(checkpoint); assert.equal(a.calls.closed, 1);
});

test('malformed close/restart checkpoints cannot authorize closing saved work', async () => {
  for (const checkpoint of [null, {}, {revision: 3, saved: true}, {revision: 'document:1:0:3', saved: 'yes'}]) {
    const a = host(); assert.equal(a.close(checkpoint), false); assert.equal(await a.restart(checkpoint), false);
    assert.equal(a.calls.closed + a.calls.restarted + a.calls.updateRequests, 0);
  }
});

test('ordinary Close keeps the existing desktop unsaved-work prompt path', () => {
  const a = host(); a.state.dirty = true; a.close(); assert.equal(a.calls.closed, 1);
});

test('restart refuses a checkpoint superseded while staging an update', async () => {
  const a = host(), checkpoint = {revision: a.state.revision, saved: true};
  a.hooks.stage = async () => {a.state.revision = 'document:1:0:4';};
  assert.equal(await a.restart(checkpoint), false); assert.equal(a.calls.restarted, 0);
});

test('restart rechecks dirty state and mutation epoch after statistics close', async () => {
  for (const mutate of [state => {state.dirty = true;}, state => {state.revision = 'document:1:0:4';}]) {
    const a = host(), checkpoint = {revision: a.state.revision, saved: true};
    a.hooks.stats = async () => {mutate(a.state);};
    assert.equal(await a.restart(checkpoint), false); assert.equal(a.calls.restarted, 0);
  }
});

test('ordinary restart still sends Save and Restart through the renderer save action', async () => {
  const a = host(); a.state.dirty = true; a.hooks.dialog = async () => ({response: 0});
  assert.equal(await a.restart(), false); assert.deepEqual(a.calls.actions, ['save-and-update']); assert.equal(a.calls.restarted, 0);
});

test('preload forwards optional close/restart checkpoints through existing narrow channels', async () => {
  const calls = [], preload = await readFile(new URL('../desktop/preload.cjs', import.meta.url), 'utf8');
  let api;
  vm.runInNewContext(preload, {process: {platform: 'win32'}, require(name) {
    assert.equal(name, 'electron');
    return {contextBridge: {exposeInMainWorld(_name, value) {api = value;}}, webFrame: {},
      ipcRenderer: {sendSync() {return 0;}, invoke(...args) {calls.push(args); return Promise.resolve(false);}}};
  }});
  const checkpoint = {revision: 'document:1:0:3', saved: true};
  assert.equal(await api.close(checkpoint), false); assert.equal(await api.restartForUpdate(checkpoint), false);
  assert.deepEqual(calls, [['styk:window', 'close', checkpoint], ['styk:update-restart', checkpoint]]);
});
