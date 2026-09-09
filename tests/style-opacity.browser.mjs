import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1560, height: 1000 } });
const checks = [],
  errors = [],
  out = "artifacts/style-opacity";
page.on("pageerror", (error) => errors.push(error.message));
page.setDefaultTimeout(10000);
const check = (name, result) => {
  assert.ok(result, name);
  checks.push(name);
  console.log("PASS", name);
};
const field = (key) => page.locator(`#inspector [data-property="${key}"]`);
const snapshot = () =>
  page.evaluate(() => ({
    outline: styk.editor.figure.segment_decode.global_style.u30,
    primary: styk.editor.figure.segments[0].transparency,
    secondary: styk.editor.figure.segments[0].secondary?.a,
    outlineColor: styk.editor.figure.segment_decode.global_style.rgb,
    gradientColor: styk.editor.figure.segments[0].secondary?.rgb,
    undo: styk.editor._undo.length,
    active: styk.properties.active,
  }));
async function type(key, value) {
  await field(key).fill(String(value));
  await field(key).press("Enter");
  await page.waitForTimeout(60);
}
async function drag(key, dx, { fine = false, cancel = false } = {}) {
  const label = page.locator(
    `#inspector [data-property-row="${key}"] [data-property-scrub]`,
  );
  await label.scrollIntoViewIfNeeded();
  const r = await label.boundingBox(),
    x = r.x + r.width / 2,
    y = r.y + r.height / 2;
  await page.mouse.move(x, y);
  if (fine) await page.keyboard.down("Shift");
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 8 });
  if (cancel) await page.keyboard.press("Escape");
  await page.mouse.up();
  if (fine) await page.keyboard.up("Shift");
  await page.waitForTimeout(60);
}
try {
  await page.goto(process.env.STYK_URL || "http://127.0.0.1:47831");
  await page.waitForFunction(() => window.styk?.ready);
  await page.evaluate(() => {
    const e = styk.editor;
    e.newDocument();
    e.select(e.selectedUid, 0);
    e.updateFigureStyle({
      name: "Gradient study",
      outlineWidth: 4,
      outlineColor: "#0d99ff",
      outlineOpacity: 0.8,
    });
    e.updateSegmentStyle({
      color: "#f8356a",
      opacity: 0.7,
      thickness: 16,
      gradient: { color: "#2cd876", opacity: 0.6 },
    });
  });
  await field("outline_opacity").waitFor();
  await field("segment_gradient_opacity").waitFor();
  check(
    "Actual inspector exposes outline and both gradient endpoint opacities",
    (await field("segment_opacity").count()) === 1,
  );
  let before = await snapshot();
  await type("outline_opacity", 25);
  let after = await snapshot();
  check(
    "Typing outline opacity changes only its native alpha in one undo",
    after.outline === 191 &&
      after.primary === before.primary &&
      after.secondary === before.secondary &&
      after.undo === before.undo + 1,
  );
  await page.evaluate(() => styk.editor.undo());
  await page.waitForTimeout(50);
  check(
    "Undo restores the exact imported outline alpha",
    (await snapshot()).outline === before.outline,
  );
  await page.evaluate(() => styk.editor.redo());
  await page.waitForTimeout(50);
  check(
    "Redo restores the authored outline alpha",
    (await snapshot()).outline === 191,
  );
  before = await snapshot();
  await drag("segment_gradient_opacity", -20);
  after = await snapshot();
  check(
    "Gradient-end scrubbing previews continuously and commits once",
    after.secondary > before.secondary &&
      after.outline === before.outline &&
      after.primary === before.primary &&
      after.undo === before.undo + 1,
  );
  check(
    "Scrubbing preserves native endpoint and outline RGB values",
    JSON.stringify(after.gradientColor) ===
      JSON.stringify(before.gradientColor) &&
      JSON.stringify(after.outlineColor) ===
        JSON.stringify(before.outlineColor),
  );
  before = after;
  await drag("segment_gradient_opacity", 30, { cancel: true });
  after = await snapshot();
  check(
    "Escape restores gradient-end opacity without adding history",
    after.secondary === before.secondary &&
      after.undo === before.undo &&
      !after.active,
  );
  await type("segment_gradient_opacity", 50);
  before = await snapshot();
  await drag("segment_gradient_opacity", 10, { fine: true });
  after = await snapshot();
  check(
    "Shift scrubbing makes a fine one-percent opacity adjustment",
    Math.abs(after.secondary - before.secondary) <= 3 &&
      after.secondary < before.secondary,
  );
  await type("segment_gradient_opacity", 0);
  check(
    "Gradient endpoint accepts fully transparent",
    (await snapshot()).secondary === 255,
  );
  await type("segment_gradient_opacity", 100);
  check(
    "Gradient endpoint accepts fully opaque",
    (await snapshot()).secondary === 0,
  );
  await type("segment_opacity", 40);
  check(
    "Primary gradient opacity remains independently editable",
    (await snapshot()).primary === 153 && (await snapshot()).secondary === 0,
  );
  await type("segment_gradient_opacity", 35);
  before = await snapshot();
  await field("segment_gradient_opacity").fill("101");
  await field("segment_gradient_opacity").press("Enter");
  check(
    "Out-of-range opacity remains uncommitted",
    (await snapshot()).secondary === before.secondary &&
      (await snapshot()).undo === before.undo,
  );
  await field("segment_gradient_opacity").press("Escape");
  await page.locator("#segment-gradient-color").evaluate((e) => {
    e.value = "#2388bb";
    e.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForTimeout(60);
  check(
    "Changing gradient RGB keeps endpoint opacity intact",
    (await snapshot()).secondary === before.secondary,
  );
  await mkdir(out, { recursive: true });
  for (const [width, height] of [
    [1560, 1000],
    [1280, 800],
    [1100, 740],
  ]) {
    await page.setViewportSize({ width, height });
    await field("segment_gradient_opacity").scrollIntoViewIfNeeded();
    check(
      `${width}px inspector keeps controls inside panel bounds`,
      await page
        .locator("#inspector")
        .evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
    );
    check(
      `${width}px outline opacity retains full-width hierarchy`,
      await page
        .locator('[data-property-row="outline_opacity"]')
        .evaluate((e) => e.getBoundingClientRect().width > 140),
    );
    await page.screenshot({ path: `${out}/inspector-${width}.png` });
  }
  await page.locator("#segment-gradient-enabled").uncheck();
  await page.waitForTimeout(60);
  check(
    "Removing a gradient removes its endpoint controls",
    (await field("segment_gradient_opacity").count()) === 0,
  );
  await page.locator("#segment-gradient-enabled").check();
  await field("segment_gradient_opacity").waitFor();
  check(
    "Enabling a gradient restores its endpoint opacity control",
    await field("segment_gradient_opacity").isVisible(),
  );
  check("No uncaught application errors", errors.length === 0);
  await writeFile(
    `${out}/report.json`,
    JSON.stringify({ checks, errors }, null, 2),
  );
} finally {
  await browser.close();
}
