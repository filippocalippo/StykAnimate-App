import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {buildRotatingCube} from './helpers/rotating-cube.mjs';
import {buildGeometry,buildGeometryAsync} from '../src/pivot/geometry.mjs';
import {buildContainerV2,decodeDocument} from './support/native-files.mjs';
import {validateScene} from '../src/pivot/model.mjs';
import {materializePivotDocument} from '../src/pivot-export-materialize.mjs';
import {pickFigureFill} from '../src/builder-fill.mjs';
import {surfaceOrder,surfaceDepthValues,surfaceHandles,remapSurface,validateSurface} from '../src/pivot/surfaces.mjs';
const fixture=()=>{const e=new Editor({demo:false});return {e,q:buildRotatingCube(e)};};
const select=(e,id)=>e.select(e.selectedUid,e.figure.segments.findIndex(s=>s.segment_id===id));
const visible=e=>e.geometry.objects.get(e.selectedSlot).polys.filter(p=>!p.culled).map(p=>p.index);
const area=points=>Math.abs(points.reduce((a,p,i)=>{const q=points[(i+1)%points.length];return a+p.x*q.y-p.y*q.x;},0)/2);
function hullArea(points){const sorted=points.slice().sort((a,b)=>a.x-b.x||a.y-b.y),half=points=>{const h=[];for(const p of points){while(h.length>1){const [a,b]=h.slice(-2);if((b.x-a.x)*(p.y-a.y)-(b.y-a.y)*(p.x-a.x)>1e-6)break;h.pop();}h.push(p);}return h.slice(0,-1);};return area([...half(sorted),...half(sorted.reverse())]);}

test('cube built through normal Builder commands remains closed through 1,083 projected poses',()=>{
  const {e,q}=fixture();assert.equal(e.figure._styk?.rigExample,undefined);assert.equal(e.figure.segments.length,29);
  for(const depth of [0,40,100])for(let turn=0;turn<=360;turn++){
    select(e,q.depth);e.updateSegment({length:depth});select(e,q.turn);e.updateSegment({angle_rad:turn*Math.PI/180});
    const g=e.geometry.objects.get(e.selectedSlot),polys=g.polys.filter(p=>!p.culled),expected=hullArea(g.polys.flatMap(p=>p.points));
    assert.ok(Math.abs(polys.reduce((sum,p)=>sum+area(p.points),0)-expected)<.06,`Gap/overlap at ${turn}, depth ${depth}`);
    assert.ok(polys.length>=1&&polys.length<=3);assert.ok(polys.every(p=>p.alpha===1));
  }
});

test('face side and facing edits are atomic, undoable and leave colors and vertex order intact',()=>{
  const {e,q}=fixture(),before=e.serialize(),front=visible(e),corners=e.figure.polyfills.map(p=>p.segment_ids);
  e.updatePolygon(0,{surface:{basis:q.basis,side:'back'}});assert.ok(!visible(e).includes(0));
  e.updatePolygon(0,{surface:{basis:q.basis,side:'back',flipped:true}});assert.deepEqual(visible(e),front);
  assert.deepEqual(e.figure.polyfills.map(p=>p.segment_ids),corners);e.undo();e.undo();assert.deepEqual(e.serialize(),before);
  e.updatePolygon(0,{surface:null});assert.equal(e.figure.polyfills[0]._stykSurface,undefined);e.undo();assert.deepEqual(e.serialize(),before);
  for(const surface of [{basis:[0,1,999]},{basis:[0,0,1]},{basis:[0,q.frame,q.turn]},{basis:q.basis,side:'both'},{basis:q.basis,flipped:1}]){
    assert.throws(()=>e.updatePolygon(0,{surface}));assert.deepEqual(e.serialize(),before);
  }
});

