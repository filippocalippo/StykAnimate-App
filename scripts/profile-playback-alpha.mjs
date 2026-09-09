/** Isolated audit of alpha trimming; this does not change production packets. */
import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const source = process.argv[2] || 'C:/Users/aleri/Downloads/16 Akane vs Akato Segundo round (3).piv';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`${process.env.STYK_URL || 'http://127.0.0.1:47831'}/api/health`);
  await page.evaluate(() => { document.body.innerHTML = '<input id="source" type="file">'; });
  await page.locator('#source').setInputFiles(source);
  const result = await page.evaluate(async () => {
    const { ImportClient } = await import('/src/import-client.mjs');
    const { PlaybackCache } = await import('/src/playback.mjs');
    const importer = new ImportClient(), cache = new PlaybackCache();
    try {
      const imported = await importer.importFile(document.querySelector('#source').files[0]); cache.load(imported.document, { scale: 2 });
      await cache.prepareRange([1824]); const packet = cache.get(1824), rows = [];
      for (const entry of packet.compatibility) {
        const start = performance.now(), width = entry.bitmap.width, height = entry.bitmap.height;
        const canvas = new OffscreenCanvas(width, height), ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(entry.bitmap, 0, 0); const data = ctx.getImageData(0, 0, width, height).data, readAt = performance.now();
        let x0 = width, y0 = height, x1 = -1, y1 = -1;
        for (let y = 0; y < height; y++) {
          const offset = y * width * 4;
          for (let x = 0; x < width; x++) if (data[offset + x * 4 + 3]) {
            x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
          }
        }
        const scanAt = performance.now();
        const pixels = x1 < 0 ? 0 : (Math.min(width, x1 + 3) - Math.max(0, x0 - 2)) * (Math.min(height, y1 + 3) - Math.max(0, y0 - 2));
        rows.push({ uid: entry.uid, originalPixels: width * height, alphaBoundPixels: pixels, readMs: readAt - start, scanMs: scanAt - readAt });
      }
      return { tick: 1824, scale: 2, packetBytes: packet.byteLength, compileMs: packet.compileMs, clipping: packet.clipping, rows,
        savedBytes: rows.reduce((sum, row) => sum + (row.originalPixels - row.alphaBoundPixels) * 4, 0),
        readMs: rows.reduce((sum, row) => sum + row.readMs, 0), scanMs: rows.reduce((sum, row) => sum + row.scanMs, 0) };
    } finally { importer.dispose(); cache.dispose(); }
  });
  await mkdir('artifacts', { recursive: true });
  await writeFile(path.join('artifacts', 'playback-alpha-audit.json'), JSON.stringify({ measuredAt: new Date().toISOString(), ...result,
    note: 'Read-only diagnostic in an isolated browser. Production playback performs stage-bound cropping without per-frame pixel readback or alpha scans.' }, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
