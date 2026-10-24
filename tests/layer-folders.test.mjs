import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument} from '../src/demo.mjs';
import {layerFolderRows} from '../src/layer-folders.mjs';
import {organizeTimelineRows} from '../src/timeline-organization.mjs';
import {sheetRowLayout} from '../src/timeline-rows.mjs';
import {runTimelineHotkey} from '../src/timeline-hotkeys.mjs';
import {roundTrip} from './support/codec.mjs';

function editor() { const e = new Editor({demo:false,layerTimeline:true}).load(emptyDocument()); for(const name of ['Floor','Drawing','Scene 2'])e.createLayer(name); return e; }
test('keyboard layer navigation skips folder headers and never selects folder cells', () => {
  const selected=[], timeline={tracks:[{id:'scene',kind:'scene'},{id:'layer-1',kind:'layer'},{id:'folder-1',kind:'folder'},{id:'layer-2',kind:'layer'}],selectedTrackId:'layer-2',editor:{tick:5},_run:fn=>fn(),_selectCell:hit=>selected.push(hit),revealPlayhead(){}};
  runTimelineHotkey(timeline,'timeline-layer-up');assert.deepEqual(selected.pop(),{row:1,tick:5});
  timeline.selectedTrackId='layer-1';runTimelineHotkey(timeline,'timeline-layer-down');assert.deepEqual(selected.pop(),{row:3,tick:5});
});
test('inserting layers inside folders and moving layers into a folder keep the stack contiguous', () => {
  const e=editor(), folder=e.createLayerFolder('Shot',['layer-1','layer-2']);
  const inserted=e.createLayer('Prop',{index:1});assert.equal(inserted.folderId,folder.id);
  e.moveLayersToFolder(['layer-4'],folder.id);
  assert.deepEqual(e.report._styk.layers.order,['layer-1',inserted.id,'layer-2','layer-4','layer-3']);
  const before=e.serialize();e.undo();e.redo();assert.deepEqual(e.serialize(),before);
});
test('folder grouping saves and undoes together without creating pose tracks or changing artwork', () => {
  const e=editor(), before=e.serialize(), sources=e.report._styk.layerSheet.tracks, frames=e.report.keyframes;
  const folder=e.createLayerFolder('Scene 1',['layer-1','layer-3']);
  assert.deepEqual(e.report._styk.layers.order,['layer-2','layer-1','layer-3','layer-4']);
  assert.deepEqual(Object.keys(e.report._styk.layerSheet.tracks),Object.keys(sources));
  for(const id of Object.keys(sources))assert.equal(e.report._styk.layerSheet.tracks[id],sources[id]);
  assert.equal(e.report.keyframes,frames);
  const copy=new Editor({demo:false,layerTimeline:true}).load(e.serialize());
  assert.equal(copy.getLayer('layer-3').folderId,folder.id);
  assert.equal(copy.getLayerFolders()[0].name,'Scene 1');
  e.undo();assert.deepEqual(e.serialize(),before);e.redo();assert.equal(e.getLayer('layer-1').folderId,folder.id);
});
test('moving, renaming and ungrouping folders retain layers and undo their metadata', () => {
  const e=editor(), f=e.createLayerFolder('First',['layer-1','layer-2']);
  e.renameLayerFolder(f.id,'Shot');assert.equal(e.getLayerFolders()[0].name,'Shot');
  e.moveLayersToFolder(['layer-3'],f.id);assert.equal(e.getLayer('layer-3').folderId,f.id);
  e.moveLayersToFolder(['layer-2']);assert.equal(e.getLayer('layer-2').folderId,undefined);
  const before=e.serialize();e.deleteLayerFolder(f.id);assert.equal(e.getLayerFolders().length,0);assert.equal(e.layers.filter(l=>l.kind==='layer').length,4);
  e.undo();assert.deepEqual(e.serialize(),before);
  e.deleteLayer('layer-1');assert.equal(e.getLayerFolders().length,1);e.undo();assert.equal(e.getLayer('layer-1').folderId,f.id);
});
test('arranging layers restacks them and changes their folder in one undo step', () => {
  const e=editor(), folder=e.createLayerFolder('Shot',['layer-1','layer-2']), start=e.serialize(), steps=e._undo.length;
  // Into the folder, between its layers.
  e.arrangeLayers(['layer-1','layer-4','layer-2','layer-3'],['layer-4'],folder.id);
  assert.deepEqual(e.report._styk.layers.order,['layer-1','layer-4','layer-2','layer-3']);assert.equal(e.getLayer('layer-4').folderId,folder.id);
  assert.equal(e._undo.length,steps+1);e.undo();assert.deepEqual(e.serialize(),start);e.redo();
  // Out of the folder, to the front; the folder's own layers move as a block without a folder change.
  e.arrangeLayers(['layer-1','layer-2','layer-3','layer-4'],['layer-4'],null);
  assert.equal(e.getLayer('layer-4').folderId,undefined);assert.deepEqual(e.report._styk.layers.order,['layer-1','layer-2','layer-3','layer-4']);
  e.arrangeLayers(['layer-3','layer-4','layer-1','layer-2'],['layer-1','layer-2']);
  assert.deepEqual(e.report._styk.layers.order,['layer-3','layer-4','layer-1','layer-2']);assert.equal(e.getLayer('layer-1').folderId,folder.id);
  // A stack that would split a folder keeps its layers together; an unchanged one records nothing.
  e.arrangeLayers(['layer-1','layer-3','layer-2','layer-4']);
  const order=e.report._styk.layers.order;assert.equal(Math.abs(order.indexOf('layer-1')-order.indexOf('layer-2')),1);
  const count=e._undo.length;assert.equal(e.arrangeLayers(order),false);assert.equal(e._undo.length,count);
  assert.throws(()=>e.arrangeLayers(['layer-1','layer-2','layer-3']));assert.throws(()=>e.arrangeLayers(order,['layer-3'],'folder-9'));assert.equal(e._undo.length,count);
});
test('the pinned rows leave room for three content rows before they scroll with them', () => {
  const rows=lanes=>[{kind:'camera'},...Array.from({length:lanes},()=>({kind:'motion'})),{kind:'scene'},{kind:'layer'}];
  assert.equal(sheetRowLayout(rows(2),{viewport:240}).pinned,true);
  assert.equal(sheetRowLayout(rows(3),{viewport:240}).pinned,false);
  assert.equal(sheetRowLayout(rows(8),{viewport:640}).pinned,true,'Half of a tall grid still pins');
});
test('collapse and folder search preserve visibility and fixed row geometry', () => {
  const e=editor(), f=e.createLayerFolder('Scene 1',['layer-1','layer-2']), before=e.serialize();
  const content=e.layers.filter(l=>l.kind==='layer').reverse();
  const collapsed=layerFolderRows(content,e.report._styk.layers,new Set([f.id]));
  assert.equal(collapsed.some(row=>row.id==='layer-1'),false);
  assert.deepEqual(e.serialize(),before);
  const expanded=layerFolderRows(content,e.report._styk.layers);
  assert.deepEqual(organizeTimelineRows(expanded,'scene 1').map(row=>row.id),[f.id,'layer-2','layer-1']);
  assert.deepEqual(organizeTimelineRows(expanded,'',new Set(['layer-1'])).map(row=>row.id),[f.id,'layer-1']);
  const layout=sheetRowLayout([e.getLayer('camera'),e.getLayer('scene'),...collapsed]);assert.equal(layout.system,2);
});
test('bad folder references reject loading atomically and invalid operations leave history alone', () => {
  const e=editor(), before=e.serialize();
  assert.throws(()=>e.createLayerFolder('Shot',['camera']));assert.throws(()=>e.moveLayersToFolder(['layer-1'],'missing'));assert.deepEqual(e.serialize(),before);
  const bad=e.serialize();bad._styk.layers.byId['layer-1'].folderId='missing';assert.throws(()=>e.load(bad));assert.deepEqual(e.serialize(),before);
  const f=e.createLayerFolder('Empty');assert.equal(layerFolderRows(e.layers.filter(l=>l.kind==='layer').reverse(),e.report._styk.layers)[0].id,f.id);
  e.moveLayersToFolder(['layer-1','layer-2'],f.id);const grouped=e.serialize(),scattered=e.serialize();
  scattered._styk.layers.order=['layer-1','layer-3','layer-2','layer-4'];assert.throws(()=>e.load(scattered));assert.deepEqual(e.serialize(),grouped);
});
test('native STYK export and import retain folder membership and layer order', async () => {
  const e=editor(), folder=e.createLayerFolder('Shot',['layer-1','layer-2']), document=e.serialize();
  const restored=new Editor({demo:false,layerTimeline:true}).load(await roundTrip({document,format:'styk'}));
  assert.deepEqual(restored.report._styk.layers,document._styk.layers);
  assert.equal(restored.getLayer('layer-1').folderId,folder.id);
});
