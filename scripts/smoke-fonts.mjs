import { _electron as electron } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(path.join(root, "artifacts"), { recursive: true });
const app = await electron.launch({
  args: [root],
  cwd: root,
  timeout: 45000,
  env: {
    ...process.env,
    STYK_USER_DATA_DIR: path.join(root, "artifacts", "fonts-desktop-profile"),
  },
});
const checks = [],
  errors = [];
let evidence;
const check = (label, value) => {
  assert.ok(value, label);
  checks.push(label);
  console.log("PASS", label);
};
try {
  const page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForFunction(
    () =>
      window.styk?.ready && typeof window.stykDesktop?.listFonts === "function",
    null,
    { timeout: 30000 },
  );
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => {
    window.fontLongTasks = [];
    window.fontObserver = new PerformanceObserver((list) =>
      fontLongTasks.push(...list.getEntries().map((entry) => entry.duration)),
    );
    fontObserver.observe({ type: "longtask" });
  });
  const metadata = await page.evaluate(async () => {
    const started = performance.now(),
      fonts = await stykDesktop.listFonts(),
      coldMs = performance.now() - started;
    const warm = performance.now(),
      cached = await stykDesktop.listFonts(),
      warmMs = performance.now() - warm;
    window.nativeFonts = fonts;
    return {
      fonts,
      coldMs,
      warmMs,
      stable: JSON.stringify(fonts) === JSON.stringify(cached),
    };
  });
  check(
    "Native bridge discovers installed font metadata",
    metadata.fonts.length > 20,
  );
  check(
    "Metadata IDs are opaque and contain no filesystem paths",
    metadata.fonts.every(
      (font) =>
        /^font_[a-f0-9]{32}$/.test(font.id) &&
        !("path" in font) &&
        !("filename" in font),
    ),
  );
  check(
    "Repeated font enumeration keeps stable cached results",
    metadata.stable,
  );
  check(
    "Renderer cannot request an arbitrary font path",
    await page.evaluate(async () => {
      try {
        await stykDesktop.readFont("C:/Windows/win.ini");
        return false;
      } catch {
        return true;
      }
    }),
  );
  const native = await page.evaluate(async () => {
    const regular =
      nativeFonts.find(
        (font) => font.family === "Arial" && font.style === "Regular",
      ) || nativeFonts.find((font) => !font.collection);
    const collection =
      nativeFonts.find(
        (font) => font.collection && font.family === "Cambria",
      ) || nativeFonts.find((font) => font.collection);
    const output = [];
    for (const font of [regular, collection].filter(Boolean)) {
      const started = performance.now(),
        bytes = await stykDesktop.readFont(font.id);
      output.push({
        id: font.id,
        family: font.family,
        collection: font.collection,
        bytes: bytes.byteLength,
        signature: new DataView(bytes).getUint32(0),
        readMs: performance.now() - started,
      });
    }
    return output;
  });
  check(
    "Font bytes cross the bridge as bounded owned ArrayBuffers",
    native.every(
      (font) =>
        font.bytes > 0 &&
        font.bytes <= 32 * 1024 * 1024 &&
        [0x10000, 0x4f54544f, 0x74727565, 0x74797031].includes(font.signature),
    ),
  );
  check(
    "Collection fonts cross the bridge as standalone outline faces",
    process.platform !== "win32" ||
      native.some((font) => font.collection && font.signature === 0x10000),
  );
  await page.evaluate(() => styk.actions["add-text"]());
  await page.waitForFunction(
    () => document.querySelector("#create-text")?.disabled === false,
  );
  await page.locator("#text-local-fonts").click();
  await page.waitForFunction(
    () => document.querySelectorAll("#text-installed-font option").length > 20,
  );
  check(
    "Text dialog exposes native installed-font discovery",
    await page.locator("#text-installed-picker").isVisible(),
  );
  await page.locator("#text-font-search").fill(native[0].family);
  const desired = metadata.fonts.find((font) => font.id === native[0].id);
  await page
    .locator("#text-installed-font")
    .selectOption({ label: desired.fullName });
  await page.waitForFunction(
    (family) =>
      document
        .querySelector("#text-font option:checked")
        ?.textContent.includes(family) &&
      document.querySelector("#create-text")?.disabled === false,
    native[0].family,
  );
  await page.locator("#text-content").fill("StykAnimate");
  await page.waitForFunction(
    () => document.querySelector("#create-text")?.disabled === false,
  );
  await page.screenshot({
    path: path.join(root, "artifacts", "desktop-installed-fonts.png"),
  });
  const before = await page.evaluate(
    () => styk.editor.report.figure_types.length,
  );
  await page.locator("#create-text").click();
  await page.waitForFunction(() => !document.querySelector("#dialog").open);
  check(
    "Native installed font creates portable outline text in the actual editor",
    await page.evaluate(
      ({ before, family }) => {
        const figure = styk.editor.figure;
        return (
          styk.editor.report.figure_types.length === before + 1 &&
          figure?._styk?.textAuthoring?.fontFamily === family &&
          figure.text_assets[0].text === "StykAnimate"
        );
      },
      { before, family: native[0].family },
    ),
  );
  await page.evaluate(() => styk.editor.markSaved());
  await page.waitForTimeout(100);
  const longTasks = await page.evaluate(() => {
    fontObserver.disconnect();
    return fontLongTasks;
  });
  check(
    "Font enumeration, reads and worker preview cause no renderer long task",
    longTasks.length === 0,
  );
  check("Native font flow has no browser errors", errors.length === 0);
  evidence = {
    checks,
    errors,
    fontCount: metadata.fonts.length,
    coldListMs: metadata.coldMs,
    warmListMs: metadata.warmMs,
    fonts: native,
    longTasks,
  };
} finally {
  await writeFile(
    path.join(root, "artifacts", "desktop-fonts-smoke.json"),
    JSON.stringify(evidence || { checks, errors }, null, 2),
  );
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
}
