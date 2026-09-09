/** Canvas navigation, context actions, and compact desktop workspace regression. */
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const appRoot = fileURLToPath(new URL("..", import.meta.url)),
  out = path.join(appRoot, "artifacts");
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 900 } }),
  checks = [],
  errors = [];
page.setDefaultTimeout(15000);
page.on("pageerror", (error) => errors.push(error.stack || error.message));
const check = (name, value = true) => {
  assert.ok(value, name);
  checks.push({ name, passed: true });
  console.log("PASS", name);
};
const view = () => page.evaluate(() => ({ ...styk.state.view }));
const pose = () =>
  page.evaluate(() =>
    styk.editor.frame.objects.map((o) => ({
      uid: o.unique_id,
      x: o.root_x,
      y: o.root_y,
      scale: o.scale,
      angles: [...o.angles],
    })),
  );
const near = (a, b, tolerance = 0.02) => Math.abs(a - b) < tolerance;
async function screen(x, y) {
  return page.evaluate(
    ({ x, y }) => {
      const r = document.querySelector("#viewport").getBoundingClientRect(),
        v = styk.state.view;
      return { x: r.left + v.x + x * v.scale, y: r.top + v.y + y * v.scale };
    },
    { x, y },
  );
}
async function frames() {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
}
async function zoomCommand(action) {
  await page.locator("#zoom-label").click();
  await page.locator(`#menu [data-action="${action}"]`).click();
  await frames();
}
async function rightClick(x, y) {
  const p = await screen(x, y);
  await page.mouse.click(p.x, p.y, { button: "right" });
  await page.locator("#menu").waitFor({ state: "visible" });
}
async function menuBounds() {
  return page.evaluate(() => {
    const r = document.querySelector("#menu").getBoundingClientRect();
    return {
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      width: innerWidth,
      height: innerHeight,
    };
  });
}
function clamped(r) {
  return (
    r.left >= 7 &&
    r.top >= 7 &&
    r.right <= r.width - 7 &&
    r.bottom <= r.height - 7
  );
}
const selection = () => page.evaluate(() => [...styk.editor.selectedUids]);
const order = () =>
  page.evaluate(() =>
    styk.editor.frame.object_draw_order.map(
      (slot) => styk.editor.frame.objects[slot].unique_id,
    ),
  );

