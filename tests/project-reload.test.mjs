import test from 'node:test';
import assert from 'node:assert/strict';
import {createProjectReloader} from '../src/project-reload.mjs';
function setup(overrides = {}) {
  const calls = [], checkpoint = {}, decoded = {};
  const reload = createProjectReloader({busy: () => false, settle: async () => true,
    confirm: async () => true, capture: () => checkpoint, isCurrent: () => true,
    read: async cp => { assert.equal(cp, checkpoint); calls.push('read'); return {bytes: 1}; },
    decode: async () => { calls.push('decode'); return decoded; },
    apply: async result => { assert.equal(result, decoded); calls.push('apply'); return true; },
    release: async () => calls.push('release'), ...overrides});
  return {reload, calls};
}
test('reload decodes before replacing and releases the temporary source', async () => {
  const {reload,calls}=setup();assert.equal(await reload.run(),true);
  assert.deepEqual(calls,['read','decode','apply','release']);assert.equal(reload.active,false);
});
test('cancel and busy leave the document and disk untouched', async () => {
  for(const overrides of [{confirm:async()=>false},{settle:async()=>false},{busy:()=>true}]){
    const {reload,calls}=setup(overrides);assert.equal(await reload.run(),false);assert.deepEqual(calls,[]);
  }
});
test('missing save target and stale reads cannot replace the editor', async () => {
  for(const overrides of [{read:async()=>null},{isCurrent:()=>false}]){
    const {reload,calls}=setup(overrides);assert.equal(await reload.run(),false);assert.ok(!calls.includes('apply'));
  }
});
test('changes during decode discard the result',async()=>{
  let current=true;const {reload,calls}=setup({isCurrent:()=>current,decode:async()=>{current=false;return {};}});
  assert.equal(await reload.run(),false);assert.deepEqual(calls,['read','release']);
});
test('read, decode and apply failures leave the reload available for retry',async()=>{
  for(const stage of ['read','decode','apply','release']){
    const {reload}=setup({[stage]:async()=>{throw new Error(stage);}});
    await assert.rejects(reload.run(),new RegExp(stage));assert.equal(reload.active,false);
  }
});
test('repeated clicks cannot run two reads concurrently',async()=>{
  let finish;const {reload}=setup({read:()=>new Promise(resolve=>{finish=resolve;})});
  const first=reload.run();while(!finish)await Promise.resolve();
  assert.equal(await reload.run(),false);finish(null);assert.equal(await first,false);
});
