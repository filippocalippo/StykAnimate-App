import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir, writeFile, readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {rgbaToVfwBgr24} from '../src/vfw-pixels.mjs';
import {getVfwCapabilities, encodeVfwVideo, configureVfwCodec} from '../src/vfw-video-export.mjs';
import service from '../desktop/vfw-export-service.cjs';

const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'artifacts', 'vfw-service');
const helperPaths = Object.fromEntries(['x86', 'x64'].map(arch => [arch, path.join(root, 'native', 'bin', arch, 'styk-vfw.exe')]));
const makeService = () => new service.VfwExportService({helperPaths, tempRoot: path.join(output, 'temp')});
const colors = [[240, 20, 30], [30, 230, 40], [20, 40, 240], [220, 120, 30], [30, 210, 200], [180, 30, 210]];
function pixels(width, height, index) {
  const data = new Uint8Array(width * height * 4), a = colors[index % colors.length], b = colors[(index + 1) % colors.length];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([...(y < height / 2 ? a : b), 255], (y * width + x) * 4);
  return data;
}
async function encode(vfw, codecId, {width = 160, height = 92, totalFrames = 6} = {}) {
  const transfer = await vfw.begin({codecId, width, height, fps: 16, totalFrames, quality: .9, keyframeEvery: 3});
  try {
    for (let index = 0; index < totalFrames; index++) {
      const {bytes} = rgbaToVfwBgr24(pixels(width, height, index), width, height); vfw.beginFrame(transfer.token, {index, size: bytes.length});
      for (let offset = 0; offset < bytes.length; offset += 17000) await vfw.writeFrameChunk(transfer.token, bytes.subarray(offset, offset + 17000));
      await vfw.endFrame(transfer.token);
    }
    const meta = await vfw.finish(transfer.token), parts = []; let done = false;
    while (!done) { const chunk = await vfw.read(transfer.token); assert.ok(chunk.bytes.length <= 262144); parts.push(Buffer.from(chunk.bytes)); done = chunk.done; }
    const bytes = Buffer.concat(parts); assert.equal(bytes.length, meta.size); assert.equal(bytes.toString('ascii', 0, 4), 'RIFF'); assert.equal(bytes.toString('ascii', 8, 12), 'AVI ');
    return {bytes, meta, outputChunks: parts.length};
  } finally { await vfw.cancel(transfer.token); }
}

