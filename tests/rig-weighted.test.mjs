import test from 'node:test';
import assert from 'node:assert/strict';
import {newOwnedEditor} from './support/owned-editor.mjs';
import {rigExampleDocument} from '../src/rig-examples.mjs';
import {rigSections,rigControlChange} from '../src/rig-controls.mjs';
import {renderInspector} from '../src/inspector-kit.mjs';
const rigView=e=>renderInspector({kind:'joint',sections:rigSections(e)});
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-4,`${a} != ${b}`);
function fixture(){const e=newOwnedEditor({demo:false});e.load(rigExampleDocument('sliding-carriage'));e.select(1,0);return e;}
function check(e,id,origin,anchors){const g=e.geometry.objects.get(0),o=g.joints.get(origin),p=g.joints.get(id);for(const c of ['x','y'])near(p[c],o[c]+anchors.reduce((n,a)=>n+(g.joints.get(a.joint)[c]-o[c])*a.weight,0));}

test('weighted creation and inspector edits are undoable; invalid dependencies cannot change the document',()=>{
 const e=fixture(),before=e.serialize(),s=e.addWeightedJoint(0,[{joint:1,weight:.5}]);
 e.undo();assert.deepEqual(e.serialize(),before);e.redo();e.select(1,e.figure.segments.findIndex(v=>v.segment_id===s.segment_id));
 assert.match(rigView(e),/Weighted joint/);
 rigControlChange(e,{id:'rig-weighted-weight-0',valueAsNumber:.75});check(e,s.segment_id,0,[{joint:1,weight:.75}]);
 e.undo();check(e,s.segment_id,0,[{joint:1,weight:.5}]);
 const stable=e.serialize();
 for(const weighted of [{origin:999},{anchors:[]},{anchors:[{joint:s.segment_id,weight:1}]},{anchors:[{joint:1,weight:Infinity}]},{anchors:[{joint:1,weight:1},{joint:1,weight:0}]},{anchors:Array.from({length:17},(_,i)=>({joint:i,weight:0}))}]){
  assert.throws(()=>e.setRigBehavior({weighted}));assert.deepEqual(e.serialize(),stable);
 }
 assert.equal(e.poseJoint(20,40),false);assert.equal(e.beginRigDrag(),false);
 e.select(1,0);assert.throws(()=>e.deleteSingleSegment(),/missing|relationship|itself/);assert.deepEqual(e.serialize(),stable);
});
