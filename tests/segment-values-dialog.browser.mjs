import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const output = path.resolve("artifacts/segment-values-dialog");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({
  viewport: { width: 1100, height: 780 },
  permissions: ["clipboard-read", "clipboard-write"],
});
const page = await context.newPage(),
  checks = [],
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const check = (name, valid = true) => {
  assert.ok(valid, name);
  checks.push(name);
  console.log("PASS", name);
};
const near = (a, b) => Math.abs(a - b) < 1e-4;
const state = () =>
  page.evaluate(() => ({
    values: editor.segmentValues(),
    relative: editor.segmentValues({ relative: true }),
    undo: editor._undo.length,
    dragging: editor.dragging,
    document: JSON.stringify(editor.report.keyframes),
    open: document.querySelector("#dialog").open,
  }));
async function setup({ joint = 0, editMode = false, relative = false } = {}) {
  await page.evaluate(
    async ({ joint, editMode, relative }) => {
      window.valueDialog?.destroy();
      const { Editor } = await import("/src/editor.mjs"),
        { emptyDocument, createFrame, createObject } = await import(
          "/src/demo.mjs"
        ),
        { SegmentValuesDialog } = await import(
          "/src/segment-values-dialog.mjs"
        );
      const report = emptyDocument(),
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
      report.keyframes = [
        createFrame([createObject(figure, 1, 300, 220)]),
        createFrame([createObject(figure, 1, 320, 200)]),
      ];
      window.editor = new Editor({ demo: false }).load(report);
      editor.select(1, joint);
      window.beforeDocument = JSON.stringify(editor.report.keyframes);
      window.valueDialog = new SegmentValuesDialog({
        dialog: document.querySelector("#dialog"),
        content: document.querySelector("#dialog-content"),
        editor,
      });
      valueDialog.open({ editMode, relative });
    },
    { joint, editMode, relative },
  );
}
async function type(key, value) {
  await page.locator("#segment-" + key).fill(String(value));
  await page.locator("#segment-" + key).press("Tab");
}
async function drag(key, dx, modifier) {
  const rect = await page
    .locator(`[data-property-row="${key}"] [data-property-scrub]`)
    .boundingBox();
  if (modifier) await page.keyboard.down(modifier);
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    rect.x + rect.width / 2 + dx,
    rect.y + rect.height / 2,
    { steps: 5 },
  );
  await page.mouse.up();
  if (modifier) await page.keyboard.up(modifier);
}
try {
  await page.route("**/src/app.mjs", (route) =>
    route.fulfill({ contentType: "text/javascript", body: "" }),
  );
  await page.goto(process.env.STYK_URL || "http://127.0.0.1:47831");
  await setup();
  let before = await state();
  check(
    "Opening segment values starts one preview with no history",
    before.dragging && before.undo === 0,
  );
  await type("angle", 60);
  await type("bend", 20);
  await type("length", 120);
  let after = await state();
  check(
    "Typing all three numeric fields changes the real model without undo entries",
    near(after.values.angle, 60) &&
      near(after.values.bend, 20) &&
      near(after.values.length, 120) &&
      after.undo === 0,
  );
  await drag("angle", 20);
  after = await state();
  check(
    "Figma label drag changes angle with pointer capture",
    near(after.values.angle, 80),
  );
  await drag("angle", 10, "Shift");
  after = await state();
  check("Shift provides fine numeric scrubbing", near(after.values.angle, 81));
  await drag("angle", 10, "Alt");
  after = await state();
  check("Alt provides finer numeric scrubbing", near(after.values.angle, 81.1));
  await page.locator("#segment-angle").fill("100");
  await page.locator("#segment-angle").press("Escape");
  after = await state();
  check(
    "Escape during typing restores that field gesture and keeps the dialog open",
    near(after.values.angle, 81.1) && after.open,
  );
  await page.keyboard.press("Escape");
  after = await state();
  check(
    "Escape outside a field gesture cancels the whole preview exactly",
    !after.open &&
      !after.dragging &&
      after.undo === 0 &&
      after.document === before.document,
  );

  await setup();
  await type("angle", 45);
  await type("bend", 30);
  await type("length", 125);
  await page.locator("#segment-values-apply").click();
  after = await state();
  check(
    "Apply commits the complete three-field preview as one undo",
    after.undo === 1 &&
      !after.dragging &&
      !after.open &&
      near(after.values.angle, 45) &&
      near(after.values.bend, 30) &&
      near(after.values.length, 125),
  );
  check(
    "Undo restores exact native frame data",
    await page.evaluate(() => {
      editor.undo();
      return JSON.stringify(editor.report.keyframes) === beforeDocument;
    }),
  );
  await page.evaluate(() => editor.redo());
  check(
    "Redo restores all edited segment values",
    near((await state()).values.length, 125),
  );

  await setup({ joint: 1 });
  before = await state();
  await page.locator("#segment-relative").check();
  after = await state();
  check(
    "Relative angle uses the incoming segment end tangent without changing pose",
    after.document === before.document &&
      near(after.relative.angle, ((1 - 0.9) * 180) / Math.PI) &&
      Math.abs(
        Number(await page.locator("#segment-angle").inputValue()) -
          after.relative.angle,
      ) < 0.00051,
  );
  await type("angle", 0);
  after = await state();
  check(
    "A zero relative angle aligns to the incoming tangent",
    near(after.values.angle, (0.9 * 180) / Math.PI),
  );
  await page.locator("#segment-values-cancel").click();
  after = await state();
  check(
    "Cancel restores exact native values after relative edits",
    after.document === before.document && after.undo === 0,
  );

  await setup();
  await page.locator("#segment-values-copy").click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  check(
    "Copy writes actual system clipboard values in Angle:Bend:Length order",
    copied.split(":").length === 3 && near(Number(copied.split(":")[2]), 100),
  );
  await page.evaluate(() =>
    navigator.clipboard.writeText("ignored:30:bad:-15:42.5:99"),
  );
  await page.locator("#segment-values-paste").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#segment-values-status").textContent ===
      "Pasted 3 values.",
  );
  after = await state();
  check(
    "Native clipboard ignores malformed tokens and compacts the first three numeric values",
    near(after.values.angle, 30) &&
      near(after.values.bend, -15) &&
      near(after.values.length, 42.5) &&
      after.undo === 0,
  );
  await page.evaluate(() => navigator.clipboard.writeText("45"));
  await page.locator("#segment-values-paste").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#segment-values-status").textContent ===
      "Pasted 1 value.",
  );
  after = await state();
  check(
    "Partial native paste changes only the leading field",
    near(after.values.angle, 45) &&
      near(after.values.bend, -15) &&
      near(after.values.length, 42.5),
  );
  await page.evaluate(() => navigator.clipboard.writeText("bad"));
  await page.locator("#segment-values-paste").click();
  await page.waitForFunction(() =>
    document
      .querySelector("#segment-values-status")
      .textContent.includes("No numeric"),
  );
  check(
    "All-invalid clipboard text is a harmless no-op",
    (await state()).document === after.document,
  );
  await page.evaluate(() => navigator.clipboard.writeText("30:-15:0"));
  await page.locator("#segment-values-paste").click();
  await page.locator("#segment-values-error").waitFor({ state: "visible" });
  check(
    "Invalid clipboard length does not modify the preview",
    (await state()).document === after.document,
  );
  await page.evaluate(
    () =>
      (valueDialog.clipboard = {
        readText: async () => {
          throw new Error("blocked");
        },
        writeText: async () => {
          throw new Error("blocked");
        },
      }),
  );
  await page.locator("#segment-values-paste").click();
  await page.locator("#segment-clipboard-input").waitFor({ state: "visible" });
  await page.locator("#segment-clipboard-input").fill("60,5:10,25");
  await page.locator("#segment-clipboard-use").click();
  after = await state();
  check(
    "Clipboard permission fallback accepts native decimal-comma values",
    near(after.values.angle, 60.5) &&
      near(after.values.bend, 10.25) &&
      near(after.values.length, 42.5),
  );
  await page.screenshot({ path: path.join(output, "clipboard.png") });
  await page.locator("#segment-values-apply").click();
  check(
    "Multiple clipboard previews still form one undo",
    (await state()).undo === 1,
  );

  await setup({ joint: 1, editMode: true });
  await type("angle", 45);
  await type("length", 75);
  await page.locator("#segment-values-apply").click();
  after = await state();
  check(
    "Handle Edit mode uses the same modal transaction and one undo",
    after.undo === 1 &&
      near(after.values.angle, 45) &&
      near(after.values.length, 75),
  );
  await setup();
  before = await state();
  await page.locator("#segment-length").fill("0");
  check(
    "Zero length is invalid and cannot be applied",
    (await page.locator("#segment-values-apply").isDisabled()) &&
      (await state()).document === before.document,
  );
  await page.locator("#segment-length").fill("88.123456");
  await page.locator("#segment-length").press("Enter");
  check(
    "Typed precision survives formatted display",
    near((await state()).values.length, 88.123456),
  );
  await page.screenshot({ path: path.join(output, "values.png") });
  await page.locator("#segment-values-cancel").click();
  check(
    "Final cancellation releases the modal model gesture",
    !(await state()).dragging,
  );
  check("Actual browser has no uncaught errors", errors.length === 0);
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
