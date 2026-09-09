import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';
import {validateAnimationDocument} from '../src/animation-channels.mjs';
import {resolveInstanceFigure} from '../src/animation-style.mjs';
import {storedFrameReport} from '../src/pivot-frame-draft.mjs';
import {evaluatedFrame, timeline} from '../src/pivot/geometry.mjs';
import {beginNativePropertyEdit, previewNativePropertyEdit, commitNativePropertyEdit} from '../src/native-property-edit.mjs';
import {createNativeStyleTable} from '../src/pivot-style-materialize.mjs';
import {sampleAnimationChannel} from '../src/animation-channels.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';
import {buildChannelTimelineTracks} from '../src/timeline.mjs';
import {segmentPaint,paintGeometry} from '../src/paint.mjs';

function fixture() {
  const report = emptyDocument(), figure = report.figure_types[0];
  figure.segment_decode = {global_style:{outline_thickness:2,u30:0,rgb:[0,0,0]}};
  report.keyframes = [0,100,200].map(x => createFrame([createObject(figure,1,x,100),createObject(figure,2,x+300,100)],5));
  const editor = new Editor({demo:false,propertyChannels:true}).load(report); editor.select(1); return editor;
}
const properties = editor => editor.animationChannels.map(channel => channel.property);
const numeric = (editor,key,value) => {const token=beginNativePropertyEdit(editor,key);previewNativePropertyEdit(token,value);commitNativePropertyEdit(token);};

test('timeline markers never sample frame values and scalar previews reuse their projection', () => {
  const e=fixture(),target={kind:'figure',uid:1};
  const projected=e.nativePropertyChannel(target,'opacity',{markersOnly:true});
  const tracks=buildChannelTimelineTracks(e.layers,e.animationChannels,e.report,new Set(),{
    nativePropertyChannel:(target,property)=>e.nativePropertyChannel(target,property,{markersOnly:true}),
    nativePoseChannel:target=>e.nativePoseChannel(target),figurePoses:true,
  });
  const row=tracks.byId.get('figure:1').channelChildren.find(row=>row.property==='opacity');
  assert.equal(row.keys.length,3);assert.equal(e._propertyChannelCache.frames.size,0);
  assert.equal(e._propertyChannelCache.values.size,0);
  e.beginAnimationEdit(target,'x');e.previewAnimationEdit(70);
  assert.strictEqual(e.nativePropertyChannel(target,'opacity',{markersOnly:true}),projected);
  e.cancelAnimationEdit();
  const owned=e.nativePropertyChannel(target,'opacity');
  assert.ok(owned.keys.every(key=>!Object.getOwnPropertyDescriptor(key,'value').get),'Persisted keys must be ordinary immutable data');
  e.updateObject({field28:128});assert.equal(e.evaluatedFrame.objects[0].field28,128);
});

for(const mode of ['advanced','simple'])test(`${mode} interpolates gradient, polygon, camera and scene keys independently`,()=>{
  const e=fixture();e.addPolygon([0,1,2]);e.select(1,0);
  const paint={type:'linear',angle:0,stops:[{offset:0,color:[255,0,0],opacity:1},{offset:1,color:[0,0,255],opacity:1}]};
  if(mode==='simple')e.enableFrameDrafts({mode:'update'});
  const edit=(index,opacity,secondary,width,x,color)=>{
    e.selectFrame(index);e.select(1,0);e.updateSegmentStyle({paint});numeric(e,'segment_opacity',opacity);numeric(e,'segment_gradient_opacity',secondary);
    e.updatePolygon(0,{opacity:opacity/100});e.updateFigureStyle({outlineWidth:width});e.setCameraValues({x});e.setSceneColor(color);
    if(mode==='simple')e.updateDraftFrame();
  };
  edit(0,20,80,2,0,0xff000000);edit(1,80,20,12,100,0xffffffff);
  if(mode==='simple')e.disableFrameDrafts();e.seek(2);e.select(1,0);
  const appearance=resolveInstanceFigure(e.figure,e.object);
  assert.equal(appearance.segments[0].transparency,Math.round(255*.56));
  assert.equal(appearance.segments[0].secondary.a,Math.round(255*.44));
  assert.equal(appearance.polyfills[0].alpha_raw,Math.round(255*.56));
  assert.equal(appearance.segment_decode.global_style.outline_thickness,6);
  assert.equal(e.evaluatedFrame.camera.x,40);assert.equal(e.evaluatedFrame._stykBackgroundColor,0xff666666);
  assert.ok(!properties(e).includes('pose'));validateAnimationDocument(e.report);
});

