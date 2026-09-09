/** Pixel proof for resuming editing with the already prepared vector packet. */
import {chromium} from 'playwright';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
const source = process.argv[2] || 'C:/Users/aleri/Downloads/16 Akane vs Akato Segundo round (3).piv';
const cameraEnabled = process.env.STYK_NEUTRAL_EDITOR !== '1';
const output = path.resolve(`artifacts/renderer-adoption${cameraEnabled ? '' : '-neutral'}`); await mkdir(output, {recursive: true});
const browser = await chromium.launch({channel: 'chrome', headless: true});
try {
  const page = await browser.newPage({viewport: {width: 1400, height: 950}}), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.STYK_URL || 'http://127.0.0.1:47831'); await page.waitForFunction(() => window.styk?.ready);
  await page.evaluate(() => styk.editor.markSaved()); await page.locator('#file-input').setInputFiles(source);
  await page.waitForFunction(name => !styk.state.importing && styk.editor.name === name, path.basename(source, '.piv'), {timeout: 180000});
  const rows = await page.evaluate(async cameraEnabled => {
    const {createRenderer} = await import('/src/renderer.mjs'), {PlaybackCache} = await import('/src/playback.mjs');
    const {buildGeometry, evaluatedFrame, timeline} = await import('/src/pivot/geometry.mjs');
    const report = styk.editor.report, resources = styk.state.renderer.resources, entries = timeline(report);
    const originalCanvas = document.createElement('canvas'), adoptedCanvas = document.createElement('canvas');
    const original = await createRenderer(originalCanvas, {resources}), adopted = await createRenderer(adoptedCanvas, {resources});
    const cache = new PlaybackCache({maxFrames: 2}), rows = [];
    const pixels = async png => {
      const image = new Image(); image.src = png; await image.decode();
      const surface = new OffscreenCanvas(image.width, image.height), ctx = surface.getContext('2d'); ctx.drawImage(image, 0, 0);
      return ctx.getImageData(0, 0, image.width, image.height).data;
    };
    try {
      for (const scale of [1, 2]) {
        const view = {x: 100, y: 80, scale}; original.resize(1120, 820, 1); adopted.resize(1120, 820, 1);
        cache.load(report, {scale});
        for (const tick of [535, 536, 1824, 1836, 1871]) {
          let index = entries.findLastIndex(entry => entry.start <= tick);
          const frame = evaluatedFrame(report, index, (tick - entries[index].start) / entries[index].count, tick);
          const geometry = buildGeometry(report, frame);
          await Promise.all([original.prepareBackgrounds(report, frame), adopted.prepareBackgrounds(report, frame)]);
          await cache.prepareRange([tick]); const packet = cache.get(tick);
          const images = geometry.drawables.filter(item => item.asset && item.type === 'image').map(item => resources.image(resources.url(item.asset))).filter(Boolean);
          await Promise.all(images.filter(image => !image.complete).map(image => image.decode()));
          const options = {report, frame, geometry, view, clipToCanvas: false, cameraEnabled};
          original.render(options); await original.device.queue.onSubmittedWorkDone(); const referencePNG = originalCanvas.toDataURL();
          adopted.render({...options, preparedPacket: packet}); await adopted.device.queue.onSubmittedWorkDone(); const adoptedPNG = adoptedCanvas.toDataURL();
          const a = await pixels(referencePNG), b = await pixels(adoptedPNG); let changedChannels = 0, maxDifference = 0;
          for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { changedChannels++; maxDifference = Math.max(maxDifference, Math.abs(a[i] - b[i])); }
          rows.push({tick, scale, cameraEnabled, changedChannels, maxDifference, adoptedObjects: adopted.stats.adoptedObjects,
            compiledObjects: adopted.stats.compiledObjects, copiedBytes: adopted.stats.adoptedVectorBytes, referencePNG, adoptedPNG});
        }
      }
    } finally {cache.dispose(); original.destroy(); adopted.destroy();}
    return rows;
  }, cameraEnabled);
  for (const row of rows) for (const field of ['referencePNG', 'adoptedPNG']) {
    await writeFile(path.join(output, `${row.tick}-${row.scale}x-${field}.png`), Buffer.from(row[field].split(',')[1], 'base64')); delete row[field];
  }
  await writeFile(path.join(output, 'report.json'), JSON.stringify({rows, errors, limitation: 'Ten real Akane frames/views, with off-artboard content visible, compared to independent fresh editor vector compilation on one GPU.'}, null, 2));
  console.log(JSON.stringify({rows, errors}, null, 2));
  if (errors.length || rows.some(row => row.changedChannels || !row.adoptedObjects)) throw new Error('Prepared vector adoption changed editor pixels.');
} finally {await browser.close();}
