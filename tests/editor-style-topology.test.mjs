import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Editor} from '../src/editor.mjs';
import {emptyDocument,createFrame,createObject} from '../src/demo.mjs';
import {resolveInstanceFigure} from '../src/animation-style.mjs';
import {materializePivotDocument} from '../src/pivot-export-materialize.mjs';
import backend from '../desktop/backend.cjs';

const clone=value=>structuredClone(value), target=handleId=>({kind:'segment',uid:1,handleId});
function fixture() {
  const report=emptyDocument(), figure=report.figure_types[0];
  figure.segments=figure.segments.slice(0,3).map((segment,i)=>({...segment,segment_id:[42,600,1000][i],parent_id:[0,42,600][i],
    primitive_code:0,segment_kind:'line',segment_type:'line',length:[80,40,30][i],angle_rad:.3*i,
    ...(i===1?{secondary:{rgb:[40,180,220],a:40}}:{})}));
  report.figure_types.push({...clone(figure),figure_type_id:2});
  report.keyframes=[0,1].map(i=>createFrame([createObject(figure,1,100+i*30,200),createObject(report.figure_types[1],2,400,200)],i?1:4));
  for(const frame of report.keyframes) frame.objects[0]._stykStyle={outlineOpacity:.8,segments:{42:{opacity:.25},600:{opacity:.6,gradientOpacity:.45},1000:{opacity:.9}}};
  const editor=new Editor({demo:false}).load(report);editor.captureFrameSource(editor.frame);
  editor.addAnimationKeys([
    {target:target(42),property:'opacity',tick:0,value:.2},{target:target(42),property:'opacity',tick:4,value:.8},
    {target:target(600),property:'gradientOpacity',tick:0,value:.3},{target:target(600),property:'gradientOpacity',tick:4,value:.7},
    {target:{kind:'segment',uid:2,handleId:42},property:'opacity',tick:0,value:.9},
  ]);editor.select(1,0);return editor;
}
const channel=(editor,id,property='opacity')=>editor.animationChannel(target(id),property);
function styledSegments(editor,tick){editor.seek(tick);editor.select(1);return resolveInstanceFigure(editor.figure,editor.object).segments.map(s=>({length:s.length,transparency:s.transparency,secondary:s.secondary?.a}));}

test('Set Origin keeps authored and captured styles on the same physical sparse segments in one undo',()=>{
  const editor=fixture(), before=editor.serialize(), expected=[0,2,4].map(tick=>styledSegments(editor,tick)), original=clone(channel(editor,42)), history=editor._undo.length;
  editor.setOrigin(600);assert.equal(editor._undo.length,history+1);
  // Native Set Origin reverses the second gradient: endpoint roles swap while
  // their world positions retain the same colors/alpha (covered independently).
  assert.deepEqual([0,2,4].map(tick=>styledSegments(editor,tick)),expected.map(frame=>frame.map((segment,index)=>index===1?
    {...segment,transparency:segment.secondary,secondary:segment.transparency}:segment)));
  assert.deepEqual(channel(editor,600).keys,original.keys);assert.equal(channel(editor,42,'gradientOpacity'),null);
  assert.equal(channel(editor,42).keys[0].value,.3);
  for(const frame of editor._allSourceFrames()){
    const style=frame.objects[0]._stykStyle;assert.deepEqual(style.segments[600],{opacity:.25});assert.deepEqual(style.segments[42],{opacity:.45,gradientOpacity:.6});assert.equal(style.outlineOpacity,.8);
  }
  assert.equal(editor.animationChannel({kind:'segment',uid:2,handleId:42},'opacity').keys[0].value,.9);
  const after=editor.serialize();editor.undo();assert.deepEqual(editor.serialize(),before);editor.redo();assert.deepEqual(editor.serialize(),after);
});

