import test from 'node:test';
import assert from 'node:assert/strict';
import {newOwnedEditor} from './support/owned-editor.mjs';
import {ProjectTabs, MAX_OPEN_PROJECTS} from '../src/project-tabs.mjs';
import {createProjectTabsHost} from '../src/project-tabs-host.mjs';
import {movieclipScopes, sessionProjectName, sessionUnsaved} from '../src/editor-sessions.mjs';
import {beginNativePropertyEdit, previewNativePropertyEdit, commitNativePropertyEdit} from '../src/native-property-edit.mjs';

const names = tabs => tabs.items.map(item => item.name);
const x = editor => editor.selectionFrame.objects[0].root_x;
function edit(editor, x) {
  const uid = editor.frame.objects[0].unique_id;
  editor.select(uid); const token = beginNativePropertyEdit(editor, 'root_x'); previewNativePropertyEdit(token, x); commitNativePropertyEdit(token);
}

test('the list keeps one project in front, opens beside it and remembers the order of use', () => {
  const tabs = new ProjectTabs(), kinds = [];
  tabs.addEventListener('change', event => kinds.push(event.detail.kind));
  const a = tabs.add({name: 'A'}), b = tabs.add({name: 'B'}), c = tabs.add({name: 'C'});
  assert.deepEqual(names(tabs), ['A', 'B', 'C']); assert.equal(tabs.active, c);
  assert.equal(tabs.activate(a.id), true); assert.equal(tabs.activate(a.id), false);
  const d = tabs.add({name: 'D'});
  assert.deepEqual(names(tabs), ['A', 'D', 'B', 'C'], 'a new project opens beside the one in front');
  assert.deepEqual(tabs.recency.map(item => item.name), ['D', 'A', 'C', 'B']);
  assert.equal(tabs.successor(d.id), a); assert.equal(tabs.successor(b.id), d);
  assert.equal(tabs.neighbour(1), b); assert.equal(tabs.neighbour(-1), a); assert.equal(tabs.neighbour(-2), c);
  assert.throws(() => tabs.remove(d.id), /another project/);
  tabs.activate(a.id); assert.equal(tabs.remove(d.id), d); assert.equal(tabs.remove(d.id), null);
  assert.deepEqual(tabs.recency.map(item => item.name), ['A', 'C', 'B']);
  assert.equal(tabs.move(c.id, 0), true); assert.equal(tabs.move(c.id, 0), false); assert.equal(tabs.move(b.id, 99), false);
  assert.deepEqual(names(tabs), ['C', 'A', 'B']);
  assert.equal(tabs.update(a.id, {name: 'A', dirty: false}), false); assert.equal(tabs.update(a.id, {dirty: true}), true);
  assert.deepEqual(tabs.unsaved, [a]);
  assert.deepEqual(kinds, ['add', 'add', 'add', 'activate', 'add', 'activate', 'remove', 'move', 'update']);
  assert.throws(() => tabs.activate('project-999'), /no longer open/);
  tabs.remove(b.id); tabs.remove(c.id); assert.equal(tabs.remove(a.id), a);
  assert.equal(tabs.active, null); assert.equal(tabs.size, 0);
});

test('the list is bounded', () => {
  const tabs = new ProjectTabs({limit: 2});
  tabs.add({name: 'A'}); tabs.add({name: 'B'});
  assert.equal(tabs.full, true);
  assert.throws(() => tabs.add({name: 'C'}), /Close a project/);
  assert.equal(tabs.size, 2); assert.ok(MAX_OPEN_PROJECTS >= 8);
  assert.throws(() => new ProjectTabs({limit: 0}), RangeError);
});

/** The application around the host, reduced to what the host asks of it. */
function application({limit} = {}) {
  const editor = newOwnedEditor({demo: false, propertyChannels: true, layerTimeline: true}).newDocument();
  const app = {view: 1, token: 'token-1', tokens: 1, released: [], shown: [], refused: [], settles: 0, canSettle: true, answer: true, busy: false, idle: true,
    checkpoints: [], checkpoint: async () => true, recoveryCurrent: false};
  const host = createProjectTabsHost({editor, tabs: new ProjectTabs(limit ? {limit} : {}), hooks: {
    settle: async () => { app.settles++; return app.canSettle; },
    capture: () => ({view: app.view, token: app.token, recoveryCurrent: app.recoveryCurrent}),
    restore: state => { app.view = state.view; app.token = state.token; },
    shown: (record, state) => app.shown.push([record.name, state?.token ?? null]),
    confirmClose: async () => (typeof app.answer === 'function' ? app.answer() : app.answer),
    blank: () => { editor.newDocument(); app.view = 1; app.token = `token-${++app.tokens}`; },
    release: record => app.released.push([record.name, record.state?.token, Boolean(record.session)]),
    refuse: reason => app.refused.push(reason),
    busy: () => app.busy,
    idle: () => app.idle,
    checkpoint: (record, signal) => { app.checkpoints.push(record.name); return app.checkpoint(record, signal); },
  }});
  /** What the application does to open a project: a load that parks the one in front. */
  const open = (name, {blank = false} = {}) => {
    if (!host.canOpen()) return null;
    const replace = host.replaceable();
    editor.newDocument(replace ? {} : {onDetach: session => host.park(session)});
    editor.name = name; app.view = 1; app.token = `token-${++app.tokens}`;
    return host.opened({blank});
  };
  return {editor, app, host, tabs: host.tabs, open};
}

