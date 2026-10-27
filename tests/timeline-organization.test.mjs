import test from 'node:test';
import assert from 'node:assert/strict';
import {organizeTimelineRows} from '../src/timeline-organization.mjs';
import {newOwnedEditor} from './support/owned-editor.mjs';
import {emptyDocument} from '../src/demo.mjs';
import {validateLayerState} from '../src/layers.mjs';

test('layer filtering preserves fixed tracks, source order and source objects',()=>{
  const rows=[{id:'camera',kind:'camera',name:'Camera'},{id:'scene',kind:'scene',name:'Scene'},
    ...Array.from({length:10000},(_,i)=>({id:`layer-${i+1}`,kind:'layer',name:`Character ${i}`}))];
  const filtered=organizeTimelineRows(rows,'CHARACTER 999',new Set(['layer-1000','layer-10000']));
  assert.deepEqual(filtered.map(row=>row.id),['camera','scene','layer-1000','layer-10000']);
  assert.equal(filtered.at(-1),rows.at(-1));assert.equal(rows.length,10002);
});
test('layer colors serialize, undo atomically and do not modify keys or poses',()=>{
  const e=newOwnedEditor({demo:false,layerTimeline:true}).load(emptyDocument());
  e.createLayer('Foreground');const before=e.serialize(),keys=e.report._styk.layerSheet.tracks;
  e.setLayerColor(['layer-1','layer-2'],'violet');
  assert.equal(e.getLayer('layer-1').color,'violet');assert.equal(e.getLayer('layer-2').color,'violet');
  assert.equal(e.report._styk.layerSheet.tracks['layer-1'],keys['layer-1']);
  const restored=newOwnedEditor({demo:false,layerTimeline:true}).load(e.serialize());
  assert.equal(restored.getLayer('layer-2').color,'violet');
  e.undo();assert.deepEqual(e.serialize(),before);e.redo();assert.equal(e.getLayer('layer-1').color,'violet');
  e.setLayerColor(['layer-1'],null);assert.equal(e.getLayer('layer-1').color,undefined);
  assert.throws(()=>e.setLayerColor(['layer-1','missing'],'blue'));assert.equal(e.getLayer('layer-1').color,undefined);
  const bad=structuredClone(e.report._styk.layers);bad.byId['layer-1'].color='invalid';assert.throws(()=>validateLayerState(bad));
});