test('Split copies opacity curves and captured style to both pieces with independent key identities',()=>{
  const editor=fixture(), before=editor.serialize(), original=clone(channel(editor,42)), ids=new Set(editor.animationChannels.flatMap(channel=>channel.keys.map(key=>key.id))), history=editor._undo.length;
  editor.splitSegment(.3);const copied=editor.figure.segments[0].segment_id;
  assert.equal(editor._undo.length,history+1);assert.notEqual(copied,42);assert.deepEqual(channel(editor,42),original);
  assert.deepEqual(channel(editor,copied).keys.map(({id,...key})=>key),original.keys.map(({id,...key})=>key));assert.ok(channel(editor,copied).keys.every(key=>!ids.has(key.id)));
  for(const frame of editor._allSourceFrames())assert.deepEqual(frame.objects[0]._stykStyle.segments[copied],{opacity:.25});
  editor.undo();assert.deepEqual(editor.serialize(),before);editor.redo();assert.equal(channel(editor,copied).keys[0].value,.2);
});

test('Branch deletion and replacement definitions remove only deleted physical style targets',()=>{
  for(const operation of['delete','replace']){
    const editor=fixture(), before=editor.serialize(), kept=clone(channel(editor,42));editor.select(1,1);
    if(operation==='delete')editor.deleteSegment();
    else {const definition=clone(editor.figure);definition.segments=definition.segments.filter(segment=>segment.segment_id!==600);definition.segments[1].parent_id=42;editor.replaceFigureDefinition(1,definition);}
    assert.deepEqual(channel(editor,42),kept);assert.equal(channel(editor,600,'gradientOpacity'),null);
    for(const frame of editor._allSourceFrames())assert.equal(frame.objects[0]._stykStyle.segments[600],undefined);
    editor.undo();assert.deepEqual(editor.serialize(),before);
  }
});

test('key capacity failure rolls back changed topology, source styles and channel metadata atomically',()=>{
  const editor=fixture();editor.report._styk.animation.nextKeyId=Number.MAX_SAFE_INTEGER;
  const before=editor.serialize(), history=editor._undo.length, revision=editor.revision;
  assert.throws(()=>editor.splitSegment(),/identity/);assert.deepEqual(editor.serialize(),before);assert.equal(editor._undo.length,history);assert.equal(editor.revision,revision);
});

test('reused identities retain each rig’s continuous physical style curves through remap and later property edits',()=>{
  const editor=fixture();editor.report.keyframes[1].objects[0].figure_type_id=2;
  editor.captureFrameSource(editor.report.keyframes[1]);
  const before=editor.serialize(), history=editor._undo.length,untouched=editor.report.keyframes[1].objects[0],saved=clone(untouched);
  const opacity=clone(channel(editor,42).keys),gradient=clone(channel(editor,600,'gradientOpacity').keys);
  editor.setOrigin(600);assert.equal(editor._undo.length,history+1);assert.equal(editor.report.keyframes[1].objects[0],untouched);assert.deepEqual(untouched,saved);
  const scoped=(handleId,figureTypeId,property='opacity')=>editor.animationChannel({...target(handleId),figureTypeId},property);
  assert.deepEqual(scoped(600,1).keys,opacity);
  assert.deepEqual(scoped(42,2).keys.map(key=>key.value),opacity.map(key=>key.value));
  assert.deepEqual(scoped(42,1).keys,gradient);
  assert.deepEqual(scoped(600,2,'gradientOpacity').keys.map(key=>key.value),gradient.map(key=>key.value));
  for(const frame of editor._allSourceFrames())for(const object of frame.objects)if(object.unique_id===1&&object.figure_type_id===2)assert.deepEqual(object._stykStyle,saved._stykStyle);
  const after=editor.serialize();editor.undo();assert.deepEqual(editor.serialize(),before);editor.redo();assert.deepEqual(editor.serialize(),after);
  editor.seek(4);editor.select(1,0);
  assert.deepEqual(editor.segmentAnimationTarget(1,42,'opacity'),{...target(42),figureTypeId:2});
  const first=clone(scoped(600,1));editor.beginAnimationEdit(target(42),'opacity');editor.previewAnimationEdit(.55);editor.commitAnimationEdit();
  assert.deepEqual(scoped(600,1),first);assert.equal(scoped(42,2).keys.at(-1).value,.55);
  editor.undo();assert.deepEqual(editor.serialize(),after);
  const other=clone(scoped(600,1));editor.setOrigin(600);assert.deepEqual(scoped(600,1),other);
  editor.undo();assert.deepEqual(editor.serialize(),after);
});

