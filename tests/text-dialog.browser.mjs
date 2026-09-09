/** Isolated actual UI tests: the same dialog module, browser worker, font parser and canvas paths. */
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const output = path.resolve("artifacts/text-dialog");
await mkdir(output, { recursive: true });
const native = JSON.parse(
  await readFile(
    "../reports/browser_corpus/text_speech_bubble_0f3b81ef/scene.json",
    "utf8",
  ),
).figure_types.find((f) => f.text_assets?.length);
const abc = JSON.parse(
  await readFile(
    "../reports/browser_corpus/text_abc_66903de7/scene.json",
    "utf8",
  ),
).figure_types.find((f) => f.text_assets?.length);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 960 } }),
  checks = [],
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const check = (name, ok = true) => {
  assert.ok(ok, name);
  checks.push(name);
  console.log("PASS", name);
};
const ready = () =>
  page.waitForFunction(
    () =>
      document.querySelector("#text-preview-state")?.textContent === "Ready",
  );
const canvasPixels = () =>
  page.evaluate(() => {
    const canvas = document.querySelector("#text-preview"),
      pixels = canvas
        .getContext("2d")
        .getImageData(0, 0, canvas.width, canvas.height).data;
    return pixels.reduce(
      (sum, value, index) => sum + (index % 4 === 3 && value > 0 ? 1 : 0),
      0,
    );
  });
