import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1560, height: 1000 } });
const errors = [],
  checks = [];
page.on("pageerror", (error) => errors.push(error.message));
const check = (name, value = true) => {
  assert.ok(value, name);
  checks.push(name);
  console.log("PASS", name);
};
await mkdir("artifacts", { recursive: true });
try {
  await page.goto(process.env.STYK_URL || "http://127.0.0.1:47831");
  await page.waitForFunction(() => window.styk?.ready && window.styk.assets);
  await page.locator('[data-tab="assets"]').click();
  await page.waitForFunction(
    () => window.styk.assets.stats.cachedPreviews === 3,
  );
  check(
    "Actual Assets tab renders three native artwork previews",
    (await page.locator(".styk-asset-preview canvas").count()) === 3,
  );
  check(
    "Walker preview contains actual rendered artwork",
    await page
      .locator('.styk-asset-row[data-figure="1"] canvas')
      .evaluate((canvas) => {
        const pixels = canvas
          .getContext("2d")
          .getImageData(0, 0, canvas.width, canvas.height).data;
        return pixels.some((value, index) => index % 4 === 3 && value > 100);
      }),
  );
  await page.screenshot({ path: "artifacts/asset-library-native.png" });
  const before = await page.evaluate(
    () => window.styk.editor.frame.objects.length,
  );
  await page.locator('.styk-asset-row[data-figure="1"]').click();
  check(
    "One library click adds exactly one figure",
    (await page.evaluate(() => window.styk.editor.frame.objects.length)) ===
      before + 1,
  );
  await page.waitForFunction(
    () => window.styk.assets.stats.cachedPreviews === 3,
  );
  const stable = await page.evaluate(() => {
    const assets = window.styk.assets;
    const before = { ...assets.stats };
    for (let i = 0; i < 100; i++)
      assets.update(window.styk.editor.report.figure_types, { selectedId: 1 });
    return { before, after: { ...assets.stats } };
  });
  check(
    "100 pose/selection refreshes reuse name index and previews",
    stable.after.indexBuilds === stable.before.indexBuilds &&
      stable.after.previewRenders === stable.before.previewRenders,
  );
  await page.locator(".styk-assets-search input").fill("bounce");
  check(
    "Search finds a named figure",
    (await page.locator(".styk-asset-row").count()) === 1 &&
      (await page.locator(".styk-asset-name").innerText()) === "Bounce",
  );
  const keyboardBefore = await page.evaluate(
    () => window.styk.editor.frame.objects.length,
  );
  await page.locator(".styk-assets-search input").press("ArrowDown");
  await page.keyboard.press("Enter");
  check(
    "Keyboard adds the focused result once",
    (await page.evaluate(() => window.styk.editor.frame.objects.length)) ===
      keyboardBefore + 1,
  );
  await page
    .locator(".styk-assets-search input")
    .fill("no figure has this name");
  check(
    "Empty search is explicit",
    await page.locator(".styk-assets-empty").isVisible(),
  );
  await page.locator(".styk-assets-search button").click();
  check(
    "Search clear restores library",
    (await page.locator(".styk-asset-row").count()) === 3,
  );

  // Reuse the actual mounted module while leaving the document unchanged.
  await page.evaluate(async () => {
    const { defaultFigure } = await import("/src/demo.mjs");
    const { imageFileToFigure } = await import("/src/media-authoring.mjs");
    const { createTextFigure } = await import("/src/text-authoring.mjs");
    const source = document.createElement("canvas");
    source.width = source.height = 32;
    const context = source.getContext("2d");
    context.fillStyle = "#f00010";
    context.fillRect(0, 0, 32, 32);
    const blob = await new Promise((resolve) => source.toBlob(resolve));
    const image = await imageFileToFigure(
      new File([blob], "Red square.png", { type: "image/png" }),
      { preserveOpaqueBackground: true },
    );
    const text = await createTextFigure({
      text: "Aa",
      fontSize: 32,
      color: [20, 80, 200],
    });
    const polygon = defaultFigure(501);
    polygon.name = "Polygon rig";
    polygon.polyfills = [
      { segment_ids: [1, 4, 6], color_rgb: [255, 0, 128], transparency: 0 },
    ];
    const complex = defaultFigure(504);
    complex.name = "Dense figure";
    complex.segments = Array.from({ length: 30000 }, (_, i) => ({
      ...complex.segments[0],
      segment_id: i + 1,
    }));
    complex.segment_count = 30000;
    image.figure_type_id = 502;
    text.figure_type_id = 503;
    window.libraryFixtures = [polygon, image, text, complex];
    window.styk.assets.update(window.libraryFixtures);
  });
  await page.waitForFunction(
    () => window.styk.assets.stats.cachedPreviews === 4,
  );
  check(
    "Image, text and polygon previews render actual artwork",
    (await page.locator(".styk-asset-preview canvas").count()) === 3,
  );
  check(
    "Embedded sprite preserves red artwork",
    await page
      .locator('.styk-asset-row[data-figure="502"] canvas')
      .evaluate((canvas) => {
        const d = canvas
          .getContext("2d")
          .getImageData(0, 0, canvas.width, canvas.height).data;
        for (let i = 0; i < d.length; i += 4)
          if (d[i] > 200 && d[i + 1] < 60 && d[i + 3] > 200) return true;
        return false;
      }),
  );
  check(
    "30,000-segment figure gets bounded explicit fallback",
    (await page
      .locator('[data-figure="504"] .styk-asset-fallback')
      .getAttribute("title")) === "Complex figure · add to canvas to view",
  );
  await page.screenshot({ path: "artifacts/asset-library-artwork.png" });
  await page.evaluate(() => {
    const assets = window.styk.assets,
      base = window.libraryFixtures[0];
    window.largeLibrary = Array.from({ length: 20000 }, (_, i) => ({
      ...base,
      figure_type_id: i + 1000,
      name: `Asset ${String(i).padStart(5, "0")}`,
    }));
    assets.update(window.largeLibrary);
  });
  await page.waitForFunction(
    () => window.styk.assets.stats.cachedPreviews >= 5,
  );
  check(
    "20,000 definitions create only visible row DOM",
    (await page.locator(".styk-asset-row").count()) <= 9,
  );
  const largeStats = await page.evaluate(() => ({
    ...window.styk.assets.stats,
  }));
  check(
    "Virtual scroll height represents every definition",
    await page
      .locator(".styk-assets-spacer")
      .evaluate((e) => parseFloat(e.style.height) === 20000 * 74),
  );
  await page.locator(".styk-assets-search input").fill("Asset 19999");
  check(
    "Search reaches the final definition by name",
    (await page.locator(".styk-asset-row").getAttribute("data-figure")) ===
      "20999",
  );
  await page.locator(".styk-assets-search button").click();
  await page.locator(".styk-assets-viewport").focus();
  await page.keyboard.press("End");
  check(
    "Keyboard End reaches a virtualized final row",
    await page.evaluate(
      () => document.activeElement?.dataset.figure === "20999",
    ),
  );
  for (let step = 0; step < 20; step++) {
    await page
      .locator(".styk-assets-viewport")
      .evaluate((element, step) => (element.scrollTop = step * 740), step);
    await page.waitForTimeout(60);
  }
  check(
    "Preview memory and DOM stay bounded while scrolling",
    await page.evaluate(
      () =>
        window.styk.assets.stats.cachedPreviews <= 64 &&
        window.styk.assets.stats.thumbnailBytes <= 64 * 108 * 108 * 4 &&
        window.styk.assets.stats.rows <= 9,
    ),
  );
  await page.screenshot({ path: "artifacts/asset-library-20000.png" });
  await page.setViewportSize({ width: 1100, height: 740 });
  await page.waitForTimeout(100);
  check(
    "Compact library has no horizontal overflow",
    await page
      .locator(".styk-asset-library")
      .evaluate((e) => e.scrollWidth <= e.clientWidth),
  );
  await page.screenshot({ path: "artifacts/asset-library-compact.png" });
  await page.evaluate(() => window.styk.assets.setVisible(false));
  const paused = await page.evaluate(
    () => window.styk.assets.stats.previewRenders,
  );
  await page.waitForTimeout(150);
  check(
    "Hidden library does no preview work",
    (await page.evaluate(() => window.styk.assets.stats.previewRenders)) ===
      paused,
  );
  check("No browser errors", errors.length === 0);
  await writeFile(
    "artifacts/asset-library-verification.json",
    JSON.stringify(
      {
        checks,
        errors,
        largeStats,
        finalStats: await page.evaluate(() => ({
          ...window.styk.assets.stats,
        })),
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
