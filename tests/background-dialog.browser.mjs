import { chromium } from "./support/playwright.mjs";
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
// The fill is edited in the paint picker (the Fill button of the dialog), the dialog's one fill control.
const picker = page.getByRole("dialog", { name: "Color picker", exact: true });
const openPicker = async () => {
  await page.locator("#background-paint").click();
  await picker.waitFor();
};
const closePicker = () => picker.locator("[data-close]").click();
const background = () =>
  page.evaluate(() => {
    const e = styk.editor;
    return e.report.backgrounds.find(
      (b) => b.background_id === e.evaluatedFrame.background_id,
    );
  });
try {
  await page.goto(process.env.STYK_URL || "http://127.0.0.1:47831");
  await page.waitForFunction(() => window.styk?.ready);
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
  await openPicker();
  const angle = Number(await picker.getByLabel("Gradient angle").inputValue());
  check(
    "Imported off-center gradient angle is read from its endpoints",
    Math.abs(angle - (Math.atan2(0.2, 0.6) * 180) / Math.PI) < 0.01,
  );
  await picker.getByRole("button", { name: /^Stop 1,/ }).press("Enter");
  const firstOpacity = Number(await picker.getByLabel("Alpha percent").inputValue());
  await picker.getByRole("button", { name: /^Stop 2,/ }).press("Enter");
  check(
    "Imported gradient preserves separate stop opacity",
    Math.abs(firstOpacity - (128 / 255) * 100) < 1 &&
      Number(await picker.getByLabel("Alpha percent").inputValue()) === 100,
  );
  await closePicker();
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
  await openPicker();
  const angleField = picker.getByLabel("Gradient angle");
  await angleField.fill("90");
  await angleField.press("Enter");
  await closePicker();
  await page.locator("#create-background").click();
  await page.waitForFunction(() => !document.getElementById("dialog").open);
  const rotated = await background();
  check(
    "Changing the angle in the picker applies a rotated linear gradient with the same colors",
    rotated.kind === 3 &&
      rotated.paint?.type === "linear" &&
      rotated.paint.angle === 90 &&
      rotated.color_a === original.color_a &&
      rotated.color_b === original.color_b,
  );
  await open();
  await openPicker();
  await picker.getByLabel("Gradient type").selectOption("radial");
  await closePicker();
  await page.locator("#create-background").click();
  await page.waitForFunction(() => !document.getElementById("dialog").open);
  const radial = await background();
  check(
    "Choosing a radial gradient in the picker applies a radial background",
    radial.kind === 4 && radial.paint?.type === "radial",
  );
  await open();
  await page.locator("#background-search").fill("Off-center");
  check(
    "Library search retains current background and matching entries",
    (await page.locator("#background-library option").count()) === 3,
  );
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
