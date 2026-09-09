import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {editorInbetweenMethods, planInsertInbetweens} from '../src/editor-inbetween.mjs';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';
import {buildGeometry, evaluatedFrame, evaluatedNativeFrame, nativeTimeline} from '../src/pivot/geometry.mjs';
import {validateAnimationDocument} from '../src/animation-channels.mjs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import backend from '../desktop/backend.cjs';

Object.assign(Editor.prototype, editorInbetweenMethods);
const clone = value => structuredClone(value);
function fixture({durations = [6, 4, 3, 9], easing = false, version = 5} = {}) {
  const report = emptyDocument(), figure = report.figure_types[0];
  report.auto_easing = easing; report.version = version;
  report.backgrounds = [{background_id: 1, kind: 2, color: 0xff112233}, {background_id: 2, kind: 2, color: 0xffddeeff}];
  figure.image_assets = [{name: 'Retained image', data_base64: 'AA=='}];
  figure.text_assets = [{text: 'Retained text'}];
  report.keyframes = durations.map((ticks, index) => {
    const parent = createObject(figure, 12, [10, 90, 140, 20][index % 4], 100 + index * 5);
    parent.angles = parent.angles.map((angle, joint) => angle + index * .1 + joint * .01);
    parent.len_flag = 1; parent.lengths = figure.segments.map(segment => segment.length * (1 + .1 * index));
    parent.bend_flag = 1; parent.bends = figure.segments.map((_, joint) => joint * .02 * index);
    parent.scale = 1 + index / 5; parent.field28 = index * 32; parent.color_override_raw = (0xff002244 + index * 0x00112211) >>> 0;
    const child = createObject(figure, 88, 0, 0, {join: {target_unique_id: 12, target_object_slot: 0, target_handle_id: 2}});
    const frame = createFrame([parent, child], ticks);
    frame.object_draw_order = [1, 0]; frame.object_draw_order_unique_ids = [88, 12];
    frame.camera = {is_default: false, x: index * 15, y: index * 6, scale: 1 + index / 10, angle_rad: index / 20};
    frame.background_id = index % 2 + 1; frame._styk = {custom: `pose-${index}`};
    return frame;
  });
  return new Editor({demo: false}).load(report);
}
function pose(report, frame) {
  return {camera: clone(frame.camera), background: [frame.background_id, frame.background_id_b, frame.background_mix, frame._stykBackgroundColor],
    order: clone(frame.object_draw_order_unique_ids), drawables: buildGeometry(report, frame).drawables.map(({obj, fig, seg, ...drawable}) => drawable)};
}
function clearHistory(editor) { editor._undo = []; editor._redo = []; editor._historySize = 0; }

for (const easing of [false, true]) test(`chosen ratio inserts actual native pose once without changing source durations (easing ${easing})`, () => {
  const editor = fixture({easing}), report = editor.report, before = clone(report), frames = report.keyframes.slice();
  const expected = pose(report, evaluatedNativeFrame({...report, auto_easing: false}, 1, .37)), total = editor.totalTicks;
  editor.selectFrame(2); editor.select(12); editor.copyFrames([0]); const clipboard = editor._frameClipboard;
  const figures = report.figure_types, backgrounds = report.backgrounds, result = editor.insertInbetweenFrames(.37);
  assert.deepEqual(result.indices, [2]); assert.deepEqual(result.ticks, [10]); assert.equal(result.insertedFrames, 1);
  assert.equal(editor.totalTicks, total + 3); assert.deepEqual(report.keyframes.map(frame => frame.duration_raw), [6, 4, 3, 3, 9]);
  assert.deepEqual(pose(report, report.keyframes[2]), expected);
  assert.equal(report.figure_types, figures); assert.equal(report.backgrounds, backgrounds); assert.equal(editor._frameClipboard, clipboard);
  for (let index = 0; index < frames.length; index++) assert.equal(report.keyframes[index + (index >= 2 ? 1 : 0)], frames[index]);
  assert.equal(new Set(report.keyframes.map(frame => frame._styk.frameId)).size, 5);
  assert.equal(editor._undo.length, 1); editor.undo(); assert.deepEqual(report, before); assert.equal(editor.frameIndex, 2); assert.equal(editor.selectedUid, 12);
  editor.redo(); assert.deepEqual(pose(report, report.keyframes[2]), expected); assert.doesNotThrow(() => editor.serialize());
});