try {
  await page.goto(process.env.STYK_URL || "http://127.0.0.1:47831");
  await page.waitForFunction(() => window.styk?.ready);
  check(
    "Canvas workspace initializes its actual WebGPU canvas",
    await page.evaluate(() => styk.state.renderer.stats.backend === "WebGPU"),
  );
  await page.evaluate(async () => {
    const { emptyDocument, createObject, createFrame } = await import(
      "/src/demo.mjs"
    );
    const document = emptyDocument(),
      walker = document.figure_types[0],
      ball = structuredClone(walker);
    ball.figure_type_id = 2;
    ball.name = "Ball";
    ball.segments = [
      {
        ...ball.segments[0],
        segment_id: 1,
        parent_id: 0,
        length: 35,
        angle_rad: -Math.PI / 2,
        primitive_code: 3,
        segment_kind: "circleFill",
        segment_type: "circle",
        thickness: 0,
        aux_code: 0,
        color_rgb: [240, 165, 71],
      },
    ];
    ball.segment_count = 1;
    document.figure_types.push(ball);
    document.canvas_width = 800;
    document.canvas_height = 450;
    const objects = [
      createObject(walker, 1, 210, 285, { scale: 0.6 }),
      createObject(walker, 2, 430, 300, { scale: 0.6 }),
      createObject(ball, 3, 620, 300),
    ];
    document.keyframes = [
      createFrame(objects, 4),
      createFrame(structuredClone(objects), 1),
    ];
    document._styk.name = "Canvas workspace verification";
    styk.editor.load(document);
    styk.editor.select(1);
    styk.fit();
  });
  await page.locator('[data-tool="select"]').click();
  await frames();
  const initialPose = await pose(),
    initialView = await view(),
    from = await screen(210, 285);
  await page.keyboard.down("Space");
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 72, from.y + 44, { steps: 8 });
  check(
    "Space-drag enters canvas pan instead of figure posing",
    await page.evaluate(
      () => styk.state.drag?.kind === "pan" && !styk.state.playing,
    ),
  );
  await page.mouse.up();
  await page.keyboard.up("Space");
  await frames();
  const panned = await view();
  check(
    "Space-drag moves the view by the pointer delta without changing scale",
    near(panned.x - initialView.x, 72) &&
      near(panned.y - initialView.y, 44) &&
      panned.scale === initialView.scale,
  );
  check(
    "Releasing Space after a pan neither starts playback nor edits poses",
    JSON.stringify(await pose()) === JSON.stringify(initialPose) &&
      (await page.evaluate(
        () => !styk.state.playing && !styk.editor.dirty && !styk.state.space,
      )),
  );
  await page.keyboard.press("Space");
  await page.waitForFunction(() => styk.state.playing);
  check("Tapping Space starts playback", true);
  await page.keyboard.press("Space");
  await page.waitForFunction(() => !styk.state.playing);
  check("Tapping Space again pauses playback", true);
  const rect = await page.locator("#viewport").boundingBox();
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  const beforeWheel = await view();
  await page.mouse.wheel(36, 58);
  await page.waitForFunction((y) => styk.state.view.y !== y, beforeWheel.y);
  const afterWheel = await view();
  check(
    "Ordinary horizontal and vertical wheel motion pans without zoom",
    near(afterWheel.x - beforeWheel.x, -36) &&
      near(afterWheel.y - beforeWheel.y, -58) &&
      near(afterWheel.scale, beforeWheel.scale, 1e-8),
  );
  const beforeZoom = await view();
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -60);
  await page.keyboard.up("Control");
  await page.waitForFunction(
    (scale) => styk.state.view.scale !== scale,
    beforeZoom.scale,
  );
  const zoomed = await view();
  check("Ctrl-wheel zooms the canvas", zoomed.scale > beforeZoom.scale);
  const local = { x: rect.width / 2, y: rect.height / 2 };
  check(
    "Ctrl-wheel preserves the scene point beneath the cursor",
    near(
      (local.x - beforeZoom.x) / beforeZoom.scale,
      (local.x - zoomed.x) / zoomed.scale,
    ) &&
      near(
        (local.y - beforeZoom.y) / beforeZoom.scale,
        (local.y - zoomed.y) / zoomed.scale,
      ),
  );
  for (const percent of [25, 50, 100, 200]) {
    await zoomCommand(`zoom-${percent}`);
    check(
      `Zoom dropdown selects exactly ${percent}%`,
      near((await view()).scale, percent / 100, 1e-8),
    );
  }
  await page.locator("#zoom-label").click();
  await page.keyboard.press("ArrowDown");
  check(
    "Menu arrow keys focus commands without seeking animation",
    await page.evaluate(
      () => document.activeElement?.dataset.action === "zoom-out",
    ),
  );
  const keyboardZoomBefore = (await view()).scale;
  await page.keyboard.press("Enter");
  check(
    "Enter activates the focused menu command",
    near((await view()).scale, keyboardZoomBefore / 1.2, 1e-8),
  );
  await page.locator("#zoom-label").click();
  await page.keyboard.press("Escape");
  check(
    "Escape closes the menu and restores canvas focus",
    (await page.locator("#menu").isHidden()) &&
      (await page.evaluate(() => document.activeElement?.id === "viewport")),
  );
  await zoomCommand("zoom-reset");
  const fitView = await view();
  check(
    "Fit canvas places the complete artboard inside the workspace",
    await page.evaluate(() => {
      const v = styk.state.view,
        r = document.querySelector("#viewport").getBoundingClientRect();
      return (
        v.x >= 0 &&
        v.y >= 0 &&
        v.x + styk.editor.report.canvas_width * v.scale <= r.width &&
        v.y + styk.editor.report.canvas_height * v.scale <= r.height
      );
    }),
  );
  await zoomCommand("zoom-selection");
  const selectedView = await view();
  check(
    "Fit selection zooms into the selected figure",
    selectedView.scale > fitView.scale,
  );
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("Shift+Digit1");
  await frames();
  check(
    "Shift+1 restores Fit canvas",
    near((await view()).scale, fitView.scale, 1e-8),
  );
  await page.keyboard.press("Shift+Digit2");
  await frames();
  check(
    "Shift+2 fits the selection",
    near((await view()).scale, selectedView.scale, 1e-8),
  );
  await zoomCommand("zoom-reset");
  await rightClick(430, 300);
  check(
    "Right-click selects the figure under the pointer before opening its menu",
    (await selection()).join(",") === "2",
  );
  check(
    "Canvas context menu offers figure and selection actions",
    (await page.locator('#menu [data-action="select-same"]').isVisible()) &&
      (await page.locator('#menu [data-action="layer-front"]').isVisible()),
  );
  check(
    "Context menu stays within the window viewport",
    clamped(await menuBounds()),
  );
  await page.keyboard.press("Escape");
  await page.screenshot({ path: path.join(out, "canvas-workspace-1366.png") });
  // Root installs these actions independently from the navigation chrome.
  await page.waitForFunction(
    () =>
      ["select-same", "select-invert", "layer-front", "layer-back"].every(
        (key) => typeof styk.actions[key] === "function",
      ),
    undefined,
    { timeout: 60000 },
  );
  await rightClick(430, 300);
  await page.locator('#menu [data-action="select-same"]').click();
  check(
    "Select same figure selects both reusable walker instances",
    [...(await selection())].sort().join(",") === "1,2",
  );
  await rightClick(430, 300);
  await page.locator('#menu [data-action="select-invert"]').click();
  check(
    "Invert selection selects only the previously unselected figure",
    (await selection()).join(",") === "3",
  );
  await rightClick(430, 300);
  await page.locator('#menu [data-action="layer-front"]').click();
  check(
    "Bring to front changes the actual native layer order",
    (await order()).join(",") === "1,3,2",
  );
  await rightClick(430, 300);
  await page.locator('#menu [data-action="layer-back"]').click();
  check(
    "Send to back changes the actual native layer order",
    (await order()).join(",") === "2,1,3",
  );
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("Control+z");
  check(
    "Context-menu layer changes are undoable",
    (await order()).join(",") === "1,3,2",
  );
  await page.setViewportSize({ width: 900, height: 700 });
  await frames();
  await zoomCommand("zoom-reset");
  const compact = await page.locator("#viewport").boundingBox();
  await page.mouse.click(
    compact.x + compact.width - 12,
    compact.y + compact.height - 12,
    { button: "right" },
  );
  await page.locator("#menu").waitFor({ state: "visible" });
  check(
    "Right-click menu clamps at the compact workspace lower-right edge",
    clamped(await menuBounds()),
  );
  await page.screenshot({
    path: path.join(out, "canvas-workspace-900-menu.png"),
  });
  await page.keyboard.press("Escape");
  check(
    "Compact workspace retains its canvas, toolbar and timeline without document overflow",
    (await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= innerWidth &&
        document.documentElement.scrollHeight <= innerHeight,
    )) &&
      (await page.locator('[data-tool="select"]').isVisible()) &&
      (await page.locator("#timeline").isVisible()),
  );
  await page.screenshot({ path: path.join(out, "canvas-workspace-900.png") });
  check(
    "Canvas workspace gestures emit no browser runtime errors",
    errors.length === 0,
  );
  await writeFile(
    path.join(out, "canvas-workspace-verification.json"),
    JSON.stringify(
      {
        checks,
        errors,
        visualReview:
          "Screenshots retained for bounding-box and compact-layout inspection.",
      },
      null,
      2,
    ),
  );
} catch (error) {
  await page.screenshot({
    path: path.join(out, "canvas-workspace-failure.png"),
  });
  await writeFile(
    path.join(out, "canvas-workspace-verification.json"),
    JSON.stringify({ checks, errors, failure: error.stack }, null, 2),
  );
  throw error;
} finally {
  await browser.close();
}
