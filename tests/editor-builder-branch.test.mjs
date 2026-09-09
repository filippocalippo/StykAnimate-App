import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Editor} from '../src/editor.mjs';
import {editorBuilderBranchMethods, branchSegmentIndices, builderBranchStylePatch, builderBranchStyleBinding} from '../src/editor-builder-branch.mjs';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';
import {buildGeometry, evaluatedFrame, timeline} from '../src/pivot/geometry.mjs';
import {validateScene} from '../src/pivot/model.mjs';
import {animationRotation} from '../src/animation-origin.mjs';
import {builderDrawables} from '../src/editor-builder-style.mjs';
import {createImageFigure} from '../src/media-authoring.mjs';
import {compileTextFigure} from '../src/text-authoring.mjs';
import {parse} from '../vendor/text/opentype.mjs';
import backend from '../desktop/backend.cjs';

Object.assign(Editor.prototype, editorBuilderBranchMethods);
const clone = structuredClone, kinds = ['line', 'circle', 'image', 'circleFill', 'circleClear', 'text', 'squareLine'];
const near = (a, b, tolerance = .0002) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const nearPoint = (a, b) => {near(a.x, b.x); near(a.y, b.y);};
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
function fixture() {
  const report = emptyDocument(), figure = report.figure_types[0], base = figure.segments[0];
  figure.segments = [[30,20,3],[65535,0,0],[20,10,0],[10,0,0],[40,20,1],[50,40,4],[60,30,6],[70,10,0]].map(([id,parent,kind],i) => ({
    ...clone(base), segment_id: id, parent_id: parent, primitive_code: kind, segment_kind: kinds[kind], segment_type: [1,3,4].includes(kind) ? 'circle' : 'line',
    flags: kind | ((i % 2) << 8), aux_code: i % 2, is_static: Boolean(i % 2), length: 14 + i * 2, angle_rad: -.4 + i * .16,
    bend_rad: .2 + i * .04, thickness: [4,7,3,7,8,1,999,10][i], z_order: [7,2,4,1,5,6,8,9][i], transparency: i * 20,
    secondary: {rgb: [240,80,20], a: i * 11}, extra_u8_a: 3, extra_u8_b: 2,
  }));
  figure.segment_count = figure.segments.length;
  figure.polyfills = [
    {polyfill_id: 1, segment_ids: [10,20,40,50], color_rgb: [5,6,7], alpha_raw: 71, z_order: 4.5},
    {polyfill_id: 2, segment_ids: [0,10,20], color_rgb: [8,9,10], alpha_raw: 17, z_order: 3},
    {polyfill_id: 3, segment_ids: [30,40,20], color_rgb: [11,12,13], alpha_raw: 31, z_order: 4.5},
  ];
  const child = {...clone(figure), figure_type_id: 2, segments: [{...clone(base), segment_id: 1, parent_id: 0}], segment_count: 1, polyfills: []};
  report.figure_types.push(child);
  report.keyframes = [0,1].map(i => createFrame([
    createObject(figure, 1, 180 + 40 * i, 160, {scale: .8 + i * .4,
      angles: figure.segments.map(segment => segment.angle_rad + i * .2), len_flag: 1,
      lengths: figure.segments.map(segment => segment.length * (1 + i * .2)), bend_flag: 1,
      bends: figure.segments.map(segment => segment.bend_rad + i * .1)}),
    createObject(child, 2, 0, 0, {join: {target_object_slot: 0, target_unique_id: 1, target_handle_id: 20}}),
    createObject(child, 3, 350, 220),
  ], i ? 1 : 5));
  const editor = new Editor({demo: false}).load(report); editor.select(1, 2); editor.captureFrameSource(editor.report.keyframes[1]); return editor;
}
function reversible(editor, action) {
  const before = editor.serialize(), history = editor._undo.length;
  assert.equal(action(), true); assert.equal(editor._undo.length, history + 1);
  const after = editor.serialize(); editor.undo(); assert.deepEqual(editor.serialize(), before); editor.redo(); assert.deepEqual(editor.serialize(), after);
}

