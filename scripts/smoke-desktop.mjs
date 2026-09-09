import { _electron as electron } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {createHash} from 'node:crypto';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(appRoot, 'artifacts');
await mkdir(output, { recursive: true });
const packaged = process.argv.includes('--packaged');
const defaultPackagedPath = process.platform === 'win32' ? ['win-unpacked', 'StykAnimate.exe']
  : process.platform === 'darwin' ? [process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'StykAnimate.app', 'Contents', 'MacOS', 'StykAnimate']
  : [process.arch === 'arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked', 'stykanimate-webapp'];
const executablePath = packaged ? process.env.STYK_PACKAGED_EXECUTABLE || path.join(appRoot, 'release', ...defaultPackagedPath) : undefined;
const profilePath = path.join(output, `${packaged ? 'packaged' : 'desktop'}-profile-${Date.now()}`);
const app = await electron.launch({ executablePath, args: packaged ? [] : [appRoot], cwd: appRoot, timeout: 45000, env: { ...process.env, STYK_DEBUG: '1', STYK_USER_DATA_DIR: profilePath } });
const errors = [];
let appClosed = false;
app.on('close', () => { appClosed = true; });
try {
  const page = await app.firstWindow({ timeout: 45000 });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForLoadState('networkidle');
  await page.waitForSelector('canvas', { state: 'visible', timeout: 20000 });
  await page.waitForFunction(() => window.styk?.ready === true, undefined, { timeout: 20000 });
  const actual = await page.evaluate(async () => ({
    title: document.title,
    desktop: window.stykDesktop?.isDesktop,
    bridge: typeof window.stykDesktop?.openFile,
    nodeExposed: typeof window.require !== 'undefined' || typeof window.process !== 'undefined',
    secureContext: window.isSecureContext,
    gpuApi: Boolean(navigator.gpu),
    gpuAdapter: Boolean(navigator.gpu && await navigator.gpu.requestAdapter()),
    canvasCount: document.querySelectorAll('canvas').length,
    renderer: window.styk?.state?.renderer?.stats,
    figures: window.styk?.editor?.frame?.objects?.length,
    state: await window.stykDesktop?.getWindowState(),
    backend: await (await fetch('/api/health')).json(),
  }));
  if (!actual.desktop || actual.bridge !== 'function') throw new Error('Desktop bridge was not initialized.');
  if (actual.nodeExposed) throw new Error('Node.js is exposed to the renderer.');
  if (!actual.secureContext || !actual.gpuApi || !actual.gpuAdapter) throw new Error('A WebGPU adapter is not available.');
  actual.version = await app.evaluate(({ app }) => app.getVersion());
  if(packaged) {
    actual.executablePath=executablePath;
    const manifest=JSON.parse(await readFile(path.join(output,'package-manifest.json'),'utf8'));
    actual.packageFilesSha256=createHash('sha256').update(JSON.stringify([...manifest.files].sort((a,b)=>a.path.localeCompare(b.path)))).digest('hex');
  }
  if (packaged && actual.backend.jsonEncoder !== 'orjson') throw new Error('The packaged backend did not use the compiled JSON encoder.');
  if (packaged && actual.backend.nativeFrameScanner !== 'cpp') throw new Error('The packaged backend did not load its native PIV scanner.');
  if (packaged) {
    actual.videoCapabilities = await page.evaluate(() => window.stykDesktop.getVideoCapabilities({width:320,height:240}));
    for (const format of ['mp4','avi','wmv','webm']) {
      if (!actual.videoCapabilities.formats.some(item => item.id === format && item.supported)) throw new Error(`The packaged encoder cannot export ${format}.`);
    }
    if (process.platform === 'win32') {
      actual.vfwCapabilities = await page.evaluate(() => window.stykDesktop.getVfwCapabilities({width:320,height:240}));
      for (const architecture of ['x86','x64']) {
        if (!actual.vfwCapabilities.codecs.some(codec => codec.arch === architecture && codec.kind === 'uncompressed' && codec.supported)) throw new Error(`The packaged ${architecture} VFW helper did not load.`);
      }
    }
  }
  const stem = packaged ? 'desktop-packaged-smoke' : 'desktop-smoke';
  await page.evaluate(() => {
    const editor = window.styk.editor;
    const actor = editor.frame.objects.find((object) => editor.report.figure_types.find((figure) => figure.figure_type_id === object.figure_type_id)?.segments.length > 5);
    if (actor) editor.select(actor.unique_id);
  });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: path.join(output, `${stem}.png`) });
  // Select known fixtures through a test substitute for the native dialog.
  // Production IPC still receives no caller-selected read or write path.
  await app.evaluate(({ dialog }, fixture) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture] }); }, path.resolve(appRoot, '..', 'Samples.stk'));
  const imported = await page.evaluate(async () => {
    const native = await window.stykDesktop.openFile();
    let result = native;
    if (native?.bytes instanceof ArrayBuffer) {
      const { ImportClient } = await import('/src/import-client.mjs');
      const importer = new ImportClient();
      try { result = await importer.importFile(new File([native.bytes], native.filename)); }
      finally { importer.dispose(); }
    }
    return { sourceId: result?.sourceId, filename: result?.filename, kind: result?.kind, document: Boolean(result?.document), transport: native?.bytes ? 'source-bytes-v1' : 'expanded-document-v0', nativeBytes: native?.bytes?.byteLength };
  });
  if (!imported.document || !imported.sourceId || imported.kind !== 'stk') throw new Error(`Native STK import failed: ${JSON.stringify(imported)}`);
  await app.evaluate(({ dialog }, fixture) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture] }); }, path.resolve(appRoot, '..', 'Goku_Broly_Movie_by_Killer1.piv'));
  const nativePivImport = await page.evaluate(async () => {
    const native = await window.stykDesktop.openFile();
    let result = native;
    if (native?.bytes instanceof ArrayBuffer) {
      const { ImportClient } = await import('/src/import-client.mjs');
      const importer = new ImportClient();
      try { result = await importer.importFile(new File([native.bytes], native.filename)); }
      finally { importer.dispose(); }
    }
    return { sourceId: result?.sourceId, filename: result?.filename, kind: result?.kind, frames: result?.document?.keyframes?.length, timings: { ...native?.timings, ...result?.timings }, nativeBytes: native?.bytes?.byteLength };
  });
  if (nativePivImport.kind !== 'piv' || !(nativePivImport.frames > 1)) throw new Error(`Native PIV import failed: ${JSON.stringify(nativePivImport)}`);
  await page.evaluate(() => window.styk.actions.open());
  await page.waitForFunction(() => window.styk.editor.report.keyframes.length === 40, undefined, { timeout: 20000 });
  actual.nativePivDisplayed = await page.evaluate(() => ({ keyframes: window.styk.editor.report.keyframes.length, figures: window.styk.editor.frame.objects.length, name: window.styk.editor.name }));
  const savePath = path.join(output, `${stem}-save.txt`);
  await app.evaluate(({ dialog }, destination) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination }); }, savePath);
  await page.evaluate(() => window.stykDesktop.saveFile({ data: 'StykAnimate native save smoke', encoding: 'utf8', defaultPath: 'smoke.txt', filters: [{ name: 'Text', extensions: ['txt'] }] }));
  if (await readFile(savePath, 'utf8') !== 'StykAnimate native save smoke') throw new Error('Native file save content did not match.');
  actual.nativeImport = imported;
  actual.nativePivImport = nativePivImport;
  actual.nativeSave = true;
  actual.packaged = packaged;
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0 });
    dialog.showSaveDialog = async () => ({ canceled: true });
  });
  await page.evaluate(async () => {
    window.styk.editor.dirty = true;
    await window.stykDesktop.setDocumentState({ name: window.styk.editor.name, dirty: true });
    await window.stykDesktop.close();
  });
  await page.waitForFunction(() => document.getElementById('status')?.textContent === 'Save cancelled', undefined, { timeout: 10000 });
  if (!await page.evaluate(() => window.styk.editor.dirty)) throw new Error('Canceling save during close lost the dirty document state.');
  actual.closeSaveCancelPreservedDocument = true;
  const closeSavePath = path.join(output, `${stem}-close-save.styk`);
  await app.evaluate(({ dialog }, destination) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination }); }, closeSavePath);
  const closed = page.waitForEvent('close', { timeout: 10000 });
  await page.evaluate(() => window.stykDesktop.close());
  await closed;
  const savedOnClose = JSON.parse(await readFile(closeSavePath, 'utf8'));
  if (!savedOnClose.keyframes?.length) throw new Error('Save-on-close did not persist a complete project.');
  actual.closeSavedAndClosed = true;
  if (errors.length) throw new Error(`Renderer errors:\n${errors.join('\n')}`);
  await writeFile(path.join(output, `${stem}.json`), JSON.stringify({ ...actual, errors, platform: process.platform, checkedAt: new Date().toISOString() }, null, 2));
  console.log(JSON.stringify(actual, null, 2));
} finally {
  if (!appClosed) {
    // The test may fail while its synthetic dirty document is still open.
    // Exit the isolated test process instead of leaving a modal dialog behind.
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  }
}
