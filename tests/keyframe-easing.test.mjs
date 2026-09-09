import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';
import {easedProgress, cubicBezierProgress, keyEasing} from '../src/keyframe-easing.mjs';
import {sampleAnimationChannel, validateAnimationDocument} from '../src/animation-channels.mjs';
import {evaluatedNativeFrame, evaluatedFrame, timeline} from '../src/pivot/geometry.mjs';
import {materializePivotDocument, needsPivotMaterialization} from '../src/pivot-export-materialize.mjs';
import {compilePlaybackPacket} from '../src/playback-worker.mjs';
import {PlaybackCache} from '../src/playback.mjs';
import {Worker} from 'node:worker_threads';

const near = (actual, expected, epsilon = 1e-7) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} ≠ ${expected}`);
const modes = ['auto', 'bezier', 'ease-in', 'ease-out', 'linear', 'constant'];
function fixture(legacy = false) {
  const report = emptyDocument(); report.auto_easing = legacy;
  report.keyframes = [0,100,20].map((x, index) => ({...createFrame([
    createObject(report.figure_types[0], 1, x, 100), createObject(report.figure_types[0], 2, x + 200, 100),
  ], 10), camera: {is_default: false, x, y: 0, scale: 1 + index, angle_rad: index * .2}}));
  return new Editor({demo: false}).load(report);
}
function sample(report, tick) {
  const rows = timeline(report), row = rows.findLast(row => row.start <= tick);
  return evaluatedFrame(report, row.index, row.count ? (tick - row.start) / row.count : 0, tick);
}
test('Bezier inverts time, presets are distinct, constant switches only at the next key', () => {
  // x(u)=u^3, y(u)=3u-3u²+u³: at x=.125, u=.5 and y=.875.
  near(cubicBezierProgress(.125, [0,1,0,1]), .875);
  near(easedProgress({interpolation:'ease-in'}, .5), .3153568125725393);
  near(easedProgress({interpolation:'ease-out'}, .5), .6846431874274608);
  near(easedProgress({interpolation:'bezier'}, .25), .1291619310473198);
  for (const interpolation of modes) {
    const key = {interpolation};
    assert.equal(easedProgress(key, -1), 0); assert.equal(easedProgress(key, 2), 1);
    let previous = 0;
    for (let i = 0; i <= 100; i++) { const value = easedProgress(key, i / 100); assert.ok(value >= previous && value <= 1); previous = value; }
  }
  assert.equal(easedProgress({interpolation:'constant'}, .999999), 0);
  assert.deepEqual(keyEasing({interpolation:'hold'}), {interpolation:'constant'});
});

for (const interpolation of modes) test(`${interpolation}: scalar, native pose, camera, playback packet and Pivot export agree`, async () => {
  const editor = fixture(true), easing = {interpolation, ...(interpolation === 'bezier' ? {bezier:[0,1,0,1]} : {})};
  const pose = editor.nativePoseChannel({kind:'figure',uid:1});
  editor.setAnimationKeysEasing([{channelId:pose.id,keyIds:[pose.keys[0].id]}], easing);
  const scalar = {property:'x',keys:[{tick:0,value:0,...easing},{tick:10,value:100}]};
  const native = structuredClone(editor.report); native.keyframes[0]._styk.easing = easing;
  for (const tick of [0, 1.25, 2.5, 5, 9.999, 10]) {
    const expected = 100 * easedProgress(easing, tick / 10);
    near(sampleAnimationChannel(scalar, tick), expected);
    near(sample(editor.report, tick).objects.find(object => object.unique_id === 1).root_x, expected);
    const frame = evaluatedNativeFrame(native, 0, tick / 10);
    near(frame.objects.find(object => object.unique_id === 1).root_x, expected); near(frame.camera.x, expected);
    near(sample(editor.report, tick).objects.find(object => object.unique_id === 2).root_x, evaluatedNativeFrame(editor.report, 0, tick / 10).objects.find(object => object.unique_id === 2).root_x);
  }
  const output = materializePivotDocument(editor.serialize());
  assert.equal(output.auto_easing, false);
  for (let tick = 0; tick < 10; tick++) {
    near(sample(output,tick).objects.find(object => object.unique_id === 1).root_x, 100 * easedProgress(easing,tick/10));
    const packet = await compilePlaybackPacket(editor.report,tick);
    const group = packet.groups.find(group => group.slot === sample(editor.report,tick).objects.findIndex(object => object.unique_id === 1));
    near(packet.transforms[group.transformIndex * 4], 100 * easedProgress(easing,tick/10), 1e-5);
  }
});

test('independent figure easing survives value edits, retiming, copies, history and serialization', () => {
  const editor = fixture(), target = {kind:'figure',uid:1}, channel = editor.nativePoseChannel(target);
  const before = editor.serialize(), selection = [{channelId:channel.id,keyIds:[channel.keys[0].id]}];
  editor.setAnimationKeysEasing(selection,{interpolation:'bezier',bezier:[.1,.7,.4,1]});
  const expected = sample(editor.report,5).objects.find(object => object.unique_id === 1).root_x;
  near(sample(editor.report,5).objects.find(object => object.unique_id === 2).root_x,250);
  editor.undo(); assert.deepEqual(editor.serialize(),before); editor.redo(); near(sample(editor.report,5).objects.find(object => object.unique_id === 1).root_x,expected);
  editor.duplicateAnimationKeys(selection,30);
  assert.deepEqual(editor.animationChannel(target,'pose').keys.at(-1).bezier,[.1,.7,.4,1]);
  editor.moveAnimationKeys(selection,1); assert.equal(editor.animationChannel(target,'pose').keys[0].tick,1);
  const saved = editor.serialize(); validateAnimationDocument(saved);
  const restored = new Editor({demo:false}).load(JSON.parse(JSON.stringify(saved)));
  near(sample(restored.report,5).objects.find(object => object.unique_id === 1).root_x,sample(editor.report,5).objects.find(object => object.unique_id === 1).root_x);
  const key = restored.addAnimationKeys([{target,property:'x',tick:1,value:0,interpolation:'bezier',bezier:[.1,.7,.4,1]}])[0];
  restored.seek(1); restored.beginAnimationEdit(target,'x'); restored.previewAnimationEdit(7); restored.commitAnimationEdit();
  assert.deepEqual(restored.animationChannel(target,'x').keys[0].bezier,[.1,.7,.4,1]);
  restored.setAnimationKey(restored.animationChannel(target,'x').id,key.id,{interpolation:'linear'});
  assert.equal(restored.animationChannel(target,'x').keys[0].bezier,undefined);
});

test('frame easing invalidates native descriptors and exports without authored channels or double easing', () => {
  const editor = fixture(true), target = {kind:'figure',uid:1}; editor.nativePoseChannel(target);
  editor.setFramesEasing([0],{interpolation:'ease-out'});
  assert.equal(editor.nativePoseChannel(target).keys[0].interpolation,'ease-out');
  const expected = 100 * easedProgress({interpolation:'ease-out'},.5);
  near(sample(editor.report,5).objects.find(object => object.unique_id === 1).root_x,expected);
  assert.equal(needsPivotMaterialization(editor.report),true);
  const output = materializePivotDocument(editor.serialize());
  near(sample(output,5).objects.find(object => object.unique_id === 1).root_x,expected);
  assert.ok(output.keyframes.every(frame => !frame._styk?.easing));
  editor.undo(); assert.equal(editor.report.keyframes[0]._styk.easing,undefined);
  editor.redo(); near(sample(editor.report,5).objects.find(object => object.unique_id === 1).root_x,expected);
});

test('invalid curves reject atomically; hidden and terminal keys retain exact boundaries', () => {
  const editor = fixture(), channel = editor.nativePoseChannel({kind:'figure',uid:1}), before = editor.serialize();
  for (const bezier of [[-1,0,1,1],[0,NaN,1,1],[0,0,1],['0',0,1,1]]) {
    assert.throws(() => editor.setAnimationKeysEasing([{channelId:channel.id,keyIds:[channel.keys[0].id]}],{interpolation:'bezier',bezier}),/Bezier/);
    assert.deepEqual(editor.serialize(),before);
  }
  assert.throws(() => editor.setAnimationKeysEasing([{channelId:channel.id,keyIds:[channel.keys[0].id,'missing']}],{interpolation:'ease-in'}),/no longer exists/);
  assert.deepEqual(editor.serialize(),before);
  editor.setAnimationKey(channel.id,channel.keys[0].id,{interpolation:'constant'});
  near(sample(editor.report,9.999).objects.find(object => object.unique_id === 1).root_x,0); near(sample(editor.report,10).objects.find(object => object.unique_id === 1).root_x,100);
  const saved=editor.serialize(); saved.keyframes[0]._styk.easing={interpolation:'bezier',bezier:[2,0,1,1]};
  assert.throws(()=>validateAnimationDocument(saved),/Bezier/);
});

test('nonlinear scalar spans retain every unedited tick when pasting frames or baking a camera', () => {
  for (const operation of ['paste', 'camera']) {
    const editor = fixture(), target = {kind:'figure',uid:1};
    editor.copyFrames([0]);
    editor.addAnimationKeys([{target,property:'x',tick:0,value:0,interpolation:'bezier',bezier:[.1,.8,.3,.9]},
      {target,property:'x',tick:20,value:100}]);
    const expected = Array.from({length:21},(_,tick)=>sample(editor.report,tick).objects.find(o=>o.unique_id===1).root_x);
    if (operation === 'paste') editor.pasteFrames(1);
    else editor.applyCameraToFigures(undefined,{ticks:[5]});
    validateAnimationDocument(editor.report);
    for (let tick=0;tick<=20;tick++) {
      if (operation==='camera' && tick===5) continue;
      near(sample(editor.report,operation==='paste' && tick>=10 ? tick+10 : tick).objects.find(o=>o.unique_id===1).root_x,expected[tick]);
    }
  }
});

test('worker frame and channel patches invalidate cached easing without reloading the document', async () => {
  const editor=fixture(), workerFactory=()=>{
    const worker=new Worker(new URL('./playback-node-worker.mjs',import.meta.url));
    return {postMessage:(...args)=>worker.postMessage(...args),terminate:()=>worker.terminate(),
      addEventListener:(name,callback)=>worker.on(name,value=>callback(name==='message'?{data:value}:value))};
  };
  const cache=new PlaybackCache({workerFactory});
  const packetX=(packet,uid)=>{
    const slot=sample(editor.report,5).objects.findIndex(o=>o.unique_id===uid), group=packet.groups.find(g=>g.slot===slot);
    return packet.transforms[group.transformIndex*4];
  };
  try {
    cache.load(editor.report); await cache.prepareRange([5]); near(packetX(cache.get(5),1),50);
    const loads=cache.stats.documentLoads;
    editor.setFramesEasing([0],{interpolation:'ease-in'});
    cache.updateDocument({frameIndices:[0],revision:1}); await cache.prepareRange([5]);
    near(packetX(cache.get(5),1),31.535681257,1e-5);
    const channel=editor.nativePoseChannel({kind:'figure',uid:2});
    editor.setAnimationKeysEasing([{channelId:channel.id,keyIds:[channel.keys[0].id]}],{interpolation:'constant'});
    cache.updateDocument({revision:2}); await cache.prepareRange([5]);
    near(packetX(cache.get(5),2),200); near(packetX(cache.get(5),1),31.535681257,1e-5);
    editor.setFramesEasing([0,1],{interpolation:'auto'});
    cache.updateDocument({frameIndices:[0,1],revision:3});await cache.prepareRange([5]);
    near(packetX(cache.get(5),1),50);
    editor.report.keyframes[2].objects.find(o=>o.unique_id===1).root_x=160;
    cache.updateDocument({frameIndices:[2],revision:4});await cache.prepareRange([5]);
    near(packetX(cache.get(5),1),40.625);
    assert.equal(cache.stats.documentLoads,loads);
  } finally {cache.dispose();}
});

test('discrete background identities cannot advertise a continuous easing curve', () => {
  const editor=fixture(), target={kind:'scene'}, key=editor.addAnimationKey(target,'backgroundId',0,0);
  editor.addAnimationKey(target,'backgroundId',10,1);
  const channel=editor.animationChannel(target,'backgroundId'), before=editor.serialize();
  for (const interpolation of modes.filter(mode=>mode!=='constant')) {
    assert.throws(()=>editor.setAnimationKey(channel.id,key.id,{interpolation}),/Constant/);
    assert.throws(()=>editor.addAnimationKeys([{target,property:'backgroundId',tick:5,value:2,interpolation}]),/Constant/);
    assert.deepEqual(editor.serialize(),before);
  }
  assert.equal(sampleAnimationChannel(channel,9.999),0); assert.equal(sampleAnimationChannel(channel,10),1);
});

test('legacy file versions keep native holds until an explicit frame curve is assigned', () => {
  const editor=fixture(); editor.report.version=4;
  near(evaluatedNativeFrame(editor.report,0,.5).objects[0].root_x,0);
  editor.setFramesEasing([0],{interpolation:'linear'});
  near(evaluatedNativeFrame(editor.report,0,.5).objects[0].root_x,50);
});

test('Auto shares velocity at unevenly spaced keys, stops at extrema and never overshoots', () => {
  const keys = [0, 4, 17, 20, 31].map((tick, index) => ({tick, value:[0, 12, 40, 20, 20][index], interpolation:'auto'}));
  const channel = {property:'x', keys}, at = tick => sampleAnimationChannel(channel, tick), h = 1e-5;
  for (let i = 0; i < keys.length - 1; i++) for (let step = 0; step <= 100; step++) {
    const a = keys[i], b = keys[i + 1], value = at(a.tick + (b.tick - a.tick) * step / 100);
    assert.ok(value >= Math.min(a.value,b.value) - 1e-9 && value <= Math.max(a.value,b.value) + 1e-9);
  }
  const leftVelocity = (at(4) - at(4-h))/h, rightVelocity = (at(4+h) - at(4))/h;
  assert.ok(leftVelocity > 2); near(leftVelocity, rightVelocity, 3e-5);
  near((at(17+h)-at(17))/h,0,1e-4); near((at(17)-at(17-h))/h,0,1e-4);
  near(at(h)/h,0,1e-4); near(at(25),20);
  keys[1].interpolation = 'constant';
  near(at(4-h),12,1e-7); near(at(16.9),12); near(at(17),40);
  keys[1].interpolation = 'auto'; keys[2].passthrough = true;
  near(at(10),12); assert.equal(at(17),undefined);
});

test('Auto pose and scalar curves agree across a run and update neighbours after edits and history', async () => {
  const editor = fixture(), target={kind:'figure',uid:1};
  editor.report.keyframes[2].objects[0].root_x=160;
  editor.setFramesDuration([0],4);editor.setFramesDuration([1],13);
  const pose=editor.nativePoseChannel(target);
  editor.setAnimationKeysEasing([{channelId:pose.id,keyIds:pose.keys.map(k=>k.id)}],{interpolation:'auto'});
  const scalar={property:'x',keys:[{tick:0,value:0,interpolation:'auto'},{tick:4,value:100,interpolation:'auto'},{tick:17,value:160,interpolation:'auto'}]};
  for (let tick=0;tick<=17;tick+=.25) near(sample(editor.report,tick).objects.find(o=>o.unique_id===1).root_x,sampleAnimationChannel(scalar,tick));
  const before=sample(editor.report,2).objects.find(o=>o.unique_id===1).root_x;
  editor.setAnimationKey(pose.id,pose.keys[1].id,{interpolation:'constant'});
  assert.notEqual(sample(editor.report,2).objects.find(o=>o.unique_id===1).root_x,before);
  editor.undo();near(sample(editor.report,2).objects.find(o=>o.unique_id===1).root_x,before);
  const saved=JSON.parse(JSON.stringify(editor.serialize()));validateAnimationDocument(saved);
  const output=materializePivotDocument(saved);
  for(let tick=0;tick<=17;tick++) {
    const expected=sampleAnimationChannel(scalar,tick);
    near(sample(output,tick).objects.find(o=>o.unique_id===1).root_x,expected);
    const packet=await compilePlaybackPacket(saved,tick),slot=sample(saved,tick).objects.findIndex(o=>o.unique_id===1),group=packet.groups.find(g=>g.slot===slot);
    near(packet.transforms[group.transformIndex*4],expected,1e-5);
  }
});

test('Auto preserves unedited integer samples across camera baking, clipboard insertion and native baking', () => {
  for (const operation of ['paste','camera','bake']) {
    const editor=fixture(),target={kind:'figure',uid:1};
    editor.report.keyframes[2].objects[0].root_x=160;
    editor.copyFrames([0]);
    if(operation==='bake')editor.setFramesEasing([0,1,2],{interpolation:'auto'});
    else editor.addAnimationKeys([0,10,20].map((tick,i)=>({target,property:'x',tick,value:[0,100,160][i],interpolation:'auto'})));
    const expected=Array.from({length:21},(_,tick)=>sample(editor.report,tick).objects.find(o=>o.unique_id===1).root_x);
    if(operation==='paste')editor.pasteFrames(1);
    if(operation==='camera')editor.applyCameraToFigures(undefined,{ticks:[5]});
    if(operation==='bake')editor.bakeFrames([1]);
    validateAnimationDocument(editor.report);
    for(let tick=0;tick<=20;tick++) {
      if(operation==='camera'&&tick===5)continue;
      near(sample(editor.report,operation==='paste'&&tick>=10?tick+10:tick).objects.find(o=>o.unique_id===1).root_x,expected[tick]);
    }
    editor.undo();
    for(let tick=0;tick<=20;tick++)near(sample(editor.report,tick).objects.find(o=>o.unique_id===1).root_x,expected[tick]);
  }
});

test('simple frame easing is immediate and independent of pending pose edits', () => {
  const editor=fixture();editor.enableFrameDrafts();
  editor.setFramesEasing([0],{interpolation:'auto'});
  assert.equal(editor.frameDraft.dirty,false);
  editor.undo();assert.equal(editor.frameDraft.dirty,false);
  editor.redo();assert.equal(editor.frameDraft.dirty,false);
  editor.select(1);editor.updateObject({root_x:33});
  editor.setFramesEasing([0],{interpolation:'linear'});
  assert.equal(editor.frameDraft.dirty,true);
  editor.undo();assert.equal(editor.frame._styk.easing.interpolation,'auto');
  editor.redo();assert.equal(editor.frame._styk.easing.interpolation,'linear');
  editor.discardFrameDraft();assert.equal(editor.frame.objects[0].root_x,0);
  assert.equal(editor.frame._styk.easing.interpolation,'linear');
  editor.beginFrameDraft({mode:'add',index:2});editor.select(1);editor.updateObject({root_x:77});
  editor.editStoredFrames(()=>editor.setFramesEasing([2],{interpolation:'auto'}));
  assert.equal(editor.frame.objects[0].root_x,77);assert.equal(editor.frameDraft.dirty,true);
  assert.equal(editor.report._styk.simpleFrameDraft.baseline._styk.easing.interpolation,'auto');
  editor.undo();assert.equal(editor.frame.objects[0].root_x,77);
  assert.equal(editor.report._styk.simpleFrameDraft.baseline._styk.easing,undefined);
  editor.redo();assert.equal(editor.frame.objects[0].root_x,77);
});

test('Auto handles wrapped pose angles, opacity, ARGB, hidden keys and absolute scalar rotations', () => {
  const editor=fixture();editor.setFramesEasing([0,1,2],{interpolation:'auto'});
  const radians=degrees=>degrees*Math.PI/180;
  for(let i=0;i<3;i++) {
    const frame=editor.report.keyframes[i];
    frame.camera.angle_rad=radians([170,-170,-140][i]);
    frame.objects[0].field28=[0,100,200][i];
    frame.objects[0].color_override_raw=[0xff101010,0xff808080,0xffeeeeee][i];
  }
  const a=evaluatedNativeFrame(editor.report,0,.99999).camera.angle_rad;
  const b=evaluatedNativeFrame(editor.report,1,.00001).camera.angle_rad;
  near(a,b+2*Math.PI,1e-5);
  for(let tick=0;tick<20;tick++) {
    const frame=sample(editor.report,tick),object=frame.objects[0];
    assert.ok(object.field28>=0&&object.field28<=200);
    assert.equal(object.color_override_raw>>>24,255);
  }
  const rotation={property:'rotation',keys:[{tick:0,value:0,interpolation:'auto'},{tick:10,value:4*Math.PI}]};
  near(sampleAnimationChannel(rotation,5),2*Math.PI);
  const hidden={property:'x',keys:[{tick:0,value:0,interpolation:'auto'},{tick:10,value:50,hidden:true,interpolation:'auto'},
    {tick:10,value:100,interpolation:'auto'},{tick:20,value:200}]};
  near(sampleAnimationChannel(hidden,10),100);
  assert.ok(sampleAnimationChannel(hidden,9.99)<50);
  near(sampleAnimationChannel(hidden,15),150);
});
