import test from 'node:test';
import assert from 'node:assert/strict';
import {newOwnedEditor} from './support/owned-editor.mjs';
import {rigExampleDocument} from '../src/rig-examples.mjs';
import {SOLID_RIG_EXAMPLES} from '../src/rig-solids.mjs';
import {geometryOfDocument} from './support/engine-geometry.mjs';
import {validateScene} from '../src/pivot/model.mjs';
import {buildContainerV2,decodeDocument} from './support/native-files.mjs';
const area=points=>Math.abs(points.reduce((a,p,i)=>{const q=points[(i+1)%points.length];return a+p.x*q.y-p.y*q.x;},0)/2);
function hull(points){
  const sorted=[...points].sort((a,b)=>a.x-b.x||a.y-b.y),cross=(o,a,b)=>(a.x-o.x)*(b.y-o.y)-(a.y-o.y)*(b.x-o.x),half=list=>{const h=[];for(const p of list){while(h.length>1&&cross(h.at(-2),h.at(-1),p)<=1e-8)h.pop();h.push(p);}return h.slice(0,-1);};
  return [...half(sorted),...half(sorted.reverse())];
}
function closed(g){
  const expected=area(hull(g.polys.flatMap(p=>p.points))),drawn=g.polys.filter(p=>!p.culled).reduce((a,p)=>a+area(p.points),0);
  assert.ok(Math.abs(drawn-expected)<Math.max(1e-5,expected*1e-6),`Surface gap/overlap: ${drawn} vs hull ${expected}`);
  assert.ok(g.polys.every(p=>p.alpha===1&&p.points.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y))));
}
const editorFor=(id='solid-box-3d',options={})=>{const e=newOwnedEditor({demo:false,...options});e.load(rigExampleDocument(id));e.select(1,0);return e;};
const change=(e,key,value)=>{e.select(e.selectedUid,e.figure.segments.findIndex(s=>s.name===({turn:'Turn',tilt:'Depth',height:'Height'}[key])));return e.updateSegment(key==='turn'?{angle_rad:value*Math.PI/180}:{length:value});};
for(const r of SOLID_RIG_EXAMPLES){
  test(`${r.name}: opaque closed coverage over full turns, depth collapse and height extremes`,()=>{
    const d=rigExampleDocument(r.id),fig=d.figure_types[0],o=d.keyframes[0].objects[0],c=Object.fromEntries([['turn','Turn'],['tilt','Depth'],['height','Height']].map(([key,name])=>[key,fig.segments.find(s=>s.name===name).segment_id]));
    validateScene(d);o.len_flag=1;o.lengths=fig.segments.map(s=>s.length);
    for(const height of [20,100,300])for(const depth of [0,40,100])for(let deg=0;deg<=360;deg+=15){
      o.angles[c.turn-1]=deg*Math.PI/180;o.lengths[c.tilt-1]=depth;o.lengths[c.height-1]=height;
      closed(geometryOfDocument(d,d.keyframes[0]).objects.get(0));
    }
    assert.ok(fig.segments.length<180,'Small reusable construction budget');
  });
  test(`${r.name}: reflections and whole figure rotation retain the same colored faces`,()=>{
    const e=editorFor(r.id),visible=()=>e.geometry.objects.get(0).polys.filter(p=>!p.culled).map(p=>p.index);
    for(const turn of [0,45,95,180,275,360]){change(e,'turn',turn);const original=visible();
      for(const axis of ['horizontal','vertical']){e.select(1,-1);e.mirrorFigure(axis);closed(e.geometry.objects.get(0));assert.deepEqual(visible(),original);e.undo();}
      e.select(1,-1);e.rotateFigure(.7);closed(e.geometry.objects.get(0));assert.deepEqual(visible(),original);e.undo();
    }
  });
}
test('ordinary polygon colors are independent and reversible',()=>{
  const e=editorFor('solid-cylinder-3d',{layerTimeline:true,propertyChannels:true}),before=e.serialize(),undo=e._undo.length,colors=()=>e.geometry.objects.get(0).polys.map(p=>p.rgb);
  const original=colors();e.updatePolygon(0,{color:'#e03060'});assert.equal(e._undo.length,undo+1);
  assert.notDeepEqual(colors()[0],original[0]);assert.deepEqual(colors().slice(1),original.slice(1));const changed=e.serialize();
  e.undo();assert.deepEqual(e.serialize(),before);e.redo();assert.deepEqual(e.serialize(),changed);
  for(const bad of ['red',[Infinity,0,0],[256,0,0]])assert.throws(()=>e.updatePolygon(0,{color:bad}));assert.deepEqual(e.serialize(),changed);
});
test('native joint controls reject nonfinite values and coalesce one gesture into one undo',()=>{
  const e=editorFor(),before=e.serialize(),joint=e.selectedJoint;
  for(const v of [NaN,Infinity])assert.throws(()=>change(e,'turn',v));
  assert.deepEqual(e.serialize(),before);assert.equal(e.selectedJoint,joint);
  e.beginDrag('Turn');for(let i=1;i<30;i++)change(e,'turn',i*11);e.commitDrag();assert.equal(e._undo.length,1);e.undo();assert.deepEqual(e.serialize(),before);
});
test('solid faces and colors survive native saves',async()=>{
  const e=editorFor(undefined,{layerTimeline:true,propertyChannels:true});change(e,'turn',211);change(e,'height',140);e.updatePolygon(0,{color:'#faf030'});
  const d=(await decodeDocument(await buildContainerV2(e.serialize(),'styk'),'styk')).document;validateScene(d);assert.deepEqual(d.figure_types[0].polyfills,e.figure.polyfills);
});
test('malformed native surface metadata is rejected',()=>{
  for(const basis of [[0,1,999],[0,1,1],[0,1],null]){const d=rigExampleDocument('solid-box-3d');d.figure_types[0].polyfills[0]._stykSurface.basis=basis;assert.throws(()=>validateScene(d),/reference joints/);}
});