test('the untouched empty animation gives its place; anything else stays open beside the new project', () => {
  const {editor, host, tabs, open, app} = application();
  assert.equal(tabs.size, 1); assert.equal(host.replaceable(), true);
  const first = open('First');
  assert.equal(tabs.size, 1, 'the empty animation was replaced'); assert.equal(first.name, 'First'); assert.equal(first.blank, false);
  assert.equal(host.replaceable(), false);
  app.view = 7;
  open('Second');
  assert.deepEqual(names(tabs), ['First', 'Second']); assert.equal(tabs.active.name, 'Second');
  assert.ok(first.session, 'the project that left the front rests as a session'); assert.deepEqual(first.state, {view: 7, token: 'token-2', recoveryCurrent: false});
  assert.equal(editor.name, 'Second');
  // A new empty animation that was edited is a project like any other.
  open('Blank', {blank: true}); assert.equal(host.replaceable(), true);
  edit(editor, 30); host.sync();
  assert.equal(host.replaceable(), false); assert.equal(tabs.active.blank, false);
  editor.undo(); assert.equal(host.replaceable(), false, 'its history is worth keeping');
});

test('switching brings a project back with its history and the application state it left with', async () => {
  const {editor, host, tabs, open, app} = application();
  const first = open('First');
  edit(editor, 40); app.view = 3;
  const firstReport = editor.report;
  const second = open('Second');
  edit(editor, 90); app.view = 5;
  assert.equal(first.dirty, true);

  assert.equal(await host.activate(first.id), true);
  assert.equal(editor.report, firstReport); assert.equal(editor.name, 'First'); assert.equal(app.view, 3); assert.equal(app.token, 'token-2');
  assert.equal(x(editor), 40); assert.equal(editor.dirty, true);
  editor.undo(); assert.notEqual(x(editor), 40);
  assert.equal(first.session, null); assert.ok(second.session); assert.equal(second.dirty, true);
  assert.deepEqual(second.state, {view: 5, token: 'token-3', recoveryCurrent: false});
  assert.deepEqual(app.shown.at(-1), ['First', 'token-2']);
  assert.equal(await host.activate(first.id), true, 'the project in front is already there');
  assert.equal(await host.activate('project-404'), false);

  // The edit in progress, a figure being built or a save keeps the project in front.
  app.canSettle = false;
  assert.equal(await host.activate(second.id), false); assert.equal(editor.name, 'First');
  app.canSettle = true; app.busy = true;
  assert.equal(await host.activate(second.id), false); assert.deepEqual(app.refused, ['busy']);
  app.busy = false;
  assert.equal(await host.activate(second.id), true); assert.equal(x(editor), 90);
});

test('a second request while a switch is running is dropped, never interleaved', async () => {
  const {editor, host, open} = application();
  const first = open('First'); open('Second'); const third = open('Third');
  const [a, b] = await Promise.all([host.activate(first.id), host.activate(third.id)]);
  assert.deepEqual([a, b], [true, false]);
  assert.equal(editor.name, 'First');
});

test('closing asks about the project it closes, and the one used before it comes to the front', async () => {
  const {editor, host, tabs, open, app} = application();
  const first = open('First'); const second = open('Second'); const third = open('Third');
  await host.activate(first.id);
  // Closing a resting project brings it forward first, so the question is about what is on screen.
  let asked = null;
  app.answer = () => { asked = editor.name; return false; };
  assert.equal(await host.close(second.id), false);
  assert.equal(asked, 'Second'); assert.equal(tabs.active, second); assert.equal(tabs.size, 3);
  app.answer = true;
  assert.equal(await host.close(second.id), true);
  assert.deepEqual(names(tabs), ['First', 'Third']); assert.equal(editor.name, 'First', 'the project used before it is in front');
  assert.deepEqual(app.released, [['Second', 'token-3', true]]);
  assert.throws(() => editor.resumeDocument(second.session), /no longer open/, 'a closed project can never be resumed');
  assert.equal(await host.close(third.id), true); assert.equal(editor.name, 'First');
  // The last project closes into a new, empty one in the same tab.
  edit(editor, 12);
  assert.equal(await host.close(), true);
  assert.equal(tabs.size, 1); assert.equal(tabs.active, first); assert.equal(first.blank, true); assert.equal(first.dirty, false);
  assert.equal(editor.dirty, false); assert.equal(editor.canUndo, false); assert.equal(host.replaceable(), true);
  assert.deepEqual(app.released.at(-1), ['First', 'token-2', true]);
});