test('VFW conversion produces exact bottom-up BGR rows with DWORD padding and black alpha matte', () => {
  const {bytes, stride} = rgbaToVfwBgr24(new Uint8Array([255, 10, 20, 255, 30, 200, 50, 128]), 1, 2);
  assert.equal(stride, 4); assert.deepEqual([...bytes], [25, 100, 15, 0, 20, 10, 255, 0]);
  assert.deepEqual([...rgbaToVfwBgr24(new Uint8Array([255, 20, 80, 0]), 1, 1).bytes], [0, 0, 0, 0]);
  assert.throws(() => rgbaToVfwBgr24(new Uint8Array(4), 2, 1), /exact/);
  assert.throws(() => rgbaToVfwBgr24(new Uint8Array(4), 0, 1), /dimensions/);
});
test('browser capability and configuration honestly require native Windows APIs', async () => {
  const caps = await getVfwCapabilities({}, {}); assert.equal(caps.available, false); assert.deepEqual(caps.codecs, []); assert.match(caps.reason, /Windows/);
  await assert.rejects(configureVfwCodec({}, {}), /Windows/);
  await assert.rejects(encodeVfwVideo({codecId: 'mpeg4'}), /installed/);
});
test('non-Windows service never advertises installed VFW codecs', async () => {
  const vfw = new service.VfwExportService({platform: 'linux'});
  try { const caps = await vfw.capabilities({width: 160, height: 90}); assert.equal(caps.available, false); assert.equal(caps.codecs.length, 0); }
  finally { await vfw.dispose(); }
});
test('actual Windows enumeration distinguishes codec architectures and input rejection', {skip: process.platform !== 'win32'}, async () => {
  const vfw = makeService();
  try {
    const caps = await vfw.capabilities({width: 160, height: 92}); assert.equal(caps.available, true); assert.equal(caps.errors.length, 0);
    assert.ok(caps.codecs.some(codec => codec.arch === 'x86' && codec.supported)); assert.ok(caps.codecs.some(codec => codec.arch === 'x64' && codec.supported));
    assert.ok(caps.codecs.some(codec => !codec.supported && codec.reason));
    assert.ok(caps.codecs.filter(codec => codec.kind === 'uncompressed').every(codec => codec.handler === 0));
    await mkdir(output, {recursive: true}); await writeFile(path.join(output, 'capabilities.json'), JSON.stringify(caps, null, 2));
  } finally { await vfw.dispose(); }
});
test('every currently installed RGB24 compressor exports an independently decoded six-frame AVI', {skip: process.platform !== 'win32'}, async () => {
  await mkdir(output, {recursive: true}); const vfw = makeService(), rows = [];
  try {
    const caps = await vfw.capabilities({width: 160, height: 92}), codecs = [...new Map(caps.codecs.filter(codec => codec.supported).map(codec => [codec.id, codec])).values()];
    for (const codec of codecs) {
      const result = await encode(vfw, codec.id), filename = path.join(output, `${codec.id.replaceAll(':', '-')}.avi`); await writeFile(filename, result.bytes);
      const decoded = execFileSync(path.join(root, 'build', 'video-encoder', 'ffmpeg.exe'), ['-v', 'error', '-threads', '1', '-i', filename, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-threads', '1', 'pipe:1'], {windowsHide: true, maxBuffer: 16 * 1024 * 1024});
      assert.equal(decoded.length, 160 * 92 * 3 * 6, `${codec.id} frame count`); let maxDifference = 0;
      for (let index = 0; index < 6; index++) for (const y of [20, 70]) {
        const expected = colors[(index + (y < 46 ? 0 : 1)) % colors.length], offset = ((index * 92 + y) * 160 + 80) * 3;
        for (let c = 0; c < 3; c++) maxDifference = Math.max(maxDifference, Math.abs(decoded[offset + c] - expected[c]));
      }
      assert.ok(maxDifference <= (codec.lossless ? 0 : 35), `${codec.id} decoded RGB mismatch ${maxDifference}`);
      rows.push({codec: codec.id, name: codec.name, bytes: result.bytes.length, frames: 6, maxDifference, outputChunks: result.outputChunks});
    }
    await writeFile(path.join(output, 'report.json'), JSON.stringify({codecs: rows, checks: rows.length, errors: []}, null, 2));
  } finally { await vfw.dispose(); }
});
test('native uncompressed AVI keeps odd dimensions and output streaming is bounded', {skip: process.platform !== 'win32'}, async () => {
  const vfw = makeService();
  try { const result = await encode(vfw, 'vfw:x64:00000000', {width: 161, height: 91}); assert.equal(result.meta.width, 161); assert.equal(result.meta.height, 91); assert.ok(result.outputChunks > 1); }
  finally { await vfw.dispose(); }
});
test('invalid frames, concurrent start and cancellation are isolated and the encoder remains reusable', {skip: process.platform !== 'win32'}, async () => {
  const vfw = makeService(), options = {codecId: 'vfw:x86:00000000', width: 32, height: 24, fps: 16, totalFrames: 3};
  try {
    await assert.rejects(vfw.begin({...options, codecId: 'vfw:x86:ffffffff'}), /unavailable/);
    const pending = vfw.begin(options); await assert.rejects(vfw.begin(options), /current/); const transfer = await pending;
    assert.throws(() => vfw.beginFrame(transfer.token, {index: 1, size: transfer.frameBytes}), /sequential/);
    vfw.beginFrame(transfer.token, {index: 0, size: transfer.frameBytes}); await assert.rejects(vfw.endFrame(transfer.token), /incomplete/);
    await assert.rejects(vfw.writeFrameChunk(transfer.token, new Uint8Array(262145)), /chunk/);
    await vfw.writeFrameChunk(transfer.token, new Uint8Array(100)); await vfw.cancel(transfer.token); assert.equal(vfw.jobs.size, 0);
    const next = await encode(vfw, options.codecId, {width: 32, height: 24, totalFrames: 2}); assert.equal(next.meta.frames, 2);
    assert.deepEqual(await readdir(path.join(output, 'temp')), []);
  } finally { await vfw.dispose(); }
});
