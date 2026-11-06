import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument,createFrame,createObject} from '../src/demo.mjs';
import {movieclipFigure} from '../src/movieclips.mjs';
import {validateLayerSheet} from '../src/layer-sheet.mjs';
import {ownedScope} from './support/owned-scope.mjs';

const open = ownedScope();

function fixture() {
  const report=emptyDocument(),figure=report.figure_types[0],source=emptyDocument();
  source.keyframes=[createFrame([createObject(source.figure_types[0],1,100,100)],3)];
  const clip=movieclipFigure(2,'Reusable motion',source,{duration:3});
  report.figure_types.push(clip);
  report.keyframes=[createFrame([createObject(figure,1,100,100),createObject(figure,2,200,100)],20)];
  const e=open({demo:false,layerTimeline:true}, report);
  const second=e.createLayer('Second').id;e.assignFiguresToLayer([2],second);
  e.sheetInsertKey(['layer-1',second],0);
  e.sheetSetDuration(20,'layer-1',0);e.sheetSetDuration(20,second,0);
  const third=e.createLayer('Empty').id;e.sheetInsertKey([third],0,{blank:true});
  e.reorderLayers([third,second,'layer-1']);
  return {e,third,second,figure:figure.figure_type_id,clip:clip.figure_type_id};
}
for(const kind of ['figure','clip'])for(const tick of [0,5,19])test(`${kind} insertion at ${tick} owns the empty active layer after slot normalization`,()=>{
  const f=fixture(),{e,third,second}=f;e.seek(tick);e.selectSheetLayer(third);
  // Other layers must not be rewritten merely because their slots are sorted.
  const untouched=[e.report._styk.layerSheet.tracks['layer-1'],e.report._styk.layerSheet.tracks[second]];
  e.setLayerLocked(second,true);const before=e.serialize();e.addFigure(f[kind]);const uid=e.selectedUid;
  assert.equal(e.layerForUid(uid),third);e.seek(tick);
  assert.ok(e.evaluatedFrame.objects.some(o=>o.unique_id===uid));
  assert.equal(e.report._styk.layerSheet.tracks['layer-1'],untouched[0]);
  assert.equal(e.report._styk.layerSheet.tracks[second],untouched[1]);
  assert.equal(e.report._styk.layerSheet.tracks[third].keys.at(-1).empty,false);
  validateLayerSheet(e.report);const after=e.serialize();e.undo();assert.deepEqual(e.serialize(),before);e.redo();assert.deepEqual(e.serialize(),after);
  const reopened=open({demo:false,layerTimeline:true},after);reopened.seek(tick);
  assert.equal(reopened.layerForUid(uid),third);assert.ok(reopened.evaluatedFrame.objects.some(o=>o.unique_id===uid));
});
test('duplicate ownership hints win over the active layer and survive history',()=>{
  const {e,third,second}=fixture();e.select(2);e.setActiveLayer(third);const before=e.serialize();
  const copy=e.duplicateFigure();assert.equal(e.layerForUid(copy.unique_id),second);
  const after=e.serialize();e.undo();assert.deepEqual(e.serialize(),before);e.redo();assert.deepEqual(e.serialize(),after);
});
test('new figures use the default user layer when a permanent track is active',()=>{
  const {e,figure}=fixture();e.setActiveLayer('camera');e.addFigure(figure);
  assert.equal(e.layerForUid(e.selectedUid),'layer-1');
});
test('a locked insertion destination rejects the complete edit',()=>{
  const {e,third,clip}=fixture();e.setLayerLocked(third,true);const before=e.serialize();
  assert.throws(()=>e.addFigure(clip),/Unlock/);assert.deepEqual(e.serialize(),before);
});
