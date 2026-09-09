import test from 'node:test';
import assert from 'node:assert/strict';
import {playbackMemoryBudget} from '../src/playback-budget.mjs';
test('memory tiers bound playback residency and unknown runtimes retain a conservative default',()=>{
  const mib=1024*1024;
  for(const unknown of [null,NaN,Infinity,0,-1,'8'])assert.equal(playbackMemoryBudget(unknown),128*mib);
  for(const [ram,budget] of [[.25,32],[.5,32],[1,64],[2,128],[4,256],[8,512],[64,512]])assert.equal(playbackMemoryBudget(ram),budget*mib);
});
