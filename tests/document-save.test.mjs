import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import {DocumentSave, RecoveryDeadline, documentCheckpoint, matchesDocumentCheckpoint} from '../src/document-save.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject}; };
const source = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');
const saveSource = source.slice(source.indexOf('function saveNative('), source.indexOf('function showDialog(', source.indexOf('function saveNative(')));
const recoverySource = source.slice(source.indexOf('function scheduleRecovery('), source.indexOf('function offerRecovery(', source.indexOf('function scheduleRecovery(')));
const changeAt = source.indexOf('editor.addEventListener("change", (e) => {');
const epochSource = source.slice(source.indexOf('  const kind = e.detail?.kind;', changeAt), source.indexOf("  if ((['toggle-selection'", changeAt));

/** Exercise the application's actual save/close functions with staged I/O. */
function app({browser = false} = {}) {
  const editor = {report: {}, revision: 1, dirty: true, name: 'Animation', markSaved() {this.dirty = false;}};
  const state = {documentToken: 'document-1'}, manualSave = new DocumentSave(), recoveryDeadline = new RecoveryDeadline();
  const calls = {pickers: 0, writes: 0, committed: 0, closed: 0, restarted: 0, failed: [], statuses: [], cleared: []};
  // One open project: the list of open projects reports the editor's own state.
  const projects = {tabs: {activeId: 'project-1'}, summary: () => ({open: 1, unsaved: editor.dirty ? 1 : 0, unsavedName: editor.dirty ? editor.name : '', stamp: 0}),
    saveAll: async save => !editor.dirty || save()};
  const hooks = {write: async () => {}, cleanup: async () => {}, picker: async () => {}, flushPreferences: async () => {}, flushSettings: async () => {}, publish: async () => {}, close: async () => {}};
  const desktop = browser ? null : {
    beginProjectWrite() {}, async deleteRecovery(target) {calls.cleared.push(target); await hooks.cleanup();},
    async setDocumentState(value) {await hooks.publish(value);},
    async close(checkpoint) {calls.closed++; return hooks.close(checkpoint);}, async restartForUpdate() {calls.restarted++;},
  };
  const context = vm.createContext({editor, state, manualSave, recoveryDeadline, projects,
    documentCheckpoint, matchesDocumentCheckpoint, AbortController, DOMException,
    navigator: {userActivation: {isActive: true}},
    exportFlow: {async openExportSink() {calls.pickers++; return hooks.picker();}},
    drawingController: {async barrier() {}}, drawingBarrier: async () => {},
    finishCurrentEdit() {}, interruptRecovery() {}, updateTitle() {}, scheduleRecovery() {}, scheduleProjectPicture() {},
    telemetry: {}, status(value) {calls.statuses.push(value);}, fail(error) {calls.failed.push(error);},
    interfaceText: value => value, notify() {}, messageError: error => error,
    desktop, browserRecovery: {clear: slot => { calls.cleared.push(slot); return hooks.cleanup(); }},
    async writeNativeBlob(_desktop, _blob, {signal}) {calls.writes++; await hooks.write(); if (signal.aborted) throw new DOMException('', 'AbortError'); calls.committed++; return true;},
    async runDocumentExport(_format, consume, {controller}) {return consume({}, controller.signal);},
    workspaceLayout: {flushPreferences: () => hooks.flushPreferences()},
    editorSettings: {flush: () => hooks.flushSettings()},
  });
  const functions = vm.runInContext(`let savingDocument = false, lastSave = null, saveMutationEpoch = 0, finalizingDocument = false, recoveredEpoch = -1;\n${saveSource}\nfunction editorChanged(e) {${epochSource}}\n({saveNative, finishDocumentAction, saveEveryProjectThen, checkpoint: () => lastSave, emitChange: kind => editorChanged({detail: {kind}})})`, context);
  return {editor, state, calls, hooks, projects, ...functions};
}

