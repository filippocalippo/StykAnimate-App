// Memory of the desktop app with a document open: the engine's WebAssembly memory, the JS heap, the renderer process and all processes (Electron app metrics).
//
//   node scripts/engine-memory.mjs <file>…
import {_electron} from '../tests/support/playwright.mjs';
import {createRequire} from 'node:module';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import os from 'node:os'; import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
async function measure(file) {
  const profile = mkdtempSync(path.join(os.tmpdir(), 'styk-mem-'));
  writeFileSync(path.join(profile, 'editor-settings.json'), JSON.stringify({theme: 'light', locale: 'en'}));
  const env = {...process.env, STYK_STARTUP_VIEW: 'editor', STYK_USER_DATA_DIR: profile, STYK_LIBRARY_DIR: path.join(profile, 'library')}; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({executablePath: createRequire(path.join(root, 'package.json'))('electron'), args: [root, '--js-flags=--expose-gc'], cwd: root, env});
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.styk?.ready === true);
  await page.evaluate(() => { document.querySelector('.styk-privacy [data-decline]')?.click(); for (const d of document.querySelectorAll('dialog[open]')) d.close(); window.__r = styk.editor.report; });
  await page.locator('#file-input').setInputFiles(file);
  await page.waitForFunction(() => styk.editor.report !== window.__r && !styk.state.busy, null, {timeout: 600000});
  const info = await page.evaluate(async () => {
    const frame = () => new Promise(r => requestAnimationFrame(r));
    for (let i = 0; i < 30; i++) await frame();
    const side = styk.state.renderer.engineSide;
    await new Promise(r => setTimeout(r, 2000));
    globalThis.gc?.();
    const engineModule = side ? await import('/src/engine/engine.mjs') : null;
    return {refusal: styk.state.renderer.engineStats?.refusal ?? null,
      wasmMiB: side ? +(side.engine.memoryBytes / 1048576).toFixed(1) : 0,
      heapMiB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(1)};
  });
  const metrics = await app.evaluate(({app}) => app.getAppMetrics().map(m => ({type: m.type, ws: m.memory.workingSetSize, priv: m.memory.privateBytes ?? null})));
  const total = metrics.reduce((sum, m) => sum + m.ws, 0) / 1024;
  const renderer = metrics.filter(m => m.type === 'Tab').reduce((sum, m) => sum + m.ws, 0) / 1024;
  await app.close(); rmSync(profile, {recursive: true, force: true});
  return {...info, totalWorkingSetMiB: +total.toFixed(0), rendererWorkingSetMiB: +renderer.toFixed(0)};
}
for (const file of process.argv.slice(2)) console.log(path.basename(file), JSON.stringify(await measure(file)));