test('native branch traversal excludes ancestors/siblings and color-only retains mixed alpha and enclosed polygon eligibility', () => {
  const editor = fixture(), figure = editor.figure, frames = editor.report.keyframes, sources = clone(editor._allSourceFrames()), unrelated = figure.segments[1];
  assert.deepEqual(branchSegmentIndices(figure, 2), [0,2,4,5,6]);
  reversible(editor, () => editor.updateSegmentBranchStyle({color: '#123456'}));
  for (const i of [0,2,4,5,6]) {assert.deepEqual(editor.figure.segments[i].color_rgb, [18,52,86]); assert.equal(editor.figure.segments[i].transparency, i * 20);}
  for (const i of [0,2]) {assert.deepEqual(editor.figure.polyfills[i].color_rgb, [18,52,86]); assert.equal(editor.figure.polyfills[i].alpha_raw, [71,17,31][i]);}
  assert.deepEqual(editor.figure.polyfills[1].color_rgb, [8,9,10]);
  assert.equal(editor.report.keyframes, frames); assert.deepEqual(editor._allSourceFrames(), sources); assert.equal(editor.figure.segments[1], unrelated);
  const command = editor._undo.at(-1); assert.equal(command.kind, 'native-properties'); assert.ok(command.before.entries.every(entry => !entry.path.includes('image_assets')));
});

test('explicit alpha and gradient endpoint updates follow native branch rules and collapse only matching RGBA endpoints', () => {
  const editor = fixture();
  editor.updateSegmentBranchStyle({gradient: {color: '#123456'}});
  for (const i of [0,2,4,5,6]) assert.deepEqual(editor.figure.segments[i].secondary, {rgb: [18,52,86], a: i * 11});
  assert.deepEqual(editor.figure.polyfills[0].color_rgb, [5,6,7]);
  editor.updateSegmentBranchStyle({color: '#123456', opacity: .6});
  for (const i of [0,2,4,5,6]) {assert.equal(editor.figure.segments[i].transparency, 102); assert.ok(editor.figure.segments[i].secondary);}
  assert.equal(editor.figure.polyfills[0].alpha_raw, 102); assert.equal(editor.figure.polyfills[1].alpha_raw, 17);
  reversible(editor, () => editor.updateSegmentBranchStyle({gradient: {color: '#123456', opacity: .6}}));
  for (const i of [0,2,4,5,6]) assert.equal(editor.figure.segments[i].secondary, null);
  editor.updateSegmentBranchStyle({gradient: {color: '#ff0000', opacity: .5}});
  reversible(editor, () => editor.updateSegmentBranchStyle({gradient: null}));
});

test('fixed thickness, delta clamping and selected-anchor static/caps/fill are one sparse undo each', () => {
  const editor = fixture(), before = clone(editor.figure);
  reversible(editor, () => editor.changeBranchThickness(5));
  assert.deepEqual([0,2,4,5,6].map(i => editor.figure.segments[i].thickness), [9,8,13,6,1000]);
  reversible(editor, () => editor.updateSegmentBranchStyle({thickness: 12.5, static: true}));
  for (const i of [0,2,4,5,6]) {const s = editor.figure.segments[i]; assert.equal(s.thickness, 12.5); assert.equal(s.aux_code & 1, 1); assert.equal(s.flags & 256, 256);}
  assert.deepEqual(editor.figure.segments[3], before.segments[3]);
  reversible(editor, () => editor.setBranchCaps());
  assert.equal(editor.figure.segments[2].primitive_code, 6); assert.equal(editor.figure.segments[6].primitive_code, 6);
  assert.equal(editor._undo.at(-1).after.entries.filter(e => e.path.at(-1) === 'primitive_code').length, 1);
  editor.select(1, 4); reversible(editor, () => editor.setBranchFill());
  assert.equal(editor.figure.segments[4].primitive_code, 3); assert.equal(editor.figure.segments[5].primitive_code, 3); assert.equal(editor.figure.segments[0].primitive_code, 3);
  editor.setBranchFill('circleClear'); assert.equal(editor.figure.segments[4].primitive_code, 4); assert.equal(editor.figure.segments[5].primitive_code, 4);
});

