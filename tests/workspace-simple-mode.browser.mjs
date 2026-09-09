import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
const browser = await chromium.launch({ channel: "chrome", headless: true }),
  page = await browser.newPage({ viewport: { width: 1100, height: 780 } }),
  checks = [];
const check = (name, ok) => {
  assert.ok(ok, name);
  checks.push(name);
  console.log("PASS", name);
};
try {
  await page.route("**/src/app.mjs", (route) =>
    route.fulfill({ contentType: "text/javascript", body: "" }),
  );
  await page.goto(process.env.STYK_URL || "http://127.0.0.1:47831");
  await page.evaluate(async () => {
    const { initWorkspaceLayout } = await import("/src/workspace-layout.mjs");
    window.layout = initWorkspaceLayout({
      storage: null,
      preferences: { timeline: 135, floating: {} },
    });
  });
  check(
    "Advanced dock can be compact",
    await page.evaluate(() => layout.sizes.timeline === 135),
  );
  await page.evaluate(() =>
    document.querySelector(".timeline-panel").classList.add("simple-mode"),
  );
  await page.waitForFunction(() => layout.sizes.timeline === 205);
  check(
    "Switching into Simple immediately expands docked minimum to 205px",
    await page.evaluate(() => layout.sizes.limits.timeline[0] === 205),
  );
  const splitter = page.locator('.styk-workspace-splitter[data-axis="y"]'),
    r = await splitter.boundingBox();
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width / 2, r.y + 400, { steps: 5 });
  await page.mouse.up();
  check(
    "Dock resize cannot hide Simple controls",
    await page.evaluate(() => layout.sizes.timeline === 205),
  );
  await page.evaluate(() => layout.float("timeline"));
  const edge = page.locator('.timeline-panel [data-edge="se"]');
  const edges = await page.locator(".timeline-panel [data-edge]").count();
  check("Floating timeline exposes resize edges", edges === 8);
  const corner = await edge.boundingBox();
  await page.mouse.move(
    corner.x + corner.width / 2,
    corner.y + corner.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(corner.x + corner.width / 2, corner.y - 180, {
    steps: 5,
  });
  await page.mouse.up();
  check(
    "Floating resize cannot hide Simple controls",
    await page.evaluate(() => layout.floating.timeline.height === 205),
  );
  await page.evaluate(() => {
    const root = document.querySelector(".workspace");
    layout.destroy();
    window.restorePrefs = {
      timeline: 135,
      floating: { timeline: { x: 50, y: 80, width: 600, height: 150 } },
    };
  });
  await page.evaluate(async () => {
    const { initWorkspaceLayout } = await import("/src/workspace-layout.mjs");
    window.layout = initWorkspaceLayout({
      storage: null,
      preferences: restorePrefs,
    });
  });
  check(
    "Restored floating Simple panel clamps height to 205px",
    await page.evaluate(() => layout.floating.timeline.height === 205),
  );
  await page.evaluate(() => {
    layout.dock("timeline");
    document.querySelector(".timeline-panel").classList.remove("simple-mode");
  });
  await page.waitForFunction(() => layout.sizes.limits.timeline[0] === 135);
  check("Advanced minimum restores after changing modes", true);
  await mkdir("artifacts/workspace-simple-mode", { recursive: true });
  await writeFile(
    "artifacts/workspace-simple-mode/report.json",
    JSON.stringify({ checks }, null, 2),
  );
} finally {
  await browser.close();
}
