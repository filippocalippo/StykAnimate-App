// The clipboards of an engine-owned editor (D19, docs/engine/editing.md "Clipboards"): the session runs the copies and pastes, the
// editor shows what was copied where the interface reads it (the Paste buttons, the shared clipboard), and a clipboard the
// interface holds (restored from another window or the system's, copied in another project) reaches the session before the
// paste. Every paste is compared with what the same steps gave on an editor alone (the frozen references of
// tests/support/owner-references.mjs).
import '../engine/tools/v8-pin.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {emptyDocument} from '../src/editor.mjs';
import {clipboardSnapshot, restoreClipboard, pasteSheetClipboard} from '../src/shared-clipboard.mjs';
import {createClipboards} from '../src/engine/engine-clipboards.mjs';
import {engineBuilt} from './support/engine-node.mjs';
import {ownedEditorSync} from './support/owned-editor.mjs';
import {recordedDocument, documentText, normalized} from './support/owned-vs-plain.mjs';
import {canonical, ownerReferences} from './support/owner-references.mjs';

const opts = {skip: !engineBuilt};
const refs = ownerReferences(import.meta.url);
const options = {demo: false, layerTimeline: true, propertyChannels: true};
/** An editor the engine owns (the identities a call draws are the editor's own random ones). */
const owned = document => ownedEditorSync(options, document, {recorded: false});
/** What another window reads back from the system's clipboard. */
const wire = packet => JSON.parse(JSON.stringify(packet));
const withBackgrounds = () => JSON.parse(readFileSync(new URL('../engine/crates/styk-eval/tests/fixtures/channels/channels-pose.sheet.json', import.meta.url), 'utf8'));

/** The steps on owned editors and what an editor alone showed for them (its references): that the session took every call. */
async function bothWays(take, documents, steps) {
  const run = async () => {
    const made = documents.map(document => owned(document));
    try {
      const shown = await steps(...made.map(({editor}) => editor));
      return {...shown, refused: made.flatMap(({owner}) => Object.keys(owner.refused))};
    } finally { for (const {owner} of made) owner.release(); }
  };
  const alone = take('alone');
  const engine = await run();
  assert.deepEqual(engine.refused, [], 'the session refused nothing');
  const {refused, ...shown} = engine;
  assert.deepEqual(canonical(shown), alone);
  return {alone, engine};
}
const shownBy = (editor, before) => ({text: documentText(editor), selected: [...editor.selectedUids], undo: editor.undoLabel, entries: editor._undo.length - before});

test('copying frames fills the clipboard the filmstrip, the timeline and the shared clipboard read', opts, () => {
  const {editor, owner} = owned(recordedDocument('sheet-layers'));
  try {
    assert.ok(!editor._sheetClipboard, 'nothing copied: Paste stays off');
    assert.equal(clipboardSnapshot(editor, 'sheet'), null);
    const answer = editor.sheetCopyFrames(['layer-1'], 0, 3);
    assert.equal(answer, editor._sheetClipboard, 'the copy answers with the clipboard');
    assert.ok(editor._sheetClipboard, 'Paste is on');
    assert.deepEqual(editor._sheetClipboard.rows.map(row => row.id), ['layer-1']);
    assert.equal(editor._sheetClipboard.duration, 4);
    assert.equal(editor._sheetClipboard.document, editor._documentToken, 'it was copied in this document');
    assert.equal(clipboardSnapshot(editor, 'sheet').kind, 'sheet', 'the shared clipboard has something to publish');
    // A cut leaves the same clipboard and the frames gone.
    editor.sheetCopyFrames(['layer-1', 'layer-2'], 0, 5);
    assert.deepEqual(editor._sheetClipboard.rows.map(row => row.id), ['layer-1', 'layer-2']);
    assert.deepEqual(owner.refused, {}, 'the session refused nothing');
  } finally { owner.release(); }
});