test('duplicate Save input joins one native write, including the pending chooser', async () => {
  const a = app(), held = deferred(); a.hooks.write = () => held.promise;
  const first = a.saveNative(); await Promise.resolve(); await Promise.resolve();
  const duplicate = a.saveNative();
  assert.equal(duplicate, first);
  assert.equal(await a.saveNative({saveAs: true}), false);
  held.resolve(); assert.equal(await first, true);
  assert.equal(a.calls.writes, 1); assert.equal(a.calls.committed, 1); assert.equal(a.editor.dirty, false);
  assert.equal(await a.saveNative(), true, 'a completed request releases ownership immediately');
  assert.equal(a.calls.writes, 2);
});

test('browser picker runs in the input task and duplicate requests join its result', async () => {
  const a = app({browser: true}), held = deferred(); a.hooks.picker = () => held.promise;
  const first = a.saveNative(), duplicate = a.saveNative();
  assert.equal(a.calls.pickers, 1); assert.equal(first, duplicate);
  held.resolve(null); assert.equal(await first, false); assert.equal(a.editor.dirty, true);
});

test('a changed revision cannot join an older in-flight Save or become marked saved', async () => {
  const a = app(), held = deferred(); a.hooks.write = () => held.promise;
  const first = a.saveNative();
  for (let i = 0; i < 10 && !a.calls.writes; i++) await Promise.resolve();
  assert.equal(a.calls.writes, 1); a.editor.revision++; a.editor.dirty = true;
  assert.equal(await a.saveNative(), false);
  held.resolve(); assert.equal(await first, false); assert.equal(a.editor.dirty, true); assert.equal(a.checkpoint(), null);
});

test('recovery deletion failure cannot reject or undo a committed Save', async () => {
  const a = app(); a.hooks.cleanup = async () => {throw new Error('Recovery delete failed');};
  assert.equal(await a.saveNative(), true); assert.equal(a.calls.committed, 1);
  assert.equal(a.editor.dirty, false); assert.equal(a.calls.failed.length, 1);
  assert.equal(await a.finishDocumentAction('close', a.checkpoint()), true); assert.equal(a.calls.closed, 1);
});

test('failed native writing leaves work dirty and permits a later retry', async () => {
  const a = app(); a.hooks.write = async () => {throw new Error('Write failed');};
  await assert.rejects(a.saveNative(), /Write failed/); assert.equal(a.editor.dirty, true); assert.equal(a.calls.committed, 0);
  a.hooks.write = async () => {}; assert.equal(await a.saveNative(), true);
});

for (const action of ['close', 'restartForUpdate']) for (const stage of ['flushPreferences', 'flushSettings', 'publish']) {
  test(`${action} preserves an edit arriving during ${stage}`, async () => {
    const a = app(); assert.equal(await a.saveNative(), true);
    a.hooks[stage] = async () => {a.editor.revision++; a.editor.dirty = true;};
    assert.equal(await a.finishDocumentAction(action, a.checkpoint()), false);
    assert.equal(a.calls.closed + a.calls.restarted, 0); assert.equal(a.editor.dirty, true);
  });
}

test('close rejects replacement documents despite clean dirty flags', async () => {
  for (const change of [a => {a.editor.report = {};}, a => {a.state.documentToken = 'replacement';}]) {
    const a = app(); assert.equal(await a.saveNative(), true); change(a);
    assert.equal(await a.finishDocumentAction('close', a.checkpoint()), false); assert.equal(a.calls.closed, 0);
  }
});

test('same-revision persisted metadata cannot become marked saved or approve closing', async () => {
  const a = app(), held = deferred(); a.hooks.write = () => held.promise;
  const saving = a.saveNative();
  for (let i = 0; i < 10 && !a.calls.writes; i++) await Promise.resolve();
  a.emitChange('edit'); held.resolve(); assert.equal(await saving, false); assert.equal(a.editor.dirty, true);
  a.hooks.write = async () => {}; assert.equal(await a.saveNative(), true);
  a.hooks.flushPreferences = async () => {a.emitChange('selection');};
  assert.equal(await a.finishDocumentAction('close', a.checkpoint()), false); assert.equal(a.calls.closed, 0);
});

test('pure navigation during a save retains the unchanged persisted checkpoint', async () => {
  const a = app(), held = deferred(); a.hooks.write = () => held.promise;
  const saving = a.saveNative();
  for (let i = 0; i < 10 && !a.calls.writes; i++) await Promise.resolve();
  a.editor.tick = 5; a.emitChange('seek'); held.resolve();
  assert.equal(await saving, true); assert.equal(a.editor.dirty, false); assert.equal(a.calls.committed, 1);
});

