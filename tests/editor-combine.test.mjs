import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Editor} from '../src/editor.mjs';
import {buildGeometry, mixColor} from '../src/pivot/geometry.mjs';
import {validateScene} from '../src/pivot/model.mjs';
import backend from '../desktop/backend.cjs';

const near = (a, b, epsilon = 1e-4) => assert.ok(Math.abs(a - b) <= epsilon, `${a} != ${b}`);
const blank = () => { const editor = new Editor({demo: false}); editor.addFigure(); editor.markSaved(); return editor; };
function compareGeometry(before, after) {
  assert.equal(after.drawables.length, before.drawables.length);
  for (let i = 0; i < before.drawables.length; i++) {
    const a = before.drawables[i], b = after.drawables[i]; assert.equal(b.type, a.type); assert.deepEqual(b.rgb, a.rgb);
    near(a.alpha, b.alpha); near(a.opacity, b.opacity); if (a.thickness !== undefined) near(a.thickness, b.thickness);
    assert.equal(a.points.length, b.points.length);
    for (let j = 0; j < a.points.length; j++) { near(a.points[j].x, b.points[j].x); near(a.points[j].y, b.points[j].y); }
    if (a.type === 'image' || a.type === 'text') {
      assert.equal(Boolean(a.seg.extra_u8_b ?? a.seg.extra?.[2]) !== Boolean(a.obj.image_text_flags), Boolean(b.seg.extra_u8_b) !== Boolean(b.obj.image_text_flags));
      assert.equal(b.asset.data_url, a.asset.data_url);
    }
  }
}
function vectorGroup() {
  const editor = blank(), root = editor.selectedUid;
  editor.select(root, 2); editor.updateSegment({bend_rad: 0.5});
  editor.addPolygon([0, 7, 9], {color: '#e24491', opacity: 0.5});
  const child = editor.duplicateFigure().unique_id; editor.updateObject({scale: 0.6, color_override_raw: 0x80224466});
  editor.joinTo(root, 4); editor.select(root); return {editor, root, child};
}

test('combine joined figures preserves curved geometry, circles, fills, paint order and root identity', () => {
  const {editor, root} = vectorGroup(); editor.duplicateFrame(); const before = editor.serialize(), geometry = editor.geometry;
  editor.combineJoinedFigure(root, {name: 'Merged rig'});
  assert.equal(editor.frame.objects.length, 1); assert.equal(editor.object.unique_id, root); assert.equal(editor.figure.name, 'Merged rig');
  assert.equal(editor.figure.segments.length, 20); assert.equal(editor.figure.polyfills.length, 2);
  assert.equal(editor.report.keyframes[0].objects.length, 2); compareGeometry(geometry, editor.geometry);
  assert.doesNotThrow(() => validateScene(editor.serialize())); assert.equal(editor._undo.at(-1).kind, 'figure-splice');
  editor.undo(); assert.deepEqual(editor.serialize(), before); editor.redo(); compareGeometry(geometry, editor.geometry);
});

test('combine retains an external parent attachment and remaps its shifted object slot', () => {
  const {editor, root} = vectorGroup(); editor.select(root); const outside = editor.duplicateFigure().unique_id;
  editor.select(root); editor.joinTo(outside, 0); const baseline = editor.geometry;
  editor.combineJoinedFigure(root); assert.equal(editor.frame.objects.length, 2);
  assert.equal(editor.object.join.target_unique_id, outside); assert.equal(editor.frame.objects[editor.object.join.target_object_slot].unique_id, outside);
  compareGeometry(baseline, editor.geometry); assert.doesNotThrow(() => validateScene(editor.serialize()));
});

test('advanced combine uses the displayed retimed pose and undo restores definitions and independent parts', () => {
  const {editor,root,child}=vectorGroup(); editor.duplicateFrame();
  editor.select(root); editor.moveSelection(40,0); editor.commitDrag();
  for(const uid of [root,child]) editor.adoptNativePoseTrack({kind:'figure',uid});
  editor.seek(2); editor.select(root); const before=editor.serialize(), baseline=editor.geometry, depth=editor._undo.length;
  editor.combineJoinedFigure();
  assert.equal(editor.evaluatedFrame.objects.length,1); compareGeometry(baseline,editor.geometry);
  assert.equal(editor._undo.length,depth+1); assert.doesNotThrow(()=>validateScene(editor.serialize()));
  editor.undo(); assert.deepEqual(editor.serialize(),before);
  editor.redo(); assert.equal(editor.evaluatedFrame.objects.length,1); compareGeometry(baseline,editor.geometry);
});

