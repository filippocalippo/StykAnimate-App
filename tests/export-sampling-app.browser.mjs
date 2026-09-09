/** Root UI wiring: modes, working-pose versus stored frames, vectors and cancel. */
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import backend from "../desktop/backend.cjs";
const output = path.resolve("artifacts/export-sampling-app");
await mkdir(output, { recursive: true });
const service = await backend.startBackend({ appRoot: process.cwd() });
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
    await page.locator(".export-settings summary").click();
    await page.locator("#export-smoothing").selectOption(mode);
  }
  async function download(action, name) {
    const waiting = page.waitForEvent("download");
    await page.locator(`[data-action="${action}"]`).click();
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
      mode + " root pixels equal the tested worker rendering",
      (
        await summary(
          await readFile(
            path.resolve("artifacts/export-sampling/line-" + mode + ".png"),
          ),
        )
      ).hash === summaries[mode].hash,
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
  await page.evaluate(async () => {
    styk.settingsUI.commit({ timelineMode: "simple", autosaveSeconds: 0 });
    await styk.settingsUI.flush();
    styk.editor.enableFrameDrafts({ mode: "add", restoreSaved: false });
    styk.editor.select(1);
  });
  await page.locator('#inspector [data-field="root_x"]').fill("70.3");
  await page.locator('#inspector [data-field="root_x"]').press("Enter");
  check(
    "actual numeric edit creates an unstored Simple working pose",
    await page.evaluate(
      () =>
        styk.editor.frameDraft.dirty &&
        styk.editor.frame.objects[0].root_x === 70.3,
    ),
  );
  await open("none");
  const draft = await summary(
    await download("export-png", "working-draft.png"),
  );
  await open("none");
  const stored = await summary(
    await download("export-apng", "stored-animation.apng"),
  );
  check(
    "current-frame PNG includes working pose while animation keeps stored pose",
    Math.abs(draft.x - stored.x - 40) < 1 &&
      Math.abs(stored.x - summaries.none.x) < 1,
  );
  check(
    "exports preserve dirty Simple working pose",
    await page.evaluate(
      () =>
        styk.editor.frameDraft.dirty &&
        styk.editor.frame.objects[0].root_x === 70.3,
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
    const expected = await summary(
      await readFile(
        path.resolve("artifacts/export-sampling/image-" + mode + ".png"),
      ),
    );
    check(
      mode + " actual sprite PNG matches verified worker pixels",
      sprite[mode].hash === expected.hash,
    );
  }
  check("actual No smoothing sprite has hard boundaries and nearest pixels", sprite.none.partial === 0 && sprite.none.gray === 0);
  check(
    "actual Smooth sprites reduces checkerboard aliasing",
    sprite.sprites.gray > sprite.edges.gray + 20,
  );
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let downloads = 0;
  const listener = () => downloads++;
  page.on("download", listener);
  await page.route("**/src/export-frame-worker.mjs", async (route) => {
    await gate;
    await route.continue().catch(() => {});
  });
  try {
    await open("sprites");
    await page.locator('[data-action="export-apng"]').click();
    await page.locator("#cancel-export").waitFor();
    check(
      "progress and Cancel are visible before worker loading finishes",
      await page.locator("#export-progress").isVisible(),
    );
    await page.locator("#cancel-export").click();
    await page.waitForFunction(() => !document.querySelector("#dialog").open);
    check(
      "actual Cancel aborts worker loading without a download",
      downloads === 0,
    );
  } finally {
    release();
    await page.unroute("**/src/export-frame-worker.mjs");
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
    JSON.stringify({ checks, errors, error: error.stack }, null, 2),
  );
  throw error;
} finally {
  await browser?.close();
  await service.stop();
}