test('final close handoff is bounded and honors a main-process checkpoint rejection', async () => {
  const a = app(), held = deferred(); assert.equal(await a.saveNative(), true);
  a.hooks.flushPreferences = () => held.promise;
  const closing = a.finishDocumentAction('close', a.checkpoint());
  assert.equal(await a.finishDocumentAction('close', a.checkpoint()), false);
  // The checkpoint names the project in front, its revision and mutation epoch, and the list of open projects.
  a.hooks.close = async checkpoint => {assert.equal(checkpoint.saved, true); assert.equal(checkpoint.revision, 'document-1:1:0:0'); return false;};
  held.resolve(); assert.equal(await closing, false); assert.equal(a.calls.closed, 1);
});

test('a save removes only its own project\'s recovery copy', async () => {
  const a = app(); assert.equal(await a.saveNative(), true);
  assert.deepEqual(a.calls.cleared.map(target => ({...target})), [{documentToken: 'document-1'}]);
  const b = app({browser: true}); b.hooks.picker = async () => ({streamed: true, async write() {}, async finish() {return {saved: true};}, async abort() {}});
  assert.equal(await b.saveNative(), true);
  assert.deepEqual(b.calls.cleared, ['project-1']);
});

test('the desktop is told what every open project would lose, and closing needs all of them saved', async () => {
  const a = app(), published = [];
  a.hooks.publish = async value => { published.push(value); };
  // Another open project has unsaved changes while the one in front is saved.
  assert.equal(await a.saveNative(), true);
  a.projects.summary = () => ({open: 3, unsaved: 1, unsavedName: 'Resting project', stamp: 4});
  assert.equal(await a.finishDocumentAction('close'), true);
  assert.deepEqual({...published.at(-1)}, {name: 'Animation', dirty: true, activeDirty: false, unsaved: 1, unsavedName: 'Resting project', revision: 'document-1:1:0:4'});
  // Save and close saves the others first and stops when one of them is not saved.
  let saved = 0;
  a.projects.saveAll = async () => { saved++; return false; };
  assert.equal(await a.saveEveryProjectThen('close'), false); assert.equal(saved, 1); assert.equal(a.calls.closed, 1);
  a.projects.saveAll = async () => true;
  assert.equal(await a.saveEveryProjectThen('close'), false, 'a project still unsaved keeps the window open');
  a.projects.summary = () => ({open: 3, unsaved: 0, unsavedName: '', stamp: 5});
  a.hooks.close = async checkpoint => { assert.equal(checkpoint.saved, true); assert.equal(checkpoint.revision, 'document-1:1:0:5'); };
  assert.equal(await a.saveEveryProjectThen('close'), true); assert.equal(a.calls.closed, 2);
});

test('recovery deadline cannot be postponed forever by repeated edits', () => {
  let now = 0; const deadline = new RecoveryDeadline({now: () => now}), document = {};
  assert.equal(deadline.delay(document, 2500), 2500);
  now = 6000; assert.equal(deadline.delay(document, 2500), 1500);
  now = 7500; assert.equal(deadline.delay(document, 2500), 0);
  deadline.retryAfter(1000); assert.equal(deadline.delay(document, 2500), 1000);
  now = 8000; assert.equal(deadline.delay(document, 2500), 500);
  now = 8500; assert.equal(deadline.delay(document, 2500), 0);
});

test('recovery retry floors bound failed work and a hidden-page checkpoint can expedite it', () => {
  let now = 0; const deadline = new RecoveryDeadline({now: () => now}), document = {};
  deadline.delay(document, 2500); now = 10000; deadline.retryAfter(30000);
  assert.equal(deadline.delay(document, 2500), 30000);
  assert.equal(deadline.delay(document, 2500, 0), 0);
  assert.equal(deadline.delay({}, 2500), 2500, 'replacement projects own a new deadline');
  deadline.reset(); assert.equal(deadline.delay(document, 2500), 2500);
});