for (const version of [2,3,4]) for (const authored of [false,true]) {
  test(`import version ${version}: merge ${authored ? 'advanced' : 'stored'} poses directly, retaining colors, timing and undo`, () => {
    const {editor,root,child}=vectorGroup(); editor.duplicateFrame();
    const document=editor.serialize(); document.version=version;
    document.keyframes[0].duration_raw=4; document.keyframes[1].duration_raw=3;
    for (const frame of document.keyframes) for (const object of frame.objects)
      object.color_override_raw=object.unique_id===root ? 0x2244dd : -1;
    editor.load(document); editor.select(root); editor.selectFrame(1);
    if (authored) for (const uid of [root,child]) editor.adoptNativePoseTrack({kind:'figure',uid});
    const before=editor.serialize(), geometry=editor.geometry, ticks=editor.totalTicks, depth=editor._undo.length;
    editor.combineJoinedFigure(root);
    assert.equal(editor.evaluatedFrame.objects.length,1);
    assert.equal(editor.report.version,version,'import metadata must not force a document-wide timing conversion');
    assert.equal(editor.totalTicks,ticks); assert.deepEqual(editor.report.keyframes.map(frame=>frame.duration_raw),[4,3]);
    compareGeometry(geometry,editor.geometry); validateScene(editor.serialize());
    assert.equal(editor._undo.length,depth+1);
    const reopened=new Editor({demo:false}); reopened.load(editor.serialize()); reopened.seek(editor.tick);
    compareGeometry(geometry,reopened.geometry);
    editor.undo(); assert.deepEqual(editor.serialize(),before); validateScene(editor.serialize());
    editor.redo(); compareGeometry(geometry,editor.geometry);
  });
}

test('unrepresentable opacity, outline and interleaved layer groups reject before mutation', () => {
  const {editor, root, child} = vectorGroup(); editor.select(child); editor.updateObject({field28: 50}); editor.select(root);
  let before = editor.serialize(); assert.throws(() => editor.combineJoinedFigure(), /opacity/); assert.deepEqual(editor.serialize(), before);
  editor.select(child); editor.updateObject({field28: 0}); editor.select(root); editor.updateFigureStyle({outlineWidth: 2});
  before = editor.serialize(); assert.throws(() => editor.combineJoinedFigure(), /outlines/); assert.deepEqual(editor.serialize(), before);
  editor.updateFigureStyle({outlineWidth: 0}); const third = editor.duplicateFigure().unique_id; editor.moveLayer(-1); editor.select(root);
  before = editor.serialize(); assert.throws(() => editor.combineJoinedFigure(), /adjacent layers/); assert.deepEqual(editor.serialize(), before);
  assert.ok(third);
});

test('combined image assets retain anchors, bytes and effective reflection with remapped media indices', () => {
  const editor = blank(), root = editor.selectedUid;
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1kAAAAASUVORK5CYII=';
  const definition = {figure_type_id: 77, name: 'Sprite', segments: [{segment_id: 1, parent_id: 0, length: 30, angle_rad: 0,
    thickness: 0, bend_rad: 0, primitive_code: 2, aux_code: 0, segment_type: 'image', segment_kind: 'image', color_rgb: [0, 0, 0], transparency: 0, visible: true,
    extra_u16: 0, extra_u8_a: 0, extra_u8_b: 1, z_order: 1}], polyfills: [], text_assets: [],
    image_assets: [{kind: 'image', asset_index: 0, table_index: 0, data_url: png, anchor_start: {x: 0, y: 0}, anchor_end: {x: 1, y: 0}, anchor_length: 1, anchor_angle_rad: 0}]};
  editor.importFigure(definition); editor.updateObject({scale: 2, image_text_flags: 1}); editor.joinTo(root, 4); editor.select(root);
  const baseline = editor.geometry; editor.combineJoinedFigure();
  assert.equal(editor.figure.image_assets.length, 1); assert.equal(editor.figure.image_assets[0].data_url, png);
  const segment = editor.figure.segments.find(s => s.segment_type === 'image'); assert.equal(segment.extra_u8_b, 0);
  compareGeometry(baseline, editor.geometry); assert.doesNotThrow(() => validateScene(editor.serialize()));
});

test('combined joined vectors roundtrip through actual native PIV and STK writers', () => {
  const {editor, root} = vectorGroup(); editor.combineJoinedFigure(root); const baseline = editor.geometry, document = editor.serialize();
  const python = String.raw`
import json,sys
from pathlib import Path
sys.path.insert(0,str(Path('backend').resolve()))
import server
doc=json.load(sys.stdin); store=server.ProjectStore(server.WORKSPACE); result={}
for kind in ('piv','stk'):
    raw,name=store.export({'document':doc,'format':kind,'figureTypeId':doc['keyframes'][0]['objects'][0]['figure_type_id']})
    result[kind]=store.import_bytes(raw,name)['document']
print(json.dumps(result))
`;
  const candidate = backend.pythonCandidates()[0], output = spawnSync(candidate.command, [...candidate.args, '-c', python], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), input: JSON.stringify(document), encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024});
  assert.equal(output.status, 0, output.error?.message || output.stderr); const decoded = JSON.parse(output.stdout);
  compareGeometry(baseline, buildGeometry(decoded.piv, decoded.piv.keyframes[0]));
  const figure = decoded.stk.figure_types.find(f => f.segments.length === 20);
  assert.equal(figure.segments.length, 20); assert.equal(figure.polyfills.length, 2);
});