test('branch width ranges author segment keys without changing the shared definition or Pose', () => {
  const e=fixture();e.select(1,0);const definition=structuredClone(e.figure);
  const token=beginNativePropertyEdit(e,'thickness',{branch:true,indices:[0,2]});
  previewNativePropertyEdit(token,17);commitNativePropertyEdit(token);
  assert.deepEqual(e.figure,definition);assert.ok(properties(e).length>1);
  assert.ok(properties(e).every(property=>property==='thickness'));
  for(const channel of e.animationChannels) {
    assert.equal(channel.target.kind,'segment');
    assert.equal(channel.keys.find(key=>key.tick===0).value,17);
    assert.equal(channel.keys.find(key=>key.tick===10).value,17);
  }
  e.undo();assert.equal(e.animationChannels.length,0);e.redo();validateAnimationDocument(e.report);
  e.changeBranchThickness(3);assert.deepEqual(e.figure,definition);
  assert.ok(properties(e).every(property=>property==='thickness'));
  assert.equal(resolveInstanceFigure(e.figure,e.object).segments[0].thickness,20);
});

test('figure appearance and transform edits author only their changed properties, with exact undo', () => {
  const e=fixture(), original=structuredClone(e.report.keyframes);
  e.updateObject({field28:128,color_override_raw:0xff0000ff});
  assert.deepEqual(properties(e).sort(),['color','opacity']);
  assert.deepEqual(e.report.keyframes,original);
  assert.equal(e.evaluatedFrame.objects[0].field28,128);
  assert.equal(e.evaluatedFrame.objects[1].field28,0);
  assert.equal(Object.keys(e.report._styk.frameSources??{}).length,0);
  e.undo();assert.equal(e.animationChannels.length,0);e.redo();
  e.moveSelection(30,0);assert.ok(!properties(e).includes('x'));assert.ok(properties(e).includes('pose'));
  assert.equal(e.evaluatedFrame.objects[0].root_x,30);
  validateAnimationDocument(e.report);
});

test('a skeleton key detaches figure properties and captures no changed opacity into Pose', () => {
  const e=fixture();e.select(1,1);e.beginDrag();e.updateObject({field28:128});e.updateSegment({length:80});e.commitDrag();
  const pose=e.animationChannels.find(c=>c.property==='pose');assert.ok(pose);
  const key=pose.keys.find(k=>k.tick===0), source=e.report._styk.frameSources[key.value.frameId];
  assert.equal(source.objects[0].field28,0);
  assert.equal(e.evaluatedFrame.objects[0].field28,128);
  assert.equal(e.animationChannel({kind:'figure',uid:1},'x'),null);
  const colors=e.animationChannel({kind:'figure',uid:1},'color');
  e.setAnimationKey(pose.id,key.id,{tick:2});
  assert.strictEqual(e.animationChannel({kind:'figure',uid:1},'color'),colors);
});

test('camera gestures and Scene edits have property keys without Pose sources', () => {
  const e=fixture(), frames=structuredClone(e.report.keyframes);
  e.setCameraValues({x:40,scale:2});e.setSceneColor(0xffff0000);
  e.beginCameraDrag();e.updateCameraDrag({y:20});e.commitCameraDrag();
  assert.equal(e.evaluatedFrame.camera.y,20);
  assert.ok(!properties(e).includes('pose'));assert.deepEqual(e.report.keyframes,frames);
  assert.equal(e.evaluatedFrame._stykBackgroundColor,0xffff0000);
  e.undo();assert.equal(e.evaluatedFrame.camera.y,0);
  const clean=fixture();clean.beginCameraDrag();clean.updateCameraDrag({x:20});clean.cancelCameraDrag();
  assert.equal(clean.report._styk.animation,undefined);
});

test('Scene import, color release, undo and redo retain scalar channel ownership', () => {
  const e=fixture();e.setSceneColor(0xffff0000);
  const asset=e.importSceneBackground({kind:2,color:0xff00ff00});
  assert.equal(e.evaluatedFrame.background_id,asset.background_id);
  assert.equal(e.evaluatedFrame._stykBackgroundColor,undefined);
  assert.ok(!properties(e).includes('pose'));
  e.undo();assert.equal(e.evaluatedFrame._stykBackgroundColor,0xffff0000);
  e.redo();assert.equal(e.evaluatedFrame.background_id,asset.background_id);validateAnimationDocument(e.report);
});