test('multiple selected insertions sample the original timeline and retain hidden source identities', () => {
  const editor = fixture({durations: [5, 0, 7, 1], easing: true}), report = editor.report, before = clone(report);
  const expected = [1, 2, 3].map(index => pose(report, evaluatedNativeFrame({...report, auto_easing: false}, index - 1, .5)));
  const result = editor.insertInbetweenFrames(.5, [3, 2, 1, 2]);
  assert.deepEqual(result.indices, [1, 3, 5]); assert.deepEqual(result.skippedIndices, []); assert.deepEqual(result.ticks, [5, 5, 19]);
  assert.deepEqual(result.indices.map(index => pose(report, report.keyframes[index])), expected);
  assert.equal(report.keyframes[2].duration_raw, 0); assert.equal(report.keyframes[2]._styk.frameId, before.keyframes[1]._styk.frameId);
  editor.undo(); assert.deepEqual(report, before); editor.redo(); assert.equal(report.keyframes.length, 7);
});

test('endpoint ratios copy endpoint poses, including births, media and topology', () => {
  for (const ratio of [0, 1]) {
    const editor = fixture(), report = editor.report;
    report.keyframes[1].objects.push(createObject(report.figure_types[0], 111, 35, 70, {object_slot: 2}));
    report.keyframes[1].object_draw_order.push(2); report.keyframes[1].object_draw_order_unique_ids.push(111);
    const expected = pose(report, report.keyframes[ratio]);
    editor.insertInbetweenFrames(ratio, [1]);
    assert.deepEqual(pose(report, report.keyframes[1]), expected);
    assert.equal(report.keyframes[1].duration_raw, ratio === 0 ? 6 : 4);
    assert.doesNotThrow(() => editor.serialize());
  }
});

test('a zero-exposure authored insertion keeps coincident hidden pose ordering without scalar collisions', () => {
  const editor = fixture({durations: [6,0,4,1]}), report = editor.report;
  editor.adoptNativePoseTrack({kind:'layer',id:'layer-1'});
  editor.addAnimationKeys([{target:{kind:'figure',uid:12},property:'x',tick:0,value:100},
    {target:{kind:'figure',uid:12},property:'x',tick:6,value:180}]);
  const before = clone(report), sourceIds = new Set(editor.animationChannels[0].keys.map(key=>key.id));
  clearHistory(editor); const result = editor.insertInbetweenFrames(.4,[1]);
  assert.deepEqual(result.durations,[0]); assert.equal(editor.totalTicks,11);
  const poseKeys=editor.animationChannels.find(channel=>channel.property==='pose').keys;
  const inserted=poseKeys.find(key=>!sourceIds.has(key.id));
  assert.equal(inserted.hidden,true); assert.ok(poseKeys.indexOf(inserted)<poseKeys.findIndex(key=>key.value.frameId===before.keyframes[1]._styk.frameId));
  assert.deepEqual(editor.animationChannels.find(channel=>channel.property==='x'),before._styk.animation.channels.find(channel=>channel.property==='x'));
  assert.doesNotThrow(()=>editor.serialize()); editor.undo(); assert.deepEqual(report,before);
});

test('bad ratios, capacity and later unsupported background transitions reject atomically', () => {
  const editor = fixture(), report = editor.report;
  report.backgrounds.push({background_id: 3, kind: 2, color: 0xffabcdef});
  report.keyframes[1].background_id = 1; report.keyframes[1].background_id_b = 2; report.keyframes[1].background_mix = 96;
  report.keyframes[2].background_id = 3;
  const before = clone(report), identity = editor._nextFrameIdentity;
  for (const ratio of [NaN, Infinity, -1, 1.01, '0.5']) assert.throws(() => editor.insertInbetweenFrames(ratio, [1]), /ratio/);
  assert.throws(() => editor.insertInbetweenFrames(.5, [1, 2]), /more than two background/);
  assert.deepEqual(report, before); assert.equal(editor.canUndo, false); assert.equal(editor._nextFrameIdentity, identity);
  editor._nextFrameIdentity = Number.MAX_SAFE_INTEGER;
  assert.throws(() => editor.insertInbetweenFrames(1, [1]), /identity capacity/); assert.deepEqual(report, before);
});

