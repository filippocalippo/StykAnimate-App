import test from 'node:test';
import assert from 'node:assert/strict';
import {animationChannelId,validateAnimationDocument,validateAnimationDocumentSteps} from '../src/animation-channels.mjs';
const clone=value=>structuredClone(value);
function fixture(count=520){
  const scalar={target:{kind:'figure',uid:1},property:'x',keys:Array.from({length:count},(_,i)=>({id:`key-${i+1}`,tick:i,value:i/4,interpolation:i%2?'hold':'linear'}))};
  scalar.id=animationChannelId(scalar.target,scalar.property);
  const pose={target:{kind:'layer',id:'layer-1'},property:'pose',keys:[{id:'pose-1',tick:0,hidden:true,value:{frameId:'frame-1'}},
    {id:'pose-2',tick:0,value:{frameId:'retained-519'}},{id:'pose-3',tick:3,value:{frameId:null}}]};pose.id=animationChannelId(pose.target,pose.property);
  return {keyframes:Array.from({length:520},(_,i)=>({_styk:{frameId:`frame-${i}`}})),_styk:{animation:{version:1,nextKeyId:count+1,channels:[scalar,pose]},
    frameSources:Object.fromEntries(Array.from({length:520},(_,i)=>[`retained-${i}`,{opaque:i}]))}};
}
async function drain(report){let count=0;const iterator=validateAnimationDocumentSteps(report);for(;;){const step=iterator.next();if(step.done)return{report:step.value,count};count++;await Promise.resolve();}}
test('cooperative validation yields while scanning keys and source identities and preserves sync return identity',async()=>{
  const report=fixture(),before=clone(report);assert.equal(validateAnimationDocument(report),report);
  const result=await drain(report);assert.equal(result.report,report);assert.ok(result.count>=6);assert.deepEqual(report,before);
  assert.equal((await drain({})).count,0);assert.equal((await drain({_styk:{animation:null}})).count,0);
});
test('sync and cooperative animation validation reject the same malformed metadata after checkpoints',async()=>{
  const cases=[
    [r=>r._styk.animation.version=2,/channel table/],
    [r=>r._styk.animation.nextKeyId=0,/identity counter/],
    [r=>r._styk.animation.channels[0].id='wrong',/stable identities/],
    [r=>r._styk.animation.channels.push(r._styk.animation.channels[0]),/stable identities/],
    [r=>r._styk.animation.channels[0].keys[519].id='key-1',/stable identities/],
    [r=>r._styk.animation.channels[0].keys[519].tick=4,/sorted/],
    [r=>r._styk.animation.channels[0].keys[519].tick=1e7+1,/whole-frame/],
    [r=>r._styk.animation.channels[0].keys[519].hidden=true,/pose keys/],
    [r=>r._styk.animation.channels[0].keys[519].passthrough=1,/boolean passthrough/],
    [r=>r._styk.animation.channels[1].keys[0].passthrough=false,/scalar keys/],
    [r=>r._styk.animation.channels[1].keys[0].hidden=false,/same frame/],
    [r=>r._styk.animation.channels[0].keys[519].interpolation='smooth',/interpolation/],
    [r=>r._styk.animation.channels[0].keys[519].value=NaN,/finite numbers/],
    [r=>r._styk.animation.channels[1].keys[1].value.frameId='missing',/missing source/],
    [r=>r._styk.animation.channels[1].keys[1].value={},/native frame identity/],
  ];
  for(const[mutate,pattern]of cases){const report=fixture();mutate(report);const before=clone(report);let sync;
    assert.throws(()=>validateAnimationDocument(report),error=>{sync=error;return pattern.test(error.message);});
    await assert.rejects(drain(report),error=>error.constructor===sync.constructor&&error.message===sync.message);
    assert.deepEqual(report,before);
  }
});
test('cancelling cooperative validation leaves the complete source reusable and unmodified',()=>{
  const report=fixture(1200),before=clone(report),steps=validateAnimationDocumentSteps(report);
  for(let i=0;i<3;i++)assert.equal(steps.next().done,false);
  assert.equal(steps.return().done,true);assert.deepEqual(report,before);assert.equal(validateAnimationDocument(report),report);
});
