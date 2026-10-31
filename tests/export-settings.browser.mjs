import { chromium } from "./support/playwright.mjs";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { chooseExport } from "./helpers/export-dialog.mjs";
const out = path.resolve("artifacts/export-settings");
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  acceptDownloads: true,
});
const errors = [],
  checks = [];
page.on("pageerror", (e) => errors.push(e.message));
const check = (name, value) => {
  assert.ok(value, name);
  checks.push(name);
};
// Opens Export on a type with its Size set to Custom…, where Width, Lock ratio and Height are.
async function settings(action) {
  await page.locator('.titlebar [data-action="export"]').click();
  await chooseExport(page, action);
  await page.locator("#export-resolution").selectOption("custom");
}
async function download() {
  const pending = page.waitForEvent("download");
  await page.locator("#export-submit").click();
  const file = await pending,
    p = path.join(out, file.suggestedFilename());
  await file.saveAs(p);
  return readFile(p);
}
try {
  // Headless Chrome aborts showSaveFilePicker; without it an animation export saves through a download.
  await page.addInitScript(() => { delete window.showSaveFilePicker; });
  await page.goto(process.env.STYK_URL || "http://127.0.0.1:47831");
  await page.waitForFunction(() => window.styk?.ready);
  // The demo animation: a 960 × 540 artboard with enough frames for the ranges below.
  await page.evaluate(async () => {
    const { createDemo } = await import("/src/demo.mjs");
    styk.editor.load(createDemo(), "Export settings");
    styk.editor.markSaved();
  });
  await settings("export-png");
  await page.locator("#export-width").fill("480");
  check(
    "Aspect lock scales the other dimension",
    (await page.locator("#export-height").inputValue()) === "270",
  );
  let bytes = await download();
  check(
    "PNG contains requested output dimensions",
    bytes.readUInt32BE(16) === 480 && bytes.readUInt32BE(20) === 270,
  );
  await settings("export-svg");
  await page.locator("#export-aspect").uncheck();
  await page.locator("#export-width").fill("400");
  await page.locator("#export-height").fill("240");
  const svg = (await download()).toString();
  check(
    "SVG retains native coordinates with independent output dimensions",
    svg.includes('width="400"') &&
      svg.includes('height="240"') &&
      svg.includes('viewBox="0 0 960 540"'),
  );
  await settings("export-apng");
  // Lock ratio is remembered from the SVG export above: lock it again for a scaled copy.
  await page.locator("#export-aspect").check();
  await page.locator("#export-width").fill("160");
  await page.locator("#export-start").fill("3");
  await page.locator("#export-end").fill("5");
  bytes = await download();
  let frames = 0;
  for (let at = 8; at + 12 <= bytes.length; ) {
    const n = bytes.readUInt32BE(at),
      type = bytes.toString("ascii", at + 4, at + 8);
    if (type === "acTL") frames = bytes.readUInt32BE(at + 8);
    at += n + 12;
  }
  check("APNG uses the inclusive requested three-frame range", frames === 3);
  check(
    "APNG uses requested scale",
    bytes.readUInt32BE(16) === 160 && bytes.readUInt32BE(20) === 90,
  );
  await settings("export-apng");
  await page.locator("#export-start").fill("8");
  await page.locator("#export-end").fill("2");
  await page.locator("#export-end").press("Enter");
  check(
    "Invalid frame ranges keep export settings open",
    (await page.locator("#export-dialog").evaluate((e) => e.open)) &&
      (await page.locator("#export-submit").isDisabled()),
  );
  check(
    "Invalid frame ranges report a useful error",
    (await page.locator("#export-validation").innerText()).includes(
      "frame range",
    ),
  );
  assert.deepEqual(errors, []);
  check("No uncaught browser errors", true);
  await writeFile(
    path.join(out, "verification.json"),
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(`${checks.length} export settings checks passed.`);
} finally {
  await browser.close();
}
