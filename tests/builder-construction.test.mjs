import test from 'node:test';
import assert from 'node:assert/strict';
import {builderFixture} from '../scripts/builder-benchmark-fixture.mjs';
import {ConstructionIndex,strokeSegments} from '../src/builder-construction.mjs';
import {validateScene} from '../src/pivot/model.mjs';
import {ownedEditorFor} from './support/owned-editor.mjs';
test('chain append is atomic and independent of later edits',()=>{
 const e = ownedEditorFor(undefined, builderFixture(100));e.select(1,10);
 const before=JSON.stringify(e.serialize()),count=e._undo.length;
 const parts=e.addSegments(strokeSegments([{x:0,y:0},{x:50,y:0},{x:50,y:30},{x:20,y:30}],2));
 assert.equal(e._undo.length,count+1);assert.equal(parts.length,3);assert.equal(parts[0].parent_id,11);assert.equal(parts[1].parent_id,parts[0].segment_id);
 assert.equal(parts[0].length,25);validateScene(e.report);
 const after=JSON.stringify(e.serialize());e.select(1,0);e.updateSegmentStyle({thickness:99});e.undo();e.undo();assert.equal(JSON.stringify(e.serialize()),before);
 e.redo();assert.equal(JSON.stringify(e.serialize()),after);e.redo();assert.equal(e.figure.segments[0].thickness,99);
});
test('invalid chain does not partially create anything',()=>{const e = ownedEditorFor(undefined, builderFixture(10));e.select(1,0);const before=JSON.stringify(e.serialize());assert.throws(()=>e.addSegments([{length:20},{length:NaN}]));assert.equal(JSON.stringify(e.serialize()),before);});
test('snapping prioritizes joints, supports midpoint and bypass, excludes moved handles',()=>{
 const g={joints:new Map([[0,{x:0,y:0}],[1,{x:100,y:0}]]),segments:[{seg:{segment_id:1},start:{x:0,y:0},end:{x:100,y:0}}]};
 const i=new ConstructionIndex(g);assert.equal(i.snap({x:99,y:2}).kind,'Joint');assert.equal(i.snap({x:49,y:1}).kind,'Midpoint');assert.equal(i.snap({x:100,y:50}).kind,'Align');assert.deepEqual(i.snap({x:99,y:2},{disabled:true}),{x:99,y:2});assert.equal(new ConstructionIndex(g,new Set([1])).nearest({x:100,y:0},8),null);
});
test('reflected scale maps chain world endpoints to native directions',()=>{const [s]=strokeSegments([{x:0,y:0},{x:20,y:0}],-2);assert.equal(s.length,10);assert.equal(s.angle,-Math.PI);assert.throws(()=>strokeSegments([{x:0,y:0},{x:1,y:1}],0));});

test('new chain round-trips and undo removes the complete new figure',()=>{
 const e=ownedEditorFor({demo:false});e.select(null);const before=JSON.stringify(e.serialize());
 e.addSegments(strokeSegments([{x:110,y:100},{x:160,y:100},{x:160,y:140}]));
 assert.equal(e.figure.segments.length,2);const saved=e.serialize();
 const restored=ownedEditorFor({demo:false},saved);restored.select(e.selectedUid);
 assert.equal(restored.figure.segments[1].parent_id,1);assert.equal(restored.object.root_x,110);assert.equal(restored.object.angles.length,2);
 e.undo();assert.equal(JSON.stringify(e.serialize()),before);e.redo();assert.equal(JSON.stringify(e.serialize()),JSON.stringify(saved));
});