test('branch planner is pure, gesture binding is reusable and malformed/no-op edits cannot enter history', () => {
  const editor = fixture(), original = clone(editor.figure), history = editor._undo.length;
  const patch = builderBranchStylePatch(editor.figure, 2, {thickness: 20}); assert.equal(patch.entries.length, 10); assert.deepEqual(editor.figure, original);
  const binding = builderBranchStyleBinding(editor, {thickness: 20}); assert.deepEqual(binding.segmentIndices, [0,2,4,5,6]);
  const preview = clone(original); binding.mutate(preview, {thickness: 10}); binding.mutate(preview, {thickness: 15});
  assert.equal(preview.segments[0].thickness, 15); assert.equal(preview.segments[1].thickness, original.segments[1].thickness);
  assert.throws(() => binding.mutate(preview, {opacity: .5}), /fields changed/);
  for (const value of [{color: '#zzz'}, {color:'#123456',opacity:2}, {thickness:-1}, {static:1}, {gradient:{color:[1,2,999]}}, {shape:'circle'}])
    assert.throws(() => editor.updateSegmentBranchStyle(value));
  assert.deepEqual(editor.figure, original); assert.equal(editor._undo.length, history); assert.equal(editor.updateSegmentBranchStyle({}), false);
  editor.updateSegmentBranchStyle({thickness: 10}); const nextHistory = editor._undo.length;
  assert.equal(editor.updateSegmentBranchStyle({thickness: 10}), false); assert.equal(editor._undo.length, nextHistory);
});

test('selected-only sparse style combines shape/static/gradient without copying assets, poses or sibling styles', () => {
  const editor = fixture(), siblings = clone(editor.figure.segments), polygons = clone(editor.figure.polyfills), frames = clone(editor._allSourceFrames());
  const asset = createImageFigure({dataUrl:png,width:1,height:1}).image_assets[0]; editor.figure.image_assets.push(asset);
  reversible(editor, () => editor.updateBuilderSegmentStyle({color:'#fedcba',opacity:.25,static:true,shape:'squareLine',thickness:1400,gradient:{color:'#123456',opacity:.4}}));
  const segment = editor.figure.segments[2]; assert.equal(segment.flags,262); assert.equal(segment.thickness,1400); assert.equal(segment.transparency,191);
  assert.deepEqual(segment.secondary,{rgb:[18,52,86],a:153}); assert.equal(editor.figure.image_assets[0],asset);
  for(let i=0;i<siblings.length;i++)if(i!==2)assert.deepEqual(editor.figure.segments[i],siblings[i]);
  assert.deepEqual(editor.figure.polyfills,polygons); assert.deepEqual(editor._allSourceFrames(),frames);
  assert.ok(editor._undo.at(-1).after.entries.every(e => e.path[0]==='segments' && e.path[1]===2));
  const before=editor.serialize(); assert.throws(() => editor.updateBuilderSegmentStyle({color:'#ffffff',shape:'image'}),/round line/); assert.deepEqual(editor.serialize(),before);
});

test('branch split retains posed endpoints, joined figures, sparse max IDs, polygon closures and combined draw order', () => {
  const editor = fixture(), before = editor.serialize(), frames = editor._allSourceFrames(), geometries = frames.map(frame => buildGeometry(editor.report, frame));
  const oldOrder = builderDrawables(editor.figure).map(e => [e.kind, e.kind === 'segment' ? e.item.segment_id : e.item.polyfill_id]);
  const oldSelected = editor.selectedJoint, history = editor._undo.length;
  assert.equal(editor.splitSegmentBranch(.4), true); assert.equal(editor._undo.length, history + 1);
  assert.equal(editor.figure.segments.length, 13); assert.equal(editor.figure.segments[editor.selectedJoint + 1].segment_id, 20);
  const originals = new Map(before.figure_types[0].segments.map(s => [s.segment_id, s])), midpoint = new Map();
  for (let i = 0; i < editor.figure.segments.length; i++) {
    const segment = editor.figure.segments[i]; if (originals.has(segment.segment_id)) continue;
    const second = editor.figure.segments[i + 1], old = originals.get(second.segment_id); midpoint.set(old.segment_id, segment.segment_id);
    assert.equal(second.parent_id, segment.segment_id); assert.equal(segment.parent_id, old.parent_id);
    near(segment.length, old.length * .4); near(second.length, old.length * .6);
    for (const key of ['primitive_code','thickness','is_static','color_rgb','secondary','transparency','extra_u8_a','extra_u8_b']) {
      assert.deepEqual(segment[key], old[key]); assert.deepEqual(second[key], old[key]);
    }
  }
  assert.deepEqual([...midpoint.keys()], [30,20,40,50,60]); assert.ok([...midpoint.values()].every(id => id < 65535));
  assert.deepEqual(editor.figure.polyfills[2].segment_ids, [30,40,midpoint.get(40),20,midpoint.get(30)]);
  const expectedOrder = oldOrder.flatMap(([kind,id]) => kind === 'segment' && midpoint.has(id) ? [[kind,midpoint.get(id)],[kind,id]] : [[kind,id]]);
  assert.deepEqual(builderDrawables(editor.figure).map(e => [e.kind,e.kind === 'segment' ? e.item.segment_id : e.item.polyfill_id]), expectedOrder);
  frames.forEach((frame, i) => {
    const next = buildGeometry(editor.report, frame);
    for (const [id, point] of geometries[i].objects.get(0).joints) nearPoint(next.objects.get(0).joints.get(id), point);
    nearPoint(next.objects.get(1).root, geometries[i].objects.get(1).root);
    assert.equal(frame.objects[1].join.target_handle_id, 20); assert.equal(frame.objects[0].angles.length, 13);
  });
  validateScene({...editor.report, keyframes: editor._allSourceFrames()});
  const after = editor.serialize(); editor.undo(); assert.equal(editor.selectedJoint, oldSelected); assert.deepEqual(editor.serialize(), before); editor.redo(); assert.deepEqual(editor.serialize(), after);
});