for(const operation of ['splitSegment','duplicateSegmentBranch','deleteSegment','unsplitSegment','deleteSingleSegment'])test(`mixed-rig ${operation} changes only its definition and retains other-rig animation and sources`,()=>{
  const editor=fixture();editor.report.keyframes[1].objects[0].figure_type_id=2;editor.captureFrameSource(editor.report.keyframes[1]);
  const before=editor.serialize(),other=editor.report.keyframes[1].objects[0],snapshot=clone(other),history=editor._undo.length;
  editor.select(1,1);editor[operation]();assert.equal(editor._undo.length,history+1);
  assert.equal(editor.report.keyframes[1].objects[0],other);assert.deepEqual(other,snapshot);
  const curve=editor.animationChannel({...target(600),figureTypeId:2},'gradientOpacity');assert.ok(curve);
  assert.deepEqual(curve.keys.map(key=>key.value),[.3,.7]);
  for(const frame of editor._allSourceFrames())for(const object of frame.objects)if(object.unique_id===1&&object.figure_type_id===2)assert.deepEqual(object._stykStyle,snapshot._stykStyle);
  const after=editor.serialize();editor.undo();assert.deepEqual(editor.serialize(),before);editor.redo();assert.deepEqual(editor.serialize(),after);
});

test('mixed-rig remapping retains more-specific curves when legacy and scoped properties overlap',()=>{
  for(const reverse of [false,true]){
    const editor=fixture();editor.report.keyframes[1].objects[0].figure_type_id=2;
    editor.addAnimationKey({...target(42),figureTypeId:1},'opacity',0,.65);
    if(reverse)editor.report._styk.animation.channels.reverse();
    const before=editor.serialize();editor.setOrigin(600);
    assert.equal(editor.animationChannel({...target(600),figureTypeId:1},'opacity').keys[0].value,.65);
    assert.equal(editor.animationChannel({...target(42),figureTypeId:2},'opacity').keys[0].value,.2);
    assert.equal(new Set(editor.animationChannels.map(channel=>channel.id)).size,editor.animationChannels.length);
    editor.undo();assert.deepEqual(editor.serialize(),before);
  }
});

test('retargeted and split style curves survive real native PIV and STYK export/reopen at every tick',()=>{
  const editor=fixture();editor.setOrigin(600);editor.select(1,0);editor.splitSegment(.4);
  const before=editor.serialize(), expected=Array.from({length:editor.totalTicks},(_,tick)=>styledSegments(editor,tick));
  const script=String.raw`
import json,sys
from pathlib import Path
sys.path.insert(0,str(Path('backend').resolve()))
import server
payload=json.load(sys.stdin);store=server.ProjectStore(server.WORKSPACE);out={}
for kind,doc in payload.items():
 raw,name=store.export({'document':doc,'format':kind})
 out[kind]=store.import_bytes(raw,name)['document']
print(json.dumps(out))
`;
  const python=backend.pythonCandidates()[0], result=spawnSync(python.command,[...python.args,'-c',script],{
    cwd:fileURLToPath(new URL('..',import.meta.url)),input:JSON.stringify({styk:before,piv:materializePivotDocument(before)}),encoding:'utf8',windowsHide:true,maxBuffer:8*1024*1024});
  assert.equal(result.status,0,result.error?.message||result.stderr);
  for(const [kind,report]of Object.entries(JSON.parse(result.stdout))){
    const reopened=new Editor({demo:false}).load(report);assert.equal(reopened.totalTicks,expected.length);
    for(let tick=0;tick<expected.length;tick++){
      const actual=styledSegments(reopened,tick);assert.equal(actual.length,expected[tick].length);
      // The native writer emits parent-before-child order. Distinct fixture
      // lengths identify the same physical pieces across that array reorder.
      actual.forEach(segment=>{const saved=expected[tick].find(value=>Math.abs(value.length-segment.length)<1e-4);assert.ok(saved);assert.equal(segment.transparency,saved.transparency,kind);assert.equal(segment.secondary,saved.secondary,kind);});
    }
  }
  assert.deepEqual(editor.serialize(),before);
});
