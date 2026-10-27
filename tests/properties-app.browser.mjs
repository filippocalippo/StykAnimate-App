import { chromium } from "./support/playwright.mjs";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
  checks = [],
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const check = (name, ok = true) => {
  assert.ok(ok, name);
  checks.push(name);
  console.log("PASS", name);
};
const state = () =>
  page.evaluate(() => ({
    x: styk.editor.object?.root_x,
    channels: styk.editor.animationChannels.length,
    undo: styk.editor._undo.length,
    active: styk.properties.active,
    context: styk.state.inspectorContext,
    camera: styk.editor.evaluatedFrame?.camera,
  }));
const field = (key) => page.locator(`#inspector [data-property="${key}"]`);
async function drag(key, dx, escape = false) {
  const r = await page
    .locator(`#inspector [data-property-row="${key}"] [data-property-scrub]`)
    .boundingBox();
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width / 2 + dx, r.y + r.height / 2, {
    steps: 8,
  });
  if (escape) await page.keyboard.press("Escape");
  await page.mouse.up();
  await page.waitForTimeout(60);
}
try {
  await page.goto(process.env.STYK_URL || "http://127.0.0.1:47831");
  await page.waitForFunction(() => window.styk?.ready);
  await page.evaluate(() => styk.editor.newDocument());
  await page.waitForTimeout(100);
  let before = await state();
  await drag("root_x", 20);
  let after = await state();
  check(
    "Actual app native X scrub moves figure with one undo and no scalar channel",
    after.undo === before.undo + 1 &&
      Math.abs(after.x - before.x - 20) < 0.001 &&
      after.channels === 0,
  );
  before = after;
  await drag("root_x", 30, true);
  after = await state();
  check(
    "Actual app Escape restores the figure without an undo",
    after.undo === before.undo && after.x === before.x && !after.active,
  );
  await field("root_x").fill("350.123456");
  await field("root_x").press("Enter");
  after = await state();
  check(
    "Actual app typing preserves exact native value",
    after.x === 350.123456 && after.undo === before.undo + 1,
  );
  check(
    "Typed property edits write a layer-sheet key, not a channel",
    await page.evaluate(() => {
      const e = styk.editor,
        keys =
          e.report._styk.layerSheet.tracks[e.layerForUid(e.selectedUid)].keys;
      return (
        e.animationChannels.length === 0 &&
        keys.some((key) => key.sourceTick === undefined && key.value?.frameId)
      );
    }),
  );
  before = await state();
  await drag("root_x", 10);
  after = await state();
  check(
    "Scrubbing a keyed property edits its sheet pose in one undo",
    after.undo === before.undo + 1 &&
      Math.abs(after.x - before.x - 10) < 0.001 &&
      after.channels === 0,
  );
  await page
    .locator('.sheet-layer[data-kind="camera"] .sheet-layer-name')
    .click();
  await field("camera_x").waitFor();
  check(
    "Selecting Camera shows only camera controls",
    (await page
      .locator('#inspector [data-property="canvas_width"]')
      .count()) === 0 &&
      (await page.locator('#inspector [data-property="root_x"]').count()) === 0,
  );
  before = await state();
  await drag("camera_x", 15);
  after = await state();
  check(
    "Actual app camera scrub commits one small native camera patch",
    after.undo === before.undo + 1 &&
      after.camera.x === 15 &&
      (await page.evaluate(() => styk.editor._undo.at(-1).bytes < 3500)),
  );
  await page
    .locator('.sheet-layer[data-kind="scene"] .sheet-layer-name')
    .click();
  await field("canvas_width").waitFor();
  check(
    "Selecting Scene separates canvas and playback from camera controls",
    (await page.locator('#inspector [data-property="camera_x"]').count()) ===
      0 &&
      (await page.locator('#inspector [data-property="duration"]').count()) ===
        0,
  );
  before = await state();
  await drag("canvas_width", 10);
  after = await state();
  check(
    "Scene dimensions scrub through the native adapter",
    after.undo === before.undo + 1 &&
      (await page.evaluate(() => styk.editor.report.canvas_width === 970)),
  );
  await page
    .locator('.sheet-layer[data-kind="layer"] .sheet-layer-name')
    .first()
    .click();
  await page.locator("#inspector-layer-name").waitFor();
  check(
    "Selecting a layer shows contextual layer properties",
    (await page
      .locator('#inspector [data-property="canvas_width"]')
      .count()) === 0,
  );
  await page.locator("#inspector-layer-name").fill("Main action");
  await page.locator("#inspector-layer-name").press("Tab");
  check(
    "Layer name changes through its inspector",
    await page.evaluate(
      () =>
        styk.editor.getLayer(styk.editor.activeLayerId).name === "Main action",
    ),
  );
  await page.setViewportSize({ width: 900, height: 760 });
  await page
    .locator('.sheet-layer[data-kind="camera"] .sheet-layer-name')
    .click();
  await field("camera_x").waitFor();
  check(
    "900px app camera properties render no key controls",
    (await page
      .locator("#inspector [data-property-key], #inspector [data-property-nav]")
      .count()) === 0,
  );
  check(
    "900px app inspector has no horizontal clipping",
    await page
      .locator("#inspector")
      .evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
  );
  await mkdir("artifacts/properties-app", { recursive: true });
  await page.screenshot({ path: "artifacts/properties-app/compact.png" });
  check("No app page errors", errors.length === 0);
  await writeFile(
    "artifacts/properties-app/report.json",
    JSON.stringify({ checks, errors }, null, 2),
  );
} finally {
  await browser.close();
}