test('independent layer, scene, camera and scalar tracks reproduce the sampled composition without double transforms', () => {
  const editor = fixture(), report = editor.report;
  const layer = editor.createLayer('Second').id; editor.assignFiguresToLayer([88], layer);
  for (const target of [{kind: 'layer', id: 'layer-1'}, {kind: 'layer', id: layer}, {kind: 'scene'}, {kind: 'camera'}]) {
    editor.addAnimationKeys([{target, property: 'pose', tick: 0, value: {frameId: editor.getFrameId(0)}, interpolation: 'linear'},
      {target, property: 'pose', tick: 12, value: {frameId: editor.getFrameId(3)}, interpolation: 'linear'}]);
  }
  for (const [target, property, first, last] of [
    [{kind: 'figure', uid: 12}, 'x', 100, 220], [{kind: 'figure', uid: 12}, 'rotation', .2, 1],
    [{kind: 'figure', uid: 12}, 'scale', 1.1, 1.8], [{kind: 'figure', uid: 88}, 'opacity', 1, .2],
    [{kind: 'camera'}, 'x', 90, 20], [{kind: 'camera'}, 'rotation', -.2, .3],
    [{kind: 'scene'}, 'color', 0xff123456, 0xff987654],
  ]) editor.addAnimationKeys([{target, property, tick: 0, value: first}, {target, property, tick: 14, value: last}]);
  const expected = pose(report, evaluatedFrame(report, 0, .5, 3)), before = clone(report), oldFrames = report.keyframes.slice(), channels = clone(editor.animationChannels);
  clearHistory(editor); const result = editor.insertInbetweenFrames(.5, [1]); editor.seek(result.ticks[0]);
  assert.deepEqual(pose(report, editor.evaluatedFrame), expected);
  for (let index = 0; index < oldFrames.length; index++) assert.equal(report.keyframes[index + (index >= 1 ? 1 : 0)], oldFrames[index]);
  assert.equal(Object.keys(report._styk.frameSources).length, 1); assert.equal(editor._undo.length, 1);
  for (const channel of channels) for (const key of channel.keys) {
    const current = editor.animationChannels.find(entry => entry.id === channel.id).keys.find(entry => entry.id === key.id);
    assert.deepEqual(current, {...key, tick: key.tick + (key.tick >= 6 ? 4 : 0)});
  }
  assert.doesNotThrow(() => validateAnimationDocument(report));
  editor.undo(); assert.deepEqual(report, before); editor.redo(); editor.seek(6); assert.deepEqual(pose(report, editor.evaluatedFrame), expected);
  const reopened = new Editor({demo: false}).load(editor.serialize()); reopened.seek(6); assert.deepEqual(pose(reopened.report, reopened.evaluatedFrame), expected);
});

test('a scalar starting after the requested sample cannot mask the inserted pose', () => {
  const editor = fixture(), report = editor.report;
  editor.addAnimationKeys([{target: {kind: 'figure', uid: 12}, property: 'x', tick: 4, value: 500},
    {target: {kind: 'figure', uid: 12}, property: 'x', tick: 12, value: 800}]);
  const expected = pose(report, evaluatedFrame(report, 0, .25, 1.5));
  clearHistory(editor); editor.insertInbetweenFrames(.25, [1]); editor.seek(6);
  assert.deepEqual(pose(report, editor.evaluatedFrame), expected);
  assert.equal(report._styk.frameSources, undefined, 'Scalar-only authoring needs no captured source assets.');
});

test('authored hidden keys preserve identity, hidden state, interpolation and external source references', () => {
  const editor = fixture({durations: [6, 0, 4, 1]}), report = editor.report;
  const channel = editor.adoptNativePoseTrack({kind: 'layer', id: 'layer-1'});
  editor.setAnimationKey(channel.id, channel.keys[0].id, {interpolation: 'hold'});
  const old = clone(editor.animationChannels), frameId = editor.getFrameId(1);
  clearHistory(editor); editor.insertInbetweenFrames(.4, [1, 2]);
  const current = editor.animationChannels[0];
  for (const key of old[0].keys) assert.deepEqual(current.keys.find(item => item.id === key.id), {...key, tick: key.tick + (key.tick >= 6 ? 4 : 0)});
  assert.ok(current.keys.some(key => key.hidden && key.value.frameId === frameId));
  assert.equal(editor.getFrameById(frameId).duration_raw, 0);
  const newKeys = current.keys.filter(key => !old[0].keys.some(oldKey => oldKey.id === key.id));
  assert.equal(newKeys[0].interpolation, 'constant'); assert.doesNotThrow(() => editor.serialize());
});

test('late authored timeline overflow rejects before IDs, sources, channels or history change', () => {
  const editor = fixture(); editor.addAnimationKey({kind: 'camera'}, 'x', 10000000, 3);
  clearHistory(editor); const before = clone(editor.report), identity = editor._nextFrameIdentity;
  assert.throws(() => editor.insertInbetweenFrames(.5, [1]), /10,000,000/);
  assert.deepEqual(editor.report, before); assert.equal(editor._nextFrameIdentity, identity); assert.equal(editor.canUndo, false);
});

test('first-key insertion copies its pose and exposure; preview never reserves IDs or records history', () => {
  const editor = fixture(), before = clone(editor.report), identity = editor._nextFrameIdentity;
  assert.equal(editor.insertInbetweenFrames(.5, []).insertedFrames, 0);
  assert.deepEqual(pose(editor.report, editor.previewInbetween(.5, 0).frame), pose(editor.report, editor.report.keyframes[0]));
  const preview = editor.previewInbetween(.5, 1), expected = pose(editor.report, evaluatedFrame(editor.report, 0, .5));
  assert.deepEqual(pose(editor.report, preview.frame), expected); assert.equal(preview.sourceTick, 3); assert.equal(preview.insertionTick, 6);
  assert.deepEqual(editor.report, before); assert.equal(editor._nextFrameIdentity, identity); assert.equal(editor.canUndo, false);
  assert.equal(planInsertInbetweens(editor, .5, [1]).entries.length, 1);
  assert.equal(editor.insertInbetweenFrames(.5, [0]).insertedFrames, 1);
  assert.equal(editor.report.keyframes[0].duration_raw, 6); editor.undo(); assert.deepEqual(editor.report, before);
});

