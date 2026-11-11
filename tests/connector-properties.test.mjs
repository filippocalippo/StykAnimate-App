import test from 'node:test';
import assert from 'node:assert/strict';
import {rigExampleDocument} from '../src/rig-examples.mjs';
import {inspectorView} from '../src/inspector-view.mjs';
import {getPivotHandles} from '../src/canvas-interactions.mjs';
import {drawConnectorGuides} from '../src/rig-controls.mjs';
import {ownedEditorFor} from './support/owned-editor.mjs';

for(const builder of [false,true])test(`connector slider exposes position/static but no appearance (${builder?'Builder':'Animate'})`,()=>{
  const e = ownedEditorFor({demo:false}, rigExampleDocument('sliding-carriage'));e.select(1,2);
  const before=e.serialize(),slider=inspectorView({editor:e,builder});
  assert.match(slider,/id="rig-position"/);assert.match(slider,/id="static-joint"/);
  assert.doesNotMatch(slider,/id="segment-color"|id="segment-shape"|data-field="(?:thickness|joint_angle|joint_bend)"|Appearance/);
  e._connectorInspector={uid:1,id:3,part:'segment'};const segment=inspectorView({editor:e,builder});
  assert.match(segment,/id="segment-color"/);assert.match(segment,/data-field="thickness"/);assert.doesNotMatch(segment,/id="rig-position"|id="static-joint"|data-field="joint_angle"/);
  assert.deepEqual(e.serialize(),before,'Property navigation is not document state');
  const colors=e.figure.segments.map(s=>s.color_rgb);e.setConnectorPosition(.27);assert.deepEqual(e.figure.segments.map(s=>s.color_rgb),colors);
  e.undo();assert.deepEqual(e.serialize(),before);
  e.select(1,0);assert.match(inspectorView({editor:e,builder}),/id="segment-color"/,'Anchor segment keeps its own real artwork settings');
});

test('slider handles keep their configured size at both endpoints and guides connect A, slider, B',()=>{
  const e = ownedEditorFor({demo:false}, rigExampleDocument('sliding-carriage'));e.select(1,2);
  for(const position of [0,.5,1]){
    e.setConnectorPosition(position);
    const h=getPivotHandles(e.geometry,{selectedUid:1,maxDiameter:12}).find(h=>h.id===3);
    assert.equal(h.connector,true);assert.equal(h.screenRadius,6);
    const calls=[],ctx=new Proxy({}, {get:(_,key)=>(...args)=>calls.push([key,...args]),set:()=>true});
    const s=e.geometry.objects.get(e.selectedSlot).segments[2];
    drawConnectorGuides(ctx,e.geometry,e,p=>p);
    assert.deepEqual(calls.filter(c=>c[0]==='moveTo'||c[0]==='lineTo'),[['moveTo',s.start.x,s.start.y],['lineTo',s.handle.x,s.handle.y],['lineTo',s.end.x,s.end.y]]);
    assert.deepEqual(calls.find(c=>c[0]==='setLineDash'),['setLineDash',[2,4]]);
  }
});
