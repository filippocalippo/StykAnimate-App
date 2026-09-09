import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument,createFrame,createObject} from '../src/demo.mjs';
import {animationChannelId} from '../src/animation-channels.mjs';
import {reverseGradientEndpoints} from '../src/editor-style-topology.mjs';
const clone=value=>structuredClone(value),target=handleId=>({kind:'segment',uid:1,handleId});
function fixture({single=false}={}){
  const report=emptyDocument(),figure=report.figure_types[0],base=figure.segments[0];
  figure.segments=[7,99,301].slice(0,single?1:3).map((id,i)=>({...clone(base),segment_id:id,parent_id:i?7:0,
    angle_rad:[.3,1.4,-.7][i],length:[80,50,60][i],bend_rad:[.2,-.3,0][i],
    color_rgb:[20+i*20,60,90],transparency:30+i*20,color_alpha:1-(30+i*20)/255,secondary:{rgb:[220,130+i*20,10],a:180-i*30}}));
  figure.segment_count=figure.segments.length;report.figure_types.push({...clone(figure),figure_type_id:2});
  report.keyframes=[0,1].map(i=>createFrame([createObject(figure,1,100+i*30,200),createObject(report.figure_types[1],2,400,200)],i?1:4));
  for(const frame of report.keyframes)frame.objects[0]._stykStyle={outlineOpacity:.8,segments:{7:{opacity:.2},...(!single?{99:{gradientOpacity:.7},301:{opacity:.4,gradientOpacity:.6}}:{})}};
  const editor=new Editor({demo:false}).load(report);editor.captureFrameSource(editor.frame);
  editor.addAnimationKeys([
    {target:target(7),property:'opacity',tick:0,value:.25},{target:target(7),property:'opacity',tick:4,value:.55},
    {target:target(7),property:'gradientOpacity',tick:1,value:.85},{target:target(7),property:'gradientOpacity',tick:3,value:.15},
    ...(!single?[{target:target(99),property:'gradientOpacity',tick:0,value:.35},{target:target(301),property:'opacity',tick:0,value:.9}]:[]),
    {target:{kind:'segment',uid:2,handleId:7},property:'opacity',tick:0,value:.3}]);
  editor.select(1,0);return editor;
}
function worldEndpoints(editor,tick){
  editor.seek(tick);editor.select(1);
  const round=v=>+v.toFixed(5);
  return editor.geometry.objects.get(editor.selectedSlot).segments.map(shape=>({length:round(shape.length),
    endpoints:[{point:[round(shape.start.x),round(shape.start.y)],rgb:shape.seg.color_rgb,alpha:shape.seg.transparency},
      {point:[round(shape.end.x),round(shape.end.y)],rgb:shape.seg.secondary.rgb,alpha:shape.seg.secondary.a}]
      .sort((a,b)=>JSON.stringify(a.point).localeCompare(JSON.stringify(b.point)))}));
}
test('Set Origin retains world endpoint colors and animated alpha while reversing sparse path roles',()=>{
  const editor=fixture(),before=editor.serialize(),expected=Array.from({length:5},(_,tick)=>worldEndpoints(editor,tick)),
    primary=clone(editor.animationChannel(target(7),'opacity')),secondary=clone(editor.animationChannel(target(7),'gradientOpacity')),history=editor._undo.length;
  editor.setOrigin(99);assert.equal(editor._undo.length,history+1);
  for(let tick=0;tick<5;tick++){
    const actual=worldEndpoints(editor,tick);
    actual.forEach((shape,index)=>shape.endpoints.forEach((endpoint,end)=>{
      const point=expected[tick][index].endpoints[end].point;
      assert.ok(Math.hypot(endpoint.point[0]-point[0],endpoint.point[1]-point[1])<.0001);
      endpoint.point=point;
    }));
    assert.deepEqual(actual,expected[tick]);
  }
  for(const[property,old]of[['opacity',secondary],['gradientOpacity',primary]]){
    const channel=editor.animationChannel(target(99),property);assert.equal(channel.id,animationChannelId(target(99),property));assert.deepEqual(channel.keys,old.keys);
  }
  assert.equal(editor.animationChannel(target(7),'gradientOpacity'),null);assert.equal(editor.animationChannel(target(7),'opacity').keys[0].value,.35);
  assert.equal(editor.animationChannel(target(301),'opacity').keys[0].value,.9);assert.equal(editor.animationChannel({kind:'segment',uid:2,handleId:7},'opacity').keys[0].value,.3);
  for(const frame of editor._allSourceFrames()){
    assert.deepEqual(frame.objects[0]._stykStyle.segments[99],{gradientOpacity:.2});assert.deepEqual(frame.objects[0]._stykStyle.segments[7],{opacity:.7});
    assert.deepEqual(frame.objects[0]._stykStyle.segments[301],{opacity:.4,gradientOpacity:.6});
  }
  const after=editor.serialize();editor.undo();assert.deepEqual(editor.serialize(),before);editor.redo();assert.deepEqual(editor.serialize(),after);
});
test('a reversed segment retaining its handle ID still swaps sparse endpoint properties without duplicating keys',()=>{
  const editor=fixture({single:true}),before=editor.serialize(),primary=clone(editor.animationChannel(target(7),'opacity')),secondary=clone(editor.animationChannel(target(7),'gradientOpacity'));
  editor.setOrigin(7);assert.equal(editor.figure.segments[0].segment_id,7);
  assert.deepEqual(editor.animationChannel(target(7),'opacity').keys,secondary.keys);assert.deepEqual(editor.animationChannel(target(7),'gradientOpacity').keys,primary.keys);
  assert.equal(editor.report._styk.animation.nextKeyId,before._styk.animation.nextKeyId);
  for(const frame of editor._allSourceFrames())assert.deepEqual(frame.objects[0]._stykStyle.segments[7],{gradientOpacity:.2});
  editor.undo();assert.deepEqual(editor.serialize(),before);
});
test('gradient reversal handles primary alpha-only aliases and does not alter solid segments',()=>{
  const original={color_rgb:[10,20,30],color_alpha:.2,secondary:{rgb:[40,50,60],a:102,unknown:'retained'}};
  const result=reverseGradientEndpoints(original);assert.deepEqual(result.color_rgb,[40,50,60]);assert.equal(result.transparency,102);assert.equal(result.color_alpha,.6);
  assert.deepEqual(result.secondary,{rgb:[10,20,30],a:204,unknown:'retained'});assert.equal(original.color_alpha,.2);
  const solid={color_rgb:[1,2,3],transparency:80};assert.equal(reverseGradientEndpoints(solid),solid);
});