test('outline and segment styles animate per instance and materialize for native export', () => {
  const e=fixture(), definition=structuredClone(e.figure);
  e.updateFigureStyle({outlineColor:'#ff0000',outlineWidth:8,outlineOpacity:.5});
  e.select(1,0);e.updateSegmentStyle({color:'#00ff00',thickness:12,opacity:.25});
  assert.deepEqual(e.figure,definition);assert.ok(!properties(e).includes('pose'));
  const object=e.evaluatedFrame.objects[0], resolved=resolveInstanceFigure(e.figure,object);
  assert.deepEqual(resolved.segment_decode.global_style.rgb,[255,0,0]);
  assert.equal(resolved.segment_decode.global_style.outline_thickness,8);
  assert.deepEqual(resolved.segments[0].color_rgb,[0,255,0]);
  assert.equal(resolved.segments[0].thickness,12);
  const output={...e.report,figure_types:[...e.report.figure_types]};
  const id=createNativeStyleTable(output)(object);
  assert.notEqual(id,e.figure.figure_type_id);assert.deepEqual(output.figure_types.at(-1).segments[0].color_rgb,[0,255,0]);
});

test('numeric appearance edits use property history and keep the source definition unchanged', () => {
  const e=fixture(), original=structuredClone(e.figure);
  numeric(e,'outline_opacity',30);numeric(e,'outline_width',9);e.select(1,0);numeric(e,'segment_opacity',45);numeric(e,'thickness',14);
  assert.deepEqual(e.figure,original);assert.ok(!properties(e).includes('pose'));
  assert.equal(e.animationValue({kind:'figure',uid:1},'outlineWidth'),9);
  assert.equal(e.animationValue({kind:'segment',uid:1,handleId:1},'thickness'),14);
});

test('Simple Discard and Update carry the same independent property edits across mode changes', () => {
  const e=fixture();e.selectFrame(1);e.select(1);e.enableFrameDrafts({mode:'add'});numeric(e,'figure_opacity',50);
  assert.ok(e.frameDraft.dirty);assert.ok(!properties(e).includes('pose'));
  const stored=storedFrameReport(e.report);assert.equal(evaluatedFrame(stored,1,0,timeline(stored)[1].start).objects[0].field28,0);
  e.discardFrameDraft();assert.equal(e.evaluatedFrame.objects[0].field28,0);
  numeric(e,'figure_opacity',25);e.updateDraftFrame();e.disableFrameDrafts();e.selectFrame(1);
  assert.equal(e.evaluatedFrame.objects[0].field28,191);
  const reopened=new Editor({demo:false,propertyChannels:true}).load(structuredClone(e.report));reopened.selectFrame(1);
  assert.equal(reopened.evaluatedFrame.objects[0].field28,191);
});

test('gradient paint, endpoint keys and polygon style survive reopen and native materialization', () => {
  const e=fixture();e.addPolygon([0,1,2]);e.select(1,0);
  const definition=structuredClone(e.figure);
  e.updateSegmentStyle({paint:{type:'linear',angle:30,stops:[{offset:0,color:[255,0,0],opacity:.8},{offset:1,color:[0,0,255],opacity:.3}]}});
  e.updatePolygon(0,{color:'#00ff00',opacity:.4});
  assert.deepEqual(e.figure,definition);assert.ok(!properties(e).includes('pose'));
  let resolved=resolveInstanceFigure(e.figure,e.object);
  assert.deepEqual(resolved.segments[0].secondary.rgb,[0,0,255]);assert.equal(resolved.segments[0].secondary.a,179);
  assert.deepEqual(resolved.polyfills[0].color_rgb,[0,255,0]);
  const paint=e.animationChannels.find(c=>c.property==='paint');assert.ok(paint);
  e.seek(5);e.updateSegmentStyle({gradient:{color:'#ffff00',opacity:.7}});
  const output={...e.report,figure_types:[...e.report.figure_types]},table=createNativeStyleTable(output);
  e.seek(0);const a=table(e.evaluatedFrame.objects[0]);e.seek(5);const b=table(e.evaluatedFrame.objects[0]);assert.notEqual(a,b);
  const reopened=new Editor({demo:false,propertyChannels:true}).load(e.serialize());reopened.seek(5);reopened.select(1);
  resolved=resolveInstanceFigure(reopened.figure,reopened.object);assert.deepEqual(resolved.segments[0].secondary.rgb,[255,255,0]);
  validateAnimationDocument(reopened.report);
});

