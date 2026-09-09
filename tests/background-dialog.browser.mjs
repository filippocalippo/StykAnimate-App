import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
  errors = [],
  checks = [];
page.on("pageerror", (error) => errors.push(error.message));
const check = (name, value) => {
  assert.ok(value, name);
  checks.push(name);
  console.log("PASS", name);
};
const open = () => page.evaluate(() => styk.actions["background-style"]());
const background = () =>
  page.evaluate(() => {
    const e = styk.editor;
    return e.report.backgrounds.find(
      (b) => b.background_id === e.evaluatedFrame.background_id,
    );
  });
try {
  await page.goto(process.env.STYK_URL || "http://127.0.0.1:47831");
  await page.waitForFunction(() => styk.ready);
  await page.evaluate(() => {
    const e = styk.editor;
    e.newDocument();
    e.importSceneBackground({
      kind: 3,
      name: "Off-center linear",
      x1: 0.1,
      y1: 0.2,
      x2: 0.7,
      y2: 0.4,
      color_a: 0x80443322,
      color_b: 0xffeeddcc,
    });
  });
  const original = await background();
  await open();
  const angle = Number(await page.locator("#background-angle").inputValue());
  check(
    "Imported off-center gradient angle is read from its endpoints",
    Math.abs(angle - (Math.atan2(0.2, 0.6) * 180) / Math.PI) < 0.01,
  );
  check(
    "Imported gradient preserves separate stop opacity",
    Math.abs(
      Number(await page.locator("#background-alpha").inputValue()) -
        (128 / 255) * 100,
    ) < 0.01 &&
      Number(await page.locator("#background-alpha-b").inputValue()) === 100,
  );
  await page.locator("#background-name").fill("Evening");
  await page.locator("#create-background").click();
  await page.waitForFunction(() => !document.getElementById("dialog").open);
  const edited = await background();
  check(
    "Applying name preserves exact imported gradient geometry and both ARGB colors",
    ["x1", "y1", "x2", "y2", "color_a", "color_b"].every(
      (key) => edited[key] === original[key],
    ),
  );
  check(
    "Applying fill keeps original shared background intact",
    await page.evaluate(
      (original) =>
        JSON.stringify(
          styk.editor.report.backgrounds.find(
            (b) => b.background_id === original.background_id,
          ),
        ) === JSON.stringify(original),
      original,
    ),
  );
  await open();
  await page.locator("#background-name").fill("Renamed sky");
  await page.locator("#rename-background").click();
  check(
    "Library rename is visible and has one undoable metadata command",
    (await background()).name === "Renamed sky",
  );
  await page.evaluate(() => styk.editor.undo());
  check(
    "Undo restores background name",
    (await background()).name === "Evening",
  );
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await open();
  await page.evaluate(() => {
    document.getElementById("dialog").close();
    styk.actions["background-style"]();
  });
  await page.waitForTimeout(35);
  await page.locator("#background-name").fill("Reopened sky");
  await page.locator("#rename-background").click();
  check(
    "Immediately reopening the dialog keeps its new event handlers active",
    (await background()).name === "Reopened sky",
  );
  await page.locator("#background-angle").fill("90");
  await page.locator("#create-background").click();
  await page.waitForFunction(() => !document.getElementById("dialog").open);
  const rotated = await background();
  check(
    "Changing angle preserves the imported gradient midpoint and length",
    Math.abs((rotated.x1 + rotated.x2) / 2 - 0.4) < 1e-8 &&
      Math.abs((rotated.y1 + rotated.y2) / 2 - 0.3) < 1e-8 &&
      Math.abs(
        Math.hypot(rotated.x2 - rotated.x1, rotated.y2 - rotated.y1) -
          Math.hypot(0.6, 0.2),
      ) < 1e-8,
  );
  await open();
  await page.locator("#background-kind").selectOption("4");
  for (const [key, value] of Object.entries({
    x1: 1152,
    y1: -54,
    x2: 70.2,
    y2: 437.4,
  }))
    await page.locator("#background-" + key).fill(String(value));
  await page.locator("#create-background").click();
  await page.waitForFunction(() => !document.getElementById("dialog").open);
  const radial = await background();
  check(
    "Radial center and both radii are editable without resetting offsets",
    radial.kind === 4 &&
      Math.abs(radial.x1 - 1.2) < 1e-12 &&
      Math.abs(radial.y1 + 0.1) < 1e-12 &&
      Math.abs(radial.x2 - 0.13) < 1e-12 &&
      Math.abs(radial.y2 - 0.81) < 1e-12,
  );
  await open();
  await page.locator("#background-search").fill("Off-center");
  check(
    "Library search retains current background and matching entries",
    (await page.locator("#background-library option").count()) === 3,
  );
  await page.locator("#background-x2").fill("-1");
  await page.locator("#create-background").click();
  check(
    "Invalid radius is rejected without changing the document",
    (await page.locator("#background-error").isVisible()) &&
      Math.abs((await background()).x2 - 0.13) < 1e-12,
  );
  await page.locator("#background-x2").fill("70.2");
  await mkdir("artifacts/background-dialog", { recursive: true });
  await page.screenshot({
    path: "artifacts/background-dialog/gradient-controls.png",
  });
  check("No unhandled browser errors", errors.length === 0);
  await writeFile(
    "artifacts/background-dialog/report.json",
    JSON.stringify({ checks, errors }, null, 2),
  );
} finally {
  await browser.close();
}