try {
  await page.route("**/src/app.mjs", (route) =>
    route.fulfill({ contentType: "text/javascript", body: "" }),
  );
  await page.goto(process.env.STYK_URL || "http://127.0.0.1:47831");
  await page.evaluate(async () => {
    const { TextDialog } = await import("/src/text-dialog.mjs");
    const { Editor } = await import("/src/editor.mjs");
    window.editor = new Editor({ demo: false });
    window.applied = 0;
    window.lastFigure = null;
    window.dialogModule = new TextDialog({
      dialog: document.querySelector("#dialog"),
      content: document.querySelector("#dialog-content"),
      fontService: {
        listFonts: async () => [
          {
            id: "test-bold",
            family: "Noto Sans",
            style: "Bold",
            fullName: "Noto Sans Bold",
          },
        ],
        readFont: async () =>
          new Uint8Array(
            await (await fetch("/vendor/text/NotoSans-Bold.ttf")).arrayBuffer(),
          ),
      },
    });
    window.openText = (figure) =>
      dialogModule.open({
        figure,
        onApply: (definition) => {
          window.applied++;
          window.lastFigure = definition;
          editor.importFigure(definition);
        },
      });
    // The preview must only draw the actual exported paths.
    CanvasRenderingContext2D.prototype.fillText = () => {
      throw new Error("Unexpected platform text preview");
    };
    CanvasRenderingContext2D.prototype.strokeText = () => {
      throw new Error("Unexpected platform text preview");
    };
    await window.openText();
  });
  await ready();
  check(
    "Fresh dialog compiles and previews real paths through its worker",
    (await canvasPixels()) > 1000,
  );
  const before = await page.evaluate(() => ({
    undo: editor._undo.length,
    applied,
  }));
  await page.locator("#text-content").fill("Portable\nCafé");
  await page.locator("#text-bold").check();
  await page.locator("#text-italic").check();
  await page.locator("#text-alignment").selectOption("center");
  await page.locator("#text-gradient-enabled").check();
  await page.locator("#text-outline-width").fill("1.5");
  await ready();
  check(
    "Live styling produces a valid draft without changing editor history",
    await page.evaluate(
      (before) =>
        editor._undo.length === before.undo && applied === before.applied,
      before,
    ),
  );
  await page.screenshot({ path: path.join(output, "new-text.png") });
  await page.locator("#create-text").click();
  await page.waitForFunction(() => !document.querySelector("#dialog").open);
  check(
    "Apply creates one portable text figure and one undo",
    await page.evaluate(
      (before) =>
        applied === before.applied + 1 &&
        editor._undo.length === before.undo + 1 &&
        lastFigure._styk.textAuthoring.fontOrigin === "bundled" &&
        lastFigure.text_assets[0].font_style === 3,
      before,
    ),
  );
  await page.evaluate(() => openText(lastFigure));
  await ready();
  check(
    "Previously authored Noto text stays editable with the bundled font",
    (await page.locator("#text-font").inputValue()) === "bundled",
  );
  await page.locator("#text-content").fill("More new glyphs");
  await ready();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("#dialog").open);
  check(
    "Escape discards the draft without applying a change",
    await page.evaluate(() => applied === 1),
  );

  await page.evaluate((figure) => openText(figure), native);
  await ready();
  check(
    "Imported native text defaults to embedded original font and percentage scale",
    (await page.locator("#text-font").inputValue()) === "embedded" &&
      (await page.locator("#text-size-label").textContent()) === "Scale · %" &&
      (await page.locator("#text-size").inputValue()) === "100",
  );
  check(
    "Native centered multiline preview is visible despite large stored coordinates",
    (await canvasPixels()) > 1000,
  );
  check(
    "No-op native draft retains original positions and CRLF exactly",
    await page.evaluate(
      (native) =>
        JSON.stringify(dialogModule.result.text_assets[0].placements) ===
          JSON.stringify(native.text_assets[0].placements) &&
        dialogModule.result.text_assets[0].text === native.text_assets[0].text,
      native,
    ),
  );
  await page.locator("#text-size").fill("150");
  await ready();
  check(
    "Imported glyph percentage scaling previews finite native H/V outlines",
    await page.evaluate(
      () =>
        Number.isFinite(dialogModule.result.text_assets[0].bounds.width) &&
        dialogModule.result.text_assets[0].bounds.width > 0,
    ),
  );
  await page.screenshot({ path: path.join(output, "native-text.png") });
  await page.locator("#text-content").fill("Missing Ω");
  await page.waitForFunction(
    () => !document.querySelector("#text-error").hidden,
  );
  check(
    "New missing native glyphs request a font and disable Apply",
    (await page
      .locator("#text-error")
      .textContent()
      .then((s) => s.includes("Choose a font"))) &&
      (await page.locator("#create-text").isDisabled()),
  );
  await page
    .locator("#text-font-file")
    .setInputFiles(path.resolve("vendor/text/NotoSans-Regular.ttf"));
  await ready();
  check(
    "Explicit TTF file replaces missing glyphs with named portable outlines",
    await page.evaluate(
      () =>
        dialogModule.result.text_assets[0].font_name === "Noto Sans" &&
        dialogModule.result.text_assets[0].text === "Missing Ω" &&
        dialogModule.result._styk.textAuthoring.fontOrigin === "custom",
    ),
  );
  await page.locator("#create-text").click();
  await page.waitForFunction(() => !document.querySelector("#dialog").open);

  await page.evaluate((figure) => openText(figure), abc);
  await ready();
  await page.locator("#text-content").fill("Abc Abc");
  await ready();
  check(
    "Reusing imported characters keeps Arial outlines without a local Arial font",
    await page.evaluate(
      () =>
        dialogModule.result.text_assets[0].font_name === "Arial" &&
        dialogModule.result._styk.textAuthoring.fontOrigin === "embedded",
    ),
  );
  await page.locator("#text-local-fonts").click();
  await page.locator("#text-font-search").fill("bold");
  await page.locator("#text-installed-font").selectOption("0");
  await ready();
  check(
    "Installed-font service returns a real font to the worker and exposes its actual face",
    (await page.evaluate(
      () =>
        dialogModule.result.text_assets[0].font_name === "Noto Sans" &&
        dialogModule.result.text_assets[0].bold,
    )) &&
      (await page.locator("#text-bold").isChecked()) &&
      (await page.locator("#text-bold").isDisabled()),
  );
  await page
    .locator("#text-font-file")
    .setInputFiles({
      name: "bad-font.ttf",
      mimeType: "font/ttf",
      buffer: Buffer.from("invalid-font"),
    });
  await page.waitForFunction(
    () => !document.querySelector("#text-error").hidden,
  );
  check(
    "Malformed font reports an actionable error without closing or crashing",
    (await page
      .locator("#text-error")
      .textContent()
      .then((s) => s.includes("Could not read"))) &&
      (await page.locator("#dialog").isVisible()),
  );
  await page.locator("#text-font").selectOption("bundled");
  await ready();
  await page.locator("#text-size").fill("");
  await page.waitForFunction(
    () => !document.querySelector("#text-error").hidden,
  );
  check(
    "Empty numeric input cannot silently become an applied zero",
    await page.locator("#create-text").isDisabled(),
  );
  await page.locator("#text-size").fill("42");
  await ready();
  await page.setViewportSize({ width: 600, height: 840 });
  await page.screenshot({ path: path.join(output, "compact-text.png") });
  check(
    "Compact dialog has no horizontal overflow and keeps the preview available",
    await page.evaluate(() => {
      const d = document.querySelector("#dialog"),
        b = d.querySelector(".dialog-body");
      return (
        d.getBoundingClientRect().width <= innerWidth &&
        b.scrollWidth <= b.clientWidth + 1 &&
        document.querySelector("#text-preview").width > 0
      );
    }),
  );
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("#dialog").open);
  check(
    "Close terminates the worker and releases pending requests",
    await page.evaluate(
      () =>
        dialogModule.events.signal.aborted && dialogModule.pending.size === 0,
    ),
  );
  check("Actual browser reports no uncaught errors", errors.length === 0);
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify({ checks, errors }, null, 2),
  );
} finally {
  await browser.close();
}
