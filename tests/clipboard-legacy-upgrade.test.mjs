import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument,createObject,createFrame} from '../src/demo.mjs';
import {timeline,evaluatedFrame,buildGeometry} from '../src/pivot/geometry.mjs';
import {validateScene} from '../src/pivot/model.mjs';
import {validateFrameIdentities} from '../src/editor-frames.mjs';
import {planLegacyDestinationUpgrade} from '../src/clipboard-legacy-upgrade.mjs';
import {beginNativePropertyEdit,previewNativePropertyEdit,commitNativePropertyEdit} from '../src/native-property-edit.mjs';

const clone=structuredClone;
function legacy(version=4) {
  const report=emptyDocument();report.version=version;report.frame_delay_ms=40;report.fps=25;
  report.keyframes=[0,100,200].map((x,i)=>createFrame([createObject(report.figure_types[0],4,x,200,{color_override_raw:i?0x0033cc:-1})],[4,0,3][i]));
  report.nativeUnknown={retain:'legacy metadata'};
  return report;
}
function editor() {
  const source=emptyDocument();source.keyframes=[createFrame([createObject(source.figure_types[0],4,700,200)],3),createFrame([createObject(source.figure_types[0],4,750,200)],1)];
  const e=new Editor({demo:false}).load(source);e.copyFrames([0,1]);e.load(legacy());return e;
}
function tickGeometry(report,tick) {
  const rows=timeline(report);let i=0;
  while(i+1<rows.length&&rows[i+1].start<=tick)i++;
  return buildGeometry(report,evaluatedFrame(report,i,rows[i].count?(tick-rows[i].start)/rows[i].count:0,tick));
}
const shapes=geometry=>geometry.drawables.map(shape=>({rgb:shape.rgb,points:shape.points,cx:shape.cx,cy:shape.cy,thickness:shape.thickness}));

test('native legacy hold conversion preserves every output pose, colors and existing frame identity',()=>{
  for(const version of [2,3,4]) {
    const e=new Editor({demo:false}).load(legacy(version)),original=clone(e.report);
    const result=planLegacyDestinationUpgrade(e.report,e._nextFrameIdentity);
    assert.equal(result.report.version,5);assert.deepEqual(result.report.keyframes.map(frame=>frame.duration_raw),[3,1,0,2,1]);
    assert.deepEqual(result.indexes,[0,2,3,5]);
    for(let i=0;i<3;i++)assert.equal(result.report.keyframes[result.indexes[i]]._styk.frameId,e.report.keyframes[i]._styk.frameId);
    for(let tick=0;tick<7;tick++)assert.deepEqual(shapes(tickGeometry(result.report,tick)),shapes(tickGeometry(e.report,tick)),`${version}:${tick}`);
    assert.deepEqual(e.report,original);validateFrameIdentities(result.report);validateScene(result.report);
  }
});

test('paste upgrades the destination in one undo, preserving old ticks and inserted modern motion',()=>{
  const e=editor(),before=clone(e.report),identities=[e._nextFrameIdentity,e._nextUid],history=e._undo.length,token=e._documentToken;
  assert.equal(e.insertClipboardFrames(1),2);assert.equal(e._undo.length,history+1);assert.equal(e._documentToken,token);
  assert.equal(e.report.version,5);assert.deepEqual(e.report.nativeUnknown,before.nativeUnknown);
  assert.deepEqual(e.report.keyframes.map(frame=>frame.duration_raw),[3,1,3,1,0,2,1]);
  for(let tick=0;tick<4;tick++)assert.deepEqual(shapes(tickGeometry(e.report,tick)),shapes(tickGeometry(before,tick)));
  assert.equal(tickGeometry(e.report,4).objects.get(0).obj.root_x,700);
  assert.ok(tickGeometry(e.report,5).objects.get(0).obj.root_x>700);
  for(let tick=4;tick<7;tick++)assert.deepEqual(shapes(tickGeometry(e.report,tick+4)),shapes(tickGeometry(before,tick)));
  const after=clone(e.report);e.undo();assert.deepEqual(e.report,before);assert.deepEqual([e._nextFrameIdentity,e._nextUid],identities);
  e.redo();assert.deepEqual(e.report,after);validateFrameIdentities(e.report);
  assert.ok(!JSON.stringify(e._undo.at(-1)).includes('legacy metadata'),'Full snapshot stays out of history JSON sizing');
});

