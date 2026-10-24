import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument,createFrame,createObject} from '../src/demo.mjs';
import {builderDrawables} from '../src/editor-builder-style.mjs';
import {resolveInstanceFigure} from '../src/animation-style.mjs';
import {validateAnimationDocument,validateAnimationValue} from '../src/animation-channels.mjs';
import {beginNativePropertyEdit,previewNativePropertyEdit,commitNativePropertyEdit,cancelNativePropertyEdit,getNativePropertyValue} from '../src/native-property-edit.mjs';
import {materializePivotDocument} from '../src/pivot-export-materialize.mjs';
import {buildGeometry,evaluatedFrame,timeline} from '../src/pivot/geometry.mjs';

function fixture(layerTimeline) {
  const report=emptyDocument(),figure=report.figure_types[0];
  figure.polyfills=[{polyfill_id:1,segment_ids:[0,1,2],color_rgb:[255,0,0],color_alpha:1,z_order:1.5}];
  report.keyframes=[0,1,2].map(()=>createFrame([1,2].map(uid=>createObject(figure,uid,uid*200,200)),10));
  const e=new Editor({demo:false,propertyChannels:true,layerTimeline}).load(report);
  e.select(1,0);return e;
}
const frameAt=(report,tick)=>{const row=timeline(report).findLast(row=>row.start<=tick);return evaluatedFrame(report,row.index,(tick-row.start)/row.count,tick);};
const order=(report,frame,uid=1)=>{
  const object=frame.objects.find(o=>o.unique_id===uid),figure=report.figure_types.find(f=>f.figure_type_id===object.figure_type_id);
  return builderDrawables(resolveInstanceFigure(figure,object)).map(entry=>`${entry.kind}:${entry.index}`);
};
const current=e=>order(e.report,e.evaluatedFrame);
const numeric=(e,key,value,options)=>{const token=beginNativePropertyEdit(e,key,options);previewNativePropertyEdit(token,value);return commitNativePropertyEdit(token);};

for(const layerTimeline of [false,true]) {
  test(`internal order is local to timeline frames and figure instances (layerTimeline=${layerTimeline})`,()=>{
    const e=fixture(layerTimeline),base=current(e),definition=structuredClone(e.figure);
    e.moveBuilderOrder({kind:'segment',index:0},'front');
    const first=current(e);assert.equal(first.at(-1),'segment:0');assert.notDeepEqual(first,base);
    assert.deepEqual(order(e.report,e.evaluatedFrame,2),base);
    e.seek(10);numeric(e,'segment_z_order',1);
    const second=current(e);assert.equal(second[0],'segment:0');
    e.seek(0);assert.deepEqual(current(e),first);
    e.seek(10);assert.deepEqual(current(e),second);
    assert.deepEqual(e.figure,definition);validateAnimationDocument(e.report);
    const reopened=new Editor({demo:false,propertyChannels:true,layerTimeline}).load(structuredClone(e.serialize()));
    assert.deepEqual(order(reopened.report,frameAt(reopened.report,0)),first);
    assert.deepEqual(order(reopened.report,frameAt(reopened.report,10)),second);
  });
  test(`polygon and branch order preview, cancel and history are atomic (layerTimeline=${layerTimeline})`,()=>{
    const e=fixture(layerTimeline),base=current(e),definition=structuredClone(e.figure),history=e._undo.length;
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
  test(`rendering and Pivot materialization preserve internal order (layerTimeline=${layerTimeline})`,()=>{
    const e=fixture(layerTimeline);e.moveBuilderOrder({kind:'segment',index:0},'front');
    e.seek(10);e.moveBuilderOrder({kind:'polygon',index:0},'front');
    const exported=materializePivotDocument(e.serialize());
    for(const tick of [0,5,9.999,10,20]) {
      const frame=frameAt(e.report,tick),expected=order(e.report,frame);
      assert.deepEqual(order(exported,frameAt(exported,tick)),expected);
      const geometry=buildGeometry(e.report,frame).objects.get(0);
      const rendered=[...geometry.polys.map(p=>({id:`polygon:${p.index}`,z:p.z})),...geometry.segments.map((s,index)=>({id:`segment:${index}`,z:s.z}))].sort((a,b)=>a.z-b.z).map(s=>s.id);
      assert.deepEqual(rendered,expected);
    }
  });
  test(`numeric order ranges update only selected frames (layerTimeline=${layerTimeline})`,()=>{
    const e=fixture(layerTimeline),base=current(e),indices=[0,1];
    if(layerTimeline)indices.sheetTicks=[0,10];
    numeric(e,'segment_z_order',base.length,{indices});
    const changed=current(e);
    e.seek(10);assert.deepEqual(current(e),changed);
    e.seek(20);assert.deepEqual(current(e),base);
    e.undo();e.seek(0);assert.deepEqual(current(e),base);
  });
}

test('internal depth validates persisted overrides and permits imported fractional order',()=>{
  const e=fixture(true),target={kind:'segment',uid:1,handleId:1};
  assert.equal(validateAnimationValue(target,'zIndex',1.5),1.5);
  for(const value of [NaN,Infinity,1e50,'1'])assert.throws(()=>validateAnimationValue(target,'zIndex',value));
  for(const key of ['segments','polygons']){
    const report=structuredClone(e.report);report.keyframes[0].objects[0]._stykStyle={[key]:{1:{zIndex:Infinity}}};
    assert.throws(()=>new Editor({demo:false}).load(report),/order|finite/);
  }
});
