import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument,createFrame,createObject} from '../src/demo.mjs';
import {builderDrawables} from '../src/editor-builder-style.mjs';
import {resolveInstanceFigure} from '../src/animation-style.mjs';
import {validateAnimationDocument,validateAnimationValue} from '../src/animation-channels.mjs';
import {beginNativePropertyEdit,previewNativePropertyEdit,commitNativePropertyEdit,cancelNativePropertyEdit,getNativePropertyValue} from '../src/native-property-edit.mjs';
import {pivotDocument} from './support/engine-export.mjs';
import {ownedEditorFor} from './support/owned-editor.mjs';

function fixture() {
  const report=emptyDocument(),figure=report.figure_types[0];
  figure.polyfills=[{polyfill_id:1,segment_ids:[0,1,2],color_rgb:[255,0,0],color_alpha:1,z_order:1.5}];
  report.keyframes=[0,1,2].map(()=>createFrame([1,2].map(uid=>createObject(figure,uid,uid*200,200)),10));
  const e=ownedEditorFor({demo:false,propertyChannels:true,layerTimeline:true}, report);
  e.select(1,0);return e;
}
const order=(report,frame,uid=1)=>{
  const object=frame.objects.find(o=>o.unique_id===uid),figure=report.figure_types.find(f=>f.figure_type_id===object.figure_type_id);
  return builderDrawables(resolveInstanceFigure(figure,object)).map(entry=>`${entry.kind}:${entry.index}`);
};
const current=e=>order(e.report,e.evaluatedFrame);
const numeric=(e,key,value,options)=>{const token=beginNativePropertyEdit(e,key,options);previewNativePropertyEdit(token,value);return commitNativePropertyEdit(token);};

test(`internal order is local to timeline frames and figure instances`,()=>{
  const e=fixture(),base=current(e),definition=structuredClone(e.figure);
  e.moveBuilderOrder({kind:'segment',index:0},'front');
  const first=current(e);assert.equal(first.at(-1),'segment:0');assert.notDeepEqual(first,base);
  assert.deepEqual(order(e.report,e.evaluatedFrame,2),base);
  e.seek(10);numeric(e,'segment_z_order',1);
  const second=current(e);assert.equal(second[0],'segment:0');
  e.seek(0);assert.deepEqual(current(e),first);
  e.seek(10);assert.deepEqual(current(e),second);
  assert.deepEqual(e.figure,definition);validateAnimationDocument(e.report);
  const reopened=ownedEditorFor({demo:false,propertyChannels:true,layerTimeline:true},structuredClone(e.serialize()));
  reopened.seek(0);assert.deepEqual(current(reopened),first);
  reopened.seek(10);assert.deepEqual(current(reopened),second);
});
test(`polygon and branch order preview, cancel and history are atomic`,()=>{
  const e=fixture(),base=current(e),definition=structuredClone(e.figure),history=e._undo.length;
  let token=beginNativePropertyEdit(e,'polygon_0_z_order');
  previewNativePropertyEdit(token,base.length);assert.equal(current(e).at(-1),'polygon:0');
  previewNativePropertyEdit(token,1);assert.equal(current(e)[0],'polygon:0');
  cancelNativePropertyEdit(token);assert.deepEqual(current(e),base);assert.equal(e._undo.length,history);
  e.seek(10);numeric(e,'polygon_0_z_order',base.length);
  const changed=current(e);assert.equal(getNativePropertyValue(e,'polygon_0_z_order'),base.length);
  assert.equal(e._undo.length,history+1);e.undo();assert.deepEqual(current(e),base);e.redo();assert.deepEqual(current(e),changed);
  e.seek(0);assert.deepEqual(current(e),base);
  e.seek(10);e.moveBuilderOrder({kind:'segment',index:0},'back',{branch:true});
  e.seek(0);assert.deepEqual(current(e),base);assert.deepEqual(e.figure,definition);
  token=beginNativePropertyEdit(e,'segment_z_order');
  assert.throws(()=>previewNativePropertyEdit(token,1.5));cancelNativePropertyEdit(token);assert.deepEqual(current(e),base);
});
test(`rendering and Pivot materialization preserve internal order`,()=>{
  const e=fixture();e.moveBuilderOrder({kind:'segment',index:0},'front');
  e.seek(10);e.moveBuilderOrder({kind:'polygon',index:0},'front');
  const native=ownedEditorFor({demo:false},pivotDocument(e.serialize()));
  for(const tick of [0,5,9.999,10,20]) {
    e.seek(tick);native.seek(tick);
    const expected=current(e);
    assert.deepEqual(current(native),expected);
    const geometry=e.geometry.objects.get(0);
    const rendered=[...geometry.polys.map(p=>({id:`polygon:${p.index}`,z:p.z})),...geometry.segments.map((s,index)=>({id:`segment:${index}`,z:s.z}))].sort((a,b)=>a.z-b.z).map(s=>s.id);
    assert.deepEqual(rendered,expected);
  }
});
test(`numeric order ranges update only selected frames`,()=>{
  const e=fixture(),base=current(e),indices=[0,1];
  indices.sheetTicks=[0,10];
  numeric(e,'segment_z_order',base.length,{indices});
  const changed=current(e);
  e.seek(10);assert.deepEqual(current(e),changed);
  e.seek(20);assert.deepEqual(current(e),base);
  e.undo();e.seek(0);assert.deepEqual(current(e),base);
});

test('a draw order edit at a layer key with bezier easing is one entry that holds the order and undoes exactly',()=>{
  const edits=[
    e=>e.moveBuilderOrder({kind:'segment',index:2},'front'),
    e=>numeric(e,'segment_z_order',current(e).length),
  ];
  for(const edit of edits) {
    const e=fixture(),id=e.layerForUid(1),bezier=[.1,.2,.3,.9];
    e.sheetSetEasing([id],10,10,{interpolation:'bezier',bezier});
    e.sheetSetEasing([id],20,20,{interpolation:'bezier',bezier});
    e.seek(10);
    const base=current(e),source=JSON.stringify(e.serialize()),entries=e._undo.length;
    assert.ok(edit(e));
    assert.notDeepEqual(current(e),base);
    assert.equal(e._undo.length,entries+1);
    const keys=e.layerFrameKeys(id),written=keys.find(key=>key.tick===10);
    assert.equal(written.interpolation,'constant');assert.equal(written.bezier,undefined,'the key holds the order, it keeps no curve');
    assert.deepEqual(keys.find(key=>key.tick===20).bezier,bezier,'the other key is as it was');
    e.undo();assert.equal(JSON.stringify(e.serialize()),source);
  }
});

test('internal depth validates persisted overrides and permits imported fractional order',()=>{
  const e=fixture(),target={kind:'segment',uid:1,handleId:1};
  assert.equal(validateAnimationValue(target,'zIndex',1.5),1.5);
  for(const value of [NaN,Infinity,1e50,'1'])assert.throws(()=>validateAnimationValue(target,'zIndex',value));
  for(const key of ['segments','polygons']){
    const report=structuredClone(e.report);report.keyframes[0].objects[0]._stykStyle={[key]:{1:{zIndex:Infinity}}};
    assert.throws(()=>new Editor({demo:false}).load(report),/order|finite/);
  }
});