test('split activates runtime-only length/bend values and duplicates per-instance/authored styles into both pieces', () => {
  const editor = fixture();
  for (const frame of editor._allSourceFrames()) {
    const object = frame.objects[0]; object.len_flag = object.bend_flag = 0; object.lengths = object.bends = [];
    object.runtime_segments = editor.figure.segments.map(s => ({length: s.length * 1.4, bend_rad: s.bend_rad + .13}));
    object._stykStyle = {segments: {20: {opacity:.25,gradientOpacity:.8}}};
  }
  const target = {kind:'segment',uid:1,handleId:20};
  editor.addAnimationKeys([{target,property:'opacity',tick:0,value:.2},{target,property:'opacity',tick:5,value:.8}]);
  const geometry = editor._allSourceFrames().map(frame => buildGeometry(editor.report, frame)), keys = clone(editor.animationChannel(target,'opacity').keys);
  editor.splitSegmentBranch(); const newId = editor.figure.segments[editor.selectedJoint].segment_id;
  for (const [i, frame] of editor._allSourceFrames().entries()) {
    const object = frame.objects[0]; assert.equal(object.len_flag, 1); assert.equal(object.bend_flag, 1); assert.equal(object.runtime_segments, undefined);
    assert.deepEqual(object._stykStyle.segments[newId], object._stykStyle.segments[20]);
    nearPoint(buildGeometry(editor.report,frame).objects.get(0).joints.get(60),geometry[i].objects.get(0).joints.get(60));
  }
  const copied = editor.animationChannel({...target,handleId:newId},'opacity').keys;
  assert.deepEqual(copied.map(({id,...key}) => key),keys.map(({id,...key}) => key)); assert.notEqual(copied[0].id,keys[0].id);
});

test('native Split keeps tiny-bend second angles and uses a single signed-pi wrap for larger bends', () => {
  for (const [angle,bend,expected] of [[.2,.002,.2],[.2,-.002,.2],[3.13,.04,3.15-2*Math.PI],[-3.13,-.04,-3.15+2*Math.PI]]) {
    const report=emptyDocument(),figure=report.figure_types[0];
    figure.segments=[{...figure.segments[0],angle_rad:angle,bend_rad:bend}];figure.segment_count=1;
    report.keyframes=[createFrame([createObject(figure,1,100,100)],1)];
    const editor=new Editor({demo:false}).load(report);editor.select(1,0);editor.splitBuilderSegments({branch:false});
    assert.equal(editor.figure.segments[0].angle_rad,angle);near(editor.figure.segments[1].angle_rad,expected,1e-12);
    near(editor.object.angles[1],expected,1e-12);assert.equal(editor.figure.segments[0].bend_rad,bend/2);assert.equal(editor.figure.segments[1].bend_rad,bend/2);
  }
});

test('branch split after reroot and reference deletion retains support rotation and all posed endpoints', () => {
  const editor = fixture(); editor.setOrigin(50);
  const reference = editor.figure._styk.animationOrigin.rotationHandleId;
  editor.select(1,editor.figure.segments.findIndex(s => s.segment_id === reference)); editor.deleteSingleSegment();
  assert.ok(editor.figure._styk.animationOrigin.support);
  editor.select(1,editor.figure.segments.findIndex(s => s.parent_id === 0));
  const before = editor.serialize(), rows = timeline(before);
  const samples = Array.from({length:21},(_,i) => evaluatedFrame(before,0,i / 20,rows[0].count * i / 20));
  const ids = before.figure_types[0].segments.map(s => s.segment_id);
  editor.splitSegmentBranch();
  for (let i = 0; i <= 20; i++) {
    const next = evaluatedFrame(editor.report,0,i / 20,rows[0].count * i / 20);
    near(animationRotation(editor.figure,next.objects[0]),animationRotation(before.figure_types[0],samples[i].objects[0]),1e-9);
    const oldGeometry = buildGeometry(before,samples[i]), newGeometry = buildGeometry(editor.report,next);
    for (const id of ids) nearPoint(newGeometry.objects.get(0).joints.get(id),oldGeometry.objects.get(0).joints.get(id));
  }
});