test('failed upgrade preflight preserves the document, pending gesture, history and counters',()=>{
  const e=editor();e._nextFrameIdentity=Number.MAX_SAFE_INTEGER;
  e.beginTranslationDrag();e.moveSelection(12,0);const drag=e._drag;
  const before=clone(e.report),history=e._undo.length,next=e._nextFrameIdentity;
  assert.throws(()=>e.pasteFrames(),/identity capacity/);
  assert.deepEqual(e.report,before);assert.equal(e._undo.length,history);assert.equal(e._nextFrameIdentity,next);assert.equal(e._drag,drag);assert.equal(drag.changed,true);
});

test('authored channels and retained sources remain editable and motion matches before and after insertion',()=>{
  const e=editor();e.addAnimationKeys([{target:{kind:'figure',uid:4},property:'x',tick:0,value:11},{target:{kind:'figure',uid:4},property:'x',tick:6,value:71}]);
  const before=clone(e.report),oldKeys=e.report._styk.animation.channels[0].keys.map(key=>key.id);
  e.insertClipboardFrames(1);
  assert.ok(oldKeys.every(id=>e.report._styk.animation.channels.some(channel=>channel.keys.some(key=>key.id===id))));
  for(let tick=0;tick<4;tick++)assert.deepEqual(shapes(tickGeometry(e.report,tick)),shapes(tickGeometry(before,tick)),String(tick));
  for(let tick=4;tick<7;tick++)assert.deepEqual(shapes(tickGeometry(e.report,tick+4)),shapes(tickGeometry(before,tick)),String(tick));
  const after=clone(e.report);e.undo();assert.deepEqual(e.report,before);e.redo();assert.deepEqual(e.report,after);
});

test('Simple mode upgrade preserves working-copy colors through stored-frame paste and exact undo',()=>{
  const e=editor();e.enableFrameDrafts();e.beginFrameDraft({mode:'add',index:e.report.keyframes.length-1});
  e.select(4);const edit=beginNativePropertyEdit(e,'root_x');previewNativePropertyEdit(edit,223);commitNativePropertyEdit(edit);
  const before=clone(e.report),draft=clone(e.frameDraft);
  e.editStoredFrames(()=>e.appendClipboardFrames());
  assert.equal(e.report.version,5);assert.equal(e.frameDraft.mode,'add');
  assert.ok(e.frame.objects.every(object=>object.color_override_raw>0xffffff));
  const after=clone(e.report);e.undo();assert.deepEqual(e.report,before);assert.deepEqual(e.frameDraft,draft);
  e.redo();assert.deepEqual(e.report,after);
});



test('zero stored legacy frames upgrade without retaining a placeholder and undo restores the empty working copy',()=>{
  const e=editor(),report=legacy();report.keyframes=[createFrame([])];e.load(report);e.enableFrameDrafts();e.beginFrameDraft({mode:'add',empty:true});
  const before=clone(e.report);
  e.editStoredFrames(()=>e.pasteFrames(0),{preserveWorking:false});
  assert.equal(e.report.version,5);assert.equal(e.report.keyframes.length,2);assert.equal(e.frameDraft.empty,false);assert.equal(e.totalTicks,4);
  const after=clone(e.report);e.undo();assert.deepEqual(e.report,before);assert.equal(e.frameDraft.empty,true);
  e.redo();assert.deepEqual(e.report,after);assert.equal(e.totalTicks,4);
});

test('successful upgrade retains an unfinished authored gesture and its independent Undo step',()=>{
  const e=editor();e.addAnimationKeys([{target:{kind:'figure',uid:4},property:'x',tick:0,value:111}]);e.select(4);
  const initial=clone(e.report),history=e._undo.length;
  const reference=new Editor({demo:false}).load(clone(initial));reference.select(4);
  reference.beginTranslationDrag();reference.moveSelection(35,0);reference.commitDrag();const committed=clone(reference.report);
  reference.undo();const undone=clone(reference.report);
  e.beginTranslationDrag();e.moveSelection(35,0);assert.equal(e.evaluatedFrame.objects[0].root_x,146);
  e.appendClipboardFrames();assert.equal(e._undo.length,history+2);assert.equal(tickGeometry(e.report,0).objects.get(0).obj.root_x,146);
  const after=clone(e.report);e.undo();assert.equal(e.report.version,4);assert.equal(e.evaluatedFrame.objects[0].root_x,146);
  assert.deepEqual(e.report,committed);e.undo();assert.deepEqual(e.report,undone);e.redo();e.redo();assert.deepEqual(e.report,after);
});

