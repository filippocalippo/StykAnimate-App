import test from 'node:test';
import assert from 'node:assert/strict';
import {packPoseSequences,expandPoseSequencesSteps} from '../src/pose-sequence-storage.mjs';

const complete = iterator => {let result;do{result=iterator.next();}while(!result.done);return result.value;};

test('stored pose references reject corruption atomically and old array documents remain unchanged',()=>{
  for(const reference of [{sequence:-1},{sequence:1},{sequence:.2},{sequence:0,extra:true},[]]){
    const animation={version:2,poseSequences:[[]],channels:[{property:'pose',keys:reference}]},report={_styk:{animation}},before=structuredClone(animation);
    assert.throws(()=>complete(expandPoseSequencesSteps(report)),/reference/);assert.deepEqual(animation,before);
  }
  const old={_styk:{animation:{version:1,channels:[]}}};const animation=old._styk.animation;
  complete(expandPoseSequencesSteps(old));assert.equal(old._styk.animation,animation);
  const keys=[{id:'a',tick:0,value:{frameId:null}}],animation2={version:1,channels:[{property:'pose',keys}]};
  const nested={_styk:{animation:animation2},figure_types:[]};
  const parent={_styk:{simpleFrameDraft:{animationBaseline:animation2}},figure_types:[{_styk:{movieclip:{document:nested}}}]};
  const packed=packPoseSequences(parent);assert.equal(packed._styk.simpleFrameDraft.animationBaseline.version,2);
  assert.equal(packed.figure_types[0]._styk.movieclip.document._styk.animation.version,2);
  assert.equal(nested._styk.animation.version,1);
});

