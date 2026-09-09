import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('./native-clipboard-benchmark.py', import.meta.url), 'utf8');
const guards = source.slice(source.indexOf('function normalPath('), source.indexOf('function frameInventory('));
function check(prefix, stem = 'CF_PivotFrames_v5') {
  const context = vm.createContext({clipboardFolder: 'C:\\owned\\profile\\Pivot Animator\\',
    global(address) {return {readUtf16String() {return address === 0xb66474 ? prefix : stem;}};}});
  return vm.runInContext(`${guards}\nassertClipboardIsolation()`, context);
}

test('owned clipboard directory accepts equivalent Windows case/separators', () => {
  assert.equal(check('C:\\owned\\profile\\Pivot Animator\\'), 'C:\\owned\\profile\\Pivot Animator\\');
  assert.equal(check('c:/OWNED/profile/Pivot Animator/'), 'c:/OWNED/profile/Pivot Animator/');
});

test('missing separator, sibling directory, traversal and original AppData are rejected', () => {
  for (const prefix of ['C:\\owned\\profile\\Pivot Animator', 'C:\\owned\\profile\\Pivot Animator-other\\',
    'C:\\owned\\profile\\Pivot Animator\\..\\', 'C:\\Users\\person\\AppData\\Roaming\\Pivot Animator\\'])
    assert.throws(() => check(prefix), /escaped owned profile/);
});

test('unexpected filename stems cannot redirect the native clipboard files', () => {
  assert.throws(() => check('C:\\owned\\profile\\Pivot Animator\\', '..\\other'), /filename stem changed/);
});

test('preparation contains independent run guard and only measured native clipboard routes', () => {
  assert.match(source, /os\.environ\.get\("STYK_GPU_SLOT"\) != "native-clipboard"/);
  assert.match(source, /kind==='copy'\?0xb123ec:0xb125c8/);
  assert.match(source, /decodedClipboardFrames!==op\.count/);
  assert.match(source, /operationToSuccessfulPresentMs=present\?present\.end-op\.start:null/);
  assert.doesNotMatch(source, /Mouse\(|SendInput\(|clipboardrun\(['"]undo/);
});

test('main-window presentation is distinct from the scene bitmap dimensions', () => {
  const functionSource = source.slice(source.indexOf('function matchingClipboardPresent('), source.indexOf('function finishClipboardOperation('));
  const match = vm.runInNewContext(`(${functionSource})`);
  const valid = {mainWindowVerified: true, result: 0, start: 110, end: 111, frameCount: 1480, width: 1272, height: 798};
  const operation = {end: 100, afterFrames: 1480, presentations: [
    {...valid, mainWindowVerified: false}, {...valid, result: 0x087a0001}, {...valid, start: 99}, {...valid, frameCount: 1479}, valid]};
  assert.equal(match(operation), valid);
});