test('a failed load puts the parked project back in front untouched', () => {
  const {editor, host, tabs, open, app} = application();
  open('First'); edit(editor, 61); app.view = 9;
  const report = editor.report;
  host.park(editor.detachDocument());
  app.view = 1; app.token = 'half-open';
  assert.equal(host.failed(), true);
  assert.equal(editor.report, report); assert.equal(x(editor), 61); assert.equal(app.view, 9);
  assert.equal(tabs.size, 1); assert.equal(tabs.active.session, null);
  assert.equal(host.failed(), false);
});

test('the limit refuses another project and says so', () => {
  const {host, tabs, open, app} = application({limit: 2});
  open('First'); open('Second');
  assert.equal(open('Third'), null);
  assert.deepEqual(app.refused, ['limit']); assert.equal(tabs.size, 2);
});

test('save all saves each unsaved project in front and stops where the person cancels', async () => {
  const {editor, host, tabs, open} = application();
  const first = open('First'); edit(editor, 10);
  const second = open('Second');
  const third = open('Third'); edit(editor, 30);
  const saved = [];
  const save = async () => { saved.push(editor.name); editor.markSaved(); host.sync(); return true; };
  assert.equal(await host.saveAll(save), true);
  assert.deepEqual(saved, ['First', 'Third'], 'the project in front is saved last and stays in front');
  assert.equal(tabs.active, third); assert.equal(first.dirty, false); assert.equal(second.dirty, false);
  assert.deepEqual(host.summary(), {open: 3, unsaved: 0, unsavedName: '', stamp: host.summary().stamp});

  await host.activate(first.id); edit(editor, 11); await host.activate(second.id); edit(editor, 21);
  assert.equal(host.summary().unsaved, 2); assert.equal(host.summary().unsavedName, 'First');
  saved.length = 0;
  assert.equal(await host.saveAll(async () => { saved.push(editor.name); return false; }), false);
  assert.deepEqual(saved, ['First']); assert.equal(editor.name, 'First'); assert.equal(editor.dirty, true);
});

test('closing the saved projects leaves the one in front and every project with changes', async () => {
  const {editor, host, tabs, open, app} = application();
  open('First'); edit(editor, 10);
  open('Second'); open('Third');
  open('Front');
  assert.equal(await host.closeSaved(), 2);
  assert.deepEqual(names(tabs), ['First', 'Front']);
  assert.deepEqual(app.released.map(entry => entry[0]), ['Second', 'Third']);
  assert.equal(editor.name, 'Front');
});

test('a project that rests with changes gets one recovery copy, in a quiet moment, and none once it is current', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const {editor, host, open, app} = application();
  const first = open('First'); edit(editor, 10);
  const second = open('Second');
  assert.equal(first.dirty, true);
  app.idle = false;
  t.mock.timers.tick(1500); await Promise.resolve();
  assert.deepEqual(app.checkpoints, [], 'it waits while the person is working');
  app.idle = true;
  t.mock.timers.tick(1000); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(app.checkpoints, ['First']); assert.equal(first.state.recoveryCurrent, true);
  t.mock.timers.tick(60000); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(app.checkpoints, ['First'], 'a resting project cannot change, so one copy settles it');
  assert.equal(movieclipScopes(first.session), undefined, 'no movieclip of it is being edited'); assert.equal(sessionProjectName(first.session), 'First');
  assert.equal(sessionUnsaved(first.session), true); assert.equal(sessionUnsaved(second.session ?? {_revision: 1, _savedRevision: 1}), false);

  // A copy still being written is abandoned when its project comes back to the front.
  edit(editor, 20);
  let aborted = false;
  app.checkpoint = (_record, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('', 'AbortError')); }));
  await host.activate(first.id);
  t.mock.timers.tick(1500); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(app.checkpoints, ['First', 'Second']);
  await host.activate(second.id);
  assert.equal(aborted, true);
  host.dispose();
});
