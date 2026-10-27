import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {ownedEditorFor} from './support/owned-editor.mjs';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';
const reportJSON = editor => JSON.stringify(editor.report, (key, value) => key === 'runtime_segments' ? undefined : value);
const native = () => {
  const report = emptyDocument(), figure = report.figure_types[0];
  report.keyframes = [createFrame([createObject(figure, 1, 120, 180)], 4), createFrame([createObject(figure, 1, 150, 175)], 1)];
  const prepared = ownedEditorFor({demo: false}, report); prepared.select(1);
  const clip = prepared.createMovieclip({uids: [1], start: 0, end: 5, replace: false});
  const editor = ownedEditorFor({demo: false}, JSON.parse(reportJSON(prepared))); editor.select(1);
  return {editor, typeId: clip.figure_type_id};
};
const snapshot = e => ({document: reportJSON(e), selection: structuredClone(e._selectionState()),
  revision: e.revision, serial: e._revisionSerial, saved: e._savedRevision, layerRevision: e.layerRevision,
  identity: e._nextFrameIdentity, uid: e._nextUid,
  undo: structuredClone(e._undo), redo: structuredClone(e._redo), sources: e.report._styk.frameSources, drag: structuredClone(e._drag),
  counts: [...e._layerUidCounts], seen: [...e._layerSeenUids]});
const reopen = e => new Editor({demo: false}).load(JSON.parse(JSON.stringify(e.serialize())));
test('fractional native library insertion preserves save, history and counters', () => {
  const {editor: e, typeId} = native();
  e.setLayerColor(['layer-1'], 'blue'); e.undo(); e.seek(2.25); e.select(1);
  const events = []; e.addEventListener('change', event => events.push(event.detail));
  const before = snapshot(e); assert.doesNotThrow(() => reopen(e));
  assert.throws(() => e.addFigure(typeId), error => error.messageKey === 'errors.animationChannels.invalidMovieclipEnd');
  assert.doesNotThrow(() => reopen(e), 'a failed insertion must leave a project that saves and reopens');
  assert.deepEqual(snapshot(e), before); assert.deepEqual(events, []);
  e.beginTranslationDrag('Continue editing'); e.moveSelection(1, 1); e.cancelDrag();
  assert.doesNotThrow(() => reopen(e)); assert.equal(e.canRedo, true);
});
test('whole native and sheet insertions retain their successful behavior', () => {
  const {editor: e, typeId} = native(); e.seek(2); const inserted = e.addFigure(typeId);
  assert.equal(inserted._stykMovieclip.start, 2); assert.equal(inserted._stykMovieclip.end, 7); assert.doesNotThrow(() => reopen(e));
  const sheet = ownedEditorFor({demo: false, layerTimeline: true, propertyChannels: true}, JSON.parse(reportJSON(native().editor)));
  sheet.seek(2); const presence = sheet.addFigure(typeId); assert.equal(presence._stykMovieclip.clock, 'presence'); assert.doesNotThrow(() => reopen(sheet));
});

test('invalid library insertion leaves an existing live drag and its events intact', () => {
  const {editor: e} = native(); e.select(1); e.beginTranslationDrag('Keep live pose'); e.moveSelection(4.5, -2.25);
  const events = []; e.addEventListener('change', event => events.push(event.detail)); const before = snapshot(e), live = e._drag;
  assert.throws(() => e.addFigure(999), error => error.messageKey === 'errors.editor.chooseAFigureFromTheLibrary');
  assert.deepEqual(snapshot(e), before); assert.deepEqual(events, []);
  e.moveSelection(1, 1); assert.equal(e._drag, live); e.cancelDrag(); assert.doesNotThrow(() => reopen(e));
});

for (const tick of [2, 2.25]) {
  test(`invalid imported movieclip clock retains validation priority and atomic saving (tick=${tick})`, () => {
    const {editor: e, typeId} = native();
    e.setLayerColor(['layer-1'], 'blue'); e.undo(); e.seek(tick); e.select(1);
    const clip = e.report.figure_types.find(figure => figure.figure_type_id === typeId);
    const incoming = {...emptyDocument(), figure_types: [structuredClone(clip)], keyframes: [createFrame([createObject(clip, 1, 120, 180,
      {_stykMovieclip: {clock: 'invalid', start: 0, end: 5, offset: 0, speed: 1, mode: 'loop'}})], 1)]};
    const events = []; e.addEventListener('change', event => events.push(event.detail)); const before = snapshot(e);
    assert.doesNotThrow(() => reopen(e));
    assert.throws(() => e.importFigure(incoming), error => error.messageKey === 'errors.movieclips.invalidMovieclipClock');
    assert.deepEqual(snapshot(e), before); assert.deepEqual(events, []);
    assert.doesNotThrow(() => reopen(e)); assert.equal(e.canRedo, true);
    e.beginTranslationDrag('Continue after invalid import'); e.moveSelection(1, 1); e.cancelDrag(); assert.doesNotThrow(() => reopen(e));
  });
}

test('invalid imported clock preserves an existing live drag', () => {
  const {editor: e, typeId} = native(); e.select(1); e.beginTranslationDrag('Keep live import pose'); e.moveSelection(4.5, -2.25);
  const clip = e.report.figure_types.find(figure => figure.figure_type_id === typeId);
  const incoming = {...emptyDocument(), figure_types: [structuredClone(clip)], keyframes: [createFrame([createObject(clip, 1, 120, 180,
    {_stykMovieclip: {clock: 'invalid', start: 0, end: 5, offset: 0, speed: 1, mode: 'loop'}})], 1)]};
  const events = []; e.addEventListener('change', event => events.push(event.detail)); const before = snapshot(e), live = e._drag;
  assert.throws(() => e.importFigure(incoming), error => error.messageKey === 'errors.movieclips.invalidMovieclipClock');
  assert.deepEqual(snapshot(e), before); assert.deepEqual(events, []); assert.equal(e._drag, live);
  e.moveSelection(1, 1); assert.equal(e._drag, live); e.cancelDrag(); assert.doesNotThrow(() => reopen(e));
});