test('successful upgrade commits an unfinished shared rig gesture across destination frames',()=>{
  const e=editor();e.select(4,0);const initial=clone(e.report),history=e._undo.length;
  e.beginRigDrag({reposition:false});const segment=e.geometry.objects.get(0).segments[0];
  e.editRigJoint(segment.end.x+20,segment.end.y+13,{reposition:false,stretch:true});
  const preview=clone(e.geometry.objects.get(0).joints);
  e.appendClipboardFrames();assert.equal(e._undo.length,history+2);
  assert.deepEqual(tickGeometry(e.report,0).objects.get(0).joints,preview);
  const after=clone(e.report);e.undo();assert.equal(e.report.version,4);e.undo();assert.deepEqual(e.report,initial);e.redo();e.redo();assert.deepEqual(e.report,after);
});

test('zero stored legacy destination with authored scene channels accepts copied content and exact Undo',()=>{
  const e=editor(),report=legacy();report.keyframes=[createFrame([])];e.load(report);
  e.addAnimationKeys([{target:{kind:'scene'},property:'color',tick:0,value:0xffff0000}]);
  e.enableFrameDrafts();e.beginFrameDraft({mode:'add',empty:true});const before=clone(e.report);
  e.editStoredFrames(()=>e.pasteFrames(0),{preserveWorking:false});
  assert.equal(e.report.version,5);assert.equal(e.report.keyframes.length,2);assert.equal(e.frameDraft.empty,false);
  assert.equal(tickGeometry(e.report,0).objects.size,1);const after=clone(e.report);
  e.undo();assert.deepEqual(e.report,before);e.redo();assert.deepEqual(e.report,after);
});

test('successful upgrade preserves an unfinished authored camera move',()=>{
  const e=editor();e.addAnimationKeys([{target:{kind:'camera'},property:'x',tick:0,value:11}]);
  const history=e._undo.length;e.beginCameraDrag();e.updateCameraDrag({x:13});
  assert.equal(e.evaluatedFrame.camera.x,24);e.appendClipboardFrames();
  assert.equal(e._undo.length,history+2);assert.equal(evaluatedFrame(e.report,0,0,0).camera.x,24);
  const after=clone(e.report);e.undo();assert.equal(e.report.version,4);assert.equal(e.evaluatedFrame.camera.x,24);
  e.undo();assert.equal(e.evaluatedFrame.camera.x,11);e.redo();e.redo();assert.deepEqual(e.report,after);
});

test('failure after a staged native, authored or rig commit preserves live gestures and Redo history',()=>{
  for (const mode of ['native','authored','rig']) {
    const e=editor();e.select(4,0);
    if(mode==='authored')e.addAnimationKeys([{target:{kind:'figure',uid:4},property:'x',tick:0,value:111}]);
    e.moveSelection(3,0);e.undo();e.historyLimit=1;
    if(mode==='rig') {e.beginRigDrag({reposition:false});const end=e.geometry.objects.get(0).segments[0].end;e.editRigJoint(end.x+20,end.y+13,{reposition:false,stretch:true});}
    else {e.beginTranslationDrag();e.moveSelection(35,0);}
    e._frameClipboard[0].objects[0].figure_type_id=999999;
    const before=clone(e.report),drag=e._drag,authored=e._authoredPoseEdit,undo=e._undo,redo=e._redo;
    const history=JSON.stringify([undo,redo]),counters=[e._nextFrameIdentity,e._nextUid,e._revision,e._revisionSerial,e._historySize];
    const sources=[...e._generatedFrameSources];
    assert.throws(()=>e.appendClipboardFrames(),/definition|figure/i,mode);
    assert.deepEqual(e.report,before,mode);assert.equal(e._drag,drag);assert.equal(e._authoredPoseEdit,authored);
    assert.equal(e._undo,undo);assert.equal(e._redo,redo);assert.equal(JSON.stringify([undo,redo]),history);
    assert.deepEqual([e._nextFrameIdentity,e._nextUid,e._revision,e._revisionSerial,e._historySize],counters);
    assert.deepEqual([...e._generatedFrameSources],sources);
  }
});
