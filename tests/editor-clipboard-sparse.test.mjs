import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument,defaultFigure,createFrame,createObject} from '../src/demo.mjs';
import {createImageFigure,createImageBackground} from '../src/media-authoring.mjs';
import {validateScene} from '../src/pivot/model.mjs';
import {validateAnimationDocument} from '../src/animation-channels.mjs';
import {validateFrameIdentities} from '../src/editor-frames.mjs';
import {validateLayerState} from '../src/layers.mjs';
import {prepareSparseClipboardPaste,prepareOwnedSparseClipboardPaste,commitSparseClipboardPaste} from '../src/editor-clipboard-sparse.mjs';

const clone=structuredClone;
const dataUrl='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHk8AAAAASUVORK5CYII=';
function sourceDocument(count=4) {
  const report=emptyDocument(),figure=report.figure_types[0],sprite=createImageFigure({dataUrl,width:1,height:1,name:'Copied sprite'});
  sprite.figure_type_id=8;report.figure_types.push(sprite);
  report.backgrounds=[createImageBackground({dataUrl,width:1,height:1,name:'Copied background',backgroundId:7}),
    {background_id:9,kind:2,color:0xff003399,name:'Copied color'}];
  report.keyframes=Array.from({length:count},(_,index)=>{
    const parent=createObject(figure,12,index*20,220),child=createObject(sprite,3,0,0,
      {join:{target_object_slot:0,target_handle_id:1,target_unique_id:12,target_figure_type_id:1}});
    const frame=createFrame([parent,child],index===1?0:index+2);
    return {...frame,background_id:7,background_id_b:9,background_mix:97,object_draw_order:[1,0],
      object_draw_order_unique_ids:[3,12],native_unknown:{sentinel:729}};
  });
  return report;
}
function destinationDocument() {
  const report=emptyDocument();report.figure_types[0].segments[0].length=37;report.figure_types.push(defaultFigure(8));
  report.backgrounds=[{background_id:7,kind:2,color:0xffddccbb,name:'Destination'}];
  report.keyframes=[0,1,2].map(index=>createFrame([createObject(report.figure_types[0],3,450+index*20,200),
    createObject(report.figure_types[1],12,20,30)],5));
  const retained=clone(report.keyframes[0]);retained._styk={frameId:'retained-destination'};
  report._styk.frameSources={'retained-destination':retained};return report;
}
function fixture({sameDocument=false,frameCount=4}={}) {
  const reference=new Editor({demo:false}).load(sourceDocument(frameCount));
  const hidden=reference.createLayer('Hidden source');reference.assignFiguresToLayer([3],hidden.id);
  reference.setLayerVisible(hidden.id,false);reference.setLayerLocked(hidden.id,true);
  reference.copyFrames(reference.report.keyframes.map((_,index)=>index));
  if(!sameDocument)reference.load(destinationDocument());
  const before=clone(reference.report),editor=new Editor({demo:false}).load(clone(before));
  const index=1;reference.pasteFrames(index);const command=reference._undo.at(-1);
  assert.equal(command.kind,'splice');assert.ok(command.clipboardAssets);
  const wire={index,frames:clone(command.after),assets:clone(command.clipboardAssets),afterSelection:clone(command.afterSelection),
    nextFrameIdentity:reference._nextFrameIdentity,nextUid:reference._nextUid};
  return {editor,wire,before,expected:clone(reference.report),expectedSerialized:reference.serialize(),reference};
}
function state(editor) {
  return {report:editor.report,document:clone(editor.report),frames:editor.report.keyframes,definitions:editor.report.figure_types,
    backgrounds:editor.report.backgrounds,layers:editor.report._styk.layers,clipboard:editor._frameClipboard,
    token:editor._documentToken,revision:editor.revision,identity:editor._nextFrameIdentity,uid:editor._nextUid,
    selection:editor._selectionState(),undo:editor._undo,redo:editor._redo,
    undoValues:JSON.stringify(editor._undo),redoValues:JSON.stringify(editor._redo)};
}
function unchanged(editor,before) {assert.deepEqual(state(editor),before);}
function guard(editor) {
  const report=editor.report,revision=editor.revision,frame=editor.frameIndex,tick=editor.tick;
  return ()=>{if(editor.report!==report||editor.revision!==revision||editor.frameIndex!==frame||editor.tick!==tick)
    throw new DOMException('The document changed while staging clipboard frames.','AbortError');};
}
function validate(editor) {
  validateScene(editor.report);validateAnimationDocument(editor.report);validateLayerState(editor.report._styk.layers);validateFrameIdentities(editor.report);
}

