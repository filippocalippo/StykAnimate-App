/** Root UI wiring: modes, working-pose versus stored frames, vectors and cancel. */
import { chromium } from "./support/playwright.mjs";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import backend from '../desktop/web-host.cjs';
import { chooseExport, exportDialogClosed } from "./helpers/export-dialog.mjs";
const output = path.resolve("artifacts/export-sampling-app");
await mkdir(output, { recursive: true });
const service = await backend.startDesktopHost({ appRoot: process.cwd() });
let browser, page;
const checks = [],
  errors = [];
const check = (name, ok) => {
  assert.ok(ok, name);
  checks.push(name);
  console.log("PASS", name);
};
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  });
  page.on("pageerror", (error) => errors.push(error.message));
  // Exports are the engine's (src/engine/engine-export.mjs); its sampling is checked pixel by
  // pixel in engine/crates/styk-export/tests and its protocol in tests/engine-export.test.mjs.
  // These checks drive the actual buttons.
  await page.goto(service.origin);
  await page.waitForFunction(() => window.styk?.ready);
  await page.evaluate(async () => {
    const { samplingFixture } = await import(
      "/tests/export-sampling-fixture.mjs"
    );
    styk.editor.load(samplingFixture(), "Sampling UI");
    styk.editor.select(1);
    styk.fit();
  });
  async function open(mode) {
    await page.locator('[data-action="export"]').first().click();
    await page.locator("#export-smoothing").selectOption(mode);
  }
  async function selectFormat(action) {
    await chooseExport(page, action);
  }
  async function download(action, name) {
    await selectFormat(action);
    const waiting = page.waitForEvent("download");
    await page.locator("#export-submit").click();
    const file = await waiting,
      target = path.join(output, name);
    await file.saveAs(target);
    return readFile(target);
  }
  const summary = async (bytes) =>
    page.evaluate(
      async (data) => {
        const bitmap = await createImageBitmap(
            new Blob([Uint8Array.from(data)], { type: "image/png" }),
          ),
          canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext("2d").drawImage(bitmap, 0, 0);
        bitmap.close();
        const pixels = canvas
          .getContext("2d")
          .getImageData(0, 0, canvas.width, canvas.height).data;
        let weight = 0,
          moment = 0,
          partial = 0,
          gray = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          const alpha = pixels[i + 3];
          weight += alpha;
          moment += ((i / 4) % canvas.width) * alpha;
          if (alpha > 0 && alpha < 255) partial++;
          if (
            alpha === 255 &&
            pixels[i] > 0 &&
            pixels[i] < 255 &&
            pixels[i] === pixels[i + 1] &&
            pixels[i] === pixels[i + 2]
          )
            gray++;
        }
        return {
          width: canvas.width,
          height: canvas.height,
          partial,
          gray,
          x: moment / weight,
          visible: weight > 0,
          hash: [
            ...new Uint8Array(await crypto.subtle.digest("SHA-256", pixels)),
          ]
            .map((n) => n.toString(16).padStart(2, "0"))
            .join(""),
        };
      },
      [...bytes],
    );
  const summaries = {};
  for (const mode of ["edges", "none", "sprites"]) {
    await open(mode);
    if (mode === "none")
      await page.screenshot({
        path: path.join(output, "smoothing-controls.png"),
      });
    summaries[mode] = await summary(
      await download("export-png", "line-" + mode + ".png"),
    );
    check(
      mode + " actual PNG button exports the selected sampling mode",
      summaries[mode].width === 128 &&
        summaries[mode].height === 96 &&
        summaries[mode].visible &&
        (mode === "none"
          ? summaries[mode].partial === 0
          : summaries[mode].partial > 0),
    );
    await open(mode);
    const apng = await download("export-apng", "line-" + mode + ".apng");
    let count = 0;
    for (let i = 8; i + 12 <= apng.length; ) {
      const n = apng.readUInt32BE(i),
        type = apng.toString("ascii", i + 4, i + 8);
      if (type === "acTL") count = apng.readUInt32BE(i + 8);
      i += n + 12;
    }
    const actual = await summary(apng);
    check(
      mode + " actual APNG preserves three frames and sampling",
      count === 3 &&
        (mode === "none" ? actual.partial === 0 : actual.partial > 0),
    );
  }
  check(
    "actual PNG modes produce distinct coverage",
    !(await readFile(path.join(output, "line-edges.png"))).equals(
      await readFile(path.join(output, "line-sprites.png")),
    ),
  );
  await open("none");
  const svg = (await download("export-svg", "line.svg")).toString();
  check(
    "SVG button ignores pixel smoothing and retains paths",
    svg.includes("<path") && !svg.includes('shape-rendering="crispEdges"'),
  );
  const usesLayerSheet = await page.evaluate(async () => {
    styk.settingsUI.commit({ timelineMode: "simple", autosaveSeconds: 0 });
    await styk.settingsUI.flush();
    // The current layer-sheet timeline stores numeric edits directly. Legacy
    // documents retain the separate Simple working-pose export behavior.
    const sheet = Boolean(styk.editor.report._styk?.layerSheet);
    if (!sheet) styk.editor.enableFrameDrafts({ mode: "add", restoreSaved: false });
    styk.editor.select(1);
    return sheet;
  });
  await page.locator('#inspector [data-field="root_x"]').fill("70.3");
  await page.locator('#inspector [data-field="root_x"]').press("Tab");
  check(
    "numeric edit is visible in the active Simple pose",
    await page.evaluate(
      () =>
        styk.editor.evaluatedFrame.objects[0].root_x === 70.3,
    ),
  );
  const revisionBeforeExports = await page.evaluate(() => styk.editor.revision);
  await open("none");
  const draft = await summary(
    await download("export-png", "working-draft.png"),
  );
  await open("none");
  const stored = await summary(
    await download("export-apng", "stored-animation.apng"),
  );
  check(
    "current-frame and animation exports preserve the timeline's pose semantics",
    Math.abs(draft.x - stored.x - (usesLayerSheet ? 0 : 40)) < 1 &&
      Math.abs(stored.x - summaries.none.x - (usesLayerSheet ? 40 : 0)) < 1,
  );
  check(
    "exports preserve the Simple pose and document revision",
    await page.evaluate(
      ({usesLayerSheet, revision}) =>
        (usesLayerSheet || styk.editor.frameDraft.dirty) &&
        styk.editor.evaluatedFrame.objects[0].root_x === 70.3 &&
        styk.editor.revision === revision,
      {usesLayerSheet, revision: revisionBeforeExports},
    ),
  );
  await open("none");
  const sequence = await download("export-png-sequence", "stored-frames.zip");
  check(
    "actual PNG-sequence button produces a ZIP",
    sequence.subarray(0, 2).toString() === "PK",
  );
  await page.evaluate(async () => {
    const { samplingFixture } = await import(
        "/tests/export-sampling-fixture.mjs"
      ),
      c = document.createElement("canvas");
    c.width = c.height = 8;
    const x = c.getContext("2d");
    for (let y = 0; y < 8; y++)
      for (let i = 0; i < 8; i++) {
        x.fillStyle = (i + y) % 2 ? "#fff" : "#000";
        x.fillRect(i, y, 1, 1);
      }
    styk.editor.load(
      samplingFixture({ kind: "image", spriteURL: c.toDataURL() }),
      "Rotated sprite",
    );
    styk.editor.select(1);
  });
  const sprite = {};
  for (const mode of ["edges", "none", "sprites"]) {
    await open(mode);
    sprite[mode] = await summary(
      await download("export-png", "sprite-" + mode + ".png"),
    );
    check(mode + " actual sprite PNG is a nonempty frame", sprite[mode].visible);
  }
  check("actual No smoothing sprite has hard boundaries and nearest pixels", sprite.none.partial === 0 && sprite.none.gray === 0);
  check(
    "actual Smooth sprites reduces checkerboard aliasing",
    sprite.sprites.gray > sprite.edges.gray + 20,
  );
  // Lose only the export surface after PNG encoding, before the app can save it.
  await page.evaluate(async () => {
    const {EngineExportFrames} = await import('/src/engine/engine-export.mjs');
    const paint = EngineExportFrames.prototype._paint;
    EngineExportFrames.prototype._paint = function(result) {
      EngineExportFrames.prototype._paint = paint;
      const canvas = paint.call(this, result), toBlob = canvas.toBlob;
      canvas.toBlob = function(callback, ...args) {
        return toBlob.call(this, blob => {
          this.dispatchEvent(new Event('contextlost'));
          callback(blob);
        }, ...args);
      };
      return canvas;
    };
  });
  let failedDownloads = 0;
  const onFailedDownload = () => failedDownloads++;
  page.on('download', onFailedDownload);
  await open('sprites');
  await selectFormat('export-png');
  await page.locator('#export-submit').click();
  await page.waitForFunction(() => !document.querySelector('#export-dialog') &&
    document.querySelector('#toast').textContent.includes('before saving an incomplete frame'));
  check('canvas loss during PNG encoding produces a clear error and no download', failedDownloads === 0);
  page.off('download', onFailedDownload);
  await open('sprites');
  check('a fresh PNG export succeeds after a lost export canvas',
    (await summary(await download('export-png', 'retry-after-loss.png'))).hash === sprite.sprites.hash);
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let downloads = 0;
  const listener = () => downloads++;
  page.on("download", listener);
  await page.route("**/src/engine/engine-export-worker.mjs", async (route) => {
    await gate;
    await route.continue().catch(() => {});
  });
  try {
    await open("sprites");
    await selectFormat("export-apng");
    await page.locator("#export-submit").click();
    await page.locator("#cancel-export").waitFor();
    check(
      "progress and Cancel are visible before worker loading finishes",
      await page.locator("#export-progress").isVisible(),
    );
    await page.locator("#cancel-export").click();
    await exportDialogClosed(page);
    check(
      "actual Cancel aborts worker loading without a download",
      downloads === 0,
    );
  } finally {
    release();
    await page.unroute("**/src/engine/engine-export-worker.mjs");
    page.off("download", listener);
  }
  await page.screenshot({
    path: path.join(output, "after-export.png"),
  });
  check("no uncaught UI or CSP errors", errors.length === 0);
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      { checks, errors, summaries, draft, stored, sprite },
      null,
      2,
    ),
  );
} catch (error) {
  await page
    ?.screenshot({ path: path.join(output, "failure.png") })
    .catch(() => {});
  await writeFile(
    path.join(output, "failure.json"),
    JSON.stringify({ checks, errors, error: error.stack, editor: await page?.evaluate(() => ({
      frameDraft: styk.editor.frameDraft,
      rootX: styk.editor.frame.objects[0]?.root_x,
      evaluatedX: styk.editor.evaluatedFrame.objects[0]?.root_x,
      timelineMode: styk.state.settings.timelineMode,
    })).catch(() => null) }, null, 2),
  );
  throw error;
} finally {
  await browser?.close();
  await service.stop();
}
