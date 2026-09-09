import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {beginNativePropertyEdit,previewNativePropertyEdit,commitNativePropertyEdit,cancelNativePropertyEdit} from '../src/native-property-edit.mjs';
function fixture(){const editor=new Editor({demo:false});editor.addFigure();editor.select(editor.selectedUid,2);editor._undo=[];editor._redo=[];editor.markSaved();return editor;}
test('branch numeric thickness previews only cached descendants with sparse definition history',()=>{
 const e=fixture(),f=e.figure,before=structuredClone(f.segments),frame=e.frame,objects=e.frame.objects;
 const asset={pixels:'M'.repeat(2_000_000)};f.image_assets=[asset];
 const token=beginNativePropertyEdit(e,'thickness',{branch:true});assert.deepEqual(token.branchStyle.segmentIndices,[2,3]);
 for(let i=0;i<60;i++)previewNativePropertyEdit(token,i);
 assert.equal(e._undo.length,0);assert.equal(f.segments[2].thickness,59);assert.equal(f.segments[3].thickness,59);
 assert.equal(e.frame,frame);assert.equal(e.frame.objects,objects);assert.equal(f.image_assets[0],asset);
 assert.ok(commitNativePropertyEdit(token));assert.equal(e._undo.length,1);assert.equal(e._undo[0].kind,'native-properties');assert.equal(e._undo[0].scope,'figure');assert.ok(e._undo[0].bytes<4000);
 for(const i of [0,1,4,5,6,7,8,9])assert.deepEqual(f.segments[i],before[i]);
 e.undo();assert.deepEqual(e.figure.segments,before);e.redo();assert.equal(e.figure.segments[3].thickness,59);
});
test('entering selected original width still applies absolute width to heterogeneous branch children',()=>{
 const e=fixture(),old=e.figure.segments.map(s=>s.thickness),token=beginNativePropertyEdit(e,'thickness',{branch:true});
 assert.notEqual(old[2],old[3]);assert.ok(previewNativePropertyEdit(token,old[2]));assert.ok(commitNativePropertyEdit(token));
 assert.equal(e.figure.segments[3].thickness,old[2]);e.undo();assert.deepEqual(e.figure.segments.map(s=>s.thickness),old);
});
test('branch Cancel restores every original width/visibility and single field editing remains local',()=>{
 const e=fixture(),before=structuredClone(e.figure.segments);delete e.figure.segments[3].visible;delete before[3].visible;
 const token=beginNativePropertyEdit(e,'thickness',{branch:true});previewNativePropertyEdit(token,0);assert.equal(e.figure.segments[3].visible,false);
 assert.throws(()=>previewNativePropertyEdit(token,NaN),/finite/);cancelNativePropertyEdit(token);assert.deepEqual(e.figure.segments,before);assert.equal(e._undo.length,0);
 const local=beginNativePropertyEdit(e,'thickness');previewNativePropertyEdit(local,31);commitNativePropertyEdit(local);assert.equal(e.figure.segments[2].thickness,31);assert.equal(e.figure.segments[3].thickness,before[3].thickness);
});