refs.test('copying figures fills the clipboard the paste actions read, and each paste moves the next one along', opts, async take => {
  const {alone, engine} = await bothWays(take, [recordedDocument('sheet-layers')], editor => {
    assert.equal(Boolean(editor._figureClipboard || editor._selectionClipboard), false);
    editor.select(1, -1);
    assert.equal(editor.copySelection(), 1);
    const clipboard = editor._selectionClipboard;
    assert.equal(Boolean(editor._figureClipboard || editor._selectionClipboard), true);
    assert.deepEqual([clipboard.objects.length, clipboard.offset, clipboard.pastes, clipboard.layers instanceof Map, clipboard.documentToken === editor._documentToken], [1, 24, 0, true, true]);
    editor.pasteSelection();
    assert.equal(editor._selectionClipboard.pastes, 1);
    const first = editor.selectedObjects[0].root_x;
    editor.pasteSelection();
    assert.equal(editor._selectionClipboard.pastes, 2);
    assert.equal(editor.selectedObjects[0].root_x - first, 24, 'the next paste lands one step further');
    return shownBy(editor, 0);
  });
  assert.equal(engine.entries, 2);
  assert.equal(alone.undo, 'Paste figures');
});

refs.test('a cut pastes back where it was, in a range of frames or on the playhead', opts, async take => {
  await bothWays(take, [recordedDocument('sheet-layers')], editor => {
    editor.select(1, -1);
    const before = editor.selectedObjects[0].root_x;
    assert.equal(editor.cutSelection(), 1);
    assert.equal(editor._selectionClipboard.offset, 0);
    editor.pasteSelection();
    assert.equal(editor.selectedObjects[0].root_x, before);
    // The frame range's cut (the app copies in place, then deletes in the frames).
    assert.equal(editor.copySelection({inPlace: true}), 1, 'the pasted figure is the one selected');
    assert.equal(editor._selectionClipboard.offset, 0);
    return shownBy(editor, 0);
  });
});

refs.test('figures cross the shared clipboard into another editor and paste what an editor alone pastes', opts, async take => {
  for (const destination of [recordedDocument('sheet-layers'), emptyDocument(), recordedDocument('sheet-movieclip')]) {
    await bothWays(take, [recordedDocument('sheet-layers'), destination], async (source, target) => {
      source.select(1, -1); source.selectMany([1, 2]);
      assert.equal(source.copySelection(), 2);
      await restoreClipboard(target, wire(clipboardSnapshot(source, 'figures')));
      assert.equal(target._selectionClipboard.documentToken, null, 'it was not copied in this document');
      const before = target._undo.length;
      target.pasteSelection();
      const first = shownBy(target, before);
      target.pasteSelection();
      assert.equal(target._selectionClipboard.pastes, 2);
      return {first, second: shownBy(target, before)};
    });
  }
});

refs.test('timeline frames cross the shared clipboard into another editor and paste what an editor alone pastes', opts, async take => {
  for (const insert of [false, true]) {
    await bothWays(take, [recordedDocument('sheet-layers'), recordedDocument('sheet-layers')], async (source, target) => {
      const ids = ['layer-1', 'layer-2'];
      source.sheetCopyFrames(ids, 0, 5);
      await restoreClipboard(target, wire(clipboardSnapshot(source, 'sheet')));
      const before = target._undo.length, snapshot = documentText(target);
      pasteSheetClipboard(target, ['layer-1'], 3, {insert});
      const pasted = shownBy(target, before);
      target.undo();
      assert.equal(documentText(target), snapshot, 'one undo takes it all back');
      target.redo();
      return {pasted, redone: documentText(target)};
    });
  }
});

refs.test('a whole scene crosses the shared clipboard with its backgrounds and keeps the destination layers outside the inserted frames', opts, async take => {
  await bothWays(take, [withBackgrounds(), recordedDocument('sheet-layers')], async (source, target) => {
    const ids = ['scene', 'camera', ...source.report._styk.layers.order];
    source.sheetCopyFrames(ids, 0, 4);
    assert.ok(source._sheetClipboard.backgrounds.length > 0, 'the scene has backgrounds to bring');
    await restoreClipboard(target, wire(clipboardSnapshot(source, 'sheet')));
    const held = target.report.backgrounds?.length ?? 0, before = target._undo.length;
    pasteSheetClipboard(target, ['scene', 'camera', ...target.report._styk.layers.order], 0, {wholeScene: true, insert: true});
    assert.equal(target.report.backgrounds.length, held + source._sheetClipboard.backgrounds.length, 'the backgrounds are the destination\'s now');
    const pasted = shownBy(target, before);
    target.undo();
    assert.equal(target.report.backgrounds?.length ?? 0, held);
    target.redo();
    return {pasted, redone: documentText(target)};
  });
});

