/** Isolate prepared draw execution from worker rasterization and GPU uploads. */
import {chromium} from 'playwright';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
const source = process.argv[2] || 'C:/Users/aleri/Downloads/16 Akane vs Akato Segundo round (3).piv';
const output = path.join(process.cwd(), 'artifacts', 'renderer-gpu-isolation'); await mkdir(output, {recursive: true});
const browser = await chromium.launch({channel: 'chrome', headless: true});
try {
  const page = await browser.newPage({viewport: {width: 1600, height: 1000}}), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.STYK_URL || 'http://127.0.0.1:47831'); await page.waitForFunction(() => window.styk?.ready);
  await page.evaluate(() => styk.editor.markSaved()); await page.locator('#file-input').setInputFiles(source);
  await page.waitForFunction(name => !styk.state.importing && styk.editor.name === name, path.basename(source, '.piv'), {timeout: 180000});
  const result = await page.evaluate(async () => {
    const {createRenderer} = await import('/src/renderer.mjs'), {PlaybackCache} = await import('/src/playback.mjs');
    styk.editor.markSaved(); styk.fit(); await new Promise(resolve => setTimeout(resolve, 2500));
    const report = styk.editor.report, view = {...styk.state.view}, original = styk.state.renderer;
    styk.state.playback?.dispose();
    const canvas = document.createElement('canvas'); document.body.append(canvas);
    Object.assign(canvas.style, {position: 'fixed', inset: '0', zIndex: 100000});
    const renderer = await createRenderer(canvas, {resources: original.resources}); renderer.resize(original.width, original.height, original.dpr);
    const playback = new PlaybackCache({maxFrames: 1}), rows = []; playback.load(report, {scale: view.scale * original.dpr});
    try {
      for (const tick of [535, 536, 1792, 1800, 1809, 1810, 1850, 1851]) {
        const start = performance.now(); await playback.prepareRange([tick]); const packet = playback.get(tick), workerDeliveredMs = performance.now() - start;
        await renderer.prepareBackgrounds(report, packet.frame);
        const uploadStart = performance.now(), key = renderer.prepareFrame(packet, {report, view}), uploadCPU = performance.now() - uploadStart;
        await renderer.device.queue.onSubmittedWorkDone(); const uploadFenceMs = performance.now() - uploadStart;
        const frame = renderer.preparedFrames.frames.get(key), commands = frame.commands;
        const row = {tick, packetBytes: packet.byteLength, compileMs: packet.compileMs, workerDeliveredMs, uploadCPU, uploadFenceMs,
          shapes: packet.shapeCount, objects: packet.objectCount, compatibilityObjects: packet.compatibility.length, commands: commands.length, modes: {}};
        for (let i = 0; i < packet.shapes.length; i += 24) { const mode = packet.shapes[i + 20]; row.modes[mode] = (row.modes[mode] || 0) + 1; }
        for (const mode of ['all', 'vectors', 'textures']) {
          frame.commands = commands.filter(command => mode === 'all' || (mode === 'textures') === Boolean(command.texture));
          const samples = [];
          for (let i = 0; i < 5; i++) { const t = performance.now(); renderer.renderPrepared(key, {report, view}); const cpuMs = performance.now() - t; await renderer.device.queue.onSubmittedWorkDone(); samples.push({cpuMs, completedMs: performance.now() - t}); }
          row[mode] = samples;
        }
        frame.commands = commands; renderer.renderPrepared(key, {report, view}); await renderer.device.queue.onSubmittedWorkDone();
        row.png = canvas.toDataURL('image/png'); rows.push(row);
      }
      return {view, dpr: original.dpr, viewport: [original.width, original.height], adapter: renderer.stats.adapter, rows};
    } finally {playback.dispose(); renderer.destroy(); canvas.remove();}
  });
  for (const row of result.rows) { await writeFile(path.join(output, `${row.tick}.png`), Buffer.from(row.png.split(',')[1], 'base64')); delete row.png; }
  await writeFile(path.join(output, 'report.json'), JSON.stringify({...result, errors, limitation: 'Queue fence wall time includes callback scheduling, not a GPU timestamp. Worker is idle while each existing packet is repeatedly drawn.'}, null, 2));
  console.log(JSON.stringify({...result, errors}, null, 2));
} finally {await browser.close();}