function recoveryApp() {
  let now = 0, timerId = 0;
  const timers = new Map(), editor = {report: {}, revision: 1, dirty: true, name: 'Animation'};
  const state = {documentToken: 'document-1', settings: {autosaveSeconds: 2.5}, recoveryBackoff: 1};
  const calls = {exports: 0, writes: 0, warnings: 0}, hooks = {export: async () => {}}, manualSave = new DocumentSave();
  let busy = false, controller;
  const context = vm.createContext({state, editor, manualSave, matchesDocumentCheckpoint, documentCheckpoint,
    projects: {tabs: {activeId: 'project-1'}},
    recoveryDeadline: new RecoveryDeadline({now: () => now}), exportJobs: new Set(), desktop: null,
    setTimeout(callback, delay) {const id = ++timerId; timers.set(id, {callback, at: now + delay}); return id;},
    clearTimeout(id) {timers.delete(id);}, editingGestureActive: () => busy,
    status() {calls.warnings++;}, browserRecovery: {async write(_blob, _name, _signal, slot) {calls.writes++; calls.slot = slot; return true;}},
    async runDocumentExport(_format, consume) {
      calls.exports++; controller = new AbortController(); await hooks.export();
      if (controller.signal.aborted) throw new DOMException('', 'AbortError');
      return consume({}, controller.signal);
    },
  });
  const functions = vm.runInContext(`let saveMutationEpoch = 0, recoveredEpoch = -1;\n${recoverySource}\n({scheduleRecovery, recovered: () => recoveredEpoch === saveMutationEpoch})`, context);
  return {editor, state, calls, hooks, manualSave, ...functions,
    now(value) {now = value;}, next() {return [...timers.values()].sort((a, b) => a.at - b.at)[0]?.at;},
    busy(value) {busy = value;}, abort() {controller.abort();},
    fire() {const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0]; timers.delete(id); now = Math.max(now, timer.at); return timer.callback();},
  };
}

test('actual recovery scheduler preserves its deadline through repeated edits and retains periodic checkpoints', async () => {
  const a = recoveryApp(); a.scheduleRecovery();
  for (const now of [2000, 4000, 6000]) {a.now(now); a.editor.revision++; a.scheduleRecovery();}
  assert.equal(a.next(), 7500);
  await a.fire(); assert.equal(a.calls.exports, 1); assert.equal(a.calls.writes, 1); assert.equal(a.next(), 10000);
  a.editor.revision++; a.scheduleRecovery(); assert.equal(a.next(), 10000);
  await a.fire(); assert.equal(a.calls.writes, 2);
});

test('actual recovery scheduler delays busy/manual work without dropping an overdue checkpoint', async () => {
  const a = recoveryApp(); a.scheduleRecovery(); a.busy(true);
  for (let i = 0; i < 7; i++) await a.fire();
  assert.equal(a.calls.exports, 0); const due = a.next();
  a.now(due - 500); a.editor.revision++; a.scheduleRecovery(); assert.equal(a.next(), due);
  a.busy(false); a.manualSave.active = {}; await a.fire(); assert.equal(a.calls.exports, 0);
  a.manualSave.active = null; await a.fire(); assert.equal(a.calls.writes, 1);
});

test('cancelled mutation snapshots retry safely and never write a mixed revision', async () => {
  const a = recoveryApp(), held = deferred(); a.hooks.export = () => held.promise;
  a.scheduleRecovery(); const pending = a.fire(); assert.equal(a.calls.exports, 1);
  a.editor.revision++; a.abort(); a.scheduleRecovery(); held.resolve(); await pending;
  assert.equal(a.calls.writes, 0); assert.equal(a.next(), 5000);
  a.hooks.export = async () => {}; await a.fire(); assert.equal(a.calls.writes, 1); assert.equal(a.next(), 7500);
});

test('blocked recovery storage retries with a bounded delay and reports its failure once', async () => {
  const a = recoveryApp(); a.hooks.export = async () => {throw new Error('Storage unavailable');};
  a.scheduleRecovery(); await a.fire(); assert.equal(a.calls.warnings, 1); assert.equal(a.next(), 7500);
  a.now(6000); a.editor.revision++; a.scheduleRecovery(); assert.equal(a.next(), 7500);
  await a.fire(); assert.equal(a.calls.warnings, 1); assert.equal(a.next(), 17500);
});
