import test from 'node:test';
import assert from 'node:assert/strict';
import {copyBuilderAppearance,pasteBuilderAppearance,builderStrokeAppearance,setBuilderStroke} from '../src/builder-appearance.mjs';
import {segmentBranchIndices} from '../src/pivot/structure.mjs';
import {ownedEditorFor} from './support/owned-editor.mjs';
const fixture=()=>{const e=ownedEditorFor({demo:false,layerTimeline:true});e.addFigure();e.select(e.selectedUid,2);e.updateSegmentStyle({paint:{type:'linear',angle:30,stops:[{offset:0,color:[220,30,90],opacity:.6},{offset:1,color:[20,70,230],opacity:.3}]},thickness:21});return e;};
test('appearance clipboard is a detached snapshot; paste preserves geometry and undo/redo',()=>{
 const e=fixture(),clip=copyBuilderAppearance(e),original=structuredClone(clip),count=e._undo.length;
 assert.equal(e._undo.length,count);e.select(e.selectedUid,4);
 const geometry=e.figure.segments.map(s=>[s.segment_id,s.parent_id,s.length,s.angle_rad,s.primitive_code,s.z_order]);
 const before=JSON.stringify(e.serialize()),history=e._undo.length;
 assert.equal(pasteBuilderAppearance(e,clip),true);assert.equal(e._undo.length,history+1);
 assert.deepEqual(copyBuilderAppearance(e),clip);assert.deepEqual(e.figure.segments.map(s=>[s.segment_id,s.parent_id,s.length,s.angle_rad,s.primitive_code,s.z_order]),geometry);
 const after=JSON.stringify(e.serialize());e.undo();assert.equal(JSON.stringify(e.serialize()),before);e.redo();assert.equal(JSON.stringify(e.serialize()),after);
 e.updateSegmentStyle({color:'#000000'});assert.deepEqual(clip,original);
});
test('branch paste styles descendants, while explicit multi-selection targets only its joints',()=>{
 const e=fixture(),clip=copyBuilderAppearance(e);e.select(e.selectedUid,0);
 const indices=segmentBranchIndices(e.figure.segments,e.figure.segments[0].segment_id);assert.ok(indices.length>1);
 pasteBuilderAppearance(e,clip,{branch:true});for(const index of indices){e.select(e.selectedUid,index);assert.deepEqual(copyBuilderAppearance(e),clip);}
 const thickness=()=>e.figure.segments.map((_,i)=>{e.select(e.selectedUid,i);return copyBuilderAppearance(e).thickness;});
 e.undo();const before=thickness();e.select(e.selectedUid,0);e.toggleSegment(e.selectedUid,4);
 pasteBuilderAppearance(e,clip,{branch:true});
 thickness().forEach((value,i)=>assert.equal(value,[0,4].includes(i)?21:before[i]));
});
test('preview snapshots match inherited width at reflected scale and have a zero-width guide',()=>{
 const e=fixture();e.object.scale=-2;
 const appearance=builderStrokeAppearance(e);assert.equal(appearance.width,42);assert.equal(appearance.color,'rgb(220,30,90)');
 const ctx={setLineDash(dash){this.dash=dash;}};setBuilderStroke(ctx,appearance,1.5);assert.equal(ctx.lineWidth,63);assert.deepEqual(ctx.dash,[]);
 setBuilderStroke(ctx,{width:0,color:'black'},2);assert.equal(ctx.lineWidth,1);assert.ok(ctx.dash.length);
 e.select(e.selectedUid,-1);assert.equal(copyBuilderAppearance(e),null);assert.equal(pasteBuilderAppearance(e,null),false);
});
