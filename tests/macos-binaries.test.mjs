import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { checkMachOTree, compareVersions, machOSlices, sameBinary, unsignedDigest } from '../scripts/macos-binaries.mjs';

const ARM64 = 0x0100000c, X64 = 0x01000007;
const encode = text => { const [major, minor = 0, patch = 0] = text.split('.').map(Number); return (major << 16) | (minor << 8) | patch; };

/** A minimal 64-bit Mach-O header with one deployment-target load command. */
function thin(cpu, minimum, command = 'build') {
  const header = Buffer.alloc(32), load = Buffer.alloc(command === 'build' ? 24 : 16);
  header.writeUInt32LE(0xfeedfacf, 0); header.writeUInt32LE(cpu, 4); header.writeUInt32LE(minimum ? 1 : 0, 16); header.writeUInt32LE(minimum ? load.length : 0, 20);
  if (!minimum) return header;
  if (command === 'build') { load.writeUInt32LE(0x32, 0); load.writeUInt32LE(24, 4); load.writeUInt32LE(1, 8); load.writeUInt32LE(encode(minimum), 12); }
  else { load.writeUInt32LE(0x24, 0); load.writeUInt32LE(16, 4); load.writeUInt32LE(encode(minimum), 8); }
  return Buffer.concat([header, load]);
}
function fat(...slices) {
  const head = Buffer.alloc(8 + slices.length * 20), offsets = [];
  head.writeUInt32BE(0xcafebabe, 0); head.writeUInt32BE(slices.length, 4);
  let offset = 4096;
  slices.forEach((slice, index) => { offsets.push(offset); head.writeUInt32BE(slice.readUInt32LE(4), 8 + index * 20); head.writeUInt32BE(offset, 16 + index * 20); head.writeUInt32BE(slice.length, 20 + index * 20); offset += 4096; });
  const out = Buffer.alloc(offset); head.copy(out); slices.forEach((slice, index) => slice.copy(out, offsets[index]));
  return out;
}

test('Mach-O headers report architecture and the declared minimum macOS', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'styk-macho-'));
  try {
    const write = async (name, bytes) => { const file = path.join(directory, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes); return file; };
    assert.deepEqual(await machOSlices(await write('a', thin(ARM64, '12.0'))), [{ arch: 'arm64', minimum: '12.0.0' }]);
    assert.deepEqual(await machOSlices(await write('b', thin(X64, '10.13', 'min'))), [{ arch: 'x64', minimum: '10.13.0' }], 'older LC_VERSION_MIN_MACOSX');
    assert.deepEqual(await machOSlices(await write('c', fat(thin(X64, '11.0'), thin(ARM64, '11.0')))), [{ arch: 'x64', minimum: '11.0.0' }, { arch: 'arm64', minimum: '11.0.0' }]);
    const java = Buffer.alloc(16); java.writeUInt32BE(0xcafebabe, 0); java.writeUInt32BE(0x00000041, 4);
    assert.equal(await machOSlices(await write('d.class', java)), null, 'a Java class file is not a universal binary');
    assert.equal(await machOSlices(await write('e.py', 'print("hi")\n')), null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a tree check names native code that is too new, for the wrong CPU, or undeclared', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'styk-macho-'));
  try {
    await mkdir(path.join(directory, 'lib'), { recursive: true });
    await writeFile(path.join(directory, 'ok'), thin(ARM64, '11.0'));
    await writeFile(path.join(directory, 'lib', 'universal'), fat(thin(X64, '10.13'), thin(ARM64, '12.0')));
    await writeFile(path.join(directory, 'lib', 'host-built.dylib'), thin(ARM64, '27.0'));
    await writeFile(path.join(directory, 'intel'), thin(X64, '11.0'));
    await writeFile(path.join(directory, 'bare'), thin(ARM64, null));
    await writeFile(path.join(directory, 'notes.txt'), 'not native');
    const { count, problems } = await checkMachOTree(directory, { arch: 'arm64', minimum: '12.0' });
    assert.equal(count, 5);
    assert.deepEqual(problems.sort(), [
      'bare: declares no minimum macOS version',
      'intel: no arm64 code (x64)',
      `${path.join('lib', 'host-built.dylib')}: requires macOS 27.0.0, newer than 12.0`,
    ]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('versions compare numerically', () => {
  assert.ok(compareVersions('10.13', '12.0') < 0);
  assert.equal(compareVersions('12.0.0', '12.0'), 0);
  assert.ok(compareVersions('12.1', '12.0.9') > 0);
});

test('a re-signed binary is the same code; changed code is not', { skip: process.platform !== 'darwin' && 'uses the macOS codesign tool' }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'styk-macho-'));
  try {
    const original = path.join(directory, 'original'), resigned = path.join(directory, 'resigned'), changed = path.join(directory, 'changed');
    // A freshly linked (linker-signed) program, like the scanner build; Apple's own binaries carry other signatures.
    await writeFile(path.join(directory, 'main.c'), 'const char *marker = "STYK-MARKER";\nint main(void) { return marker[0] == 0; }\n');
    try { await promisify(execFile)('cc', ['-o', original, path.join(directory, 'main.c')]); }
    catch { return t.skip('no C compiler'); }
    await copyFile(original, resigned);
    await promisify(execFile)('codesign', ['--force', '--sign', '-', resigned]);
    assert.equal(await sameBinary(original, resigned), true);
    assert.equal(await unsignedDigest(original), await unsignedDigest(resigned));
    // Packaging signs with the hardened runtime, a larger signature that changes the link-edit mapping.
    const hardened = path.join(directory, 'hardened');
    await copyFile(original, hardened);
    await promisify(execFile)('codesign', ['--force', '--sign', '-', '--options', 'runtime', '--timestamp=none', hardened]);
    assert.equal(await sameBinary(original, hardened), true);
    // The trailing signature is exactly what comparison ignores, so change the program's own text.
    const bytes = await readFile(original), at = bytes.indexOf('STYK-MARKER');
    assert.ok(at > 0);
    bytes[at] = 'X'.charCodeAt(0); await writeFile(changed, bytes);
    assert.equal(await sameBinary(original, changed), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
