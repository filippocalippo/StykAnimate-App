/** Restoring a lifted skeleton into the editor's object model (src/document-lift.mjs). Writing the lifted form is Rust's
 *  (engine/crates/styk-formats/tests/container.rs); the container itself is tests/native-file-codec.test.mjs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {restoreLifted} from '../src/document-lift.mjs';
import {bytesToBase64} from '../src/base64.mjs';

test('restoring markers resolves every reference form and refuses damaged ones', () => {
  const bytes = new Uint8Array(60), marker = 'S2S:0:0:60';
  assert.equal(restoreLifted({a: marker}, [{kind: 2, bytes}]).a, bytesToBase64(bytes));
  assert.equal(restoreLifted({a: 'S2D:0:0:3:data:x;base64,'}, [{kind: 2, bytes: new Uint8Array([1, 2, 3])}]).a, 'data:x;base64,AQID');
  assert.equal(restoreLifted({a: 'S2E:S2B:literal'}, []).a, 'S2B:literal');
  assert.throws(() => restoreLifted({a: 'S2B:bad'}, []), /malformed section marker/);
  for (const damaged of ['S2B:u8:0:0:9007199254740993', 'S2B:u8:9007199254740993:0:0', 'S2S:0:9007199254740993:0'])
    assert.throws(() => restoreLifted({a: damaged}, [{kind: 1, bytes}]), /section reference/);
});

test('unaligned stored numeric ranges restore exact values and existing aliases', () => {
  const bytes = new Uint8Array(1 + 16), view = new DataView(bytes.buffer);
  view.setFloat64(1, .125, true); view.setFloat64(9, -1e300, true);
  const marker = 'S2B:f64:0:0:2';
  const out = restoreLifted({a: marker, b: marker}, [{kind: 1, bytes: bytes.subarray(1)}]);
  assert.deepEqual(out.a, [.125, -1e300]); assert.equal(out.a, out.b);
});

test('drawing payloads, literal markers and unknown metadata restore losslessly', () => {
  const tiles = new Uint8Array(80000).map((_, i) => i * 7 % 251);
  const skeleton = JSON.parse(`{"styk_tiles":"S2D:0:0:80000:data:application/x-styk-tiles;base64,","literal":"S2E:S2B:f64:0:0:3","escaped":"S2E:S2E:a","future":{"__proto__":{"retained":true}}}`);
  const out = restoreLifted(skeleton, [{kind: 2, bytes: tiles}]);
  assert.equal(out.styk_tiles, 'data:application/x-styk-tiles;base64,' + bytesToBase64(tiles));
  assert.equal(out.literal, 'S2B:f64:0:0:3'); assert.equal(out.escaped, 'S2E:a');
  assert.equal(Object.hasOwn(out.future, '__proto__'), true);
});
