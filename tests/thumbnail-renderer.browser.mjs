import { chromium } from "playwright";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } }),
  checks = [],
  errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const check = (label, value) => {
  assert.ok(value, label);
  checks.push(label);
  console.log("PASS", label);
};
try {
  await page.goto("http://127.0.0.1:47831");
  await page.waitForFunction(() => window.styk?.ready);
  await page.evaluate(async () => {
    const { ThumbnailRenderer } = await import("/src/thumbnail-renderer.mjs");
    const { Editor } = await import("/src/editor.mjs");
    window.previewEditor = new Editor({ demo: true });
    window.previewRenderer = new ThumbnailRenderer(window.previewEditor);
    const canvas = (window.previewCanvas = document.createElement("canvas"));
    canvas.id = "worker-preview";
    canvas.width = 200;
    canvas.height = 120;
    canvas.style.cssText =
      "position:fixed;left:250px;top:100px;z-index:60;border:1px solid #aaa";
    document.body.append(canvas);
    window.pixels = () => [
      ...canvas.getContext("2d").getImageData(0, 0, 200, 120).data,
    ];
    window.firstRendered = await previewRenderer.renderThumbnail(0, canvas);
  });
  check(
    "Worker renders native scene into a transferable thumbnail",
    await page.evaluate(
      () =>
        firstRendered &&
        pixels().some(
          (v, i, a) =>
            i % 4 === 0 &&
            v < 100 &&
            a[i + 1] < 100 &&
            a[i + 2] < 100 &&
            a[i + 3] > 200,
        ),
    ),
  );
  check(
    "Snapshot chunks remain below 64 KiB",
    await page.evaluate(
      () =>
        previewRenderer.stats.maxChunkBytes <= 65536 &&
        previewRenderer.stats.snapshots === 1,
    ),
  );
  check(
    "Repeated rendering reuses worker document",
    await page.evaluate(async () => {
      await previewRenderer.renderThumbnail(1, previewCanvas);
      return (
        previewRenderer.stats.snapshots === 1 &&
        previewRenderer.stats.renders === 2
      );
    }),
  );
  check(
    "Pose edits transfer a frame patch and update pixels",
    await page.evaluate(async () => {
      await previewRenderer.renderThumbnail(0, previewCanvas);
      const before = pixels().join();
      previewEditor.transaction("Move figure", (frame) => {
        frame.objects[0].root_x -= 250;
      });
      await previewRenderer.renderThumbnail(0, previewCanvas);
      return (
        previewRenderer.stats.snapshots === 1 &&
        previewRenderer.stats.patches === 1 &&
        before !== pixels().join()
      );
    }),
  );
  check(
    "Paused preview requests do no work",
    await page.evaluate(async () => {
      const before = previewRenderer.stats.renders;
      previewRenderer.setPaused(true);
      const value = await previewRenderer.renderThumbnail(0, previewCanvas);
      previewRenderer.setPaused(false);
      return value === false && before === previewRenderer.stats.renders;
    }),
  );
  check(
    "Aborted request does not paint or cache a blank frame",
    await page.evaluate(async () => {
      const before = pixels().join(),
        controller = new AbortController();
      controller.abort();
      return (
        (await previewRenderer.renderThumbnail(0, previewCanvas, {
          signal: controller.signal,
        })) === false && before === pixels().join()
      );
    }),
  );
  check(
    "Worker queue is bounded at eight requests",
    await page.evaluate(async () => {
      const pending = Array.from({ length: 40 }, () =>
        previewRenderer.renderThumbnail(0, previewCanvas),
      );
      const maximum = previewRenderer.stats.pending;
      const results = await Promise.all(pending);
      return maximum === 8 && results.filter(Boolean).length === 8;
    }),
  );
  check(
    "Definition changes patch actual figure appearance",
    await page.evaluate(async () => {
      const before = pixels().join();
      previewEditor.report.figure_types[0].segments.forEach(
        (segment) => (segment.color_rgb = [240, 20, 20]),
      );
      previewEditor._emit("edit", { definition: true });
      await previewRenderer.renderThumbnail(0, previewCanvas);
      return (
        pixels().join() !== before && previewRenderer.stats.snapshots === 1
      );
    }),
  );
  check(
    "Structural frame edit rebuilds the mirror",
    await page.evaluate(async () => {
      previewEditor.addFrame();
      await previewRenderer.renderThumbnail(1, previewCanvas);
      return previewRenderer.stats.snapshots === 2;
    }),
  );
  check(
    "Hidden user layers disappear from worker thumbnails",
    await page.evaluate(async () => {
      previewEditor.setLayerVisible("layer-1", false);
      await previewRenderer.renderThumbnail(0, previewCanvas);
      return pixels().every((value, index) => index % 4 === 3 || value >= 245);
    }),
  );
  check(
    "Hidden Scene leaves the thumbnail surround transparent",
    await page.evaluate(async () => {
      previewEditor.setLayerVisible("scene", false);
      await previewRenderer.renderThumbnail(0, previewCanvas);
      const center = previewCanvas
        .getContext("2d")
        .getImageData(100, 60, 1, 1).data;
      previewEditor.setLayerVisible("scene", true);
      previewEditor.setLayerVisible("layer-1", true);
      return center[0] === 245 && center[1] === 245 && center[2] === 245;
    }),
  );
  check(
    "Hidden Camera uses the untransformed native viewport",
    await page.evaluate(async () => {
      previewEditor.selectFrame(0);
      previewEditor.transaction("Camera move", (frame) => {
        frame.camera = {
          is_default: false,
          x: 150,
          y: 0,
          scale: 1,
          angle_rad: 0,
        };
      });
      await previewRenderer.renderThumbnail(0, previewCanvas);
      const moved = pixels().join();
      previewEditor.setLayerVisible("camera", false);
      await previewRenderer.renderThumbnail(0, previewCanvas);
      return moved !== pixels().join();
    }),
  );
  check(
    "Native embedded image and text decode and render inside worker",
    await page.evaluate(async () => {
      const { imageFileToFigure } = await import("/src/media-authoring.mjs"),
        { createTextFigure } = await import("/src/text-authoring.mjs"),
        { createObject, createFrame } = await import("/src/demo.mjs");
      const source = document.createElement("canvas");
      source.width = source.height = 80;
      const context = source.getContext("2d");
      context.fillStyle = "#f00010";
      context.fillRect(0, 0, 80, 80);
      const blob = await new Promise((resolve) => source.toBlob(resolve));
      const image = await imageFileToFigure(
        new File([blob], "Red.png", { type: "image/png" }),
        { preserveOpaqueBackground: true },
      );
      image.figure_type_id = 80;
      const text = await createTextFigure({
        text: "Aa",
        fontSize: 70,
        color: [20, 80, 200],
      });
      text.figure_type_id = 81;
      const report = structuredClone(previewEditor.report);
      report.canvas_width = 320;
      report.canvas_height = 180;
      report.figure_types = [image, text];
      report.keyframes = [
        createFrame([
          createObject(image, 800, 50, 90),
          createObject(text, 801, 170, 80),
        ]),
      ];
      delete report._styk;
      previewEditor.load(report, "Media test");
      await previewRenderer.renderThumbnail(0, previewCanvas);
      const data = pixels();
      let red = false,
        blue = false;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > 180 && data[i + 1] < 60 && data[i + 2] < 60) red = true;
        if (data[i] < 70 && data[i + 1] < 130 && data[i + 2] > 160) blue = true;
      }
      return (
        red &&
        blue &&
        previewRenderer.stats.mediaBytes > 0 &&
        previewRenderer.stats.mediaBytes <= 24 * 1024 * 1024
      );
    }),
  );
  await page.screenshot({ path: "artifacts/thumbnail-worker-media.png" });
  const stress = await page.evaluate(async () => {
    const { defaultFigure, createObject, createFrame } = await import(
      "/src/demo.mjs"
    );
    const figure = defaultFigure(1),
      report = structuredClone(previewEditor.report);
    report.canvas_width = 960;
    report.canvas_height = 540;
    report.figure_types = [figure];
    report.keyframes = [
      createFrame(
        Array.from({ length: 20000 }, (_, i) =>
          createObject(figure, i + 1, (i % 100) * 10, Math.floor(i / 100) * 3),
        ),
      ),
    ];
    delete report._styk;
    previewEditor.load(report, "20k figures");
    const tasks = [];
    const observer = new PerformanceObserver((list) =>
      tasks.push(...list.getEntries().map((e) => e.duration)),
    );
    observer.observe({ type: "longtask" });
    const before = performance.now();
    await previewRenderer.renderThumbnail(0, previewCanvas);
    await new Promise((resolve) => setTimeout(resolve, 50));
    observer.disconnect();
    return {
      elapsedMs: performance.now() - before,
      ...previewRenderer.stats,
      longTasks: tasks,
    };
  });
  check(
    "20,000 figure thumbnail completes with bounded transport tasks",
    stress.renders > 0 &&
      stress.maxChunkBytes <= 65536 &&
      stress.maxMainTaskMs < 50,
  );
  check(
    "Large native frame evaluation causes no UI long task",
    stress.longTasks.length === 0,
  );
  check(
    "Cancellation during render leaves worker reusable",
    await page.evaluate(async () => {
      const controller = new AbortController(),
        pending = previewRenderer.renderThumbnail(0, previewCanvas, {
          signal: controller.signal,
        });
      setTimeout(() => controller.abort(), 5);
      const cancelled = await pending;
      const next = await previewRenderer.renderThumbnail(0, previewCanvas);
      return cancelled === false && next === true;
    }),
  );
  check(
    "Destroyed renderer refuses new work",
    await page.evaluate(async () => {
      previewRenderer.destroy();
      return (
        (await previewRenderer.renderThumbnail(0, previewCanvas)) === false &&
        previewRenderer.pending.size === 0
      );
    }),
  );
  check("No browser errors", errors.length === 0);
  await writeFile(
    "artifacts/thumbnail-worker-verification.json",
    JSON.stringify({ checks, stress, errors }, null, 2),
  );
} finally {
  await browser.close();
}
