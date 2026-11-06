// The calls the engine session used to refuse for a document or a selection (and the editor ran instead) now run in the
// session: each leaves the document, the history entries and what undo and redo give back as the editor alone does
// (tests/support/owned-vs-plain.mjs; the editor alone's answers are recorded in tests/fixtures/owner-references), and nothing
// is refused or run in the editor.
import '../engine/tools/v8-pin.mjs';
import assert from 'node:assert/strict';
import {engineBuilt} from './support/engine-node.mjs';
import {construction} from '../src/rig-examples-3d.mjs';
import {createFrame, createObject, defaultFigure, emptyDocument} from '../src/demo.mjs';
import {movieclipFigure} from '../src/movieclips.mjs';
import {bothWays, recordedDocument} from './support/owned-vs-plain.mjs';
import {ownerReferences} from './support/owner-references.mjs';

const refs = ownerReferences(import.meta.url);
const opts = {skip: !engineBuilt};
/** The clipboard the interface reads, as text with its keys in order (the owned editor's mirror lists them differently). */
const clipboardText = editor => JSON.stringify(editor._selectionClipboard, (key, value) => {
  if (value instanceof Set || value instanceof Map) return [...value];
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : 1)) : value;
});

refs.test('copying, cutting or duplicating a selected branch makes a figure of its own', opts, async take => {
  for (const [name, uid, joint] of [['origin-join-layout-sheet', 1, 0], ['origin-join-layout-sheet', 1, 1], ['sheet-layers', 1, 0], ['sheet-layers', 1, 3], ['sheet-layers', 2, 0], ['branch-thickness-origin-sheet', 1, 3]]) {
    for (const how of ['copy', 'cut', 'duplicate']) {
      // A figure keeps at least one segment: cutting all of them is refused (the same in both editors).
      if (how === 'cut' && [['origin-join-layout-sheet', 0], ['sheet-layers', 0], ['sheet-layers', 2]].some(([n, j]) => n === name && j === joint && uid !== 3)) continue;
      const {owned} = await bothWays(take, recordedDocument(name), editor => {
        const before = editor.report.figure_types.length;
        editor.selectBranch(uid, joint);
        const count = how === 'cut' ? editor.cutSelection() : how === 'copy' ? editor.copySelection() : editor.duplicateSelection().length;
        assert.ok(count >= 1, `${name} ${joint} ${how}: copied something`);
        const held = how === 'duplicate' ? '' : clipboardText(editor);
        if (how !== 'duplicate') editor.pasteSelection();
        const made = editor.report.figure_types.slice(before).find(figure => / branch$/.test(figure.name));
        assert.ok(made, `${name} ${joint} ${how}: the branch is a definition of its own`);
        assert.ok(made.segments.some(segment => segment.parent_id === 0), "its first joint hangs from the figure origin");
        return held;
      }, {expectEntries: how === 'cut' ? 2 : 1});
      assert.ok(owned.result === '' || owned.result.includes('freshTypes'), 'the clipboard names the definition it made');
    }
  }
});

refs.test('a branch whose face is drawn from joints outside it cannot be copied alone', opts, async take => {
  const document = recordedDocument('origin-join-layout-sheet');
  const [fill] = document.figure_types[0].polyfills;
  fill.segment_ids = fill.segment_ids_raw = [44, 55, 66];
  fill._stykSurface.basis = [44, 55, 33];
  const {owned} = await bothWays(take, document, editor => {
    editor.selectBranch(1, 3);
    try { editor.copySelection(); } catch (error) { return error.messageKey; }
    return 'copied';
  }, {unchanged: true});
  assert.equal(owned.result, 'errors.editorSelection.copyTheWholeFigureToIncludeItsFace');
});

refs.test('the effects of a copied branch go with it to its new definition', opts, async take => {
  const document = recordedDocument('figure-vfx');
  // The figure's pinned limbs name joints the branch may not hold: the editor refuses to paste those.
  for (const frame of document.keyframes) for (const object of frame.objects) delete object._stykIK;
  const {owned} = await bothWays(take, document, editor => {
    // Effects are kept on a handle ("<definition>/<handle>", "*/<handle>") or on the whole figure.
    const [object] = editor.evaluatedFrame.objects;
    const figure = editor.report.figure_types.find(type => type.figure_type_id === object.figure_type_id);
    const joint = figure.segments.findIndex(segment => Object.keys(object._stykVfx ?? {}).some(key => key.endsWith(`/${segment.segment_id}`)));
    assert.ok(joint >= 0, 'an effect sits on a handle of the figure');
    editor.selectBranch(object.unique_id, joint);
    editor.copySelection();
    editor.pasteSelection();
    const pasted = editor.selectedObjects[0];
    return Object.keys(pasted._stykVfx ?? {}).join(' ');
  }, {expectEntries: 1});
  assert.match(owned.result, /\d+\/\d+/, 'the effect follows to the new definition');
});