test('reference deletion and copying incomplete surfaces cannot silently destroy or change faces',()=>{
  const {e,q}=fixture();select(e,q.basis[1]);const before=e.serialize();
  for(const remove of [()=>e.deleteSegment(),()=>e.deleteSingleSegment(),()=>e.unsplitSegment()]){assert.throws(remove,/reference joints/);assert.deepEqual(e.serialize(),before);}
  select(e,q.frame);assert.throws(()=>e.copyBranchSelection(),/face reference joints/);assert.deepEqual(e.serialize(),before);
  e.updatePolygon(0,{surface:null});assert.equal(e.figure.polyfills.length,6);
});

test('ordinary fills remain double-sided; visible picking ignores culled faces',()=>{
  const {e}=fixture(),g=e.geometry.objects.get(e.selectedSlot),p=g.polys.find(p=>!p.culled);
  const point=p.points.reduce((a,p)=>({x:a.x+p.x,y:a.y+p.y}),{x:0,y:0});point.x/=p.points.length;point.y/=p.points.length;
  assert.equal(pickFigureFill(g,point)?.culled,false);
  e.selectPolygon(e.selectedUid,g.polys.find(p=>p.culled).index);assert.ok(e.selectedPolygonIndex>=0,'Hidden faces remain selectable from the outliner');
  for(let i=0;i<6;i++)e.updatePolygon(i,{surface:null});assert.equal(visible(e).length,6);
});

test('cube preserves facing through mirrors, native saves, asynchronous evaluation and whole figure copies',async()=>{
  const {e}=fixture(),front=visible(e);
  for(const axis of ['horizontal','vertical']){e.select(e.selectedUid,-1);e.mirrorFigure(axis);assert.deepEqual(visible(e),front);e.undo();}
  e.rotateFigure(.9);assert.deepEqual(visible(e),front);e.undo();
  for(const kind of ['styk','stkz']){const d=(await decodeDocument(await buildContainerV2(e.serialize(),kind),kind)).document;validateScene(d);assert.deepEqual(buildGeometry(d,d.keyframes[0]).drawables,(await buildGeometryAsync(d,d.keyframes[0])).drawables);assert.deepEqual(d.figure_types.find(f=>f.figure_type_id===e.figure.figure_type_id).polyfills,e.figure.polyfills);}
  assert.throws(()=>materializePivotDocument(e.serialize()),/one-sided fills/);
  e.select(e.selectedUid,-1);e.copyFigure();e.pasteFigure();validateScene(e.serialize());assert.equal(e.frame.objects.length,2);assert.deepEqual(visible(e),front);
});

test('one-sided fills also work on ordinary figures with no rig constraints',()=>{
  const e=new Editor({demo:false});const x=e.addSegment({length:40,angle:0}).segment_id,y=e.addSegment({parentId:0,length:40,angle:Math.PI/2}).segment_id;
  e.addPolygon([0,x,y]);e.updatePolygon(0,{surface:{basis:[0,x,y],side:'front'}});assert.deepEqual(visible(e),[0]);
  e.updatePolygon(0,{surface:{basis:[0,x,y],side:'back'}});assert.deepEqual(visible(e),[]);assert.throws(()=>materializePivotDocument(e.serialize()),/one-sided fills/);
  assert.throws(()=>materializePivotDocument({figure_types:[{segments:[],_styk:{movieclip:{document:e.serialize()}}}]}),/one-sided fills/);
});