test('new Simple frames retain explicit appearance keys instead of returning those values to Pose', () => {
  const e=fixture();e.selectFrame(2);e.select(1);e.enableFrameDrafts({mode:'add'});numeric(e,'figure_opacity',25);e.addDraftFrame();
  const channel=e.animationChannel({kind:'figure',uid:1},'opacity'),key=channel.keys.find(k=>k.tick===e.tick);
  assert.ok(key&&!key.passthrough);assert.equal(e.evaluatedFrame.objects[0].field28,191);
  e.undo();assert.equal(e.report.keyframes.length,3);e.redo();assert.equal(e.report.keyframes.length,4);
});

test('range color edits are property-only and preserve native frames', () => {
  const e=fixture(),before=structuredClone(e.report.keyframes);
  e.updateFiguresInFrames({color_override_raw:0xff0000ff},[0,2]);
  assert.deepEqual(properties(e),['color']);assert.deepEqual(e.report.keyframes,before);e.seek(10);assert.equal(e.evaluatedFrame.objects[0].color_override_raw,0xff0000ff);
  e.undo();assert.equal(e.animationChannels.length,0);
});

test('detached imported curves retain native automatic easing, opacity bytes and shortest rotation', () => {
  const e=fixture();e.report.auto_easing=true;
  e.report.keyframes.forEach((frame,i)=>{frame.objects[0].field28=i*71;frame.objects[0].angles=frame.objects[0].angles.map(v=>v+i*2.8);});e._invalidate();
  for(const property of ['x','rotation','opacity','color']) {
    const channel=e.nativePropertyChannel({kind:'figure',uid:1},property);
    for(let tick=0;tick<10;tick++) {
      e.seek(tick);const value=e.animationValue({kind:'figure',uid:1},property);
      const sampled=sampleAnimationChannel(channel,tick);
      if(property==='rotation')assert.ok(Math.abs(Math.sin(value)-Math.sin(sampled))<1e-8);
      else assert.ok(Math.abs(value-sampled)<1e-8,`${property} at ${tick}: ${value} vs ${sampled}`);
    }
  }
});

test('parent rotation keeps joined children attached without manufacturing absolute child tracks', () => {
  const e=fixture();e.select(2);e.joinTo(1,1);e.select(1,1);e.updateSegment({length:90});
  assert.equal(e.animationChannel({kind:'figure',uid:2},'rotation'),null);
  const before=buildGeometry(e.report,e.evaluatedFrame).objects.get(e.evaluatedFrame.objects.findIndex(o=>o.unique_id===2)).segments[0].angle;
  e.select(1);const angle=e.animationValue({kind:'figure',uid:1},'rotation');e.addAnimationKey({kind:'figure',uid:1},'rotation',e.tick,angle+.4);
  const after=buildGeometry(e.report,e.evaluatedFrame).objects.get(e.evaluatedFrame.objects.findIndex(o=>o.unique_id===2)).segments[0].angle;
  assert.ok(Math.abs(after-before-.4)<1e-8);
});

test('changing the figure origin preserves the world direction of an independently keyed gradient',()=>{
  const e=fixture();e.select(1,1);
  e.updateSegmentStyle({paint:{type:'linear',angle:30,stops:[{offset:0,color:[255,0,0],opacity:.4},{offset:1,color:[0,0,255],opacity:.8}]}});
  const sample=()=>{
    const segment=resolveInstanceFigure(e.figure,e.object).segments[1];
    const geometry=buildGeometry(e.report,e.evaluatedFrame).objects.get(0).segments.find(item=>item.index===1);
    return paintGeometry(segmentPaint(segment),geometry.start,geometry.end);
  };
  const original=e.serialize(),before=sample(),handle=e.figure.segments[1].segment_id;e.setOrigin(handle);e.select(1);const after=sample(),changed=e.serialize();
  for(const property of ['x1','y1','x2','y2'])assert.ok(Math.abs(before[property]-after[property])<1e-6,property);
  e.undo();assert.deepEqual(e.serialize(),original);e.redo();assert.deepEqual(e.serialize(),changed);
});
