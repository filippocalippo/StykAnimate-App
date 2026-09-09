import { _electron as electron } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, "artifacts", "export-panel-layout");
await mkdir(out, { recursive: true });
const app = await electron.launch({
  args: [root],
  cwd: root,
  timeout: 45000,
  env: {
    ...process.env,
    STYK_USER_DATA_DIR: path.join(out, `profile-${Date.now()}`),
  },
});
const checks = [],
  errors = [],
  layouts = [];
const check = (name, ok, detail) => {
  assert.ok(ok, `${name}${detail ? " " + JSON.stringify(detail) : ""}`);
  checks.push(name);
  console.log("PASS", name);
};
try {
  const page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.waitForFunction(
    () => window.styk?.ready && window.stykDesktop?.getVfwCapabilities,
    null,
    { timeout: 30000 },
  );
  for (const [width, height] of [
    [1280, 800],
    [1100, 740],
    [1100, 680],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, { width, height }) =>
        BrowserWindow.getAllWindows()[0].setContentSize(width, height),
      { width, height },
    );
    await page.waitForFunction(
      ({ width, height }) => innerWidth === width && innerHeight === height,
      { width, height },
    );
    await page.locator('[data-action="export"]').first().click();
    await page.waitForFunction(
      () =>
        document.querySelector("#export-mp4-codec")?.options.length >= 2 &&
        document.querySelector("#export-avi-codec")?.options.length >= 3 &&
        !document.querySelector("#export-vfw-codec")?.disabled,
      null,
      { timeout: 30000 },
    );
    check(
      `${width}×${height}: collapsed export fits with three columns`,
      await page.locator("#dialog").evaluate((d) => {
        const r = d.getBoundingClientRect(),
          grid = d.querySelector(".export-grid");
        return (
          d.scrollWidth <= d.clientWidth &&
          r.top >= 0 &&
          r.bottom <= innerHeight &&
          getComputedStyle(grid).gridTemplateColumns.split(" ").length === 3
        );
      }),
    );
    if (height !== 680)
      await page.screenshot({
        path: path.join(out, `export-collapsed-${width}.png`),
      });
    await page.locator(".export-settings > summary").click();
    await page.locator("#export-smoothing").selectOption("sprites");
    await page.locator("#export-mp4-codec").selectOption("mpeg4");
    await page.locator("#export-avi-codec").selectOption("ffv1");
    const metrics = await page.locator("#dialog").evaluate((d) => {
      const rect = d.getBoundingClientRect(),
        body = d.querySelector(".dialog-body"),
        settings = d.querySelector(".export-settings"),
        grid = d.querySelector(".export-grid"),
        head = d.querySelector(".dialog-head");
      const controls = [
        ...settings.querySelectorAll("input,select,button"),
      ].filter((e) => e.getClientRects().length);
      return {
        viewport: [innerWidth, innerHeight],
        dialog: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
        horizontalOverflow:
          d.scrollWidth > d.clientWidth || body.scrollWidth > body.clientWidth,
        sideBySide:
          grid.getBoundingClientRect().left >
          settings.getBoundingClientRect().right,
        headY: head.getBoundingClientRect().y,
        scrollHeight: body.scrollHeight,
        bodyHeight: body.clientHeight,
        clippedControls: controls
          .filter((e) => {
            const a = e.getBoundingClientRect(),
              b = settings.getBoundingClientRect();
            return a.left < b.left || a.right > b.right;
          })
          .map((e) => e.id),
        controls: controls.length,
        tiles: grid.children.length,
        smoothing: [...d.querySelector("#export-smoothing").options].map(
          (o) => o.value,
        ),
      };
    });
    layouts.push(metrics);
    check(
      `${width}×${height}: render settings and formats have distinct columns`,
      metrics.sideBySide,
      metrics,
    );
    check(
      `${width}×${height}: all final export controls fit without horizontal clipping`,
      !metrics.horizontalOverflow &&
        !metrics.clippedControls.length &&
        metrics.controls >= 15 &&
        metrics.smoothing.join(",") === "edges,none,sprites",
      metrics,
    );
    await page.screenshot({
      path: path.join(out, `export-expanded-${width}-${height}.png`),
    });
    await page
      .locator("#dialog .dialog-body")
      .evaluate((e) => (e.scrollTop = e.scrollHeight));
    check(
      `${width}×${height}: scrolling keeps title and close action in place`,
      await page
        .locator("#dialog .dialog-head")
        .evaluate(
          (e, y) => Math.abs(e.getBoundingClientRect().y - y) < 0.5,
          metrics.headY,
        ),
    );
    await page
      .locator('[data-action="export-svg-sequence"]')
      .scrollIntoViewIfNeeded();
    check(
      `${width}×${height}: last format remains reachable`,
      await page.locator('[data-action="export-svg-sequence"]').isVisible(),
    );
    await page.locator('[data-action="close-dialog"]').click();
    check(
      `${width}×${height}: fixed close action closes export`,
      await page.locator("#dialog").evaluate((d) => !d.open),
    );
  }
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1100, 740),
  );
  for (const tab of ["interface", "canvas", "animation", "shortcuts"]) {
    await page.evaluate((tab) => styk.settingsUI.open(tab), tab);
    const metrics = await page.locator(".styk-settings").evaluate((d) => {
      const r = d.getBoundingClientRect(),
        content = d.querySelector(".styk-settings-content");
      return {
        fits:
          r.left >= 0 &&
          r.right <= innerWidth &&
          r.top >= 0 &&
          r.bottom <= innerHeight,
        noOverflow:
          d.scrollWidth <= d.clientWidth &&
          content.scrollWidth <= content.clientWidth,
        selected: d.querySelector('[role="tab"][aria-selected="true"]')?.dataset
          .tab,
      };
    });
    check(
      `Preferences ${tab}: hierarchy and controls fit1100px`,
      metrics.fits && metrics.noOverflow && metrics.selected === tab,
      metrics,
    );
    await page.keyboard.press("Tab");
    check(
      `Preferences ${tab}: keyboard focus remains inside modal`,
      await page
        .locator(".styk-settings")
        .evaluate((d) => d.contains(document.activeElement)),
    );
    await page.screenshot({ path: path.join(out, `settings-${tab}-1100.png`) });
    await page.locator(".styk-settings-head button").click();
  }
  await page.evaluate(() => styk.settingsUI.open("interface"));
  await page
    .locator('.styk-settings [data-setting="locale"]')
    .selectOption("it");
  check(
    "Italian Preferences retains usable translated navigation",
    await page
      .locator(".styk-settings")
      .evaluate(
        (d) =>
          [...d.querySelectorAll('[role="tab"]')].every(
            (e) => e.scrollWidth <= e.clientWidth,
          ) && d.scrollWidth <= d.clientWidth,
      ),
  );
  await page.screenshot({ path: path.join(out, "settings-italian-1100.png") });
  await page
    .locator('.styk-settings [data-setting="locale"]')
    .selectOption("es-419");
  const locale = await page
    .locator('.styk-settings [data-setting="locale"]')
    .evaluate((select) => {
      const style = getComputedStyle(select),
        context = document.createElement("canvas").getContext("2d");
      context.font = style.font;
      const text = select.selectedOptions[0].text;
      return {
        text,
        width: select.clientWidth,
        required:
          context.measureText(text).width +
          parseFloat(style.paddingLeft) +
          parseFloat(style.paddingRight) +
          20,
      };
    });
  layouts.push({ locale });
  await page.screenshot({ path: path.join(out, "settings-spanish-1100.png") });
  check(
    "Regional language name remains fully readable",
    locale.required <= locale.width,
    locale,
  );
  await page.locator(".styk-settings-head button").click();
  check("No uncaught renderer errors", errors.length === 0, errors);
  await writeFile(
    path.join(out, "report.json"),
    JSON.stringify(
      {
        checks,
        errors,
        layouts,
        scope:
          "Actual source Electron layout verification; codecs populated through native capabilities. No files exported or codec vendor dialog opened.",
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ checks: checks.length, errors }));
} finally {
  await app.close();
}
