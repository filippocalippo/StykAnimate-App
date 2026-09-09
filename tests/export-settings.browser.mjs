import { chromium } from "playwright";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
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
async function settings() {
  await page.locator('[data-action="export"]').first().click();
  await page.locator(".export-settings summary").click();
}
async function download(action) {
  const pending = page.waitForEvent("download");
  await page.locator(`[data-action="${action}"]`).click();
  const file = await pending,
    p = path.join(out, file.suggestedFilename());
  await file.saveAs(p);
  return readFile(p);
}
try {
  await page.goto(process.env.STYK_URL || "http://127.0.0.1:47831");
  await page.waitForFunction(() => styk?.ready);
  await settings();
  await page.locator("#export-width").fill("480");
  check(
    "Aspect lock scales the other dimension",
    (await page.locator("#export-height").inputValue()) === "270",
  );
  let bytes = await download("export-png");
  check(
    "PNG contains requested output dimensions",
    bytes.readUInt32BE(16) === 480 && bytes.readUInt32BE(20) === 270,
  );
  await settings();
  await page.locator("#export-aspect").uncheck();
  await page.locator("#export-width").fill("400");
  await page.locator("#export-height").fill("240");
  const svg = (await download("export-svg")).toString();
  check(
    "SVG retains native coordinates with independent output dimensions",
    svg.includes('width="400"') &&
      svg.includes('height="240"') &&
      svg.includes('viewBox="0 0 960 540"'),
  );
  await settings();
  await page.locator("#export-width").fill("160");
  await page.locator("#export-start").fill("3");
  await page.locator("#export-end").fill("5");
  bytes = await download("export-apng");
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
  await settings();
  await page.locator("#export-start").fill("8");
  await page.locator("#export-end").fill("2");
  await page.locator('[data-action="export-apng"]').click();
  check(
    "Invalid frame ranges keep export settings open",
    await page.locator("#dialog").evaluate((e) => e.open),
  );
  check(
    "Invalid frame ranges report a useful error",
    (await page.locator("#toast").innerText()).includes(
      "valid export frame range",
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