test('depth guides change painter order continuously and survive affine transforms and ID remapping',()=>{
  const poly={z_order:2,segment_ids:[0,1,2],_stykSurface:{basis:[0,1,2],depth:[3,4]}};
  const positions=[[10,20],[40,20],[10,50],[70,0],[-20,90]];
  const joints=new Map(positions.map(([x,y],id)=>[id,{x,y}]));
  assert.equal(surfaceOrder(poly,joints),2.5);
  for(const scale of [-2,3]){
    const a=.7,c=Math.cos(a),s=Math.sin(a);
    const transformed=new Map([...joints].map(([id,p])=>[id,{x:80+scale*(p.x*c-p.y*s),y:60+scale*(p.x*s+p.y*c)}]));
    assert.ok(Math.abs(surfaceOrder(poly,transformed)-2.5)<1e-10);
  }
  joints.set(3,{x:-50,y:0});assert.equal(surfaceOrder(poly,joints),.5);
  const remap=id=>id+10;remapSurface(poly,remap);assert.deepEqual(poly._stykSurface.depth,[13,14]);
  assert.ok(surfaceHandles(poly).includes(14));
  const mapped=new Map([...joints].map(([id,p])=>[remap(id),p]));assert.equal(surfaceOrder(poly,mapped),.5);
  mapped.set(11,mapped.get(10));assert.equal(surfaceOrder(poly,mapped),2);
  assert.equal(surfaceOrder({z_order:7},joints),7);
  for(const depth of [[],[999],[NaN],'3'])assert.throws(()=>validateSurface({_stykSurface:{basis:[0,1,2],depth}},new Set([0,1,2,3])),/Face depth/);
});

test('depth references support normal authoring, undo, deletion protection and native round trips',async()=>{
  const {e,q}=fixture(),guide=e.addSegment({parentId:0,length:90,angle:0}).segment_id;
  const before=e.serialize();e.updatePolygon(0,{surface:{basis:q.basis,side:'front',depth:[guide]}});
  assert.notEqual(e.geometry.objects.get(e.selectedSlot).polys[0].z,0);
  select(e,guide);const posed=e.serialize();assert.throws(()=>e.deleteSingleSegment(),/reference joints/);assert.deepEqual(e.serialize(),posed);
  for(const kind of ['styk','stkz']){
    const d=(await decodeDocument(await buildContainerV2(posed,kind),kind)).document;validateScene(d);
    assert.deepEqual(d.figure_types.find(f=>f.figure_type_id===e.figure.figure_type_id).polyfills[0]._stykSurface.depth,[guide]);
  }
  e.undo();assert.deepEqual(e.serialize(),before);e.redo();assert.deepEqual(e.serialize(),posed);
});

test('intersection depth preserves each corner through transforms and native authoring',async()=>{
  const e=new Editor({demo:false});
  const x=e.addSegment({parentId:0,length:40,angle:0}).segment_id,y=e.addSegment({parentId:0,length:40,angle:Math.PI/2}).segment_id;
  const z=e.addSegment({parentId:0,length:80,angle:0}).segment_id;
  e.addPolygon([0,x,y]);const surface={basis:[0,x,y],depth:[z,0,x],depthTest:true,side:'front'};
  const before=e.serialize();e.updatePolygon(0,{surface});
  const get=()=>e.geometry.objects.get(e.selectedSlot).polys[0].depthValues;
  assert.deepEqual(get(),[2,0,1]);
  e.select(e.selectedUid,-1);e.rotateFigure(.73);e.scaleSelection(2.4);e.moveSelection(-80,170);
  for(const [i,z]of get().entries())assert.ok(Math.abs(z-[2,0,1][i])<1e-5);
  const posed=e.serialize();
  for(const patch of [{surface:{...surface,depth:[z]}},{surface:{...surface,depthTest:'yes'}},{handleIds:[0,x,y,z]}]){
    assert.throws(()=>e.updatePolygon(0,patch),/Depth testing/);assert.deepEqual(e.serialize(),posed);
  }
  for(const kind of ['styk','stkz']){
    const d=(await decodeDocument(await buildContainerV2(posed,kind),kind)).document;
    assert.equal(d.figure_types.find(f=>f.figure_type_id===e.figure.figure_type_id).polyfills[0]._stykSurface.depthTest,true);
  }
  e.undo();e.undo();e.undo();e.undo();assert.deepEqual(e.serialize(),before);e.redo();assert.deepEqual(get(),[2,0,1]);
  const poly=e.figure.polyfills[0],g=e.geometry.objects.get(e.selectedSlot);
  const shifted=structuredClone(poly);remapSurface(shifted,id=>id+100);
  assert.deepEqual(surfaceDepthValues(shifted,new Map([...g.joints].map(([id,p])=>[id+100,p]))),get());
});
