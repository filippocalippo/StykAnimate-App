/** Real Camera action, worker/native PIV export, source assets and GPU pixels. */
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import backend from "../desktop/backend.cjs";
const output = path.resolve("artifacts/camera-bake-authored");
await mkdir(output, { recursive: true });
const service = process.env.STYK_URL
  ? null
  : await backend.startBackend({ appRoot: process.cwd() });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 980 } }),
  checks = [],
  errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const check = (name, value) => {
  assert.ok(value, name);
  checks.push(name);
  console.log("PASS", name);
};
async function download(action, name) {
  const pending = page.waitForEvent("download");
  await action();
  const file = await pending,
    target = path.join(output, name);
  await file.saveAs(target);
  return target;
}
try {
  await page.goto(process.env.STYK_URL || service.origin);
  await page.waitForFunction(() => window.styk?.ready);
  await page.evaluate(async () => {
    const { cameraBakeFixture } = await import(
      "/tests/camera-bake-fixture.mjs"
    );
    styk.editor.load(cameraBakeFixture(), "Authored camera conversion");
    styk.editor.seek(5);
    styk.editor.select(2, 3);
    styk.fit();
    window.cameraBakeBefore = structuredClone(styk.editor.report);
    window.cameraBakeHistory = styk.editor._undo.length;
  });
  await page
    .locator('.styk-tree-row[data-kind="camera"] .styk-tree-name')
    .click();
  await page.locator('#inspector [data-action="camera-apply-figures"]').click();
  check(
    "Actual Camera inspector converts the displayed inbetween with one undo",
    await page.evaluate(() => {
      const e = styk.editor;
      return (
        e.tick === 5 &&
        e._undo.length === cameraBakeHistory + 1 &&
        e.evaluatedFrame.camera.x === 0 &&
        e.evaluatedFrame.camera.scale === 1
      );
    }),
  );
  check(
    "Actual command preserves native keyframes and retained sources",
    await page.evaluate(
      () =>
        JSON.stringify(styk.editor.report.keyframes) ===
          JSON.stringify(cameraBakeBefore.keyframes) &&
        JSON.stringify(styk.editor.report._styk.frameSources) ===
          JSON.stringify(cameraBakeBefore._styk.frameSources),
    ),
  );
  await page.evaluate(() => styk.editor.undo());
  check(
    "Undo restores the complete authored document",
    await page.evaluate(
      () =>
        JSON.stringify(styk.editor.report._styk.animation) ===
        JSON.stringify(cameraBakeBefore._styk.animation),
    ),
  );
  await page.evaluate(() => {
    styk.editor.redo();
    styk.editor.applyCameraToFigures(undefined, { ticks: [0, 11, 12, 23] });
  });
  const stykFile = await download(
    () => page.locator('[data-action="save"]').first().click(),
    "camera-baked.styk",
  );
  await page.locator('[data-action="export"]').first().click();
  const pivFile = await download(
    () => page.locator('[data-action="export-piv"]').click(),
    "camera-baked.piv",
  );
  check(
    "Save and Export Pivot buttons produce actual files",
    stykFile && pivFile,
  );
  const result = await page.evaluate(async () => {
    const [
      { sampleCameraBake, projectedCameraBake },
      { createRenderer },
      { Editor },
      { ImportClient },
      { DocumentExporter },
    ] = await Promise.all([
      import("/tests/camera-bake-fixture.mjs"),
      import("/src/renderer.mjs"),
      import("/src/editor.mjs"),
      import("/src/import-client.mjs"),
      import("/src/document-export.mjs"),
    ]);
    const importer = new ImportClient(),
      exporter = new DocumentExporter();
    const assert = (value, message) => {
      if (!value) throw new Error(message);
    };
    const canonical = (value) =>
      JSON.stringify(value, (_, item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(
              Object.keys(item)
                .sort()
                .map((key) => [key, item[key]]),
            )
          : item,
      );
    const container = document.createElement("div");
    container.id = "camera-bake-proof";
    container.style.cssText =
      "position:fixed;inset:0;z-index:10000;background:#f5f5f5;padding:24px;overflow:auto;font:13px Inter,system-ui;color:#222";
    container.innerHTML =
      '<h1 style="font-size:18px;margin:0 0 14px">Authored Camera → Figures · native save verification</h1><div style="display:flex;gap:20px"><section><p>Original projected frame</p><canvas id="camera-before" style="width:600px;height:340px;background:white"></canvas></section><section><p>Saved Pivot frame</p><canvas id="camera-after" style="width:600px;height:340px;background:white"></canvas></section></div><p id="camera-proof-caption"></p>';
    document.body.append(container);
    const a = await createRenderer(container.querySelector("#camera-before"), {
      resources: styk.state.renderer.resources,
    });
    const b = await createRenderer(container.querySelector("#camera-after"), {
      resources: styk.state.renderer.resources,
    });
    assert(
      a.stats.backend === "WebGPU" && b.stats.backend === "WebGPU",
      "Actual WebGPU is required by this proof.",
    );
    const pixels = document.createElement("canvas");
    pixels.width = 600;
    pixels.height = 340;
    const ctx = pixels.getContext("2d", { willReadFrequently: true });
    async function render(renderer, report, tick) {
      renderer.resize(600, 340, 1);
      const frame = sampleCameraBake(report, tick);
      await renderer.prepareBackgrounds(report, frame);
      for (const figure of report.figure_types) for (const asset of figure.image_assets || []) {
        const image = renderer.resources.image(renderer.resources.url(asset));
        assert(image, 'Native sprite has no readable portable image.');
        if (!image.complete) await image.decode();
        assert(image.naturalWidth > 0, 'Native sprite did not decode.');
      }
      renderer.render({
        report,
        frame,
        view: {
          x: 0,
          y: 0,
          scale: Math.min(
            600 / report.canvas_width,
            340 / report.canvas_height,
          ),
        },
        clipToCanvas: true,
        cameraEnabled: true,
      });
      // Capture in the submission task, before a presentation boundary expires
      // the WebGPU canvas texture. The synchronous readback waits for its work.
      ctx.clearRect(0, 0, 600, 340);
      ctx.drawImage(renderer.canvas, 0, 0);
      renderer.proofPng = pixels.toDataURL("image/png");
      return ctx.getImageData(0, 0, 600, 340).data;
    }
    async function compare(
      before,
      after,
      ticks,
      kind,
      { meanLimit = 0.18, significantLimit = 0.003 } = {},
    ) {
      const results = [];
      for (const tick of ticks) {
        const first = await render(a, before, tick),
          second = await render(b, after, tick);
        let sum = 0,
          changed = 0,
          max = 0;
        for (let i = 0; i < first.length; i++) {
          const diff = Math.abs(first[i] - second[i]);
          sum += diff;
          if (diff > 8) changed++;
          max = Math.max(max, diff);
        }
        const mean = sum / first.length,
          significantFraction = changed / first.length;
        let significantPixels = 0, interiorPixels = 0;
        for (let p = 0; p < first.length; p += 4) {
          if (![0, 1, 2, 3].some(c => Math.abs(first[p + c] - second[p + c]) > 8)) continue;
          significantPixels++;
          const pixel = p / 4, x = pixel % 600, y = Math.floor(pixel / 600);
          let edge = false;
          for (let dy = -2; dy <= 2 && !edge; dy++) for (let dx = -2; dx <= 2 && !edge; dx++) {
            const q = (Math.min(339, Math.max(0, y + dy)) * 600 + Math.min(599, Math.max(0, x + dx))) * 4;
            for (let c = 0; c < 4; c++) if (Math.abs(first[p + c] - first[q + c]) > 20) { edge = true; break; }
          }
          if (!edge) interiorPixels++;
        }
        if (mean >= 0.18 || significantFraction >= 0.003) {
          window.cameraBakePixelFailure = {
            kind,
            tick,
            before: a.proofPng,
            after: b.proofPng,
          };
        }
        assert(
          mean < meanLimit && significantFraction < significantLimit,
          `${kind} GPU pixels differ at ${tick}: mean ${mean}, significant ${significantFraction}, max ${max}`,
        );
        results.push({ tick, mean, significantFraction, max, significantPixels, interiorPixels,
          differencesNearReferenceEdge: significantPixels ? 1 - interiorPixels / significantPixels : 1 });
      }
      return results;
    }
    function geometryError(before, after, ticks) {
      let maximum = 0;
      for (const tick of ticks) {
        const first = projectedCameraBake(before, tick),
          second = projectedCameraBake(after, tick);
        assert(first.size === second.size, "Native save changes figure count.");
        for (const [uid, original] of first) {
          const saved = second.get(uid);
          assert(saved, "Native save loses figure UID.");
          const joints = new Map(saved.joints);
          for (const [id, p] of original.joints) {
            const q = joints.get(id);
            assert(q, "Native save loses native joint identity.");
            maximum = Math.max(
              maximum,
              Math.abs(p.x - q.x),
              Math.abs(p.y - q.y),
            );
          }
        }
      }
      assert(
        maximum < 0.003,
        `Native saved geometry differs by ${maximum} source pixels.`,
      );
      return maximum;
    }
    try {
      const baked = styk.editor.report,
        animation = canonical(baked._styk.animation),
        sources = canonical(baked._styk.frameSources);
      const stykBlob = await exporter.export(baked, { format: "styk" }),
        stykReopened = (
          await importer.importFile(new File([stykBlob], "camera-baked.styk"))
        ).document;
      assert(
        canonical(stykReopened._styk.animation) === animation,
        "STYK loses sparse camera/figure keys.",
      );
      assert(
        canonical(stykReopened._styk.frameSources) === sources,
        "STYK loses retained pose sources.",
      );
      const piv = await exporter.export(baked, { format: "piv" }),
        pivTimings = { ...exporter.lastTimings },
        reopened = (
          await importer.importFile(new File([piv], "camera-baked.piv"))
        ).document;
      assert(
        reopened.total_output_frames === 24 && !reopened._styk?.animation,
        "PIV materialization changes duration or applies duplicate authoring.",
      );
      const beforeToBaked = await compare(
        cameraBakeBefore,
        baked,
        Array.from({ length: 24 }, (_, i) => i),
        "Camera conversion",
      );
      const savedPixels = await compare(
        cameraBakeBefore,
        reopened,
        Array.from({ length: 24 }, (_, i) => i),
        "Native Pivot save",
      );
      const media = [];
      for (const source of [
        "Pivot Animator v5/Animations/text_bike.piv",
        "Pivot Animator v5/Animations/Legacy/sprite_demo.piv",
      ]) {
        const opened = await importer.openSample(source),
          report = opened.document;
        report.keyframes = report.keyframes.slice(0, 3);
        report.keyframes.forEach((frame) => {
          frame.duration_raw = 1;
          frame.background_id = frame.background_id_b = 0;
          frame.background_mix = 0;
        });
        const editor = new Editor({ demo: false }).load(report);
        editor.addAnimationKeys([
          { target: { kind: "camera" }, property: "x", tick: 0, value: 20 },
          {
            target: { kind: "camera" },
            property: "scale",
            tick: 0,
            value: 1.15,
          },
          {
            target: { kind: "camera" },
            property: "rotation",
            tick: 0,
            value: 0.13,
          },
          {
            target: { kind: "scene" },
            property: "color",
            tick: 0,
            value: 0xffffffff,
          },
        ]);
        const original = structuredClone(editor.report),
          assets = JSON.stringify(editor.report.figure_types);
        const mediaTicks = report.keyframes.map((_, index) => index);
        editor.applyCameraToFigures(mediaTicks);
        assert(
          JSON.stringify(editor.report.figure_types) === assets,
          `${source}: camera bake mutates portable assets.`,
        );
        const file = await exporter.export(editor.report, {
          format: "piv",
          sourceId: opened.sourceId,
        });
        const imported = (
          await importer.importFile(new File([file], "camera-media.piv"))
        ).document;
        media.push({
          source,
          bytes: file.size,
          sourceVersion: original.version,
          outputVersion: imported.version,
          maxProjectedJointError: geometryError(original, imported, mediaTicks),
          // Baking changes the sampling grid of compatibility glyph/sprite
          // textures. Verify their outline geometry separately from edge AA.
          pixels: await compare(original, imported, mediaTicks, source, {
            meanLimit: 0.5,
            significantLimit: 0.02,
          }),
          originalPng: a.proofPng,
          savedPng: b.proofPng,
          textAssets: imported.figure_types.reduce(
            (count, figure) => count + (figure.text_assets?.length || 0),
            0,
          ),
          imageAssets: imported.figure_types.reduce(
            (count, figure) => count + (figure.image_assets?.length || 0),
            0,
          ),
        });
      }
      await compare(cameraBakeBefore, reopened, [5], "Screenshot");
      container.querySelector("#camera-proof-caption").textContent =
        "24/24 original, converted and reopened frames compared · independent tracks and joined figures · portable native text and sprite assets";
      return {
        backend: a.stats.backend,
        adapter: a.stats.adapter,
        beforeToBaked,
        savedPixels,
        media,
        stykBytes: stykBlob.size,
        pivBytes: piv.size,
        pivTimings,
        originalPng: a.proofPng,
        savedPng: b.proofPng,
        sparseStykKeysExact: true,
        retainedSourcesExact: true,
        warnings: [...a.stats.warnings, ...b.stats.warnings],
      };
    } finally {
      a.destroy();
      b.destroy();
      importer.dispose();
      exporter.dispose();
    }
  });
  check(
    "All 24 GPU frames preserve the projected animation",
    result.beforeToBaked.length === 24,
  );
  check(
    "All 24 actual PIV reimport frames match the original projection",
    result.savedPixels.length === 24,
  );
  check(
    "Native text and legacy sprite assets survive camera conversion and real PIV export",
    result.media[0].textAssets > 0 && result.media[1].imageAssets > 0,
  );
  check(
    "STYK retains exact sparse authoring and source metadata",
    result.sparseStykKeysExact && result.retainedSourcesExact,
  );
  check(
    "No browser or GPU errors",
    errors.length === 0 && result.warnings.length === 0,
  );
  for (const [key, name] of [
    ["originalPng", "original-frame.png"],
    ["savedPng", "saved-frame.png"],
  ]) {
    await writeFile(
      path.join(output, name),
      Buffer.from(result[key].split(",")[1], "base64"),
    );
    delete result[key];
  }
  for (const [index, item] of result.media.entries()) for (const key of ['originalPng', 'savedPng']) {
    await writeFile(path.join(output, `media-${index}-${key}.png`), Buffer.from(item[key].split(',')[1], 'base64')); delete item[key];
  }
  // Renderers release their GPU surfaces on dispose, so retain a separate root UI screenshot as well.
  await page.evaluate(() =>
    document.querySelector("#camera-bake-proof")?.remove(),
  );
  await page.screenshot({ path: path.join(output, "camera-inspector.png") });
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify({ checks, errors, ...result }, null, 2),
  );
  console.log(
    JSON.stringify(
      {
        checks: checks.length,
        maxConversionMean: Math.max(
          ...result.beforeToBaked.map((item) => item.mean),
        ),
        maxPivMean: Math.max(...result.savedPixels.map((item) => item.mean)),
        media: result.media,
      },
      null,
      2,
    ),
  );
} catch (error) {
  const pixels = await page
    .evaluate(() => window.cameraBakePixelFailure)
    .catch(() => null);
  if (pixels)
    for (const key of ["before", "after"])
      await writeFile(
        path.join(output, `failure-${key}.png`),
        Buffer.from(pixels[key].split(",")[1], "base64"),
      );
  await page
    .screenshot({ path: path.join(output, "failure.png") })
    .catch(() => {});
  await writeFile(
    path.join(output, "failure.json"),
    JSON.stringify({ checks, errors, error: error.stack }, null, 2),
  );
  throw error;
} finally {
  await browser.close();
  service?.stop();
}
