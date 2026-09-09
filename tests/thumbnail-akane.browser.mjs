/** Real PIV regression for the isolated thumbnail worker. Requires the local app. */
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const source =
  process.argv[2] ||
  "C:/Users/aleri/Downloads/16 Akane vs Akato Segundo round (3).piv";
const origin = process.env.STYK_URL || "http://127.0.0.1:47831";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1560, height: 1000 } });
const errors = [],
  checks = [];
let measurement, importMs;
const check = (label, value) => {
  assert.ok(value, label);
  checks.push(label);
  console.log("PASS", label);
};
page.on("pageerror", (error) => errors.push(error.message));
await mkdir("artifacts", { recursive: true });
try {
  await page.goto(origin);
  await page.waitForFunction(() => window.styk?.ready);
  await page.evaluate(() => styk.editor.markSaved());
  const importStarted = performance.now();
  await page.locator("#file-input").setInputFiles(source);
  await page.waitForFunction(
    (name) => !styk.state.importing && styk.editor.name === name,
    path.basename(source, ".piv"),
    { timeout: 180000 },
  );
  importMs = performance.now() - importStarted;
  console.log("Native source imported in", Math.round(importMs), "ms");
  await page.waitForTimeout(2500);
  measurement = await page.evaluate(async () => {
    const { ThumbnailRenderer } = await import("/src/thumbnail-renderer.mjs");
    const editor = styk.editor;
    const previewErrors = [];
    const renderer = (window.akaneThumbnails = new ThumbnailRenderer(editor, {
      onError: (error) => previewErrors.push(error.message),
    }));
    const tasks = [],
      raf = [];
    const observer = new PerformanceObserver((list) =>
      tasks.push(
        ...list
          .getEntries()
          .map((entry) => ({
            start: entry.startTime,
            duration: entry.duration,
          })),
      ),
    );
    observer.observe({ type: "longtask" });
    let measuring = true,
      previous = performance.now();
    const watch = (now) => {
      raf.push(now - previous);
      previous = now;
      if (measuring) requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
    const snapshots = [];
    const snapshot = renderer._snapshot.bind(renderer);
    renderer._snapshot = async (...args) => {
      const start = performance.now(),
        alreadyLoaded = renderer.loadedVersion === args[0];
      await snapshot(...args);
      if (!alreadyLoaded) snapshots.push(performance.now() - start);
    };
    const indices = [
      0,
      Math.floor(editor.report.keyframes.length / 2),
      editor.report.keyframes.length - 1,
    ];
    const gallery = document.createElement("div");
    gallery.style.cssText =
      "position:fixed;left:285px;top:100px;z-index:80;display:flex;gap:16px;background:#fff;padding:16px;border:1px solid #ddd;box-shadow:0 4px 20px #0003;border-radius:8px;";
    document.body.append(gallery);
    const frames = [];
    const canvasPixels = (canvas) => {
      const pixels = canvas
        .getContext("2d")
        .getImageData(0, 0, canvas.width, canvas.height).data;
      let hash = 2166136261,
        opaque = 0,
        dark = 0;
      const colors = new Set();
      for (let i = 0; i < pixels.length; i += 4) {
        hash = Math.imul(hash ^ pixels[i], 16777619);
        hash = Math.imul(hash ^ pixels[i + 1], 16777619);
        hash = Math.imul(hash ^ pixels[i + 2], 16777619);
        if (pixels[i + 3] > 200) opaque++;
        if (
          pixels[i] < 160 &&
          pixels[i + 1] < 160 &&
          pixels[i + 2] < 160 &&
          pixels[i + 3] > 200
        )
          dark++;
        colors.add((pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2]);
      }
      return { hash: hash >>> 0, opaque, dark, colors: colors.size };
    };
    const started = performance.now();
    for (const index of indices) {
      const wrapper = document.createElement("figure"),
        canvas = document.createElement("canvas"),
        label = document.createElement("figcaption");
      wrapper.style.margin = "0";
      canvas.width = 240;
      canvas.height = 144;
      canvas.style.cssText = "display:block;border:1px solid #ddd";
      label.textContent = `Native key ${index + 1}`;
      label.style.cssText = "padding-top:6px;font:12px Segoe UI;color:#555";
      wrapper.append(canvas, label);
      gallery.append(wrapper);
      const frameStarted = performance.now(),
        rendered = await renderer.renderThumbnail(index, canvas);
      frames.push({
        index,
        rendered,
        elapsedMs: performance.now() - frameStarted,
        workerMs: renderer.stats.lastRenderMs,
        ...canvasPixels(canvas),
      });
    }
    const repeated = document.createElement("canvas");
    repeated.width = 240;
    repeated.height = 144;
    const statsBeforeRepeat = { ...renderer.stats };
    const repeatStarted = performance.now(),
      repeatRendered = await renderer.renderThumbnail(indices[2], repeated);
    const repeat = {
      rendered: repeatRendered,
      elapsedMs: performance.now() - repeatStarted,
      ...canvasPixels(repeated),
    };
    await new Promise((resolve) => setTimeout(resolve, 100));
    measuring = false;
    observer.disconnect();
    const result = {
      definitions: editor.report.figure_types.length,
      keyframes: editor.report.keyframes.length,
      snapshots,
      elapsedMs: performance.now() - started,
      frames,
      repeat,
      statsBeforeRepeat,
      stats: { ...renderer.stats },
      longTasks: tasks,
      rafMaxMs: Math.max(...raf),
      previewErrors,
    };
    renderer.destroy();
    return result;
  });
  await page.screenshot({ path: "artifacts/thumbnail-akane.png" });
  check(
    "Actual Akane source includes 881 definitions and 1,479 native keys",
    measurement.definitions === 881 && measurement.keyframes === 1479,
  );
  check(
    "Three native key thumbnails render successfully",
    measurement.frames.length === 3 &&
      measurement.frames.every((frame) => frame.rendered),
  );
  check(
    "Native artwork is visible in each thumbnail",
    measurement.frames.every(
      (frame) => frame.opaque > 30000 && frame.colors > 20 && frame.dark > 5,
    ),
  );
  check(
    "Different native keys produce distinct scene pixels",
    new Set(measurement.frames.map((frame) => frame.hash)).size === 3,
  );
  check(
    "All keys and repeated rendering reuse one worker snapshot",
    measurement.stats.snapshots === 1 &&
      measurement.stats.patches === 0 &&
      measurement.snapshots.length === 1 &&
      measurement.stats.chunks === measurement.statsBeforeRepeat.chunks,
  );
  check(
    "Repeated native key renders identical pixels",
    measurement.repeat.rendered &&
      measurement.repeat.hash === measurement.frames[2].hash,
  );
  check(
    "Snapshot transport packets stay within 64 KiB",
    measurement.stats.maxChunkBytes <= 65536,
  );
  check(
    "Snapshot main-thread preparation stays below 50 ms",
    measurement.stats.maxMainTaskMs < 50,
  );
  check(
    "Snapshot and frame evaluation produce no main-thread long tasks",
    measurement.longTasks.length === 0,
  );
  check(
    "Worker queue drains and media memory stays bounded",
    measurement.stats.pending === 0 &&
      measurement.stats.mediaBytes <= 24 * 1024 * 1024,
  );
  check(
    "No thumbnail worker or browser errors",
    measurement.previewErrors.length === 0 && errors.length === 0,
  );
} finally {
  await writeFile(
    "artifacts/thumbnail-akane-verification.json",
    JSON.stringify(
      {
        source,
        importMs,
        checks,
        measurement,
        errors,
        limitation:
          "Headless Chrome on one Windows machine. Main-thread long-task observer covers thumbnail work after import settles; import timing is recorded separately.",
      },
      null,
      2,
    ),
  );
  await browser.close();
}
