import { chromium } from "playwright";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
const b = await chromium.launch({ channel: "chrome", headless: true }),
  p = await b.newPage({ viewport: { width: 1560, height: 1000 } }),
  checks = [],
  errors = [];
p.on("pageerror", (e) => errors.push(e.message));
const check = (label, value) => {
  assert.ok(value, label);
  checks.push(label);
  console.log("PASS", label);
};
try {
  await p.goto("http://127.0.0.1:47831");
  await p.waitForFunction(
    () => window.styk?.ready && window.styk.layers && window.styk.settingsUI,
  );
  check(
    "Actual app mounts fixed Scene Camera plus user layer tree",
    (await p.locator("#layer-list [role=treeitem]").count()) >= 6,
  );
  await p.locator("#layer-list [data-kind=camera]").click();
  check(
    "Actual camera row opens camera inspector",
    await p.evaluate(() => window.styk.state.inspectorContext === "camera"),
  );
  await p.locator("#layer-list [data-layer-command=create]").click();
  await p.locator(".styk-layer-rename").fill("Characters");
  await p.locator(".styk-layer-rename").press("Enter");
  const layerId = await p.evaluate(
    () => window.styk.editor.layers.find((l) => l.name === "Characters").id,
  );
  await p
    .locator('#layer-list [data-key="figure:1"]')
    .dragTo(p.locator(`#layer-list [data-key="${layerId}"]`));
  await p.waitForFunction(id => window.styk.editor.layerForUid(1) === id, layerId);
  check(
    "Actual tree drag changes persistent layer assignment",
    await p.evaluate((id) => window.styk.editor.layerForUid(1) === id, layerId),
  );
  await p.screenshot({ path: "artifacts/layers-integrated-app.png" });
  await p.evaluate(() => window.styk.settingsUI.open("interface"));
  await p
    .locator(".styk-settings[open] [data-setting=timelineMode][value=simple]")
    .check();
  await p.getByRole("button", { name: "Close settings", exact: true }).click();
  await p.waitForFunction(
    () => window.styk.timeline?.constructor.name === "SimpleTimeline",
  );
  await p.waitForFunction(() => window.styk.timeline.stats.cachedPreviews > 4);
  check(
    "Settings switches actual app to Simple filmstrip",
    (await p.locator("#timeline .styk-simple-card").count()) > 4,
  );
  check(
    "Actual app filmstrip thumbnails contain scene artwork",
    await p
      .locator("#timeline canvas")
      .first()
      .evaluate((canvas) => {
        const d = canvas
          .getContext("2d")
          .getImageData(0, 0, canvas.width, canvas.height).data;
        for (let i = 0; i < d.length; i += 4)
          if (d[i + 3] > 100 && d[i] < 120 && d[i + 1] < 120 && d[i + 2] < 120)
            return true;
        return false;
      }),
  );
  const before = await p.evaluate(
    () => window.styk.editor.report.keyframes.length,
  );
  if (await p.locator('#timeline [data-simple-action=update]').count())
    await p.locator('#timeline [data-simple-action=update]').click();
  await p.locator("#timeline [data-simple-action=add]").click();
  check(
    "Actual simple Add inserts one native keyframe",
    (await p.evaluate(() => window.styk.editor.report.keyframes.length)) ===
      before + 1,
  );
  await p.screenshot({ path: "artifacts/simple-timeline-integrated-app.png" });
  await p.evaluate(() => window.styk.settingsUI.open("canvas"));
  await p
    .locator(".styk-settings[open] [data-setting=showUnselectedHandles]")
    .uncheck();
  await p.locator(".styk-settings[open] [data-setting=handleSize]").fill("8");
  await p
    .locator(".styk-settings[open] [data-setting=handleSize]")
    .dispatchEvent("change");
  check(
    "Canvas settings update actual app state",
    await p.evaluate(
      () =>
        window.styk.state.settings.handleSize === 8 &&
        !window.styk.state.settings.showUnselectedHandles,
    ),
  );
  await p.getByRole("button", { name: "Close settings", exact: true }).click();
  await p.evaluate(() => window.styk.settingsUI.flush());
  await p.evaluate(() => window.styk.editor.markSaved());
  await p.reload();
  await p.waitForFunction(() => window.styk?.ready);
  check(
    "Browser reload restores Simple mode and handle preferences",
    await p.evaluate(
      () =>
        window.styk.timeline.constructor.name === "SimpleTimeline" &&
        window.styk.state.settings.handleSize === 8 &&
        !window.styk.state.settings.showUnselectedHandles,
    ),
  );
  await p.evaluate(() => window.styk.settingsUI.open());
  await p
    .locator(".styk-settings[open] [data-setting=timelineMode][value=advanced]")
    .check();
  await p.getByRole("button", { name: "Close settings", exact: true }).click();
  check(
    "Switch back restores advanced user-layer timeline",
    await p.evaluate(
      () => window.styk.timeline.constructor.name === "Timeline",
    ),
  );
  check("No browser errors", errors.length === 0);
  await writeFile(
    "artifacts/panels-settings-timeline-integrated.json",
    JSON.stringify({ checks, errors }, null, 2),
  );
} finally {
  await b.close();
}