refs.test('camera motion crosses the shared clipboard into another editor with an identity of its own', opts, async take => {
  const document = recordedDocument('camera-motion');
  await bothWays(take, [document, document], async (source, target) => {
    const [clip] = source.getCameraMotions();
    assert.equal(source.copyCameraMotion(clip.id), true);
    assert.equal(source._cameraMotionClipboard.id, clip.id);
    await restoreClipboard(target, wire(clipboardSnapshot(source, 'camera-motion')));
    const before = target._undo.length, id = target.pasteCameraMotion(9);
    const pasted = target.getCameraMotions().find(motion => motion.id === id);
    assert.notEqual(id, clip.id);
    assert.equal(pasted.start, 9);
    return {...shownBy(target, before), pasted: normalized(JSON.stringify(pasted))};
  });
});

refs.test('segment values, the camera and effect clips the interface copies paste in another editor', opts, async take => {
  await bothWays(take, [recordedDocument('joined-chain'), recordedDocument('joined-chain')], (source, target) => {
    source.select(3, 2);
    const text = source.copySegmentValues();
    assert.equal(source._segmentValuesClipboard, text);
    // The segment values dialog writes the clipboard itself.
    target._segmentValuesClipboard = text;
    target.select(3, 1);
    target.pasteSegmentValues();
    return shownBy(target, 0);
  });
  const document = recordedDocument('camera-motion');
  await bothWays(take, [document, document], (source, target) => {
    assert.ok(!source._cameraClipboard, 'Paste camera pose is off before a copy');
    const copied = source.copyCamera();
    assert.deepEqual(source._cameraClipboard, copied, 'and on after it');
    target._cameraClipboard = source._cameraClipboard;
    target.pasteCamera([0]);
    return shownBy(target, 0);
  });
  const clips = recordedDocument('vfx-clips');
  await bothWays(take, [clips, clips], (source, target) => {
    const [clip] = source.getVfxClips();
    source.copyVfxClip(clip.id);
    assert.equal(source._vfxClipClipboard.id, clip.id);
    assert.ok(source._vfxClipClipboardValues);
    [target._vfxClipClipboard, target._vfxClipClipboardValues] = [source._vfxClipClipboard, source._vfxClipClipboardValues];
    const id = target.pasteVfxClip({kind: 'figure', uid: 1});
    return {...shownBy(target, 0), id: normalized(String(id))};
  });
});

refs.test('a clipboard follows the editor from one project to the next', opts, async take => {
  for (const [copy, paste] of [
    [editor => { editor.select(1, -1); editor.copySelection(); }, editor => { editor.pasteSelection(); }],
    [editor => { editor.sheetCopyFrames(['layer-1'], 0, 3); }, editor => { editor.sheetPasteFrames(['layer-1'], 5); }],
  ]) {
    await bothWays(take, [recordedDocument('sheet-layers')], editor => {
      copy(editor);
      editor.load(recordedDocument('sheet-movieclip'));
      const before = editor._undo.length;
      paste(editor);
      return shownBy(editor, before);
    });
  }
});

test('what the interface empties is not pasted, and what it restores replaces what was copied', opts, async () => {
  const {editor, owner} = owned(recordedDocument('sheet-layers'));
  try {
    editor.select(1, -1); editor.copySelection();
    const before = documentText(editor), entries = editor._undo.length;
    editor._selectionClipboard = null;
    assert.equal(Boolean(editor._figureClipboard || editor._selectionClipboard), false);
    assert.equal(editor.pasteSelection().length, 0, 'nothing to paste');
    assert.equal(documentText(editor), before);
    assert.equal(editor._undo.length, entries);
    // The system's clipboard holds figures the session never copied.
    const other = owned(recordedDocument('sheet-movieclip'));
    try {
      other.editor.select(4, -1); other.editor.copySelection();
      await restoreClipboard(editor, wire(clipboardSnapshot(other.editor, 'figures')));
    } finally { other.owner.release(); }
    editor.pasteSelection();
    assert.equal(editor.undoLabel, 'Paste figures');
    assert.ok(editor.report.figure_types.some(figure => figure._styk?.movieclip), 'it pasted the restored clipboard');
    assert.deepEqual(owner.refused, {}, 'the session refused nothing');
  } finally { owner.release(); }
});

