import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {cameraValues} from '../src/editor-camera.mjs';
const make=()=>{const e=new Editor({demo:false,layerTimeline:true,propertyChannels:true});e.addFigure();return e;};

test('default camera previews before commit, supports cancellation, and uses one undo',()=>{
 const e=make(),before=e.serialize(),n=e._undo.length;
 e.beginCameraDrag();e.updateCameraDrag({x:45,scale:.8});
 assert.equal(cameraValues(e.evaluatedFrame.camera).x,45);assert.equal(e.evaluatedFrame.camera.is_default,false);assert.equal(e._undo.length,n);
 e.cancelCameraDrag();assert.deepEqual(e.serialize(),before);
 e.beginCameraDrag();e.updateCameraDrag({angle_rad:.4});e.commitCameraDrag();assert.equal(e._undo.length,n+1);assert.equal(e.evaluatedFrame.camera.angle_rad,.4);
 e.undo();assert.deepEqual(e.serialize(),before);
});
test('new keys after a layer ends carry the last pose while explicit blanks stay blank',()=>{
 const e=make(),uid=e.selectedUid;e.updateObject({root_x:123});const end=e.totalTicks;
 e.sheetInsertKey(['layer-1'],end+3);e.seek(end+3);assert.equal(e.evaluatedFrame.objects.find(o=>o.unique_id===uid).root_x,123);
 e.sheetInsertKey(['layer-1'],end+4,{blank:true});e.seek(end+4);assert.equal(e.evaluatedFrame.objects.length,0);
});
test('duplicate after current shifts later keys and preserves selection, pose and atomic undo',()=>{
 const e=make(),uid=e.selectedUid;e.updateObject({root_x:123});e.sheetInsertKey(['layer-1'],1);e.seek(1);e.updateObject({root_x:456});e.seek(0);
 const before=e.serialize(),n=e._undo.length;e.sheetDuplicateFrameAfter();assert.equal(e.tick,1);
 assert.equal(e.evaluatedFrame.objects.find(o=>o.unique_id===uid).root_x,123);assert.equal(e._undo.length,n+1);
 e.seek(2);assert.equal(e.evaluatedFrame.objects.find(o=>o.unique_id===uid).root_x,456);
 e.undo();assert.deepEqual(e.serialize(),before);assert.equal(e.tick,0);e.redo();assert.equal(e.tick,1);
});
test('append at the empty playhead beyond the movie carries the final pose',()=>{
 const e=make(),uid=e.selectedUid;e.updateObject({root_x:42});e.seek(e.totalTicks+5,{allowBeyondEnd:true});e.sheetAppendFrame();
 assert.equal(e.evaluatedFrame.objects.find(o=>o.unique_id===uid).root_x,42);
});