test('sparse native paste matches the sync asset/join/layer plan while keeping all existing destination references',async()=>{
  const {editor,wire,expected,expectedSerialized}=fixture(),before=state(editor),frames=editor.report.keyframes.slice(),objects=frames.map(frame=>frame.objects),
    figures=editor.report.figure_types.slice(),backgrounds=editor.report.backgrounds.slice(),retained=editor.report._styk.frameSources,
    layer=editor.report._styk.layers.byId['layer-1'];let yields=0,edits=0;const progress=[];
  editor.addEventListener('change',event=>{if(event.detail.kind==='edit')edits++;});
  const prepared=await prepareSparseClipboardPaste(editor,wire,{checkCurrent:guard(editor),onProgress:value=>progress.push(value),
    yieldControl:async()=>{yields++;unchanged(editor,before);}});
  unchanged(editor,before);assert.ok(yields>0);assert.ok(progress.length>0);
  assert.equal(commitSparseClipboardPaste(editor,prepared),wire.frames.length);validate(editor);
  assert.equal(edits,1);assert.equal(editor._undo.length,1);assert.equal(editor.report,before.report);assert.deepEqual(editor.report,expected);
  assert.deepEqual(editor.serialize(),expectedSerialized);
  for(const [index,frame]of frames.entries()) {
    const actual=editor.report.keyframes[index<wire.index?index:index+wire.frames.length];assert.equal(actual,frame);assert.equal(actual.objects,objects[index]);
  }
  figures.forEach((figure,index)=>assert.equal(editor.report.figure_types[index],figure));
  backgrounds.forEach((background,index)=>assert.equal(editor.report.backgrounds[index],background));
  assert.equal(editor.report._styk.frameSources,retained);assert.equal(editor.report._styk.layers.byId['layer-1'],layer);
  assert.equal(editor._documentToken,before.token);assert.equal(editor._nextFrameIdentity,wire.nextFrameIdentity);assert.equal(editor._nextUid,wire.nextUid);
  assert.deepEqual(editor._selectionState(),wire.afterSelection);
  assert.notEqual(editor.report.keyframes[wire.index],wire.frames[0]);
  assert.notEqual(editor.report.figure_types[wire.assets.figureIndex],wire.assets.figures[0]);
  assert.ok(!JSON.stringify(editor._undo[0]).includes(dataUrl),'Media remains outside synchronous history serialization');
  assert.ok(editor._undo[0].bytes>dataUrl.length*2,'Sparse history still accounts for retained media');
});

test('same-document sparse insertion keeps UID continuity, shared assets, hidden exposures and exact undo',async()=>{
  const {editor,wire,before,expected}=fixture({sameDocument:true}),frames=editor.report.keyframes.slice(),definitions=editor.report.figure_types.slice();
  assert.equal(wire.assets.figures.length,0);assert.equal(wire.assets.backgrounds.length,0);assert.equal(wire.assets.layers.additions.length,0);
  const prepared=await prepareSparseClipboardPaste(editor,wire);commitSparseClipboardPaste(editor,prepared);
  assert.deepEqual(editor.report,expected);assert.deepEqual(editor.report.keyframes.slice(1,5).map(frame=>frame.duration_raw),[2,0,4,5]);
  assert.deepEqual(editor.report.keyframes[1].objects.map(object=>object.unique_id),[12,3]);
  definitions.forEach((figure,index)=>assert.equal(editor.report.figure_types[index],figure));
  editor.undo();assert.deepEqual(editor.report,before);frames.forEach((frame,index)=>assert.equal(editor.report.keyframes[index],frame));
  editor.redo();assert.deepEqual(editor.report,expected);validate(editor);
});