test('the drawing pixels the Draw tool copies stay the editor\'s and cross the shared clipboard unchanged', opts, async () => {
  const pixels = {version: 2, pixelsPerUnit: 1, world: {x: 1, y: 2}, matrix: [1, 0, 0, 1, 1, 2], bounds: null, tiles: []};
  const {editor, owner} = owned(recordedDocument('sheet-layers'));
  try {
    editor._drawingPixelClipboard = pixels;
    const packet = clipboardSnapshot(editor, 'drawing-pixels');
    assert.equal(packet.data, pixels);
    editor.select(1, -1); editor.copySelection(); editor.pasteSelection();
    editor.load(recordedDocument('sheet-movieclip'));
    assert.equal(editor._drawingPixelClipboard, pixels, 'through calls to the session and another project');
    const other = owned(recordedDocument('sheet-layers'));
    try {
      await restoreClipboard(other.editor, wire(packet));
      assert.deepEqual(other.editor._drawingPixelClipboard, pixels);
    } finally { other.owner.release(); }
  } finally { owner.release(); }
});

refs.test('an audio clip copied in one project pastes in the next, its recording read from the project that has it', opts, async take => {
  await bothWays(take, [recordedDocument('audio')], editor => {
    assert.ok(!editor._audioClipboard, 'nothing copied');
    assert.equal(editor.copyAudioClip('clip-3'), true);
    assert.ok(editor._audioClipboard, 'the interface can tell something was copied');
    editor.load(recordedDocument('audio'));
    const before = editor._undo.length, id = editor.pasteAudioClip('audio-a', 3);
    assert.match(id, /^clip-/);
    const tracks = editor.report._styk.audio.tracks;
    assert.ok(tracks[0].clips.some(clip => clip.id === id && clip.start === 3));
    return {...shownBy(editor, before), id: normalized(id)};
  });
});

refs.test('an audio clip copied in a project that is then closed still pastes, its recording kept by the clipboard', opts, async take => {
  await bothWays(take, [recordedDocument('audio')], editor => {
    assert.equal(editor.copyAudioClip('clip-3'), true);
    // The project closes (its tab does, which ends its session) while another opens beside it.
    const closed = editor.detachDocument();
    editor.load(recordedDocument('startup'));
    editor.discardDocument(closed);
    assert.ok(editor._audioClipboard, 'the interface can still tell something was copied');
    const before = editor._undo.length, id = editor.pasteAudioClip('audio-a', 3);
    assert.match(id, /^clip-/);
    const [track] = editor.report._styk.audio.tracks;
    assert.ok(track.clips.some(clip => clip.id === id && clip.start === 3));
    assert.ok(editor.report._styk.audio.assets[track.clips.find(clip => clip.id === id).assetId], 'with its recording');
    return {...shownBy(editor, before), id: normalized(id)};
  });
});

test('a session that is freed hands over a recording it holds, and no clipboard asks a freed session', () => {
  const clipboards = createClipboards({}, {}, () => 'document');
  const recording = {clip: {id: 'clip-1'}, asset: {id: 'sound-1'}};
  const copier = {name: 'copier'}, pasting = {name: 'pasting'}, asked = [], sent = [];
  const fetch = (session, kind) => { asked.push([session.name, kind]); return recording; };
  const send = (kind, data, foreign) => sent.push([kind, data, foreign]);
  clipboards.adopt({kind: 'audio'}, copier);
  clipboards.surrender(copier, fetch);
  assert.deepEqual(asked, [['copier', 'audio']], 'the recording is read as the session ends');
  clipboards.handOver('pasteAudioClip', pasting, send, fetch);
  assert.deepEqual(sent, [['audio', recording, true]], 'and reaches the session that pastes');
  assert.equal(asked.length, 1, 'the session that ended is not asked again');
  // The session that pastes now has it: it hands it over in turn when it ends, and nothing is sent twice.
  sent.length = 0;
  clipboards.handOver('pasteAudioClip', pasting, send, fetch);
  assert.deepEqual(sent, []);
  clipboards.surrender(pasting, fetch);
  assert.deepEqual(asked.at(-1), ['pasting', 'audio']);
  // Sessions that hold nothing of it end without a read.
  clipboards.surrender({name: 'other'}, fetch);
  assert.equal(asked.length, 2);
});
