import test from 'node:test';
import assert from 'node:assert/strict';
import {newOwnedEditor} from './support/owned-editor.mjs';
import {construction} from '../src/rig-examples-3d.mjs';
import {createFrame,createObject} from '../src/demo.mjs';
import {buildContainerV2,decodeDocument} from './support/native-files.mjs';
import {geometryOfFrame} from './support/engine-geometry.mjs';
import {rigSections,rigControlChange} from '../src/rig-controls.mjs';
import {renderInspector} from '../src/inspector-kit.mjs';
const rigView=e=>renderInspector({kind:'joint',sections:rigSections(e)});

const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-4,`${a} != ${b}`);
function fixture(angle=.3){
  const q=construction(),driver=q.add(0,100,0,'Projection',{rig:{stretch:{restLength:100,min:0,max:1,width:'keep'}}});
  const follow={orientation:'world',follow:{driver,mode:'stretch',influence:1},response:{multiplier:2}};
  const control=q.add(0,50,angle,'Joint',{control:true,rig:follow});
  const vertex=q.add(control,30,.7,'Attached surface',{rig:{...follow,angleLock:{mode:'parent',reference:control,restAngle:angle,angle:.7,multiplier:1,space:'authored'}}});
  const offset=q.add(vertex,12,0,'Depth offset',{rig:{...follow,angleLock:{mode:'world',angle:0,multiplier:1,space:'authored'}}});
  const f={figure_type_id:1,name:'Projected joint',segments:q.segments,polyfills:q.polyfills,segment_count:q.segments.length,image_assets:[],text_assets:[]};
  const e=newOwnedEditor({demo:false});e.load({version:5,canvas_width:640,canvas_height:480,fps:30,auto_easing:false,auto_easing_disabled_raw:1,backgrounds:[],figure_types:[f],keyframes:[createFrame([createObject(f,1,100,100)])]});
  return {e,driver,control,vertex,offset};
}
const at=(e,id)=>{e.select(1,id-1);return e;};
const shape=(e,id)=>e.geometry.objects.get(0).segments[id-1];

test('angle followers project authored rotation once through positive, collapsed and reversed views',async()=>{
  const {e,driver,control,vertex,offset}=fixture();
  at(e,control).rotateJoint(.6);
  for(const ratio of [1,.75,.5,.499999,0,.5,1]){
    at(e,driver).updateSegment({length:ratio*100});
    const c=shape(e,control),v=shape(e,vertex),z=shape(e,offset),scale=2*ratio-1;
    near(c.end.x-c.start.x,50*Math.cos(.9)*scale);near(c.end.y-c.start.y,50*Math.sin(.9));
    near(v.end.x-v.start.x,30*Math.cos(1.3)*scale);near(v.end.y-v.start.y,30*Math.sin(1.3));
    near(z.end.x-z.start.x,12*scale);near(z.end.y-z.start.y,0);
    const rebuilt=geometryOfFrame(e,e.frame).objects.get(0);
    assert.deepEqual(rebuilt.segments.map(s=>s.end),e.geometry.objects.get(0).segments.map(s=>s.end));
  }
  const decoded=(await decodeDocument(await buildContainerV2(e.serialize(),'styk'),'styk')).document;
  const restored=newOwnedEditor({demo:false});restored.load(decoded);
  for(const id of [control,vertex,offset]){near(shape(restored,id).end.x,shape(e,id).end.x);near(shape(restored,id).end.y,shape(e,id).end.y);}
});

test('fixed-length projected handles remain draggable edge-on and preserve the current bend branch',()=>{
  for(const angle of [.3,Math.PI-.3])for(const ratio of [.5,.5000001,.4999999]){
    const {e,driver,control}=fixture(angle);at(e,driver).updateSegment({length:ratio*100});at(e,control);
    const before=e.serialize(),s=shape(e,control);e.beginDrag();
    for(const noise of [-.01,.01,0])e.poseJoint(s.start.x+noise,s.start.y+40,{snap:false});
    e.commitDrag();near(shape(e,control).end.y-s.start.y,40);
    assert.equal(Math.sign(Math.cos(e.object.angles[control-1])),Math.sign(Math.cos(angle)));
    e.undo();assert.deepEqual(e.serialize(),before);e.redo();near(shape(e,control).end.y-s.start.y,40);
    if(ratio===.5)assert.throws(()=>e.poseJoint(s.start.x,s.start.y+40,{stretch:true}),/fully compressed/);
  }
});

test('projection lock order is editable, undoable and invalid values reject atomically',()=>{
  const {e,driver,vertex}=fixture();at(e,driver).updateSegment({length:25});at(e,vertex);
  assert.match(rigView(e),/rig-lock-space/);
  const before=e.serialize(),angle=shape(e,vertex).angle;
  rigControlChange(e,{id:'rig-lock-space',value:'rendered'});assert.notEqual(shape(e,vertex).angle,angle);
  e.undo();assert.deepEqual(e.serialize(),before);e.redo();
  const rendered=e.serialize();assert.throws(()=>e.setRigBehavior({angleLock:{space:'unknown'}}),/lock space/);assert.deepEqual(e.serialize(),rendered);
});