/** The file of two examples joined into one assembly (as a file holds it): the second hangs from `handle` of the first. */
function assembly(take, first, second, handle) {
  return take(`assembly ${first} ${second}`);
}

refs.test('combining joined figures keeps their rig relationships', opts, async take => {
  const document = assembly(take, 'articulated-piston', 'sliding-carriage', 3);
  const {owned} = await bothWays(take, document, editor => {
    editor.select(1);
    const combined = editor.combineJoinedFigure(1);
    assert.equal(editor.undoLabel, 'Combine joined figures');
    assert.ok(editor.figure.segments.filter(segment => segment._stykRig?.connector).length >= 2, 'the sliding connectors came along');
    return combined.unique_id;
  }, {expectEntries: 1});
  assert.equal(owned.result, 1);
});

refs.test('combining joined figures keeps the faces drawn from joints and their paint order', opts, async take => {
  const document = assembly(take, 'solid-cylinder-3d', 'solid-gem-3d', 0);
  await bothWays(take, document, editor => {
    editor.select(1, -1);
    editor.combineJoinedFigure();
    assert.ok(editor.figure.polyfills.some(fill => fill._stykSurface), 'the faces kept their surfaces');
    assert.ok(editor.figure.polyfills.every(fill => (fill._stykSurface?.basis ?? []).every(handle => editor.figure.segments.some(segment => segment.segment_id === handle) || handle === 0)), 'they name joints of the new figure');
  }, {expectEntries: 1});
});

refs.test('combining joined figures draws pinned limbs as they stand and keeps colour transitions', opts, async take => {
  for (const name of ['ik-joined-late', 'ik-joined-unpinned']) {
    const document = recordedDocument(name);
    const root = document.keyframes[0].objects.find(object => !object.join && document.keyframes[0].objects.some(other => other.join?.target_object_slot === object.object_slot));
    assert.ok(root, `${name}: an assembly`);
    const withTransition = structuredClone(document);
    withTransition.keyframes[0].objects.find(object => object.unique_id === root.unique_id).color_transition = {from: 0xff112233, to: 0xff223344, t: 0.5};
    for (const source of [document, withTransition]) {
      await bothWays(take, source, editor => {
        editor.select(root.unique_id);
        editor.combineJoinedFigure(root.unique_id);
        assert.equal(editor.undoLabel, 'Combine joined figures');
      }, {expectEntries: 1});
    }
  }
});

/** A document of "sprite-segment-sparse-native" with its media figure (3) joined to the end of a limb of figure 1. */
function mediaAssembly(take, what, tune = () => {}) {
  return take(`media assembly ${what}`);
}

refs.test('combining joined figures moves their images and text into the new figure', opts, async take => {
  const texts = mediaAssembly(take, 'text', source => {
    // The same figure, drawing its text instead of its picture.
    const [segment] = source.figure_types[2].segments;
    Object.assign(segment, {primitive_code: 5, flags: 261, segment_type: 'text', segment_kind: 'text'});
  });
  for (const [what, document, table] of [['an image', mediaAssembly(take, 'image'), 'image_assets'], ['text', texts, 'text_assets']]) {
    const {owned} = await bothWays(take, document, editor => {
      editor.select(1);
      editor.combineJoinedFigure(1);
      assert.equal(editor.figure[table].length, 1, `${what} came along`);
      assert.equal(editor.figure[table][0].asset_index, 0, 'it is the first entry of the new table');
      assert.ok(editor.figure.segments.some(segment => segment.extra_u16 === 0 && ['image', 'text'].includes(segment.segment_type)), 'a segment draws it');
      return editor.figure[table][0].kind;
    }, {expectEntries: 1});
    assert.equal(owned.result, table === 'image_assets' ? 'image' : 'text');
  }
});

refs.test('a segment of an animation-origin figure is disconnected unless it holds the origin', opts, async take => {
  const document = recordedDocument('origin-join-layout-sheet');
  const {owned} = await bothWays(take, document, editor => {
    editor.select(1, 2);
    editor.disconnectSegment();
    assert.equal(editor.undoLabel, 'Disconnect segment');
    assert.ok(!editor.figure._styk?.animationOrigin, 'the part has no origin of its own');
    return editor.report.figure_types.filter(figure => figure._styk?.animationOrigin).length;
  }, {expectEntries: 1});
  assert.equal(owned.result, 2, 'both figures with an origin keep it');
  const {owned: refused} = await bothWays(take, document, editor => {
    editor.select(1, 0);
    try { editor.disconnectSegment(); } catch (error) { return error.messageKey; }
    return 'disconnected';
  }, {unchanged: true});
  assert.equal(refused.result, 'errors.editorDisconnect.moveTheFigureOriginOffThisPartFirst');
});

