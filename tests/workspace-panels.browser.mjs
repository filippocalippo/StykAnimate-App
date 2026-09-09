import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1560, height: 1000 } }),
  checks = [],
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
const check = (name, ok = true) => {
  assert.ok(ok, name);
  checks.push(name);
  console.log("PASS", name);
};
const panel = (name) => page.locator(`[data-workspace-panel="${name}"]`);
const grip = (name) => page.locator(`[data-panel-move="${name}"]`);
const toggle = (name) => page.locator(`[data-panel-toggle="${name}"]`);
const state = () =>
  page.evaluate(() => ({
    sizes: document.querySelector(".workspace")._stykLayout.sizes,
    floating: document.querySelector(".workspace")._stykLayout.floating,
  }));
async function drag(locator, dx, dy) {
  const r = await locator.boundingBox();
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width / 2 + dx, r.y + r.height / 2 + dy, {
    steps: 8,
  });
  await page.mouse.up();
}
try {
  await page.goto(process.env.STYK_URL || "http://127.0.0.1:47831");
  await page.waitForFunction(() => window.styk?.ready);
  await page.evaluate(() =>
    document.querySelector(".workspace")._stykLayout.reset(),
  );
  const initial = await state();
  check(
    "Every panel exposes accessible float and move controls",
    (await page.locator(".styk-panel-toggle").count()) === 3 &&
      (await page.locator(".styk-panel-drag-handle").count()) === 3,
  );
  await toggle("left").click();
  check(
    "Layers panel undocks into a genuine floating window",
    (await state()).floating.left !== undefined &&
      (await panel("left").evaluate((e) => getComputedStyle(e).position)) ===
        "fixed",
  );
  check(
    "Undocking gives the canvas its docked width back",
    (await state()).sizes.stage === initial.sizes.stage + initial.sizes.left,
  );
  const before = await state();
  await drag(grip("left"), 220, 80);
  const moved = await state();
  check(
    "Floating panel header moves horizontally and vertically",
    Math.abs(moved.floating.left.x - before.floating.left.x - 220) < 1 &&
      Math.abs(moved.floating.left.y - before.floating.left.y - 80) < 1,
  );
  await drag(panel("left").locator('[data-edge="se"]'), 80, 60);
  const resized = await state();
  check(
    "Floating corner resizes width and height",
    Math.abs(resized.floating.left.width - moved.floating.left.width - 80) <
      1 &&
      Math.abs(resized.floating.left.height - moved.floating.left.height - 60) <
        1,
  );
  await grip("left").focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+ArrowDown");
  const keyboard = await state();
  check(
    "Keyboard moves floating panels with fine adjustment",
    keyboard.floating.left.x === resized.floating.left.x + 10 &&
      keyboard.floating.left.y === resized.floating.left.y + 1,
  );
  await panel("left").locator('[data-edge="e"]').focus();
  await page.keyboard.press("ArrowRight");
  check(
    "Floating edges support keyboard resizing",
    (await state()).floating.left.width === keyboard.floating.left.width + 10,
  );
  await toggle("right").click();
  await toggle("timeline").click();
  check(
    "All three panels can float simultaneously",
    Object.keys((await state()).floating).length === 3 &&
      (await state()).sizes.stage === 1560 &&
      (await state()).sizes.timeline === 0,
  );
  check(
    "WebGPU backing canvas follows the expanded viewport",
    await page.evaluate(
      () =>
        Math.abs(
          document.querySelector("#scene").width / devicePixelRatio -
            document.querySelector("#viewport").clientWidth,
        ) <= 1,
    ),
  );
  const saved = await state();
  await page.reload();
  await page.waitForFunction(() => window.styk?.ready);
  check(
    "Floating modes and positions persist after reload",
    JSON.stringify((await state()).floating) === JSON.stringify(saved.floating),
  );
  await page.screenshot({ path: "artifacts/workspace-floating.png" });
  await page.setViewportSize({ width: 1100, height: 740 });
  await page.waitForFunction(() =>
    Object.values(
      document.querySelector(".workspace")._stykLayout.floating,
    ).every((r) => r.x + r.width <= 1100),
  );
  check(
    "Floating panels remain on-screen after window shrink",
    await page.evaluate(() =>
      Object.values(
        document.querySelector(".workspace")._stykLayout.floating,
      ).every(
        (r) =>
          r.x >= 0 &&
          r.y >= 0 &&
          r.x + r.width <= 1100 &&
          r.y + r.height <= document.querySelector(".workspace").clientHeight,
      ),
    ),
  );
  // Redock the timeline and properties first so the left grip is unobscured.
  await toggle("timeline").click();
  await toggle("right").click();
  check(
    "Dock buttons restore the original panel positions",
    !(await state()).floating.timeline && !(await state()).floating.right,
  );
  const prev = await state(),
    r = await grip("left").boundingBox();
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.down();
  await page.mouse.move(r.x + 80, r.y + 40);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  check(
    "Escape restores position after a cancelled panel move",
    JSON.stringify((await state()).floating.left) ===
      JSON.stringify(prev.floating.left),
  );
  const g = await grip("left").boundingBox();
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2 - 25, g.y + g.height / 2 + 20, {
    steps: 4,
  });
  const zone = await page.locator(".styk-panel-dock-zone").boundingBox();
  await page.mouse.move(zone.x + zone.width / 2, zone.y + zone.height / 2, {
    steps: 6,
  });
  check(
    "Dragging over dock target previews docking",
    (await page.locator(".styk-panel-dock-zone[data-active]").count()) === 1,
  );
  await page.mouse.up();
  check(
    "Dropping into target docks the whole panel",
    !(await state()).floating.left,
  );
  await drag(grip("right"), -180, 70);
  check(
    "Dragging a docked header directly detaches its panel",
    Boolean((await state()).floating.right),
  );
  await grip("right").focus();
  await page.keyboard.press("Enter");
  check(
    "Enter docks the focused movable panel",
    !(await state()).floating.right,
  );
  await toggle("left").click();
  await grip("left").focus();
  await page.keyboard.press("Home");
  check(
    "Home restores the focused panel to its default dock and size",
    !(await state()).floating.left && (await state()).sizes.left === 190,
  );
  await drag(panel("timeline").locator(".timeline-title"), 70, -80);
  check(
    "Timeline title itself can detach and move the panel",
    Boolean((await state()).floating.timeline),
  );
  await toggle("timeline").click();
  await page.evaluate(() =>
    document.querySelector(".workspace")._stykLayout.reset(),
  );
  check(
    "Reset restores a compact docked workspace",
    Object.keys((await state()).floating).length === 0,
  );
  check(
    "Panel move/dock controls remain fully visible at 1100px",
    await page.evaluate(() =>
      [...document.querySelectorAll(".styk-panel-controls")].every((e) => {
        const r = e.getBoundingClientRect(),
          p = e.parentElement.getBoundingClientRect();
        return r.x >= p.x && r.right <= p.right + 0.5;
      }),
    ),
  );
  await page.screenshot({ path: "artifacts/workspace-docked-compact.png" });
  check(
    "No body overflow",
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  assert.deepEqual(errors, []);
  check("No runtime or console errors");
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    "artifacts/workspace-panels-verification.json",
    JSON.stringify(
      { checks, errors, timestamp: new Date().toISOString() },
      null,
      2,
    ),
  );
} catch (error) {
  await page.screenshot({ path: "artifacts/workspace-panels-failure.png" });
  await writeFile(
    "artifacts/workspace-panels-verification.json",
    JSON.stringify({ checks, errors, failure: error.stack }, null, 2),
  );
  throw error;
} finally {
  await browser.close();
}
