/** Actual browser workers and decoded output pixels; no WebGPU app is started. */
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import backend from "../desktop/backend.cjs";
const output = path.resolve("artifacts/export-sampling");
await mkdir(output, { recursive: true });
const service = await backend.startBackend({ appRoot: process.cwd() });
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(service.origin + "/api/health");
  const result = await page.evaluate(async () => {
    const [
      { ExportFrameRenderer },
      { samplingFixture },
      { exportFrameGeometry, drawExportScene },
      { PlaybackResources },
      { exportAnimation },
    ] = await Promise.all([
      import("/src/export-frame-renderer.mjs"),
      import("/tests/export-sampling-fixture.mjs"),
      import("/src/export-frame-core.mjs"),
      import("/src/playback-resources.mjs"),
      import("/src/image-export.mjs"),
    ]);
    const checks = [],
      metrics = [],
      images = [],
      files = [];
    const check = (name, ok) => {
      if (!ok) throw new Error(name);
      checks.push(name);
    };
    const pixels = (c) =>
      c
        .getContext("2d", { willReadFrequently: true })
        .getImageData(0, 0, c.width, c.height).data;
    const summary = (a) => {
      const alphas = new Set();
      let partial = 0,
        visible = 0;
      for (let i = 3; i < a.length; i += 4) {
        alphas.add(a[i]);
        if (a[i] > 0) visible++;
        if (a[i] > 0 && a[i] < 255) partial++;
      }
      return { alphas: [...alphas].sort((a, b) => a - b), partial, visible };
    };
    const error = (a, b) => {
      let max = 0,
        sum = 0,
        changed = 0;
      for (let i = 0; i < a.length; i++) {
        const d = Math.abs(a[i] - b[i]);
        max = Math.max(max, d);
        sum += d;
        if (d) changed++;
      }
      return { max, mean: sum / a.length, changed };
    };
    const source = document.createElement("canvas");
    source.width = source.height = 8;
    const sc = source.getContext("2d");
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        sc.fillStyle = (x + y) % 2 ? "#fff" : "#000";
        sc.fillRect(x, y, 1, 1);
      }
    const spriteURL = source.toDataURL();
    let lastReport;
    for (const kind of [
      "line",
      "circle",
      "circleFill",
      "squareLine",
      "poly",
      "curve",
      "outline",
      "text",
      "image",
    ]) {
      const report = samplingFixture({ kind, spriteURL });
      lastReport = report;
      const saved = {};
      for (const smoothing of ["edges", "none", "sprites"]) {
        const renderer = new ExportFrameRenderer({
          width: 128,
          height: 96,
          smoothing,
        });
        try {
          await renderer.load(report);
          const canvas = await renderer.renderTick(0);
          saved[smoothing] = new Uint8ClampedArray(pixels(canvas));
          const stat = summary(saved[smoothing]);
          metrics.push({
            kind,
            smoothing,
            ...stat,
            worker: { ...renderer.stats },
          });
          check(
            kind +
              " " +
              smoothing +
              " renders visible pixels at requested dimensions",
            canvas.width === 128 && canvas.height === 96 && stat.visible > 20,
          );
          if (kind === "line" || kind === "image" || kind === "text")
            images.push({
              name: kind + "-" + smoothing + ".png",
              url: canvas.toDataURL(),
            });
          const svg = await renderer.renderSVGTick(0);
          check(
            kind +
              " " +
              smoothing +
              " vector export keeps resolution-independent geometry",
            !(await svg.text()).includes('shape-rendering="crispEdges"'),
          );
          if (smoothing === "sprites") {
            const resources = new PlaybackResources();
            const geometry = exportFrameGeometry(report, report.keyframes[0]);
            await resources.preload(geometry.drawables);
            const high = new OffscreenCanvas(256, 192);
            drawExportScene(
              high.getContext("2d"),
              report,
              report.keyframes[0],
              geometry,
              resources,
            );
            const hp = pixels(high),
              ap = saved.sprites;
            let maximum = 0;
            for (let y = 0; y < 96; y++)
              for (let x = 0; x < 128; x++) {
                const ids = [
                    (2 * y * 256 + 2 * x) * 4,
                    (2 * y * 256 + 2 * x + 1) * 4,
                    ((2 * y + 1) * 256 + 2 * x) * 4,
                    ((2 * y + 1) * 256 + 2 * x + 1) * 4,
                  ],
                  i = (y * 128 + x) * 4;
                const alpha = ids.reduce((sum, j) => sum + hp[j + 3], 0) / 4;
                maximum = Math.max(maximum, Math.abs(alpha - ap[i + 3]));
                for (let c = 0; c < 3; c++) {
                  const average =
                    ids.reduce(
                      (sum, j) => sum + (hp[j + c] * hp[j + 3]) / 255,
                      0,
                    ) / 4;
                  maximum = Math.max(
                    maximum,
                    Math.abs(average - (ap[i + c] * ap[i + 3]) / 255),
                  );
                }
              }
            metrics.push({
              kind,
              comparison: "native2xBox",
              maximumPremultipliedChannelError: maximum,
            });
            check(
              kind + " 2× filter matches independent premultiplied box average",
              maximum <= 2,
            );
            resources.dispose();
          }
          if (smoothing === "edges") {
            const resources = new PlaybackResources();
            await resources.preload(
              exportFrameGeometry(report, report.keyframes[0]).drawables,
            );
            const baseline = document.createElement("canvas");
            baseline.width = 128;
            baseline.height = 96;
            drawExportScene(
              baseline.getContext("2d"),
              report,
              report.keyframes[0],
              exportFrameGeometry(report, report.keyframes[0]),
              resources,
            );
            const difference = error(saved.edges, pixels(baseline));
            check(
              kind + " worker matches direct native geometry rendering",
              difference.max <= 1,
            );
            resources.dispose();
          }
        } finally {
          renderer.dispose();
        }
      }
      {
        check(
          kind + " no smoothing removes edge antialiasing",
          summary(saved.none).partial === 0,
        );
        check(
          kind + " smooth edges keeps coverage alpha",
          summary(saved.edges).partial > 10,
        );
      }
      check(
        kind + " supersampling changes subpixel coverage",
        error(saved.edges, saved.sprites).changed > 0,
      );
      if (kind === "image") {
        const grays = (a) => {
          let n = 0;
          for (let i = 0; i < a.length; i += 4)
            if (a[i + 3] === 255 && a[i] > 0 && a[i] < 255) n++;
          return n;
        };
        check("No smoothing keeps nearest sprite pixels", grays(saved.none) === 0);
        check(
          "rotated sprites gain interior filtered pixels at 2×",
          grays(saved.sprites) > grays(saved.edges) + 20,
        );
      }
    }
    const alphaSource = document.createElement('canvas'); alphaSource.width = alphaSource.height = 8;
    const alphaContext = alphaSource.getContext('2d'), alphaPixels = alphaContext.createImageData(8,8);
    const levels = [0,64,128,255];
    for (let y=0;y<8;y++) for(let x=0;x<8;x++) {const i=(y*8+x)*4;alphaPixels.data.set([50,100,150,levels[x%4]],i);}
    alphaContext.putImageData(alphaPixels,0,0);
    for (const [name,scale,opacity] of [['source-alpha',1,1],['source-alpha-opacity',1,.5],['minified-source-alpha',.1,1]]) {
      const document = samplingFixture({kind:'image',spriteURL:alphaSource.toDataURL(),opacity});
      document.keyframes[0].objects[0].scale = scale;
      const r = new ExportFrameRenderer({width:128,height:96,smoothing:'none'});
      try {
        await r.load(document); const actual = pixels(await r.renderTick(0)), a = summary(actual);
        const expected = levels.map(alpha=>Math.round(alpha*(opacity===1?1:127/255)));
        check(name+' retains sampled alpha without coverage ramps',a.visible>0&&a.alphas.every(alpha=>expected.includes(alpha)));
        const sprite = exportFrameGeometry(document, document.keyframes[0]).drawables.find(s=>s.type==='image');
        const cos=Math.cos(sprite.angle),sin=Math.sin(sprite.angle),zoom=Math.hypot(sprite.end.x-sprite.start.x,sprite.end.y-sprite.start.y)/8;
        let mismatches=0,compared=0;
        for(let y=0;y<96;y++)for(let x=0;x<128;x++){
          const dx=x+.5-sprite.start.x,dy=y+.5-sprite.start.y,sx=(dx*cos+dy*sin)/zoom,sy=(-dx*sin+dy*cos)/zoom;
          // Edge tie-breaking is renderer-specific; compare samples away from ties.
          if([sx,sy].some(v=>Math.abs(v-Math.round(v))<.002))continue;
          const alpha=sx>=0&&sy>=0&&sx<8&&sy<8?expected[Math.floor(sx)%4]:0;
          if(Math.abs(actual[(y*128+x)*4+3]-alpha)>1)mismatches++;compared++;
        }
        check(name+' matches independent nearest inverse-transform samples',mismatches===0);
        metrics.push({name,...a,compared,mismatches});
      } finally {r.dispose();}
    }
    const report = samplingFixture({ opacity: 0.5 });
    const r = new ExportFrameRenderer({
      width: 128,
      height: 96,
      smoothing: "none",
    });
    try {
      await r.load(report);
      const a = summary(pixels(await r.renderTick(0)));
      metrics.push({ name: "translucent-no-smoothing", ...a });
      check(
        "No smoothing preserves intended segment opacity",
        a.alphas.length === 2 && a.alphas.includes(127),
      );
      const override = structuredClone(report.keyframes[0]);
      override.objects[0].root_x += 20;
      const before = new Uint8ClampedArray(pixels(r.canvas));
      await r.renderFrame(override);
      check(
        "current unsaved frame override renders without altering stored frame",
        error(before, pixels(r.canvas)).changed > 50 &&
          report.keyframes[0].objects[0].root_x === 30.3,
      );
    } finally {
      r.dispose();
    }
    const gradient = samplingFixture({ gradient: true }),
      group = samplingFixture();
    group.figure_types[0].segments.push({
      ...group.figure_types[0].segments[0],
      segment_id: 2,
      angle_rad: -0.5,
    });
    group.keyframes[0].objects[0].angles.push(-0.5);
    group.keyframes[0].objects[0].field28 = 128;
    for (const [name, document] of [
      ["gradient", gradient],
      ["group", group],
    ]) {
      const r = new ExportFrameRenderer({
        width: 128,
        height: 96,
        smoothing: "none",
      });
      try {
        await r.load(document);
        const a = summary(pixels(await r.renderTick(0)));
        check(
          name + " no smoothing keeps native alpha semantics",
          name === "gradient"
            ? a.alphas.length > 20
            : Math.max(...a.alphas) === 127,
        );
        metrics.push({ name: "no-smoothing-" + name, ...a });
      } finally {
        r.dispose();
      }
    }
    for (const smoothing of ["edges", "none", "sprites"]) {
      const r = new ExportFrameRenderer({ width: 128, height: 96, smoothing });
      try {
        await r.load(lastReport);
        for (const format of [
          "gif",
          "apng",
          "png-sequence",
          "jpeg-sequence",
          "gif-sequence",
          "svg-sequence",
        ]) {
          const blob = await exportAnimation({
            format,
            width: 128,
            height: 96,
            fps: 12,
            totalFrames: 3,
            renderFrame: (i) => r.renderTick(i),
            renderSVGFrame: (i) => r.renderSVGTick(i),
          });
          check(
            format + " " + smoothing + " encodes three worker-rendered frames",
            blob.size > 50,
          );
          metrics.push({ format, smoothing, bytes: blob.size });
          files.push({
            name:
              format +
              "-" +
              smoothing +
              (format.endsWith("sequence") ? ".zip" : "." + format),
            bytes: [...new Uint8Array(await blob.arrayBuffer())],
          });
        }
      } finally {
        r.dispose();
      }
    }
    const dense = samplingFixture();
    dense.canvas_width = 512;
    dense.canvas_height = 384;
    const original = dense.keyframes[0].objects[0];
    dense.keyframes[0].objects = Array.from({ length: 1000 }, (_, i) => ({
      ...original,
      unique_id: i + 1,
      object_slot: i,
      root_x: (i % 40) * 12,
      root_y: Math.floor(i / 40) * 14,
      scale: 0.12,
    }));
    dense.keyframes[0].object_draw_order = dense.keyframes[0].objects.map(
      (_, i) => i,
    );
    dense.keyframes[0].object_draw_order_unique_ids =
      dense.keyframes[0].objects.map((object) => object.unique_id);
    for (const smoothing of ["edges", "none", "sprites"]) {
      const entries = [],
        observer = new PerformanceObserver((list) =>
          entries.push(...list.getEntries()),
        );
      observer.observe({ type: "longtask" });
      const r = new ExportFrameRenderer({ width: 512, height: 384, smoothing }),
        began = performance.now();
      try {
        await r.load(dense);
        await r.renderTick(0);
        await new Promise((resolve) => setTimeout(resolve, 0));
        const longTasks = entries.filter((entry) => entry.startTime >= began);
        metrics.push({
          scenario: "1000figures",
          smoothing,
          stats: { ...r.stats },
          longTasks: longTasks.map((entry) => entry.duration),
        });
        check(
          smoothing + " 1000 figures export without a main-thread long task",
          longTasks.length === 0,
        );
        check(
          smoothing + " 1000 figures use bounded snapshots",
          r.stats.maxChunkBytes <= 65536 && r.stats.maxMainSnapshotMs < 16,
        );
      } finally {
        observer.disconnect();
        r.dispose();
      }
    }
    let revision = 1;
    const stale = new ExportFrameRenderer({
      width: 128,
      height: 96,
      getRevision: () => revision,
    });
    await stale.load(report);
    revision++;
    try {
      await stale.renderTick(0);
      check("changed revision rejects export", false);
    } catch (e) {
      check("changed revision rejects export", e.name === "AbortError");
    } finally {
      stale.dispose();
    }
    const controller = new AbortController(),
      cancelled = new ExportFrameRenderer({
        width: 128,
        height: 96,
        signal: controller.signal,
      });
    await cancelled.load(report);
    controller.abort();
    try {
      await cancelled.renderTick(0);
      check("cancel rejects renderer", false);
    } catch (e) {
      check("cancel rejects renderer", e.name === "AbortError");
    } finally {
      cancelled.dispose();
    }
    return { checks, metrics, images, files };
  });
  assert.deepEqual(errors, []);
  const { images, files, ...report } = result;
  for (const image of images)
    await writeFile(
      path.join(output, image.name),
      Buffer.from(image.url.split(",")[1], "base64"),
    );
  for (const file of files)
    await writeFile(path.join(output, file.name), Uint8Array.from(file.bytes));
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify({ ...report, errors }, null, 2),
  );
  console.log(JSON.stringify({ checks: report.checks.length, errors, output }));
} catch (error) {
  await writeFile(path.join(output, "failure.txt"), error.stack);
  throw error;
} finally {
  await browser?.close();
  await service.stop();
}