/** A spatial head bone with a movieclip joined to it: a 3D mesh in two forms, or two sets of drawings the bone turns. */
function headClip(kind) {
  const q = construction();
  q.add(0, 0, 0, 'Figure');
  const turn = q.add(0, 0, 0, 'Turn'), pitch = q.add(0, 0, 0, 'Tilt');
  const handle = q.add(0, 30, -Math.PI / 2, 'Head', {control: true, rig: {spatial: {parent: 0, origin: [0, 0, 0], tip: [0, -30, 0], turn, pitch}}});
  const body = {figure_type_id: 1, segments: q.segments, segment_count: q.segments.length, polyfills: []};
  let head;
  if (kind === 'mesh') {
    head = movieclipFigure(2, 'Forms', {...emptyDocument(), figure_types: [], keyframes: [createFrame([]), createFrame([])]}, {duration: 2, pivot: {x: 0, y: 0}});
    const mesh = {positions: [-10, -20, 0, 10, -20, 0, 0, 0, 10, 0, 0, -10], indices: [0, 1, 2, 1, 0, 3, 0, 2, 3, 2, 1, 3], colors: [[240, 80, 0]], materials: [0, 0, 0, 0]};
    head._styk.movieclip.spatialMeshes = [mesh, {...mesh, colors: [[0, 80, 240]]}];
    head._styk.movieclip.drawingSets = [{name: 'Orange', views: [{name: 'Mesh', frame: 0}]}, {name: 'Blue', views: [{name: 'Mesh', frame: 1}]}];
  } else {
    const ink = defaultFigure(1);
    const inner = {...emptyDocument(), figure_types: [ink], keyframes: Array.from({length: 48}, (_, i) => createFrame([createObject(ink, 1, i, 0)]))};
    head = movieclipFigure(2, 'Head forms', inner, {duration: 48, pivot: {x: 0, y: 0}});
    const sets = Array.from({length: 2}, (_, g) => ({name: 'Form ' + g, views: Array.from({length: 24}, (_, i) => ({name: 'View ' + i, frame: g * 24 + i}))}));
    Object.assign(head._styk.movieclip, {drawingSets: sets, drawingRotation: {steps: 8, tiltThreshold: 20 * Math.PI / 180}});
  }
  const figure = createObject(body, 1, 200, 200);
  const clip = createObject(head, 2, 0, 0, {join: {target_object_slot: 0, target_unique_id: 1, target_handle_id: handle}, _stykMovieclip: {mode: 'single', offset: 0}});
  return {document: {...emptyDocument(), figure_types: [body, head], keyframes: [createFrame([figure, clip])]}, handle};
}

refs.test('breaking apart a movieclip of 3D meshes or turning drawings makes the figures it shows', opts, async take => {
  for (const kind of ['mesh', 'drawings']) {
    const {document, handle} = headClip(kind);
    for (const pose of [{}, {turn: 135 * Math.PI / 180, pitch: -35 * Math.PI / 180, bend: 25 * Math.PI / 180}]) {
      const {owned} = await bothWays(take, document, async editor => {
        editor.select(1, handle - 1);
        if (pose.turn !== undefined) editor.setSpatialPose(pose);
        editor.select(2);
        await editor.breakApartMovieclip();
        assert.equal(editor.undoLabel, 'Break apart frame');
        return editor.report.figure_types.length;
      }, {expectEntries: pose.turn === undefined ? 1 : 2});
      assert.ok(owned.result >= 2, `${kind}: the movieclip became figures`);
    }
  }
});

refs.test('breaking apart a movieclip that holds a joined mesh or turning drawings places them on their bone', opts, async take => {
  for (const kind of ['mesh', 'drawings']) {
    const {document: inner, handle} = headClip(kind);
    // The head turned a quarter and bent, inside a clip of its own.
    inner.keyframes[0].objects[0].angles[handle - 1] = 0.6;
    inner.keyframes[0].objects[0].angles[1] = Math.PI / 2;
    const outer = movieclipFigure(10, 'Outer', inner, {duration: 1, pivot: {x: 0, y: 0}});
    const body = defaultFigure(1);
    const document = {...emptyDocument(), figure_types: [body, outer], keyframes: [createFrame([createObject(body, 1, 100, 100), createObject(outer, 2, 300, 200, {_stykMovieclip: {mode: 'single', offset: 0}})])]};
    const {owned} = await bothWays(take, document, async editor => {
      editor.select(2);
      await editor.breakApartMovieclip();
      return editor.report.figure_types.length;
    }, {expectEntries: 1});
    assert.ok(owned.result > 2, `${kind}: the clip inside became figures`);
  }
});
