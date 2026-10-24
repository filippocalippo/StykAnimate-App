import test from 'node:test';
import assert from 'node:assert/strict';
import {construction} from '../src/rig-examples-3d.mjs';
import {Editor} from '../src/editor.mjs';
import {createObject,createFrame,emptyDocument,defaultFigure} from '../src/demo.mjs';
import {rigConstraintPlan,remapRigReferences} from '../src/rig-constraints.mjs';
import {buildContainerV2,decodeDocument} from './support/native-files.mjs';
import {rigSections,rigControlChange} from '../src/rig-controls.mjs';
import {renderInspector} from '../src/inspector-kit.mjs';
const rigView=e=>renderInspector({kind:'joint',sections:rigSections(e)});
const nearAngle=(a,b)=>assert.ok(Math.abs(Math.atan2(Math.sin(a-b),Math.cos(a-b)))<1e-5,`${a} != ${b}`);
function fixture(){
 const q=construction();q.add(0,0,0,'Figure orientation');
 const a=q.add(0,40,0,'First rotation',{control:true}),b=q.add(0,60,0,'Second rotation',{control:true});
 const c=q.add(a,30,.2,'Combined rotation',{rig:{angleLock:{mode:'parent',reference:a,restAngle:0,figureRestAngle:0,angle:.2,multiplier:1,space:'authored',secondary:{reference:b,restAngle:0,multiplier:-1}}}});
 const figure={figure_type_id:1,segments:q.segments,polyfills:[],image_assets:[],text_assets:[]},torso=defaultFigure(2),e=new Editor({demo:false});
 e.load({...emptyDocument(),figure_types:[figure,torso],keyframes:[createFrame([createObject(figure,1,200,200),createObject(torso,2,350,350)])]});
 return{e,a,b,c,select:id=>e.select(1,id-1)};
}
test('two native rotations compose through whole turns and attached torso transformations',()=>{
 const {e,a,b,c,select}=fixture();
 for(let first=-360;first<=360;first+=45)for(let second=-360;second<=360;second+=45){
  select(a);e.updateSegment({angle_rad:first*Math.PI/180});select(b);e.updateSegment({angle_rad:second*Math.PI/180});
  nearAngle(e.geometry.objects.get(0).segments[c-1].angle,.2+(first-second)*Math.PI/180);
 }
 e.select(1,-1);e.joinTo(2,1);const before=e.geometry.objects.get(0).segments[c-1].angle;
 e.select(2,0);e.rotateJoint(.8);e.select(2,-1);e.scaleSelection(2);e.moveSelection(30,-15);
 nearAngle(e.geometry.objects.get(0).segments[c-1].angle,before+.8);
});
test('second references are validated, cached by value, remapped and saved natively',async()=>{
 const {e,a,b,c,select}=fixture();select(c);const original=e.serialize(),plan=rigConstraintPlan(e.figure);
 for(const secondary of [{reference:999,restAngle:0,multiplier:1},{reference:c,restAngle:0,multiplier:1},{reference:b,restAngle:NaN,multiplier:1},{reference:b,restAngle:0,multiplier:Infinity}]){
  assert.throws(()=>e.setRigBehavior({angleLock:{secondary}}));assert.deepEqual(e.serialize(),original);
 }
 assert.throws(()=>e.setRigBehavior({angleLock:{mode:'world'}}),/second angle reference/);
 const lock=e.figure.segments[c-1]._stykRig.angleLock;lock.secondary.restAngle=.2;
 assert.notEqual(rigConstraintPlan(e.figure),plan);nearAngle(e.geometry.objects.get(0).segments[c-1].angle,.4);
 const segment=structuredClone(e.figure.segments[c-1]);remapRigReferences(segment,new Map([[a,a+10],[b,b+10]]));
 assert.equal(segment._stykRig.angleLock.reference,a+10);assert.equal(segment._stykRig.angleLock.secondary.reference,b+10);assert.equal(lock.secondary.reference,b);
 for(const kind of ['styk','stkz']){const decoded=(await decodeDocument(await buildContainerV2(e.serialize(),kind),kind)).document;assert.deepEqual(decoded.figure_types[0].segments[c-1]._stykRig.angleLock.secondary,lock.secondary);}
});
test('normal inspector edits add, tune and remove the second rotation with undo',()=>{
 const {e,a,b,c,select}=fixture();select(c);e.setRigBehavior({angleLock:{secondary:null}});const before=e.serialize();
 rigControlChange(e,{id:'rig-lock-secondary',valueAsNumber:b});assert.match(rigView(e),/Second rotation/);
 rigControlChange(e,{id:'rig-lock-secondary-multiplier',valueAsNumber:2});select(b);e.rotateJoint(.3);nearAngle(e.geometry.objects.get(0).segments[c-1].angle,.8);
 e.undo();e.undo();e.undo();assert.deepEqual(e.serialize(),before);
 select(c);e.setSecondaryAngleReference(a);e.setAngleLock('figure');assert.equal(e.figure.segments[c-1]._stykRig.angleLock.secondary,null);
});