test('later pose and shared-rig edits cannot alias sparse clipboard undo or redo snapshots',async()=>{
  const {editor,wire,before,expected}=fixture(),wireBefore=clone(wire),oldFrames=editor.report.keyframes.slice();
  commitSparseClipboardPaste(editor,await prepareSparseClipboardPaste(editor,wire));
  const command=editor._undo.at(-1),historyValue=JSON.stringify(command),inserted=editor.report.keyframes[wire.index],uid=inserted.objects[0].unique_id;
  editor.select(uid,0);editor.moveSelection(19,-11);assert.deepEqual(wire,wireBefore);assert.equal(JSON.stringify(command),historyValue);
  editor.undo();assert.deepEqual(editor.report,expected);
  editor.select(uid,0);const definition=clone(editor.figure);definition.segments[0].length+=25;
  editor.replaceFigureDefinition(definition.figure_type_id,definition);assert.deepEqual(wire,wireBefore);assert.equal(JSON.stringify(command),historyValue);
  editor.undo();assert.deepEqual(editor.report,expected);editor.undo();assert.deepEqual(editor.report,before);
  oldFrames.forEach((frame,index)=>assert.equal(editor.report.keyframes[index],frame));
  editor.redo();assert.deepEqual(editor.report,expected);validate(editor);
});

test('invalid native frames, asset tables, layer patches, positions and counters reject atomically',async()=>{
  const mutations=[
    wire=>{wire.index=-1;},wire=>{wire.index=1.5;},wire=>{wire.index=999;},
    wire=>{wire.frames[0].objects[0].root_x=NaN;},wire=>{wire.frames[0].objects[0].figure_type_id=9999;},
    wire=>{wire.frames[0].objects[0]._stykStyle={segments:{1:{opacity:2}}};},
    wire=>{wire.frames[0].duration_raw=-1;},wire=>{wire.frames[0].camera={is_default:false,x:0,y:0,scale:0,angle_rad:0};},
    wire=>{wire.frames[0]._styk.frameId='frame-1';},wire=>{wire.frames[1]._styk.frameId=wire.frames[0]._styk.frameId;},
    wire=>{wire.assets.figureIndex=0;},wire=>{wire.assets.backgroundIndex=0;},
    wire=>{wire.assets.figures[0].figure_type_id=1;},wire=>{wire.assets.figures[0].segments[0].length=Infinity;},
    wire=>{wire.assets.backgrounds[0].background_id=7;},
    wire=>{wire.assets.backgrounds.push({...clone(wire.assets.backgrounds[0]),background_id:7});},
    wire=>{wire.assets.layers.assignments[0].after='missing-layer';},
    wire=>{wire.assets.layers.beforeNextId++;},wire=>{wire.assets.layers.orderIndex=-1;},
    wire=>{wire.afterSelection.frameIndex=NaN;},wire=>{wire.nextFrameIdentity=1;},wire=>{wire.nextUid=0;},
  ];
  for(const mutate of mutations) {
    const {editor,wire}=fixture(),before=state(editor);mutate(wire);
    await assert.rejects(prepareSparseClipboardPaste(editor,wire),undefined,`Plan mutation must reject: ${mutate}`);unchanged(editor,before);
  }
});

test('cancellation before, during and after preparation never publishes sparse assets, frames or identifiers',async()=>{
  for(const phase of ['before','during','after']) {
    const {editor,wire}=fixture({frameCount:8}),before=state(editor),controller=new AbortController();let yields=0;
    if(phase==='before')controller.abort();
    const pending=prepareSparseClipboardPaste(editor,wire,{signal:controller.signal,yieldControl:async()=>{
      yields++;if(phase==='during')controller.abort();
    }});
    if(phase==='after') {
      const prepared=await pending;controller.abort();assert.throws(()=>commitSparseClipboardPaste(editor,prepared),{name:'AbortError'});
    } else await assert.rejects(pending,{name:'AbortError'});
    if(phase!=='before')assert.ok(yields>0);unchanged(editor,before);
  }
});

