/** Actual sandboxed renderer -> RGB24 worker -> IPC -> installed Windows codec. */
import {_electron as electron} from 'playwright';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
import backend from '../desktop/backend.cjs';

const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'artifacts', 'vfw-renderer');
await mkdir(output, {recursive: true});
const app = await electron.launch({args: [root], cwd: root, timeout: 45000, env: {...process.env, STYK_USER_DATA_DIR: path.join(output, `profile-${Date.now()}`)}});
try {
  const page = await app.firstWindow(), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.styk?.ready && window.stykDesktop?.beginVfwExport, undefined, {timeout: 30000});
  await app.evaluate(({ipcMain}) => {
    const original = ipcMain._invokeHandlers.get('styk:vfw-begin'); globalThis.__vfwTestRequests = [];
    ipcMain.removeHandler('styk:vfw-begin');
    ipcMain.handle('styk:vfw-begin', (event, options) => { globalThis.__vfwTestRequests.push({...options}); return original(event, options); });
    const configure = ipcMain._invokeHandlers.get('styk:vfw-configure'); globalThis.__vfwConfiguration = {status: 'idle'};
    ipcMain.removeHandler('styk:vfw-configure');
    ipcMain.handle('styk:vfw-configure', async (event, options) => { globalThis.__vfwConfiguration = {status: 'started', options}; try { const result = await configure(event, options); globalThis.__vfwConfiguration = {status: 'complete', result}; return result; } catch (error) { globalThis.__vfwConfiguration = {status: 'error', message: error.message}; throw error; } });
  });
  const result = await page.evaluate(async () => {
    const {getVfwCapabilities, encodeVfwVideo} = await import('/src/vfw-video-export.mjs');
    const checks = [], assert = (condition, message) => { if (!condition) throw new Error(message); checks.push(message); };
    const caps = await getVfwCapabilities({width: 160, height: 92});
    assert(caps.available && caps.codecs.some(codec => codec.kind === 'installed'), 'Actual installed VFW compressors are available through trusted IPC');
    assert(typeof window.require === 'undefined', 'Renderer retains Node isolation');
    const codecs = [caps.codecs.find(codec => codec.arch === 'x86' && codec.configure && codec.supported), caps.codecs.find(codec => codec.arch === 'x64' && codec.configure && codec.supported), caps.codecs.find(codec => codec.arch === 'x64' && codec.kind === 'uncompressed')];
    assert(codecs.every(Boolean), 'Both codec architectures and explicit native uncompressed AVI are exposed');
    const canvas = new OffscreenCanvas(160, 92), context = canvas.getContext('2d');
    const renderFrame = index => { context.clearRect(0, 0, 160, 92); context.fillStyle = index < 3 ? '#ed1428' : '#143ced'; context.fillRect(12, 12, 136, 68); return canvas; };
    const files = [], reports = [], options = {width: 160, height: 92, fps: 16, totalFrames: 6, renderFrame, quality: .85, keyframeEvery: 3};
    for (const codec of codecs) {
      const chunks = [], progress = [], desktop = {...window.stykDesktop, writeVfwChunk: async (token, bytes) => { chunks.push(bytes.byteLength); return window.stykDesktop.writeVfwChunk(token, bytes); }};
      const blob = await encodeVfwVideo({...options, codecId: codec.id, desktop, onProgress: value => progress.push(value)});
      assert(blob.type === 'video/x-msvideo' && blob.size > 256, `${codec.id} produces a real AVI Blob`);
      assert(progress.filter(value => value.phase === 'rendering').map(value => value.completed).join(',') === '1,2,3,4,5,6', `${codec.id} reports every source frame`);
      assert(Math.max(...chunks) <= 262144, `${codec.id} raw frame IPC stays within 256 KiB`);
      const name = `${codec.id.replaceAll(':', '-')}.avi`; files.push({name, bytes: [...new Uint8Array(await blob.arrayBuffer())]}); reports.push({codecId: codec.id, name, bytes: blob.size});
    }
    const abort = new AbortController(); let error;
    try { await encodeVfwVideo({...options, codecId: codecs[2].id, signal: abort.signal, onProgress: value => { if (value.completed === 2) abort.abort(); }}); } catch (caught) { error = caught; }
    assert(error?.name === 'AbortError', 'In-flight Windows codec export cancels after two frames');
    const afterCancel = await encodeVfwVideo({...options, codecId: codecs[2].id, totalFrames: 1}); assert(afterCancel.size > 256, 'Windows codec service is reusable after cancellation');
    let failure;
    try { await encodeVfwVideo({...options, codecId: codecs[2].id, renderFrame: () => { throw new Error('Expected frame failure'); }}); } catch (caught) { failure = caught.message; }
    assert(failure === 'Expected frame failure', 'Frame rendering errors preserve their cause through native cleanup');
    const afterFailure = await encodeVfwVideo({...options, codecId: codecs[2].id, totalFrames: 1}); assert(afterFailure.size > 256, 'Windows codec service is reusable after rendering failure');
    return {checks, capabilities: caps, files, reports};
  });
  for (const file of result.files) await writeFile(path.join(output, file.name), Uint8Array.from(file.bytes)); delete result.files;
  await page.evaluate(async () => {
    const {emptyDocument, createFrame} = await import('/src/demo.mjs'); const report = emptyDocument(); report.canvas_width = 160; report.canvas_height = 92; report.fps = 16;
    report.keyframes = [createFrame([], 5), createFrame([], 1)]; window.styk.editor.load(report);
    window.styk.editor.addAnimationKeys([{target: {kind: 'scene'}, property: 'color', tick: 0, value: 0xffed1428, interpolation: 'hold'}, {target: {kind: 'scene'}, property: 'color', tick: 3, value: 0xff143ced, interpolation: 'hold'}]); window.styk.editor.markSaved();
  });
  const filename = path.join(output, 'ui-windows-codec.avi');
  await app.evaluate(({dialog}, filename) => { dialog.showSaveDialog = async () => ({canceled: false, filePath: filename}); }, filename);
  await page.locator('[data-action="export"]').first().click();
  await page.locator('.export-settings > summary').click();
  await page.locator('#export-vfw-codec').waitFor({state: 'visible'});
  await page.waitForFunction(() => !document.querySelector('#export-vfw-codec').disabled);
  const installed = result.capabilities.codecs.find(codec => codec.arch === 'x86' && codec.supported && codec.configure && codec.dataRate);
  await page.locator('#export-vfw-codec').selectOption(installed.id);
  assert.equal(await page.locator('#export-vfw-configure').isDisabled(), false); result.checks.push('Installed codec selection enables its genuine native configuration dialog');
  await page.locator('#export-vfw-configure').click();
  const python = backend.pythonCandidates()[0];
  try { result.configurationDialog = JSON.parse(execFileSync(python.command, [...python.args, path.join(root, 'tests/vfw-owned-dialog-cancel.py'), '--parent', String(await app.evaluate(() => process.pid))], {windowsHide: true, encoding: 'utf8', timeout: 15000})); }
  catch (error) { console.log('Configuration diagnostic', await app.evaluate(() => globalThis.__vfwConfiguration), await page.locator('#dialog').innerText()); throw error; }
  await page.waitForFunction(() => document.querySelector('.vfw-config-state')?.textContent === 'Custom codec settings');
  assert.equal(await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].isEnabled()), true);
  result.checks.push('Actual Configure opens only the owned native codec dialog, retains opaque settings and restores the Electron owner');
  await page.locator('#export-vfw-quality').fill('75'); await page.locator('#export-vfw-keyframes').fill('4'); await page.locator('#export-vfw-bitrate').fill('0.4');
  assert.ok(await page.locator('#dialog').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1)); result.checks.push('Installed codec controls fit the actual export dialog without horizontal scrolling');
  await page.screenshot({path: path.join(output, 'export-controls.png')});
  await page.locator('[data-action="export-vfw"]').click();
  await page.waitForFunction(() => !document.querySelector('#dialog').open, undefined, {timeout: 30000});
  const uiBytes = await readFile(filename); assert.ok(uiBytes.length > 256); result.checks.push('Actual Windows AVI export tile renders and saves through the native file dialog bridge');
  const requests = await app.evaluate(() => globalThis.__vfwTestRequests), request = requests.at(-1);
  assert.equal(request.codecId, installed.id); assert.equal(request.quality, .75); assert.equal(request.keyframeEvery, 4); assert.equal(request.bitrate, 400000);
  assert.equal(typeof request.configurationId, 'string');
  result.checks.push('Actual quality, keyframe interval and bitrate fields reach the selected installed codec'); result.uiRequest = request;
  const ffmpeg = path.join(root, 'build', 'video-encoder', 'ffmpeg.exe');
  result.decoded = [];
  for (const file of [...result.reports.map(row => row.name), path.basename(filename)]) {
    const decoded = execFileSync(ffmpeg, ['-v', 'error', '-threads', '1', '-i', path.join(output, file), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-threads', '1', 'pipe:1'], {windowsHide: true, maxBuffer: 4 * 1024 * 1024});
    assert.equal(decoded.length, 160 * 92 * 3 * 6, `${file} all six frames`);
    const at = (frame, x, y) => [...decoded.subarray(((frame * 92 + y) * 160 + x) * 3, ((frame * 92 + y) * 160 + x) * 3 + 3)];
    const red = at(0, 80, 40), blue = at(5, 80, 40), corner = at(0, 0, 0);
    assert.ok(red[0] > 200 && red[2] < 60 && blue[2] > 200 && blue[0] < 60);
    if (file !== path.basename(filename)) assert.ok(corner.every(value => value < 20), `${file} transparent pixels use native black matte`);
    result.decoded.push({file, frames: 6, red, blue, corner});
  }
  assert.deepEqual(errors, []); result.errors = errors; await writeFile(path.join(output, 'report.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({checks: result.checks.length, codecs: result.reports.length, errors}));
} finally { await app.close(); }
