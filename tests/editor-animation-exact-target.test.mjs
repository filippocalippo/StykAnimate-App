import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument,defaultFigure,createFrame,createObject} from '../src/demo.mjs';
import {animationChannelId} from '../src/animation-channels.mjs';
const global={kind:'segment',uid:7,handleId:1},a={...global,figureTypeId:1},b={...global,figureTypeId:2};
function fixture(){
  const report=emptyDocument();report.figure_types.push(defaultFigure(2));
  report.keyframes=[1,2,1].map((id,index)=>createFrame([createObject(report.figure_types[id-1],7,120,180)],index===2?1:5));
  const editor=new Editor({demo:false}).load(report);
  editor.addAnimationKeys([global,a,b].flatMap((target,index)=>[0,10].map((tick,i)=>({target,property:'opacity',tick,value:index===0?i:index===1?.3:.8,interpolation:'linear'}))));
  editor.markSaved();return editor;
}
const channel=(editor,target)=>editor.animationChannels.find(value=>value.id===animationChannelId(target,'opacity'));
test('explicit global track insertion samples its own curve and preserves scoped siblings and undo',()=>{
  const editor=fixture(),before=structuredClone(editor.report._styk.animation);editor.seek(2);
  editor.addAnimationKey(global,'opacity',2,undefined,{exactTarget:true});
  assert.equal(channel(editor,global).keys.find(key=>key.tick===2).value,.2);
  assert.deepEqual(channel(editor,a),before.channels.find(value=>value.id===animationChannelId(a,'opacity')));
  editor.undo();assert.deepEqual(editor.report._styk.animation,before);editor.redo();
  assert.equal(channel(editor,global).keys.find(key=>key.tick===2).value,.2);
  editor.addAnimationKey(global,'opacity',3,.6);
  assert.equal(channel(editor,a).keys.find(key=>key.tick===3).value,.6,'Inspector convenience still resolves current rig');
  assert.equal(channel(editor,global).keys.some(key=>key.tick===3),false);
});
test('exact target paste retains global identity and explicit dormant scope values while omitted dormant values reject atomically',()=>{
  const editor=fixture();editor.seek(6);const before=structuredClone(editor.report._styk.animation),history=editor._undo.length;
  assert.throws(()=>editor.addAnimationKey(a,'opacity',6,undefined,{exactTarget:true}),/not present/);
  assert.deepEqual(editor.report._styk.animation,before);assert.equal(editor._undo.length,history);
  editor.addAnimationKeys([{target:global,property:'opacity',tick:6,value:.11,exactTarget:true},
    {target:a,property:'opacity',tick:6,value:.22,exactTarget:true}]);
  assert.equal(channel(editor,global).keys.find(key=>key.tick===6).value,.11);
  assert.equal(channel(editor,a).keys.find(key=>key.tick===6).value,.22);
  assert.deepEqual(channel(editor,b),before.channels.find(value=>value.id===animationChannelId(b,'opacity')));
});

test('explicit global inspector reads, previews, navigation and commit preserve exact channel identity',()=>{
  const editor=fixture(),options={exactTarget:true};editor.seek(4);
  assert.equal(editor.animationValue(global,'opacity',4,options),.4);
  assert.equal(editor.animationValue(global,'opacity',4),.3);
  assert.equal(editor.animationChannel(global,'opacity',options),channel(editor,global));
  const before=structuredClone(editor.report._styk.animation),history=editor._undo.length;
  editor.beginAnimationEdit(global,'opacity',options);editor.previewAnimationEdit(.61);editor.previewAnimationEdit(.72);
  assert.equal(editor._undo.length,history);editor.commitAnimationEdit();
  assert.equal(editor._undo.length,history+1);assert.equal(channel(editor,global).keys.find(key=>key.tick===4).value,.72);
  assert.deepEqual(channel(editor,a),before.channels.find(value=>value.id===animationChannelId(a,'opacity')));
  assert.equal(editor.nearestAnimationKey(global,'opacity',-1,5,options).tick,4);
  editor.undo();assert.deepEqual(editor.report._styk.animation,before);
  editor.beginAnimationEdit(global,'opacity',options);editor.previewAnimationEdit(.22);editor.cancelAnimationEdit();
  assert.deepEqual(editor.report._styk.animation,before);
});

test('fractional inspector reads sample the requested scope without admitting fractional keys',()=>{
  const editor=fixture(),options={exactTarget:true};editor.seek(4.5);
  const before=structuredClone(editor.report),history=editor._undo.length,revision=editor.revision,edit=editor._animationEdit;
  let events=0;editor.addEventListener('change',()=>events++);
  assert.equal(editor.animationValue(global,'opacity',4.5,options),.45);
  assert.equal(editor.animationValue(global,'opacity'),.3);
  assert.equal(editor.animationValue(a,'opacity',4.5,options),.3);
  assert.equal(editor.animationValue(b,'opacity',4.5,options),undefined);
  assert.throws(()=>editor.beginAnimationEdit(global,'opacity',options),/integer/);
  assert.throws(()=>editor.addAnimationKey(global,'opacity',4.5,.6,options),/integer/);
  for(const tick of [NaN,Infinity,-.5,10000000.5,'4.5'])assert.throws(()=>editor.animationValue(global,'opacity',tick,options));
  assert.equal(editor._animationEdit,edit);
  assert.deepEqual(editor.report,before);assert.equal(editor._undo.length,history);
  assert.equal(editor.revision,revision);assert.equal(events,0);
});
