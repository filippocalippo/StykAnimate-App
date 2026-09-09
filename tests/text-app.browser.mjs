import {readNativeDocument} from '../scripts/read-native-document.mjs';
/** Actual app integration: native import, contextual Edit text, undo, Save and native exports. */
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const output = path.resolve("artifacts/text-app");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({
  viewport: { width: 1400, height: 1000 },
  acceptDownloads: true,
});
const page = await context.newPage(),
  checks = [],
  errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.setDefaultTimeout(20000);
const check = (name, value = true) => {
  assert.ok(value, name);
  checks.push(name);
  console.log("PASS", name);
};
const ready = () =>
  page.waitForFunction(
    () =>
      document.querySelector("#text-preview-state")?.textContent === "Ready",
  );
const blur = () => page.locator('[data-tool="select"]').first().click();
async function download(action, name) {
  const pending = page.waitForEvent("download");
  await action();
  const file = await pending,
    target = path.join(output, name);
  await file.saveAs(target);
  return target;
}
async function imported(target, name) {
  await target.locator("#file-input").setInputFiles(name);
  await target.waitForFunction(
    (expected) => window.styk?.editor?.name === expected,
    path.basename(name, path.extname(name)),
  );
}
const renderPixels = (target) =>
  target.evaluate(async () => {
    const { buildGeometry, drawGeometry } = await import(
        "/src/pivot/geometry.mjs"
      ),
      doc = styk.editor.serialize(),
      canvas = document.createElement("canvas");
    canvas.width = doc.canvas_width;
    canvas.height = doc.canvas_height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.fillText =
      ctx.strokeText =
      ctx.measureText =
        () => {
          throw new Error("Text must use embedded vectors");
        };
    drawGeometry(ctx, buildGeometry(doc, doc.keyframes[0]));
    return Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
  });
