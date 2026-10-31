import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyDocument,createFrame,createObject} from '../src/demo.mjs';
import {normalizeEditorSettings} from '../src/settings.mjs';
import {OnionController} from '../src/onion-controller.mjs';
import {engineBuilt} from './support/engine-node.mjs';
import {ownedEditor, ownedEditorFor} from './support/owned-editor.mjs';

function fixture({legacy=false}={}){
  const report=emptyDocument();report.keyframes=Array.from({length:12},(_,i)=>createFrame([createObject(report.figure_types[0],1,100+i*10,250)],10));
  const editor=ownedEditorFor({demo:false,layerTimeline:true},report);editor.seek(50);
  let settings=normalizeEditorSettings({onionBefore:2,onionAfter:2,...(!legacy?{onionRangeBefore:20,onionRangeAfter:20}:{})});const commits=[],errors=[];
  const controller=new OnionController({editor,getSettings:()=>settings,getEnabled:()=>true,onCommit:patch=>{commits.push(patch);settings=normalizeEditorSettings({...settings,...patch});},onError:error=>errors.push(error)});
  return {editor,controller,commits,errors,getSettings:()=>settings};
}

/** The same document on the engine, for the tests that count the skins it plans (a layer timeline: the pose per ten ticks is a key). */
async function owned(){
  const report=emptyDocument();report.keyframes=Array.from({length:12},(_,i)=>createFrame([createObject(report.figure_types[0],1,100+i*10,250)],10));
  const {editor,owner}=await ownedEditor({demo:false,layerTimeline:true},report);editor.seek(50);
  let settings=normalizeEditorSettings({onionBefore:2,onionAfter:2,onionRangeBefore:20,onionRangeAfter:20});
  const controller=new OnionController({editor,getSettings:()=>settings,getEnabled:()=>true,onCommit:patch=>{settings=normalizeEditorSettings({...settings,...patch});},onError:error=>{throw error;}});
  /** How many skins the engine plans for what the controller asks. */
  const skins=()=>editor._shown.skins(controller.request({selected:[],hidden:[]})).ghosts.length;
  return {editor,controller,owner,skins,getSettings:()=>settings};
}

test('legacy values adopt paired fixed distances without depending on key spacing',()=>{
  const {controller,commits,getSettings}=fixture({legacy:true}),owner={};
  assert.equal(controller.snapshot().before.span,2);controller.begin(owner);
  controller.preview(owner,{onionRangeBefore:3});
  assert.equal(controller.snapshot().before.span,3);assert.equal(getSettings().onionRangeBefore,null);assert.equal(commits.length,0);
  controller.commit(owner);assert.deepEqual(commits,[{onionRangeBefore:3,onionRangeAfter:2}]);
  controller.change(owner,{onionMode:'frames'});assert.equal(controller.snapshot().before.span,3);assert.equal(controller.snapshot().before.count,3);
  controller.destroy();
});

test('superseded views cannot commit or cancel a newer gesture',()=>{
  const {controller,commits}=fixture(),a={},b={};controller.begin(a);controller.preview(a,{onionRangeBefore:40});controller.begin(b);
  assert.equal(controller.snapshot().before.span,20);controller.preview(b,{onionRangeBefore:25});controller.commit(a);controller.cancel(a);
  assert.equal(controller.snapshot().before.span,25);assert.equal(commits.length,0);controller.commit(b);assert.equal(commits.length,1);controller.destroy();
});

test('seek, document edits, disposal and failed commits leave no preview behind',()=>{
  const {controller,editor,commits,errors}=fixture(),owner={};
  controller.begin(owner);controller.preview(owner,{onionRangeBefore:40});editor.seek(60);controller.commit(owner);assert.equal(commits.length,0);assert.equal(controller.session,null);
  controller.begin(owner);controller.preview(owner,{onionRangeBefore:40});editor.sheetSetDuration(4);controller.commit(owner);assert.equal(commits.length,0);
  controller.onCommit=()=>{throw new Error('Failed setting');};controller.begin(owner);controller.preview(owner,{onionRangeBefore:30});controller.commit(owner);assert.equal(errors.length,1);assert.equal(controller.session,null);
  controller.begin(owner);controller.preview(owner,{onionRangeBefore:30});controller.destroy();assert.equal(controller.session,null);assert.equal(controller.listeners.size,0);
});

test('sampling never rounds the temporal boundary out to a distant key',{skip:!engineBuilt},async()=>{
  const {controller,skins,owner:session}=await owned(),owner={};
  try{
    controller.change(owner,{onionRangeBefore:9,onionRangeAfter:9});assert.equal(skins(),0);
    controller.change(owner,{onionRangeBefore:10});assert.equal(skins(),1);
    controller.change(owner,{onionRangeBefore:11});assert.equal(skins(),1);assert.equal(controller.snapshot().before.endpoint,39);
    controller.change(owner,{onionMode:'frames',onionStep:3,onionRangeBefore:8,onionRangeAfter:0});assert.equal(skins(),2);
  }finally{controller.destroy();session.release();}
});

test('fixed spans and endpoints follow every seek, while only available samples shrink',{skip:!engineBuilt},async()=>{
  const {controller,editor,getSettings,skins,owner:session}=await owned(),owner={};try{
  controller.change(owner,{onionRangeBefore:20,onionRangeAfter:30,onionMode:'frames'});
  const stored=getSettings();
  for(const tick of [50,51,59,0,119]){
    editor.seek(tick);const range=controller.snapshot(),actualTick=editor.tick;
    assert.equal(range.before.span,20);assert.equal(range.after.span,30);
    assert.equal(range.before.endpoint,actualTick-20);assert.equal(range.after.endpoint,actualTick+30);
    assert.equal(range.before.count,Math.min(20,actualTick));assert.equal(range.after.count,Math.min(30,editor.totalTicks-1-actualTick));
    assert.equal(skins(),Math.min(48,range.before.count+range.after.count),'every sample the range reaches, the nearest forty-eight at most');
    assert.equal(getSettings(),stored,'seeking does not write preferences');
  }
  const pending=controller.snapshot(60);assert.equal(pending.before.endpoint,40);assert.equal(pending.after.endpoint,90);
  editor.seek(0);controller.change(owner,{onionRangeBefore:300});assert.equal(controller.snapshot().before.span,300);
  assert.equal(controller.snapshot().before.count,0);editor.seek(50);assert.equal(controller.snapshot().before.span,300);
  }finally{controller.destroy();session.release();}
});

test('legacy adoption is stable through seeks and preserves the untouched side on edge edits',()=>{
  const {controller,editor,commits}=fixture({legacy:true});
  assert.equal(controller.snapshot().before.span,2);assert.equal(controller.snapshot().after.span,2);
  editor.seek(0);assert.equal(controller.snapshot().before.span,2);assert.equal(controller.snapshot().after.span,2);
  controller.change({}, {onionRangeAfter:30});assert.deepEqual(commits,[{onionRangeBefore:2,onionRangeAfter:30}]);
  editor.seek(119);assert.equal(controller.snapshot().after.span,30);assert.equal(controller.snapshot().after.count,0);
  controller.destroy();
});
