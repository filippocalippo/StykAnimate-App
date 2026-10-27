import test from 'node:test';
import assert from 'node:assert/strict';
import {newOwnedEditor} from './support/owned-editor.mjs';
import {construction} from '../src/rig-examples-3d.mjs';
import {createObject,createFrame,emptyDocument} from '../src/demo.mjs';
import {getPivotHandles,pickCanvasHandle} from '../src/canvas-interactions.mjs';
import {rigDetailsShown,setRigDetailsShown,validateControlMetadata} from '../src/rig-control-details.mjs';
import {spatialSections,installSpatialControls} from '../src/spatial-controls.mjs';
import {buildContainerV2,decodeDocument} from './support/native-files.mjs';
import {validateScene} from '../src/pivot/model.mjs';

/** `prepare(document, {main, detail})` changes the document before it opens. */
function fixture(prepare) {
  const q=construction();q.add(0,0,0,'Figure rotation');
  const bone=(name,tip,detail=false)=>{
    const turn=q.add(0,0,0,name+' turn'),pitch=q.add(0,0,0,name+' tilt');
    const id=q.add(0,Math.hypot(...tip),Math.atan2(tip[1],tip[0]),name,{control:true,rig:{spatial:{parent:0,origin:[0,0,0],tip,turn,pitch}}});
    if(detail)q.segments[id-1]._stykControl={level:'detail'};
    return id;
  };
  const main=bone('Whole finger',[30,0,0]),detail=bone('Finger middle joint',[0,30,0],true);
  const figure={figure_type_id:1,segments:q.segments,polyfills:[],image_assets:[],text_assets:[]};
  const document={...emptyDocument(),figure_types:[figure],keyframes:[createFrame([createObject(figure,1,100,100)])]};
  prepare?.(document,{main,detail});
  const editor=newOwnedEditor({demo:false,layerTimeline:false,propertyChannels:false}).load(document);editor.select(1);
  return {editor,main,detail};
}
const handles=(e,extra={})=>getPivotHandles(e.geometry,{selectedUid:e.selectedUid,selectedJoint:e.selectedJoint,...extra});

test('detailed controls are hidden from picking until requested or selected',()=>{
  const {editor:e,main,detail}=fixture(),geometry=e.geometry,descriptorCache={};
  const normal=handles(e,{descriptorCache});
  assert.deepEqual(normal.map(h=>h.id),[0,main]);
  const point=geometry.objects.get(0).joints.get(detail);
  assert.equal(pickCanvasHandle(geometry,point,{handles:normal}),null);
  const all=handles(e,{showDetailed:true,descriptorCache});
  assert.deepEqual(all.map(h=>h.id),[0,main,detail]);
  assert.equal(pickCanvasHandle(geometry,point,{handles:all}).action,'pose');
  assert.deepEqual(handles(e,{descriptorCache}).map(h=>h.id),[0,main],'changing visibility invalidates retained descriptors');
  e.select(1,e.figure.segments.findIndex(s=>s.segment_id===detail));
  assert.ok(handles(e).some(h=>h.id===detail),'a detail selected by name has its own marker');
  assert.ok(handles(e,{builder:true}).some(h=>h.id===detail));
  assert.ok(handles(e,{attaching:true}).some(h=>h.id===detail),'J can reach detailed attachment joints');
});

test('occupied attachment endpoints remain visible when detailed controls are folded',()=>{
  const {editor:e,detail}=fixture((document,{detail})=>{const figure=document.figure_types[0];document.keyframes=[createFrame([createObject(figure,1,100,100),createObject(figure,2,100,100,{join:{target_object_slot:0,target_handle_id:detail}})])];});
  const marker=handles(e).find(h=>h.uid===1&&h.id===detail);
  assert.ok(marker);assert.equal(marker.joined,true);
});

test('detail checkbox changes only editor presentation and all named joints remain selectable',()=>{
  const {editor:e,detail}=fixture(),before=e.serialize(),root=new EventTarget();let refreshed=0;
  installSpatialControls({editor:e,root,refresh:()=>refreshed++,guard:callback=>callback});
  const body=spatialSections(e).find(s=>s.id==='rig-body');
  assert.ok(body.rows.some(row=>row?.html?.includes('spatial-details')));
  const articulation=body.rows.find(row=>row?.kind==='grid').rows[0];
  assert.ok(articulation.options.some(option=>option.value===e.figure.segments.findIndex(s=>s.segment_id===detail)));
  const change=new Event('change');Object.defineProperty(change,'target',{value:{id:'spatial-details',checked:true,type:'checkbox',matches:()=>false}});
  root.dispatchEvent(change);
  assert.equal(rigDetailsShown(e),true);assert.equal(refreshed,1);assert.equal(e._undo.length,0);
  assert.deepEqual(e.serialize(),before);
  const other=fixture().editor;assert.equal(rigDetailsShown(other),false);
  setRigDetailsShown(e,false);assert.equal(rigDetailsShown(e),false);
});

test('detail metadata round trips and malformed controls fail scene validation',async()=>{
  const {editor:e,detail}=fixture(),document=e.serialize();
  const decoded=await decodeDocument(await buildContainerV2(document,'stkz'),'stkz');
  assert.deepEqual(decoded.document.figure_types[0].segments.find(s=>s.segment_id===detail)._stykControl,{level:'detail'});
  for(const value of [null,[],{level:'advanced'},{level:'detail',hidden:true}]){
    assert.throws(()=>validateControlMetadata({_stykControl:value}),/rig/i);
    const invalid=structuredClone(document);invalid.figure_types[0].segments.find(s=>s.segment_id===detail)._stykControl=value;
    assert.throws(()=>validateScene(invalid),/rig/i);
  }
});

test('articulated pose selectors contain named poses and Custom without a visibility option',()=>{
  const {editor:e,main}=fixture((document,{main})=>{document.figure_types[0]._styk={poseChoices:[{name:'Hand pose',choices:[
    {id:1,label:'Open',angles:[[main,0]],lengths:[]},
    {id:2,label:'Point',angles:[[main,.4]],lengths:[]},
  ]}]};});
  const choice=spatialSections(e).find(section=>section.id==='spatial-choices').rows[0].html;
  assert.match(choice,/Hand pose/);assert.match(choice,/Open/);assert.match(choice,/Point/);
  assert.doesNotMatch(choice,/<option value="0"/);
  e.select(1,e.figure.segments.findIndex(s=>s.segment_id===main));e.setSpatialPose({bend:.2});
  assert.match(spatialSections(e).find(section=>section.id==='spatial-choices').rows[0].html,/Custom pose/);
});
