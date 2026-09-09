import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument,createFrame,createObject} from '../src/demo.mjs';
import {validateScene,validateSceneSteps} from '../src/pivot/model.mjs';
import {beginNativePropertyEdit,previewNativePropertyEdit,commitNativePropertyEdit} from '../src/native-property-edit.mjs';

const clone=value=>structuredClone(value);
function fixture(frames=50,objects=80) {
  const report=emptyDocument(),figure=report.figure_types[0];
  report.keyframes=Array.from({length:frames},(_,i)=>createFrame(Array.from({length:objects},(_,j)=>{
    const object=createObject(figure,j+1,i+j,180);
    if(j>0&&j%3===0)object.join={target_object_slot:j-1,target_handle_id:figure.segments[0].segment_id};
    return object;
  }),3));
  return report;
}
function state(editor){return {report:editor.report,token:editor._documentToken,revision:editor.revision,uid:editor._nextUid,frame:editor.frameIndex,undo:editor._undo,redo:editor._redo};}

test('New publishes its starter figure once with clean history and first-edit undo preserves it',()=>{
  const editor=new Editor(),events=[];editor.moveSelection(10,0);
  editor.addEventListener('change',event=>events.push(event.detail.kind));editor.newDocument();
  assert.deepEqual(events,['document']);assert.equal(editor.dirty,false);assert.equal(editor.canUndo,false);assert.equal(editor.canRedo,false);
  assert.equal(editor.frame.objects.length,1);assert.equal(editor.selectedUid,1);assert.equal(editor._nextUid,2);
  const before=clone(editor.frame);editor.moveSelection(25,0);assert(editor.undo());assert.deepEqual(editor.frame,before);assert.equal(editor.canUndo,false);
});

test('cooperative import publishes once with identical validated poses, UID/layer indices and initial frame',async()=>{
  const report=fixture(),editor=new Editor({demo:false}),before=state(editor),events=[];let yields=0;
  editor.addEventListener('change',event=>events.push({kind:event.detail.kind,index:editor.frameIndex,tick:editor.tick}));
  await editor.loadAsync(report,'Imported.piv',{sliceMs:.1,initialFrameIndex:'last',yieldControl:async()=>{
    yields++;assert.deepEqual(state(editor),before);assert.equal(events.length,0);
  }});
  const sync=new Editor({demo:false}).load(clone(report),'Imported.piv',{initialFrameIndex:'last'});
  assert(yields>1);assert.deepEqual(editor.report,sync.report);assert.equal(editor.report,report);
  assert.equal(editor.frameIndex,49);assert.equal(editor.tick,147);assert.equal(editor.selectedUid,1);
  assert.deepEqual(editor._layerUidCounts,sync._layerUidCounts);assert.deepEqual(editor.layers,sync.layers);
  assert.equal(editor._nextUid,81);assert.equal(editor._nextFrameIdentity,51);
  assert.deepEqual(events,[{kind:'document',index:49,tick:147}]);
  assert(editor.lastLoadTimings.slices>1);assert(Number.isFinite(editor.lastLoadTimings.commitMs));
  editor.select(1);editor.moveSelection(4,0);assert(editor.undo());assert.deepEqual(editor.report,sync.report);
});

test('late invalid joins, cameras, styles, backgrounds and retained poses never replace the active document',async()=>{
  const mutations=[
    r=>r.keyframes.at(-1).objects.at(-1).angles[0]=NaN,
    r=>r.keyframes.at(-1).objects.at(-1).join={target_object_slot:999,target_handle_id:1},
    r=>r.keyframes.at(-1).camera={is_default:false,x:0,y:0,scale:0},
    r=>r.keyframes.at(-1).objects.at(-1)._stykStyle={outlineOpacity:NaN},
    r=>r.keyframes.at(-1).background_id=999,
    r=>{const frame=clone(r.keyframes[0]);frame._styk={frameId:'source-1'};frame.objects[0].root_x=Infinity;r._styk={frameSources:{'source-1':frame}};},
  ];
  for(const mutate of mutations){
    const editor=new Editor({demo:false}),before=state(editor),report=fixture();mutate(report);let yields=0;
    await assert.rejects(editor.loadAsync(report,'Invalid',{sliceMs:.1,yieldControl:async()=>{yields++;assert.deepEqual(state(editor),before);}}));
    assert.deepEqual(state(editor),before);assert(yields>0);
  }
});

test('abort, superseded imports and edits preserve active history and never publish staged state',async()=>{
  const editor=new Editor({demo:false}),before=state(editor),controller=new AbortController();let yielded=false;
  await assert.rejects(editor.loadAsync(fixture(),'',{signal:controller.signal,sliceMs:.1,yieldControl:async()=>{yielded=true;controller.abort();}}),{name:'AbortError'});
  assert(yielded);assert.deepEqual(state(editor),before);
  let replaced=false;
  await assert.rejects(editor.loadAsync(fixture(),'',{sliceMs:.1,yieldControl:async()=>{if(!replaced){replaced=true;editor.load(fixture(2,1),'Newer');}}}),{name:'AbortError'});
  assert.equal(editor.name,'Newer');assert.equal(editor.report.keyframes.length,2);
  let edited=false;
  await assert.rejects(editor.loadAsync(fixture(),'',{sliceMs:.1,yieldControl:async()=>{if(!edited){edited=true;editor.select(1);editor.moveSelection(20,0);}}}),{name:'AbortError'});
  assert.equal(editor.frame.objects[0].root_x,20);assert(editor.canUndo);
});

test('validation checkpoints use exactly the synchronous native checks and can close without modifying poses',()=>{
  const report=fixture(),before=clone(report),iterator=validateSceneSteps(report,{sliceMs:0});
  assert.equal(iterator.next().done,false);iterator.return();assert.deepEqual(report,before);assert.equal(validateScene(report),report);
  const corrupt=fixture();corrupt.keyframes.at(-1).camera={is_default:false,x:0,y:0,scale:-1};
  let syncError;try{validateScene(corrupt);}catch(error){syncError=error.message;}
  assert.throws(()=>{for(const _ of validateSceneSteps(corrupt,{sliceMs:0})){};},error=>error.message===syncError);
});

test('Simple Add timing exposes the stored baseline while the working exposure is edited',()=>{
  const editor=new Editor({demo:false}).load(fixture(3,1));editor.enableFrameDrafts();editor.beginFrameDraft({mode:'add',index:0});
  const before=clone(editor.timeline),total=editor.totalTicks;
  const token=beginNativePropertyEdit(editor,'duration');previewNativePropertyEdit(token,20);commitNativePropertyEdit(token);
  assert.equal(editor.frame.duration_raw,20);assert.deepEqual(editor.timeline,before);assert.equal(editor.totalTicks,total);
  editor.discardFrameDraft();assert.equal(editor.frame.duration_raw,3);assert.deepEqual(editor.timeline,before);
});

test('zero-key native imports retain an editable placeholder but expose no stored Simple timeline',async()=>{
  const report=emptyDocument();report.keyframes=[];
  const editor=new Editor({demo:false});await editor.loadAsync(report,'Empty');editor.enableFrameDrafts();
  assert.equal(editor.report.keyframes.length,1);assert.equal(editor.report._styk.simpleFrameDraft.empty,true);
  assert.equal(editor.totalTicks,0);assert.deepEqual(editor.timeline,[]);assert.equal(editor.seek(10),editor.frame);
  assert.doesNotThrow(()=>editor.selectFrame(0));
});
