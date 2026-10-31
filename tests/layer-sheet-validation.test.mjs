import test from 'node:test';
import assert from 'node:assert/strict';
import {ownedEditorFor} from './support/owned-editor.mjs';
import {emptyDocument,createFrame,createObject} from '../src/demo.mjs';
import {createLayerState} from '../src/layers.mjs';
import {validateLayerSheet} from '../src/layer-sheet.mjs';

function fixture({layers=4,figures=8}={}){
  const report=emptyDocument(),figure=report.figure_types[0],state=createLayerState();
  state.order=Array.from({length:layers},(_,i)=>`layer-${i+1}`);
  state.byId=Object.fromEntries(state.order.map(id=>[id,{name:id,visible:true,locked:false}]));
  state.nextId=layers+1;
  for(let uid=1;uid<=figures;uid++)state.assignments[uid]=state.order[(uid-1)%layers];
  report._styk={...report._styk,layers:state};
  report.keyframes=[0,10,20,30,40].map(tick=>createFrame(Array.from({length:figures},(_,i)=>createObject(figure,i+1,100+tick+i,200)),10));
  return ownedEditorFor({demo:false,layerTimeline:true,propertyChannels:true}, report);
}

test('validation rejects a layer sheet with duplicate, missing or misordered identities',()=>{
  const editor=fixture(),report=editor.report,state=report._styk.layerSheet;
  const candidate=change=>{const sheet={...state,tracks:{...state.tracks,'layer-1':{...state.tracks['layer-1'],keys:state.tracks['layer-1'].keys.map(key=>({...key}))}}};change(sheet);return {...report,_styk:{...report._styk,layerSheet:sheet}};};
  const corruptions=[
    sheet=>{sheet.tracks['layer-1'].keys[0].id=state.tracks['layer-2'].keys[0].id;},
    sheet=>{sheet.nextId=1;},
    sheet=>{delete sheet.tracks.camera;},
    sheet=>{sheet.tracks['layer-1'].end=sheet.duration+1;},
    sheet=>{sheet.tracks['layer-1'].keys.reverse();},
    sheet=>{delete sheet.tracks['layer-1'].keys[0].sourceTick;sheet.tracks['layer-1'].keys[0].value={frameId:'missing'};},
  ];
  for(const corrupt of corruptions){
    const invalid=candidate(corrupt);
    assert.throws(()=>validateLayerSheet(invalid));
    assert.equal(validateLayerSheet(report),report);
  }
  editor.drawingResources.dispose();
});
