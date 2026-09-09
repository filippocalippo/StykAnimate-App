/** Root wiring for I over a Pivot handle and the actual canvas context menu. */
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const output = path.resolve("artifacts/segment-values-app");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true }),
  context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    permissions: ["clipboard-read", "clipboard-write"],
  }),
  page = await context.newPage();
const checks = [],
  errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const check = (name, value = true) => {
    assert.ok(value, name);
    checks.push(name);
    console.log("PASS", name);
  },
  near = (a, b) => Math.abs(a - b) < 0.00051;
const state = () =>
  page.evaluate(() => ({
    values: styk.editor.segmentValues(),
    undo: styk.editor._undo.length,
    document: JSON.stringify(styk.editor.report.keyframes),
    dragging: styk.editor.dragging,
    joint: styk.editor.selectedJoint,
  }));
async function hover(handle = 22) {
  const point = await page.evaluate(async (handle) => {
    const { worldToScreen } = await import("/src/renderer-geometry.mjs"),
      e = styk.editor,
      r = document.querySelector("#viewport").getBoundingClientRect(),
      p = worldToScreen(e.geometry.objects.get(0).joints.get(handle), {
        report: e.report,
        frame: e.evaluatedFrame,
        view: styk.state.view,
        cameraEnabled: false,
      });
    return { x: r.x + p.x, y: r.y + p.y };
  }, handle);
  await page.locator("#viewport").focus();
  await page.mouse.move(point.x, point.y);
  await page.waitForFunction(() => styk.state.hoverHandle?.uid === 1);
  return point;
}
try {
  await page.goto(process.env.STYK_URL || "http://127.0.0.1:47831");
  await page.waitForFunction(() => window.styk?.ready);
  await page.evaluate(async () => {
    const { emptyDocument, createObject, createFrame } = await import(
        "/src/demo.mjs"
      ),
      report = emptyDocument(),
      figure = report.figure_types[0],
      base = figure.segments[0];
    figure.segments = [
      {
        ...base,
        segment_id: 11,
        parent_id: 0,
        length: 100,
        angle_rad: 0.2,
        bend_rad: 0.7,
      },
      {
        ...base,
        segment_id: 22,
        parent_id: 11,
        length: 55,
        angle_rad: 1,
        bend_rad: -0.3,
      },
      { ...base, segment_id: 33, parent_id: 0, length: 60, angle_rad: 2.5 },
    ];
    figure.segment_count = 3;
    report.keyframes = [createFrame([createObject(figure, 1, 260, 160)])];
    styk.editor.load(report, "Segment values");
    styk.editor.select(1, 0);
    styk.fit();
  });
  await page.locator('[data-tool="select"]').first().click();
  await hover();
  await page.keyboard.press("i");
  await page.locator("#segment-angle").waitFor({ state: "visible" });
  check(
    "I over a Pivot node selects that segment and opens the real dialog",
    (await state()).joint === 1 && (await state()).dragging,
  );
  const before = await state(),
    box = await page
      .locator('[data-property-row="angle"] [data-property-scrub]')
      .boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2, {
    steps: 5,
  });
  await page.mouse.up();
  check(
    "Root modal scrub previews the actual pose without a history command",
    near((await state()).values.angle, before.values.angle + 12) &&
      (await state()).undo === before.undo,
  );
  await page.locator("#segment-length").fill("72.123456");
  await page.locator("#segment-length").press("Tab");
  await page.screenshot({ path: path.join(output, "live-values.png") });
  await page.locator("#segment-values-apply").click();
  await page.waitForFunction(() => !document.querySelector("#dialog").open);
  check(
    "Root Apply commits all previews as one undo",
    (await state()).undo === before.undo + 1 &&
      near((await state()).values.length, 72.123456),
  );
  await page.locator('[data-tool="select"]').first().click();
  await page.keyboard.press("Control+z");
  check(
    "Actual root Undo restores exact pre-dialog native frame data",
    (await state()).document === before.document,
  );
  const point = await hover();
  await page.mouse.click(point.x + 90, point.y + 60, { button: "right" });
  await page.locator('#menu [data-action="segment-values"]').click();
  await page.locator("#segment-angle").waitFor({ state: "visible" });
  check("Canvas context menu opens the same segment value dialog", true);
  await page.locator("#segment-angle").fill("90");
  await page.locator("#segment-angle").press("Tab");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("#dialog").open);
  check(
    "Escape from the root modal restores the source without history",
    (await state()).document === before.document &&
      (await state()).undo === before.undo,
  );
  await hover();
  await page.keyboard.press("i");
  await page.locator("#segment-angle").waitFor({ state: "visible" });
  await page.evaluate(() => navigator.clipboard.writeText("bad:30:bad:10:80"));
  await page.locator("#segment-values-paste").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#segment-values-status").textContent ===
      "Pasted 3 values.",
  );
  check(
    "Root clipboard button uses native partial-token semantics",
    near((await state()).values.angle, 30) &&
      near((await state()).values.bend, 10) &&
      near((await state()).values.length, 80),
  );
  await page.locator("#segment-values-cancel").click();
  check(
    "Clipboard cancellation restores exact scene data",
    (await state()).document === before.document,
  );
  await hover();
  await page.keyboard.down("r");
  await page.keyboard.press("i");
  await page.locator("#segment-angle").waitFor({ state: "visible" });
  await page.keyboard.up("r");
  check(
    "Holding R while opening I selects native Handle Edit value behavior",
    (await page.locator(".segment-values-caption").textContent()).includes(
      "Handle Edit",
    ),
  );
  await page.locator("#segment-length").fill("95");
  await page.locator("#segment-length").press("Tab");
  await page.locator("#segment-values-apply").click();
  check(
    "Handle Edit value application is one undoable root command",
    (await state()).undo === before.undo + 1 &&
      near((await state()).values.length, 95),
  );
  check(
    "Root integration reports no uncaught browser errors",
    errors.length === 0,
  );
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify({ checks, errors }, null, 2),
  );
} catch (error) {
  await page.screenshot({ path: path.join(output, "failure.png") });
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify({ checks, errors, failure: error.stack }, null, 2),
  );
  throw error;
} finally {
  await browser.close();
}
