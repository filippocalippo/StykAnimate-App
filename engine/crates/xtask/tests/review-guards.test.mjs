import assert from 'node:assert/strict';
import test from 'node:test';
import * as sources from '../../../../scripts/native-source-guards.mjs';
import * as guards from '../../../../scripts/native-guards.mjs';
import {mkdirSync,mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
const scan = sources.interfaceErrors ?? (()=>[]);
const exportsScan = sources.boundaryErrors ?? (()=>[]);
const seal = guards.allowSealErrors ?? (()=>[]);
test('R1 local macro unwrap and expect are interface violations',()=>{
 for(const method of ['unwrap()', 'expect("reason")']) assert.match(scan(`macro_rules! get { () => { value.${method} } }`, 'engine/crates/styk-ui/src/lib.rs')[0]??'', /interface:.*unwrap|interface:.*expect/);
 assert.deepEqual(scan('#[cfg(test)] mod tests { macro_rules! ok { () => { x.unwrap() } } }','engine/crates/styk-ui/src/lib.rs'),[]);
});
test('R3 diagnostic entry points carry interface lints',()=>{
 assert.match(readFileSync('engine/crates/styk-text-check/src/lib.rs','utf8'),/deny\(clippy::unwrap_used/);
 assert.doesNotMatch(readFileSync('engine/crates/styk-text-check/src/pen_lab/self_test/worker.rs','utf8'),/#!\[allow\(/, 'worker entry points retain the interface lints');
 assert.ok(scan('fn helper() { foo.expect("bad"); }','engine/crates/styk-text-check/src/pen_lab/self_test.rs').length);
});
test('R4 engine paths and platform public Windows aliases are rejected',()=>{
 for(const source of ['use styk_core::engine::Value;', 'use styk_core::{engine::Value};', 'use styk_core as core; fn f(v: core::engine::Value) {}', 'fn f(v: styk_doc::Value) {}']) assert.ok(exportsScan(source,'engine/crates/styk-ui/src/live.rs').length,source);
 for(const source of ['pub use windows_sys::Win32::Foundation::HWND;', 'pub type Window = windows::Win32::Foundation::HWND;', 'use windows_sys::Win32::Foundation::HWND; pub type Window = HWND;']) assert.ok(exportsScan(source,'engine/crates/styk-platform/src/lib.rs').length,source);
});
test('R5 production live_tests module is scanned and cfg(test) declaration is exempt',()=>{
 const root=mkdtempSync(resolve('tmp/x1r-module-')); const dir=join(root,'engine/crates/styk-core/src'); mkdirSync(dir,{recursive:true});
 try {
  writeFileSync(join(dir,'lib.rs'),'mod live_tests;'); writeFileSync(join(dir,'live_tests.rs'),'fn f(){ std::time::Instant::now(); #[cfg(windows)] {} }');
  assert.ok(sources.sourceErrors(root).some(e=>e.includes('live_tests.rs')), 'production module escaped');
  writeFileSync(join(dir,'lib.rs'),'#[cfg(test)] mod live_tests;'); assert.deepEqual(sources.sourceErrors(root),[]);
 }finally{rmSync(root,{recursive:true});}
});
test('R6 allow-list changes require merge approval, even with a copied header',()=>{
 const base='# Initial K-guards baseline. Only the orchestrator may edit this file.\n"a" = ["x"]\n';
 assert.ok(seal(base+'"b" = []\n',base).some(e=>e.includes('orchestrator')));
 assert.ok(seal(base.replace('Only the orchestrator may edit this file.',''),base).some(e=>e.includes('header')));
 assert.ok(seal(base,null).length); assert.deepEqual(seal(base,base),[]);
});
test('R6 approval is read from the Git merge base, not the branch copy',()=>{
 const root=mkdtempSync(resolve('tmp/x1r-approval-'));
 const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});
 const base='# Only the orchestrator may edit this file.\n"a" = ["x"]\n';
 try {
  git('init','-b','native-app'); mkdirSync(join(root,'engine'));
  writeFileSync(join(root,'engine/deps-allow.toml'),base); git('add','.'); git('commit','-m','Approve initial test baseline');
  assert.deepEqual(seal(base,guards.approvedAllow(root)),[]);
  git('checkout','-b','implementation'); writeFileSync(join(root,'engine/deps-allow.toml'),base+'"b" = []\n'); git('commit','-am','Unapproved test change');
  assert.equal(guards.approvedAllow(root),base);
  assert.ok(seal(readFileSync(join(root,'engine/deps-allow.toml'),'utf8'),guards.approvedAllow(root)).length);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('R7 qualified and same-file aliased clocks are rejected',()=>{
 for(const name of ['Instant','SystemTime']) for(const code of [`<std::time::${name}>::now()`, `time::${name}::now`, `type T = ${name}; T::now()`, `type T = std::time::${name}; <T>::now()`]) assert.ok(sources.webErrors(code,'fixture.rs').length,code);
});