test('branch capacity preflight is atomic and deep 15,000-segment splitting reaches native limit without recursion', () => {
  const report = emptyDocument(), figure = report.figure_types[0], base = figure.segments[0];
  figure.segments = Array.from({length:15000},(_,i) => ({...base,segment_id:i+1,parent_id:i,length:.01,bend_rad:0,angle_rad:0}));
  figure.segment_count = 15000; report.keyframes = [createFrame([createObject(figure,1,0,0)],1)];
  const editor = new Editor({demo:false}).load(report); editor.select(1,0);
  assert.equal(editor.splitSegmentBranch(),true); assert.equal(editor.figure.segments.length,30000); assert.equal(editor.object.angles.length,30000);
  const history = editor._undo.length, segments = editor.figure.segments;
  assert.throws(() => editor.splitSegmentBranch(), /30,000/); assert.equal(editor._undo.length,history); assert.equal(editor.figure.segments,segments);
  editor.undo(); assert.equal(editor.figure.segments.length,15000); editor.redo(); assert.equal(editor.figure.segments.length,30000);
});

test('native STK and PIV roundtrip retain split image/text references, primitive kinds and gradients', async () => {
  const fontBytes = await readFile(new URL('../vendor/text/NotoSans-Regular.ttf',import.meta.url));
  const font = parse(fontBytes.buffer.slice(fontBytes.byteOffset,fontBytes.byteOffset+fontBytes.byteLength));
  const image = createImageFigure({dataUrl:png,width:1,height:1}), text = compileTextFigure({text:'Ab',fontSize:30},font);
  const figure = {...image,segments:[image.segments[0],{...text.segments[0],segment_id:2,parent_id:1,z_order:2}],text_assets:text.text_assets,segment_count:2};
  figure.segments.forEach(s => {s.secondary={rgb:[230,100,20],a:77};s.transparency=25;});
  const report = emptyDocument(); report.figure_types=[figure]; report.keyframes=[createFrame([createObject(figure,1,100,100)],1)];
  const editor = new Editor({demo:false}).load(report); editor.select(1,0);
  const assets = [editor.figure.image_assets[0],editor.figure.text_assets[0]];
  editor.splitBuilderSegments({branch:true}); assert.deepEqual(editor.figure.segments.map(s=>s.primitive_code),[2,2,5,5]);
  assert.equal(editor.figure.image_assets[0],assets[0]); assert.equal(editor.figure.text_assets[0],assets[1]);
  const python = backend.pythonCandidates()[0], script = "import json,sys\nfrom pathlib import Path\nsys.path.insert(0,str(Path('backend').resolve()))\nimport server\nr=json.loads(sys.stdin.buffer.read().decode('utf-8'));s=server.ProjectStore(server.WORKSPACE);out={}\nfor kind in ('piv','stk'):\n raw,name=s.export({'document':r,'format':kind,'figureTypeId':1});out[kind]=s.import_bytes(raw,name)['document']\nprint(json.dumps(out))";
  const result = spawnSync(python.command,[...python.args,'-c',script],{cwd:fileURLToPath(new URL('..',import.meta.url)),input:JSON.stringify(editor.serialize()),encoding:'utf8',windowsHide:true,maxBuffer:12*1024*1024});
  assert.equal(result.status,0,result.error?.message || result.stderr);
  for (const document of Object.values(JSON.parse(result.stdout))) {
    const saved = document.figure_types.find(f=>f.segments.length===4); assert.ok(saved);
    assert.deepEqual(saved.segments.map(s=>s.primitive_code),[2,2,5,5]);
    assert.equal(saved.image_assets.length,1); assert.equal(saved.text_assets.length,1); assert.equal(saved.text_assets[0].text,'Ab');
    for(const s of saved.segments) {assert.deepEqual(s.secondary,{rgb:[230,100,20],a:77});assert.equal(s.transparency,25);}
  }
});
