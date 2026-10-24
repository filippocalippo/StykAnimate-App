// Actual native options:true lifecycle, preserving the immutable Session returns oracle.
// External Session fixtures are shared prerequisites; no options or expectations are normalized.
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=process.cwd(),out=path.resolve('engine/tests/edit');
const {open}=await import(pathToFileURL(path.resolve(root,'engine/tools/fixture-kit.mjs')).href);
const {sampleAnimationChannel}=await import(pathToFileURL(path.resolve(root,'src/animation-channels.mjs')).href);
const source=path.resolve('engine/tests/session-live');
const returnSource=path.resolve('engine/tests/session-live-return');
const json=value=>JSON.stringify(value,(key,item)=>key==='runtime_segments'?undefined:item);
Object.defineProperty(performance,'now',{value:()=>0,configurable:true});
const plain=(value,depth=4)=>{
  if(value===null||['number','string','boolean'].includes(typeof value))return value;
  if(value instanceof Set)return plain([...value],depth);
  if(typeof value!=='object'||depth<=0)return undefined;
  if(Array.isArray(value))return value.map(v=>plain(v,depth-1)).filter(v=>v!==undefined);
  return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,plain(v,depth-1)]).filter(([,v])=>v!==undefined));
};
const entry=c=>({kind:c.kind,label:c.label,bytes:c.bytes,...(c.commands?{children:c.commands.map(entry)}:{})});
const names=readdirSync(source).filter(n=>n.startsWith('native-channels-')&&n.endsWith('.json')&&!n.includes('preflight')).sort();
assert.equal(names.length,8);
const traces=[];let calls=0,registrationsCount=0;
for(const file of names){
  const bytes=readFileSync(path.join(source,file)),reference=JSON.parse(bytes),returnBytes=readFileSync(path.join(returnSource,file));
  const returnReference=JSON.parse(returnBytes);
  assert.deepEqual(reference.options,{propertyChannels:true});
  const editor=open(JSON.parse(reference.steps[0].document),reference.options);
  const events=[],ids=new WeakMap(),registrations=[];let nextIdentity=1;
  let document=reference.steps[0].document,frame=reference.steps[0].frame;const nativeRows=json(editor.report.keyframes);
  const identity=v=>{if(!v||typeof v!=='object')return null;if(!ids.has(v))ids.set(v,nextIdentity++);return ids.get(v);};
  editor.addEventListener('change',event=>events.push(plain(event.detail)));
  const register=editor._registerFrameSources;
  const sourceHeads=owner=>({nextFrameIdentity:owner._nextFrameIdentity,generated:[...owner._generatedFrameSources],
    tablePresent:Object.hasOwn(owner.report._styk,'frameSources'),tableJSON:json(owner.report._styk.frameSources),
    tableWasPresent:owner._sourceTableWasPresent,uidCounts:[...owner._layerUidCounts].sort(([a],[b])=>a-b),
    pendingBytes:owner._pendingSourceBytes,pendingLayerChangesJSON:json(owner._pendingSourceLayerChanges)});
  editor._registerFrameSources=function(frames){
    const before=sourceHeads(this),framesJSON=json(frames),result=register.call(this,frames);
    registrations.push({framesJSON,resultDefined:result!==undefined,...(result!==undefined?{resultJSON:json(result)}:{}),before,after:sourceHeads(this)});
    return result;
  };
  const states=[],returns=[];
  const capture=(expected,result,error)=>{
    const evaluated=editor.evaluatedFrame,display=(editor._drag?.motionPath?editor._drag.display?.frame:null)??evaluated;
    document=expected.document??document;frame=expected.frame??frame;
    assert.equal(json(editor.report),document,`${file}: ${expected.call?.[0]} document`);
    assert.equal(json(editor.report.keyframes),nativeRows,`${file}: imported native rows changed`);
    assert.equal(json(display),frame,`${file}: ${expected.call?.[0]} frame`);
    assert.deepEqual(error,expected.error,`${file}: error`);
    assert.deepEqual(plain(result??null),expected.result,`${file}: original result`);
    const state={tick:editor.tick,frameIndex:editor.frameIndex,selectedUid:editor.selectedUid??null,selectedUids:[...editor.selectedUids],
      selectedJoint:editor.selectedJoint??-1,canUndo:editor.canUndo,canRedo:editor.canRedo,undoLabel:editor.undoLabel,redoLabel:editor.redoLabel,
      dirty:editor.dirty,layerRevision:editor.layerRevision,nextFrameIdentity:editor._nextFrameIdentity,nextUid:editor._nextUid};
    const history={size:editor.historySize,undo:editor._undo.map(entry),redo:editor._redo.map(entry),
      revision:editor.revision,revisionSerial:editor._revisionSerial,savedRevision:editor._savedRevision};
    const live={drag:Boolean(editor._drag),authored:Boolean(editor._authoredPoseEdit),animationEdit:Boolean(editor._animationEdit),
      changed:Boolean(editor._drag?.changed||editor._animationEdit?.changed),
      identities:{report:identity(editor.report),animation:identity(editor.report._styk?.animation),sheet:identity(editor.report._styk?.layerSheet),
        nativeFrame:identity(editor.report.keyframes[editor.frameIndex]),authoredFrame:identity(editor._authoredPoseEdit?.frame),
        evaluatedFrame:identity(evaluated),displayFrame:identity(display)}};
    assert.deepEqual(state,expected.state,`${file}: state`);assert.deepEqual(history,expected.history,`${file}: history`);
    assert.deepEqual(editor._selectionState(),expected.selection,`${file}: selection`);
    assert.deepEqual(live,expected.live,`${file}: live/COW identity`);assert.deepEqual(events,expected.events,`${file}: events`);
    const authored=editor._authoredPoseEdit,animationEdit=editor._animationEdit;
    states.push({step:states.length,call:expected.call,documentJSON:json(editor.report),evaluatedJSON:json(evaluated),displayJSON:json(display),
      selectionJSON:json(editor._selectionState()),state,historyJSON:json({undo:editor._undo,redo:editor._redo}),history,
      events:structuredClone(events),live,sources:{...sourceHeads(editor),
        authored:authored?{tick:authored.tick,owned:[...authored.owned],sourceJSON:json(authored.source),frameJSON:json(authored.frame)}:null,
        animationEdit:animationEdit?{tick:animationEdit.tick,target:animationEdit.target,property:animationEdit.property,
          beforeJSON:json(animationEdit.before),beforeChannelJSON:json(animationEdit.beforeChannel),previewJSON:json(animationEdit.preview),
          exactTarget:animationEdit.exactTarget,initialValue:animationEdit.initialValue,selectionJSON:json(animationEdit.selection),changed:animationEdit.changed}:null,
        registrations:structuredClone(registrations)}});
    registrationsCount+=registrations.length;events.length=0;registrations.length=0;
  };
  capture(reference.steps[0],null,null);
  for(const expected of reference.steps.slice(1)){
    let result,error=null;
    try{result=await editor[expected.call[0]](...expected.call.slice(1));}
    catch(caught){error={message:caught.message,key:caught.messageKey??null,name:caught.name};}
    returns.push({call:expected.call,resultDefined:result!==undefined,...(result!==undefined?{resultJSON:json(result)}:{}),error});
    capture(expected,result,error);calls++;
  }
  assert.deepEqual(returns,returnReference.steps,`${file}: complete frozen returns`);
  const trace={name:reference.name,options:reference.options,calls:returns.length,returns,states};traces.push(trace);

}
assert.equal(calls,93);
writeFileSync(path.join(out,'native-transform-projection-live-oracle.json'),json(traces)+'\n');
console.log(`${traces.length} native propertyChannels:true tapes / ${calls} calls / ${traces.reduce((sum,trace)=>sum+trace.states.length,0)} full states / ${registrationsCount} source registrations generated.`);