try {
  const url = process.env.STYK_URL || "http://127.0.0.1:47831";
  await page.goto(url);
  await page.waitForFunction(() => window.styk?.ready);
  check(
    "Actual application initializes WebGPU",
    await page.evaluate(() => styk.state.renderer.stats.backend === "WebGPU"),
  );
  await imported(
    page,
    path.resolve("../Pivot Animator v5/Animations/text_abc.piv"),
  );
  const target = await page.evaluate(() => {
    const e = styk.editor,
      figure = e.report.figure_types.find(
        (f) => f.text_assets?.[0]?.font_name === "Arial",
      ),
      object = e.frame.objects.find(
        (o) => o.figure_type_id === figure.figure_type_id,
      );
    return {
      uid: object.unique_id,
      type: figure.figure_type_id,
      figure: structuredClone(figure),
    };
  });
  await page
    .locator(`.styk-tree-row[data-key="figure:${target.uid}"] .styk-tree-name`)
    .click();
  check(
    "Imported native text exposes the contextual Edit text action without app metadata",
    !target.figure._styk?.textAuthoring &&
      (await page.locator('[data-action="edit-text"]').isVisible()),
  );
  const undo = await page.evaluate(() => styk.editor._undo.length);
  await page.locator('[data-action="edit-text"]').click();
  await ready();
  check(
    "Root dialog recovers native Arial content and original glyph mode",
    (await page.locator("#text-content").inputValue()) === "Abc" &&
      (await page.locator("#text-font").inputValue()) === "embedded",
  );
  await page.locator("#text-content").fill("Abc Abc");
  await page.locator("#text-gradient-enabled").check();
  await page.locator("#text-outline-width").fill(".6");
  await ready();
  check(
    "Root live preview leaves the selected native definition and undo unchanged",
    await page.evaluate(
      ({ type, undo }) =>
        styk.editor.report.figure_types.find((f) => f.figure_type_id === type)
          .text_assets[0].text === "Abc" && styk.editor._undo.length === undo,
      { type: target.type, undo },
    ),
  );
  await page.screenshot({ path: path.join(output, "native-live-preview.png") });
  await page.locator("#create-text").click();
  await page.waitForFunction(() => !document.querySelector("#dialog").open);
  check(
    "Apply replaces only the native text definition with one undo",
    await page.evaluate(
      ({ uid, type, undo }) =>
        styk.editor.selectedUid === uid &&
        styk.editor.figure.figure_type_id === type &&
        styk.editor.figure.text_assets[0].text === "Abc Abc" &&
        styk.editor._undo.length === undo + 1,
      { ...target, undo },
    ),
  );
  await blur();
  await page.keyboard.press("Control+z");
  check(
    "Actual Undo restores original native text glyphs",
    await page.evaluate(() => styk.editor.figure.text_assets[0].text === "Abc"),
  );
  await page.keyboard.press("Control+Shift+z");
  check(
    "Actual Redo restores the edited embedded text",
    await page.evaluate(
      () => styk.editor.figure.text_assets[0].text === "Abc Abc",
    ),
  );
  const nativeFile = await download(
    () => page.locator('[data-action="save"]').first().click(),
    "native-text-edited.styk",
  );
  const saved = await readNativeDocument(nativeFile),
    savedDoc = saved.document || saved;
  check(
    "Actual Save writes portable glyphs and editable original-font metadata",
    savedDoc.figure_types.some(
      (f) =>
        f.text_assets?.[0]?.text === "Abc Abc" &&
        f._styk?.textAuthoring?.fontOrigin === "embedded",
    ),
  );
  await imported(page, nativeFile);
  await page
    .locator(`.styk-tree-row[data-key="figure:${target.uid}"] .styk-tree-name`)
    .click();
  await page.locator('[data-action="edit-text"]').click();
  await ready();
  check(
    "Native Save/reopen retains original-font text editing and scale semantics",
    (await page.locator("#text-font").inputValue()) === "embedded" &&
      (await page.locator("#text-size-label").textContent()) === "Scale · %" &&
      (await page.locator("#text-content").inputValue()) === "Abc Abc",
  );
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("#dialog").open);
  const sourcePixels = await renderPixels(page);
  await page.locator('[data-action="export"]').first().click();
  const pivFile = await download(
    () => page.locator('[data-action="export-piv"]').click(),
    "native-text-edited.piv",
  );
  check(
    "Actual PIV export produces a native binary file",
    (await readFile(pivFile)).length > 100,
  );
  const portableContext = await browser.newContext({
      viewport: { width: 1400, height: 1000 },
    }),
    portable = await portableContext.newPage();
  portable.on("pageerror", (error) => errors.push(error.message));
  await portable.route("**/*.ttf", (route) => route.abort());
  await portable.route("**/*.otf", (route) => route.abort());
  await portable.goto(url);
  await portable.waitForFunction(() => window.styk?.ready);
  await imported(portable, pivFile);
  const reopenedPixels = await renderPixels(portable);
  check(
    "Fresh actual app reopens PIV with no font loading and identical rendered pixels",
    sourcePixels.every((value, index) => value === reopenedPixels[index]),
  );
  await portable.screenshot({
    path: path.join(output, "portable-piv-reopened.png"),
  });
  const uid = await portable.evaluate(() => {
    const e = styk.editor,
      f = e.report.figure_types.find(
        (f) => f.text_assets?.[0]?.text === "Abc Abc",
      );
    return e.frame.objects.find((o) => o.figure_type_id === f.figure_type_id)
      .unique_id;
  });
  await portable
    .locator(`.styk-tree-row[data-key="figure:${uid}"] .styk-tree-name`)
    .click();
  await portable.locator('[data-action="edit-text"]').click();
  await portable.waitForFunction(
    () =>
      document.querySelector("#text-preview-state")?.textContent === "Ready",
  );
  check(
    "Reopened native PIV offers embedded text editing after losing private metadata",
    (await portable.locator("#text-content").inputValue()) === "Abc Abc" &&
      (await portable.locator("#text-font").inputValue()) === "embedded",
  );
  await portableContext.close();

  await blur();
  await page.keyboard.press("t");
  await ready();
  await page.locator("#text-content").fill("New Café\nПривет");
  await page.locator("#text-bold").check();
  await page.locator("#text-italic").check();
  await page.locator("#text-size").fill("32");
  await ready();
  await page.locator("#create-text").click();
  await page.waitForFunction(() => !document.querySelector("#dialog").open);
  check(
    "T shortcut creates multilingual styled text through the integrated worker dialog",
    await page.evaluate(
      () =>
        styk.editor.figure.text_assets[0].text === "New Café\nПривет" &&
        styk.editor.figure.text_assets[0].font_style === 3,
    ),
  );
  await page.locator('[data-action="edit-text"]').click();
  await ready();
  await page.locator("#text-content").fill("😀");
  await page.waitForFunction(
    () => !document.querySelector("#text-error").hidden,
  );
  check(
    "Integrated invalid draft is blocked without modifying existing figure",
    (await page.locator("#create-text").isDisabled()) &&
      (await page.evaluate(
        () => styk.editor.figure.text_assets[0].text === "New Café\nПривет",
      )),
  );
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("#dialog").open);
  await page.locator('[data-action="export"]').first().click();
  const stkFile = await download(
    () => page.locator('[data-action="export-stk"]').click(),
    "created-text.stk",
  );
  const beforeCount = await page.evaluate(
    () => styk.editor.frame.objects.length,
  );
  await page.locator("#file-input").setInputFiles(stkFile);
  await page.waitForFunction(
    (count) => styk.editor.frame.objects.length === count + 1,
    beforeCount,
  );
  check(
    "Actual STK export/import retains newly authored text and font style",
    await page.evaluate(
      () =>
        styk.editor.figure.text_assets[0].text === "New Café\nПривет" &&
        styk.editor.figure.text_assets[0].font_style === 3,
    ),
  );
  await page.screenshot({ path: path.join(output, "text-app-final.png") });
  check(
    "Integrated UI has no uncaught browser exceptions",
    errors.length === 0,
  );
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify({ checks, errors, pixelDifference: 0 }, null, 2),
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
