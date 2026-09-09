import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const url = process.env.STYK_URL || "http://127.0.0.1:47831";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1560, height: 1000 } });
const checks = [],
  errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
const check = (name, value = true) => {
  assert.ok(value, name);
  checks.push(name);
  console.log("PASS", name);
};
const sizes = () => page.evaluate(() => window.workspaceLayout.sizes);
const init = () =>
  page.evaluate(async () => {
    const { initWorkspaceLayout } = await import("/src/workspace-layout.mjs");
    window.workspaceLayout = initWorkspaceLayout();
  });
const splitter = (name) =>
  page.locator(`.styk-workspace-splitter[data-panel="${name}"]`);
async function drag(name, dx, dy) {
  const rect = await splitter(name).boundingBox();
  const x = rect.x + rect.width / 2,
    y = rect.y + rect.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 5 });
  await page.mouse.up();
}
try {
  await page.goto(url);
  await page.waitForFunction(() => window.styk?.ready);
  await init();
  await page.evaluate(() => window.workspaceLayout.reset());
  check(
    "Three accessible separators",
    (await page.locator(".styk-workspace-splitter[role=separator]").count()) ===
      3,
  );
  const before = await sizes();
  await drag("left", 100, 0);
  await drag("right", -64, 0);
  await drag("timeline", 0, -88);
  const expanded = await sizes();
  check(
    "Pointer capture resizes layers",
    Math.abs(expanded.left - before.left - 100) < 1,
  );
  check(
    "Pointer capture resizes properties",
    Math.abs(expanded.right - before.right - 64) < 1,
  );
  check(
    "Timeline expands upward",
    Math.abs(expanded.timeline - before.timeline - 88) < 1,
  );
  check(
    "Canvas GPU backing size follows viewport",
    await page.evaluate(() => {
      const viewport = document.querySelector("#viewport"),
        canvas = document.querySelector("#scene");
      return (
        Math.abs(canvas.width / devicePixelRatio - viewport.clientWidth) < 2
      );
    }),
  );
  await splitter("left").focus();
  await page.keyboard.press("ArrowRight");
  check(
    "Keyboard resizes by ten pixels",
    Math.abs((await sizes()).left - expanded.left - 10) < 1,
  );
  await page.keyboard.press("Shift+ArrowLeft");
  check(
    "Shift supports one-pixel precision",
    Math.abs((await sizes()).left - expanded.left - 9) < 1,
  );
  const persisted = await sizes();
  await page.reload();
  await page.waitForFunction(() => window.styk?.ready);
  await init();
  const restored = await sizes();
  check(
    "Panel layout persists across reload",
    ["left", "right", "timeline"].every(
      (key) => restored[key] === persisted[key],
    ),
  );
  await page.setViewportSize({ width: 1100, height: 740 });
  await page.waitForFunction(
    () =>
      window.workspaceLayout.sizes.stage >= 420 &&
      window.workspaceLayout.sizes.left + window.workspaceLayout.sizes.right <=
        680,
  );
  check("1100px window preserves a 420px stage", (await sizes()).stage >= 420);
  check(
    "Compact workspace has no horizontal overflow",
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= innerWidth &&
        document.querySelector(".workspace").scrollWidth <= innerWidth,
    ),
  );
  await page.setViewportSize({ width: 800, height: 680 });
  await page.waitForFunction(
    () =>
      window.workspaceLayout.sizes.stage >= 300 &&
      window.workspaceLayout.sizes.left + window.workspaceLayout.sizes.right <=
        500,
  );
  check("800px window preserves a 300px stage", (await sizes()).stage >= 300);
  await page.setViewportSize({ width: 1560, height: 1000 });
  await page.waitForFunction(
    (expected) => Math.abs(window.workspaceLayout.sizes.left - expected) < 0.1,
    persisted.left,
  );
  check(
    "Restoring large window restores preferred panel sizes",
    (await sizes()).right === persisted.right,
  );
  const gestureBefore = await sizes(),
    leftRect = await splitter("left").boundingBox();
  await page.mouse.move(leftRect.x + 3, leftRect.y + 100);
  await page.mouse.down();
  await page.mouse.move(leftRect.x + 53, leftRect.y + 100);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  check(
    "Escape cancels the active resize",
    (await sizes()).left === gestureBefore.left,
  );
  check(
    "Resize cursor clears after cancellation",
    await page.evaluate(
      () => !document.body.className.includes("styk-resizing"),
    ),
  );
  await splitter("left").dblclick();
  check("Double click resets one panel", (await sizes()).left === before.left);
  await splitter("timeline").focus();
  await page.keyboard.press("Home");
  check(
    "Keyboard Home uses minimum timeline height",
    (await sizes()).timeline === 135,
  );
  await page.keyboard.press("Enter");
  check(
    "Keyboard Enter resets focused panel",
    (await sizes()).timeline === 242,
  );
  await page.evaluate(() => window.workspaceLayout.reset());
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({
    path: path.resolve("artifacts/workspace-resize.png"),
  });
  await page.evaluate(() => window.workspaceLayout.destroy());
  check(
    "Destroy removes splitters and layout styles",
    (await page.locator(".styk-workspace-splitter").count()) === 0 &&
      (await page.locator("style[data-styk-workspace-style]").count()) === 0,
  );
  await init();
  check(
    "Layout can be initialized again",
    (await page.locator(".styk-workspace-splitter").count()) === 3,
  );
  assert.deepEqual(errors, []);
  check("No browser errors");
  await writeFile(
    "artifacts/workspace-layout-verification.json",
    JSON.stringify(
      { checks, errors, timestamp: new Date().toISOString() },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
