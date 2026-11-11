/** Real builder controls, native figure round-trip, and every image export button. */
import { chromium } from "./support/playwright.mjs";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chooseExport, exportDialogClosed } from "./helpers/export-dialog.mjs";

const out = path.resolve("artifacts"),
  url = process.env.STYK_URL || "http://127.0.0.1:47831";
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({
  viewport: { width: 1560, height: 1000 },
  acceptDownloads: true,
});
// Headless Chrome aborts showSaveFilePicker; removing it exercises the
// MemorySink + anchor-download fallback path instead of a silent cancel.
await page.addInitScript(() => {
  delete window.showSaveFilePicker;
});
page.setDefaultTimeout(15000);
const checks = [],
  errors = [];
page.on("pageerror", (error) => errors.push(error.stack));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
const check = (name, result = true) => {
  assert.ok(result, name);
  checks.push(name);
  console.log("PASS", name);
};
const value = (fn) => page.evaluate(fn);
const segmentCount = () => value(() => styk.editor.figure.segments.length);
async function selectJoint(index) {
  if (await page.locator('[data-tool="rig"]').isHidden()) await page.locator('[data-workspace-mode="rig"]').click();
  await page.locator('[data-tool="rig"]').click();
  const point = await page.evaluate(async (index) => {
    const { worldToScreen } = await import("/src/renderer-geometry.mjs");
    const { editor, state } = styk,
      r = document.querySelector("#viewport").getBoundingClientRect();
    const p = worldToScreen(
      editor.geometry.objects.get(editor.selectedSlot).segments[index].end,
      { report: editor.report, frame: editor.frame, view: state.view },
    );
    return { x: r.x + p.x, y: r.y + p.y };
  }, index);
  await page.mouse.click(point.x, point.y);
  await page.waitForFunction(
    (index) => styk.editor.selectedJoint === index,
    index,
  );
}
async function undo() {
  await page.locator('[data-tool="select"]').click();
  await page.keyboard.press("Control+z");
}
async function exportDownload(action, filename) {
  await page.locator('.titlebar [data-action="export"]').click();
  await chooseExport(page, action);
  const promise = page.waitForEvent("download");
  promise.catch(() => {});
  await page.locator("#export-dialog #export-submit").click();
  const download = await promise,
    target = path.join(out, filename);
  await download.saveAs(target);
  await exportDialogClosed(page);
  return {
    target,
    suggested: download.suggestedFilename(),
    bytes: await readFile(target),
  };
}
try {
  await page.goto(url);
  await page.waitForFunction(() => window.styk?.ready);
  check(
    "Builder APIs are installed",
    await value(
      () =>
        typeof styk.editor.addPolygon === "function" &&
        typeof styk.editor.duplicateSegmentBranch === "function",
    ),
  );
  // Regression: once a pose edit materializes the layer-sheet cell into a
  // frame source, drawing a new figure with nothing selected must publish it
  // to the evaluated frame — not just report.keyframes.
  await value(() => {
    const e = styk.editor;
    e.select(e.evaluatedFrame.objects[0].unique_id);
    e.updateObject({ root_x: e.object.root_x + 12 });
    e.select(null);
  });
  check(
    "Pose edit materializes the layer-sheet cell",
    await value(
      () =>
        styk.editor.report._styk.layerSheet.tracks["layer-1"].keys[0].value
          ?.frameId,
    ),
  );
  await page.locator('[data-workspace-mode="rig"]').click();
  const box = await page.locator("#overlay").boundingBox();
  await page.mouse.move(box.x + 300, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 420, box.y + 300, { steps: 5 });
  await page.mouse.up();
  check(
    "Builder draw creates a visible figure on a materialized cell",
    await value(
      () =>
        styk.builder.session?.mode === "create" &&
        styk.editor.figure?.segments.length === 1 &&
        styk.editor.evaluatedFrame.objects.some(
          (o) => o.unique_id === styk.editor.selectedUid,
        ),
    ),
  );
  await value(() => {
    const e = styk.editor;
    e.newDocument();
    e.selectMany(e.evaluatedFrame.objects.map((o) => o.unique_id));
    e.deleteSelection();
  });
  await page.locator('[data-workspace-mode="rig"]').click();
  const view = await page.locator("#overlay").boundingBox();
  const points = [
    [230, 180],
    [390, 180],
    [390, 340],
    [230, 340],
  ].map(([x, y]) => ({ x: view.x + x, y: view.y + y }));
  for (let i = 0; i < 3; i++) {
    await page.mouse.move(points[i].x, points[i].y);
    await page.mouse.down();
    await page.mouse.move(points[i + 1].x, points[i + 1].y, { steps: 5 });
    await page.mouse.up();
  }
  check(
    "Canvas line tool creates three connected joints",
    (await segmentCount()) === 3 &&
      (await value(
        () =>
          styk.editor.figure.segments.map((s) => s.parent_id).join(",") ===
          "0,1,2",
      )),
  );
  await page.locator('[data-tool="polygon"]').click();
  const joints = await value(() => {
    const { editor, state } = styk,
      rect = document.querySelector("#overlay").getBoundingClientRect();
    return [...editor.geometry.objects.get(editor.selectedSlot).joints].map(
      ([id, p]) => ({
        id,
        x: rect.x + state.view.x + p.x * state.view.scale,
        y: rect.y + state.view.y + p.y * state.view.scale,
      }),
    );
  });
  for (const id of [0, 1, 2]) {
    const point = joints.find((p) => p.id === id);
    await page.mouse.click(point.x, point.y);
  }
  check(
    "Polygon draft tracks three clicked joints",
    (await page.locator("#polygon-count").textContent()) === "3 joints",
  );
  await page.keyboard.press("Enter");
  check(
    "Enter commits joint-bound polygon",
    await value(
      () =>
        styk.editor.figure.polyfills.length === 1 &&
        styk.editor.figure.polyfills[0].segment_ids.join(",") === "0,1,2",
    ),
  );
  check(
    "Created polygon exposes its color and delete controls",
    (await page.locator('[data-polygon-color="0"]').count()) === 1 &&
      (await page.locator('[data-delete-polygon="0"]').count()) === 1,
  );
  await page
    .locator('[data-section-toggle="colours"]')
    .click();
  await page.locator('[data-polygon-color="0"]').fill("#0d99ff");
  await page.locator('[data-polygon-color="0"]').dispatchEvent("change");
  check(
    "Polygon color control edits native fill",
    await value(async () => {
      const { resolveInstanceFigure } = await import(
        "/src/animation-style.mjs"
      );
      return (
        resolveInstanceFigure(
          styk.editor.figure,
          styk.editor.object,
        ).polyfills[0].color_rgb.join(",") === "13,153,255"
      );
    }),
  );
  await page.locator('[data-delete-polygon="0"]').click();
  check(
    "Delete polygon removes only the fill",
    (await value(() => styk.editor.figure.polyfills.length === 0)) &&
      (await segmentCount()) === 3,
  );
  await undo();
  check(
    "Polygon deletion is undoable",
    await value(() => styk.editor.figure.polyfills.length === 1),
  );
  await selectJoint(2);
  await page.locator("#segment-shape").selectOption("circleFill");
  check(
    "Shape control converts line to solid circle",
    await value(() => styk.editor.figure.segments[2].primitive_code === 3),
  );
  await page.locator("#segment-shape").selectOption("line");
  check(
    "Shape control restores line",
    await value(() => styk.editor.figure.segments[2].primitive_code === 0),
  );
  await page.locator("#segment-color").click();
  await page.locator(".paint-picker [data-hex]").fill("FF8000");
  await page.locator(".paint-picker [data-hex]").press("Tab");
  await page.keyboard.press("Escape");
  await page.locator("#segment-opacity").fill("40");
  await page.locator("#segment-opacity").press("Tab");
  check(
    "Segment color and opacity preserve native values",
    await value(async () => {
      const { resolveInstanceFigure } = await import(
        "/src/animation-style.mjs"
      );
      const segment = resolveInstanceFigure(
        styk.editor.figure,
        styk.editor.object,
      ).segments[2];
      return (
        segment.color_rgb.join(",") === "255,128,0" &&
        segment.transparency === 153
      );
    }),
  );
  await selectJoint(0);
  await page.locator('.ui-quick [data-action="split-segment"]').click();
  check("Split button inserts a joint", (await segmentCount()) === 4);
  await undo();
  check("Split undoes in one step", (await segmentCount()) === 3);
  await selectJoint(1);
  await page
    .locator('.ui-quick [data-action="duplicate-segment"]')
    .click({ modifiers: ["Shift"] });
  const parentJoint = await value(async () => {
    const { worldToScreen } = await import("/src/renderer-geometry.mjs");
    const { editor, state } = styk,
      r = document.querySelector("#viewport").getBoundingClientRect(),
      p = worldToScreen(
        editor.geometry.objects.get(editor.selectedSlot).joints.get(0),
        { report: editor.report, frame: editor.frame, view: state.view },
      );
    return { x: r.x + p.x, y: r.y + p.y };
  });
  await page.mouse.click(parentJoint.x, parentJoint.y);
  check("Duplicate branch clones descendants", (await segmentCount()) === 5);
  await page.locator('.ui-quick [data-action="delete-single-segment"]').click({ modifiers: ["Shift"] });
  check("Delete branch removes its descendants", (await segmentCount()) === 3);
  await undo();
  check("Branch deletion is undoable", (await segmentCount()) === 5);
  await undo();
  check("Branch duplication is undoable", (await segmentCount()) === 3);
  const beforeOrigin = await value(() =>
    [
      ...styk.editor.geometry.objects
        .get(styk.editor.selectedSlot)
        .joints.values(),
    ].map((p) => [p.x, p.y]),
  );
  await selectJoint(1);
  await page.evaluate(() => styk.actions['origin-segment']());
  const afterOrigin = await value(() =>
    [
      ...styk.editor.geometry.objects
        .get(styk.editor.selectedSlot)
        .joints.values(),
    ].map((p) => [p.x, p.y]),
  );
  check(
    "Set origin preserves every visible joint position",
    beforeOrigin.every((a) =>
      afterOrigin.some((b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.001),
    ),
  );
  check(
    "Set origin moves orange root to the chosen endpoint",
    Math.hypot(
      (await value(() => styk.editor.object.root_x)) - beforeOrigin[2][0],
      (await value(() => styk.editor.object.root_y)) - beforeOrigin[2][1],
    ) < 0.001,
  );
  await page.screenshot({ path: path.join(out, "builder-workspace.png") });
  const figureFile = await exportDownload(
    "export-stk",
    "builder-roundtrip.stk",
  );
  check(
    "Selected figure STK button downloads a native file",
    figureFile.bytes.length > 10 && figureFile.suggested.endsWith(".stk"),
  );
  const beforeImport = await value(
    () => styk.editor.evaluatedFrame.objects.length,
  );
  await page.locator("#file-input").setInputFiles(figureFile.target);
  await page.waitForFunction(
    (n) => styk.editor.evaluatedFrame.objects.length === n + 1,
    beforeImport,
  );
  check(
    "Authored STK imports with joints, polygons, and style",
    await value(() => {
      const imported = styk.editor.report.figure_types.at(-1);
      return (
        imported.segments.length === 3 &&
        imported.polyfills.length === 1 &&
        imported.segments.some(
          (s) =>
            s.color_rgb.join(",") === "255,128,0" && s.transparency === 153,
        )
      );
    }),
  );

  // Small deterministic fixture; actions below still pass through the real export dialog.
  await value(async () => {
    const e = styk.editor, {emptyDocument, createFrame, createObject} = await import("/src/demo.mjs"), blank = emptyDocument();
    blank.keyframes = [createFrame([createObject(blank.figure_types[0], 1, 150, 90, {scale: 0.3})], 1)];
    e.load(blank, "Export fixture");
    e.setCanvasSize(320, 180);
    e.setFPS(24);
    e.select(e.evaluatedFrame.objects[0].unique_id);
    e.updateObject({ root_x: 150, root_y: 90, scale: 0.3 });
    e.sheetSetDuration(3, e.activeLayerId, 0);
    e.sheetInsertKey([e.activeLayerId], 1);
    e.sheetInsertKey([e.activeLayerId], 2);
    e.seek(1);
    e.updateObject({ root_x: 160 });
    e.seek(2);
    e.updateObject({ root_x: 170 });
    e.seek(0);
  });
  check(
    "Export fixture has three exact display frames",
    (await value(() => styk.editor.totalTicks)) === 3,
  );
  for (const [action, extension, signature] of [
    ["export-gif", "gif", "GIF89a"],
    ["export-apng", "apng", "\x89PNG"],
    ["export-svg", "svg", null],
    ["export-png-sequence", "png-sequence.zip", "PK"],
    ["export-jpeg-sequence", "jpeg-sequence.zip", "PK"],
  ]) {
    const file = await exportDownload(action, `builder-export.${extension}`);
    check(
      `${action} button produces a non-empty download`,
      file.bytes.length > 100,
    );
    if (signature)
      check(
        `${action} has the expected container signature`,
        file.bytes
          .subarray(0, signature.length)
          .equals(Buffer.from(signature, "latin1")),
      );
    if (extension === "gif" || extension === "apng") {
      const decoded = await page.evaluate(
        async ({ bytes, type }) => {
          const decoder = new ImageDecoder({
            data: new Uint8Array(bytes),
            type,
            preferAnimation: true,
          });
          try {
            await decoder.tracks.ready;
            const { image } = await decoder.decode({ frameIndex: 2 });
            const report = {
              frames: decoder.tracks.selectedTrack.frameCount,
              width: image.displayWidth,
              height: image.displayHeight,
            };
            image.close();
            return report;
          } finally {
            decoder.close();
          }
        },
        {
          bytes: [...file.bytes],
          type: extension === "gif" ? "image/gif" : "image/png",
        },
      );
      check(
        `${action} decodes three full-size frames`,
        decoded.frames === 3 && decoded.width === 320 && decoded.height === 180,
      );
    } else if (extension.endsWith(".zip")) {
      const end = file.bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
      assert.ok(end >= 0, "ZIP end directory exists");
      const count = file.bytes.readUInt16LE(end + 10),
        names = [];
      let offset = file.bytes.readUInt32LE(end + 16);
      for (let i = 0; i < count; i++) {
        const length = file.bytes.readUInt16LE(offset + 28);
        names.push(
          file.bytes.toString("utf8", offset + 46, offset + 46 + length),
        );
        offset +=
          46 +
          length +
          file.bytes.readUInt16LE(offset + 30) +
          file.bytes.readUInt16LE(offset + 32);
      }
      check(
        `${action} contains three numbered frames`,
        names.filter((name) => /^frame-\d{6}\.(png|jpg|jpeg)$/.test(name))
          .length === 3 && names.includes("animation.json"),
      );
    } else {
      const svg = file.bytes.toString("utf8");
      check(
        "SVG download contains editable vector geometry",
        svg.includes("<svg") &&
          /<(path|line|circle|polygon)/.test(svg) &&
          /(?:viewBox="0 0 320 180"|width="320")/.test(svg),
      );
    }
  }
  assert.deepEqual(errors, []);
  check("No runtime or console errors");
  await writeFile(
    path.join(out, "builder-verification.json"),
    JSON.stringify(
      { checks, errors, timestamp: new Date().toISOString() },
      null,
      2,
    ),
  );
} catch (error) {
  await page.screenshot({ path: path.join(out, "builder-failure.png") });
  await writeFile(
    path.join(out, "builder-verification.json"),
    JSON.stringify({ checks, errors, failure: error.stack }, null, 2),
  );
  throw error;
} finally {
  await browser.close();
}