test('legacy repeat fields remain unchanged while a manually chosen pose is interpolated', () => {
  const editor = fixture({version: 4}), report = editor.report;
  const expected = pose(report, evaluatedNativeFrame({...report, version: 5, auto_easing: false}, 0, .5));
  const total = editor.totalTicks; editor.insertInbetweenFrames(.5, [1]);
  assert.equal(report.version, 4); assert.equal(editor.totalTicks, total + 4);
  assert.deepEqual(report.keyframes.map(frame => frame.duration_raw), [6, 4, 4, 3, 9]);
  assert.deepEqual(pose(report, report.keyframes[1]), expected);
});

function nativeRoundtrip(document, format) {
  const script = String.raw`
import json,sys
from pathlib import Path
sys.path.insert(0,str(Path('backend').resolve()))
import server
request=json.load(sys.stdin)
store=server.ProjectStore(server.WORKSPACE)
data,name=store.export(request)
print(json.dumps(store.import_bytes(data,name)['document']))
`;
  const python=backend.pythonCandidates()[0], result=spawnSync(python.command,[...python.args,'-c',script],{
    cwd:fileURLToPath(new URL('..',import.meta.url)),input:JSON.stringify({document,format}),encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024,
  });
  assert.equal(result.status,0,result.error?.message||result.stderr);return JSON.parse(result.stdout);
}

test('chosen native poses roundtrip through the actual PIV codec with exposures, joins and scene/camera intact', () => {
  const editor=fixture({easing:true}),report=editor.report;
  // The fixture's fake unreferenced media payloads exercise sharing above; only
  // valid native asset tables are passed through the actual binary writer.
  report.figure_types[0].image_assets=[];report.figure_types[0].text_assets=[];
  const result=editor.insertInbetweenFrames(.375,[1,3]),expected=result.indices.map(index=>buildGeometry(report,report.keyframes[index]));
  const saved=nativeRoundtrip(editor.serialize(),'piv');
  assert.deepEqual(saved.keyframes.map(frame=>frame.duration_raw),report.keyframes.map(frame=>frame.duration_raw));
  assert.equal(saved.auto_easing,true);
  const near=(actual,value)=>assert.ok(Math.abs(actual-value)<.001,`${actual} != ${value}`);
  result.indices.forEach((index,i)=>{
    const native=buildGeometry(saved,saved.keyframes[index]),frame=saved.keyframes[index],source=report.keyframes[index];
    assert.deepEqual(frame.object_draw_order_unique_ids,source.object_draw_order_unique_ids);
    assert.deepEqual([frame.background_id,frame.background_id_b,frame.background_mix],[source.background_id,source.background_id_b,source.background_mix]);
    for(const key of ['x','y','scale','angle_rad'])near(frame.camera[key],source.camera[key]);
    for(const [slot,object] of expected[i].objects){const current=native.objects.get(slot);assert.equal(current.obj.unique_id,object.obj.unique_id);
      if(object.obj.join)assert.equal(current.obj.join.target_unique_id,object.obj.join.target_unique_id);
      near(current.root.x,object.root.x);near(current.root.y,object.root.y);
      object.segments.forEach((segment,n)=>{near(current.segments[n].end.x,segment.end.x);near(current.segments[n].end.y,segment.end.y)});
    }
  });
});

test('authored insertion roundtrips through the STYK codec with hidden source IDs and sparse channels', () => {
  const editor=fixture();editor.adoptNativePoseTrack({kind:'layer',id:'layer-1'});
  editor.addAnimationKeys([{target:{kind:'figure',uid:12},property:'rotation',tick:0,value:.2},
    {target:{kind:'figure',uid:12},property:'rotation',tick:12,value:1}]);
  const result=editor.insertInbetweenFrames(.375,[1,3]),document=editor.serialize();
  const saved=nativeRoundtrip(document,'styk');
  assert.deepEqual(saved._styk,document._styk);assert.deepEqual(saved.keyframes.map(frame=>frame._styk),document.keyframes.map(frame=>frame._styk));
  const reopened=new Editor({demo:false}).load(saved);
  for(const tick of result.ticks){editor.seek(tick);reopened.seek(tick);assert.deepEqual(pose(reopened.report,reopened.evaluatedFrame),pose(editor.report,editor.evaluatedFrame));}
});