test('external edits during staging and between prepare/commit supersede the plan without replacing newer state',async()=>{
  for(const timing of ['during','after']) {
    const {editor,wire}=fixture({frameCount:8});editor.select(3);let newer,checks=0;
    const current=guard(editor),checkCurrent=()=>{checks++;current();};
    const pending=prepareSparseClipboardPaste(editor,wire,{checkCurrent,yieldControl:async()=>{
      if(timing==='during'&&!newer){editor.moveSelection(6,0);newer=state(editor);}
    }});
    if(timing==='after') {
      const prepared=await pending;editor.selectFrame(2);newer=state(editor);
      assert.throws(()=>commitSparseClipboardPaste(editor,prepared),{name:'AbortError'});
    } else await assert.rejects(pending,{name:'AbortError'});
    assert.ok(checks>1);unchanged(editor,newer);
  }
});

test('native metadata validation yields before rejecting a late cyclic figure definition',async t=>{
  const {editor,wire}=fixture(),before=state(editor);const segments=wire.assets.figures[0].segments;
  segments.at(-1).parent_id=segments.at(-1).segment_id;
  let clock=0,yields=0;t.mock.method(performance,'now',()=>clock+=8);
  await assert.rejects(prepareSparseClipboardPaste(editor,wire,{yieldControl:async()=>{yields++;unchanged(editor,before);}}),/parent|cycle/i);
  assert.ok(yields>0,'Authoritative asset validation must respect cooperative checkpoints');unchanged(editor,before);
});

test('preparing and committing a native paste never traverses or serializes an unrelated full-report payload',async()=>{
  const {editor,wire}=fixture(),report=editor.report,frames=report.keyframes.slice();let traversals=0;
  const unrelated={};Object.defineProperty(unrelated,'payload',{enumerable:true,get(){traversals++;throw new Error('Full report payload must not be traversed');}});
  report._stykSource=unrelated;
  editor.serialize=()=>{throw new Error('Sparse clipboard must not serialize the destination document');};
  const prepared=await prepareSparseClipboardPaste(editor,wire);assert.equal(commitSparseClipboardPaste(editor,prepared),wire.frames.length);
  assert.equal(editor.report,report);assert.equal(report._stykSource,unrelated);assert.equal(traversals,0);
  assert.doesNotThrow(()=>JSON.stringify(editor._undo.at(-1)));
  editor.undo();frames.forEach((frame,index)=>assert.equal(editor.report.keyframes[index],frame));
  editor.redo();assert.equal(editor.report._stykSource,unrelated);assert.equal(traversals,0);
});

test('native sparse paste retains permanent Scene and Camera track selection through undo',async()=>{
  for(const id of ['scene','camera']){
    const {editor,wire}=fixture();editor.setActiveLayer(id);wire.afterSelection.activeLayerId=id;
    const before=editor.serialize();commitSparseClipboardPaste(editor,await prepareSparseClipboardPaste(editor,wire));
    assert.equal(editor.activeLayerId,id);editor.undo();assert.deepEqual(editor.serialize(),before);
    editor.redo();assert.equal(editor.activeLayerId,id);
  }
});

test('private worker result adoption keeps independent live poses and reusable immutable history',async()=>{
  const {editor,wire,before,expected}=fixture(),owned=clone(wire),snapshot=clone(owned);
  const prepared=await prepareOwnedSparseClipboardPaste(editor,owned);commitSparseClipboardPaste(editor,prepared);
  const command=editor._undo.at(-1);assert.equal(command.after,owned.frames);assert.equal(command.clipboardAssets,owned.assets);
  assert.notEqual(editor.frame,owned.frames[0]);assert.notEqual(editor.frame.objects[0],owned.frames[0].objects[0]);
  editor.select(editor.frame.objects[0].unique_id,0);editor.rotateFigure(.3);assert.deepEqual(owned,snapshot);
  editor.undo();assert.deepEqual(editor.report,expected);editor.undo();assert.deepEqual(editor.report,before);
  editor.redo();assert.deepEqual(editor.report,expected);assert.deepEqual(owned,snapshot);
});
