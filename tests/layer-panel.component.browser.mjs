import { chromium } from "playwright";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
const b = await chromium.launch({ channel: "chrome", headless: true }),
  p = await b.newPage({ viewport: { width: 1280, height: 800 } }),
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
  await p.waitForFunction(() => window.styk?.ready);
  await p.evaluate(async () => {
    const { LayerPanel } = await import("/src/layer-panel.mjs"),
      { Editor } = await import("/src/editor.mjs");
    const host = document.createElement("div");
    host.id = "layer-test";
    host.style.cssText =
      "position:fixed;top:90px;left:15px;width:250px;height:560px;z-index:50;background:white;border:1px solid #ddd";
    document.body.append(host);
    window.layerEditor = new Editor({ demo: true });
    window.layerContexts = [];
    window.layerHidden = new Set();
    window.layerLocked = new Set();
    window.layerBrowser = new LayerPanel(host, window.layerEditor, {
      onSelectTrack: (t) => window.layerContexts.push(t.id),
      onToggleFigureVisibility: (uid) => {
        window.layerHidden.has(uid)
          ? window.layerHidden.delete(uid)
          : window.layerHidden.add(uid);
      },
      onToggleFigureLock: (uid) => {
        window.layerLocked.has(uid)
          ? window.layerLocked.delete(uid)
          : window.layerLocked.add(uid);
      },
      onError: (e) => {
        throw e;
      },
    });
    window.layerEditor.addEventListener("change", () =>
      window.layerBrowser.update({
        selectedUids: window.layerEditor.selectedUids,
        hiddenUids: window.layerHidden,
        lockedUids: window.layerLocked,
      }),
    );
  });
  check(
    "Fixed Scene Camera and default user layer",
    (await p.locator("#layer-test [role=treeitem]").count()) === 6,
  );
  await p.locator("#layer-test [data-kind=camera]").click();
  check(
    "Camera requests independent inspector context",
    await p.evaluate(() => window.layerContexts.at(-1) === "camera"),
  );
  await p.locator("#layer-test [data-layer-command=create]").click();
  await p.locator(".styk-layer-rename").fill("Characters");
  await p.locator(".styk-layer-rename").press("Enter");
  check(
    "Create and inline rename use real layer model",
    await p.evaluate(() =>
      window.layerEditor.layers.some((l) => l.name === "Characters"),
    ),
  );
  const ids = await p.evaluate(() => ({
    original: window.layerEditor.layers.find((l) => l.name === "Layer 1").id,
    characters: window.layerEditor.layers.find((l) => l.name === "Characters")
      .id,
  }));
  await p
    .locator('#layer-test [data-key="figure:1"]')
    .dragTo(p.locator(`#layer-test [data-key="${ids.characters}"]`));
  check(
    "Figure drag assigns to target layer",
    await p.evaluate(
      () =>
        window.layerEditor.getLayer(window.layerEditor.layerForUid(1)).name ===
        "Characters",
    ),
  );
  await p
    .locator(
      `#layer-test [data-key="${ids.characters}"] [data-layer-command=visibility]`,
    )
    .click();
  check(
    "Hide layer changes persistent visibility",
    await p.evaluate(
      (id) => window.layerEditor.getLayer(id).visible === false,
      ids.characters,
    ),
  );
  await p
    .locator(
      `#layer-test [data-key="${ids.characters}"] [data-layer-command=lock]`,
    )
    .click();
  check(
    "Lock layer changes persistent lock state",
    await p.evaluate(
      (id) => window.layerEditor.getLayer(id).locked === true,
      ids.characters,
    ),
  );
  await p
    .locator(`#layer-test [data-key="${ids.characters}"]`)
    .click({ button: "right" });
  await p
    .getByRole("menuitem", { name: "Move layer down", exact: true })
    .click();
  check(
    "Move down follows front-to-back displayed hierarchy",
    await p.evaluate(
      (id) =>
        window.layerEditor.layers.filter((l) => !l.permanent).at(0).id === id,
      ids.characters,
    ),
  );
  await p
    .locator(`#layer-test [data-key="${ids.characters}"]`)
    .click({ button: "right" });
  await p.getByRole("menuitem", { name: "Delete layer", exact: true }).click();
  check(
    "Delete preserves assigned figures by migration",
    await p.evaluate(
      (id) =>
        !window.layerEditor.getLayer(id) &&
        window.layerEditor.frame.objects.some((o) => o.unique_id === 1),
      ids.characters,
    ),
  );
  await p.evaluate(() => window.layerEditor.undo());
  check(
    "Layer delete undo restores assignment",
    await p.evaluate(
      (id) => window.layerEditor.layerForUid(1) === id,
      ids.characters,
    ),
  );
  await p
    .locator('#layer-test [data-key="figure:1"] [data-layer-command=lock]')
    .click();
  check(
    "Figure lock callback stays separate",
    await p.evaluate(() => window.layerLocked.has(1)),
  );
  await p
    .locator('#layer-test [data-key="figure:1"] [data-layer-command=lock]')
    .focus();
  await p.keyboard.press("Space");
  check(
    "Keyboard activates figure controls without changing tree selection",
    await p.evaluate(() => !window.layerLocked.has(1)),
  );
  await p.evaluate(() => window.layerBrowser.update({ query: "walker" }));
  check(
    "Search keeps fixed tracks plus matching hierarchy",
    (await p.locator("#layer-test [data-kind=figure]").count()) === 1,
  );
  await p.evaluate(() => window.layerBrowser.update({ query: "" }));
  await p.screenshot({ path: "artifacts/layer-panel-hierarchy.png" });
  await p.evaluate(async () => {
    const { emptyDocument, createFrame, createObject } = await import(
      "/src/demo.mjs"
    );
    const report = emptyDocument();
    report.keyframes = [
      createFrame(
        Array.from({ length: 20000 }, (_, i) =>
          createObject(report.figure_types[0], i + 1, 0, 0),
        ),
      ),
    ];
    window.layerEditor.load(report);
  });
  check(
    "20,000 figures retain bounded tree row DOM",
    (await p.locator("#layer-test [role=treeitem]").count()) <= 20,
  );
  const stats = await p.evaluate(() => {
    const before = { ...window.layerBrowser.stats };
    for (let i = 0; i < 100; i++) window.layerBrowser.update();
    return { before, after: { ...window.layerBrowser.stats } };
  });
  check(
    "100 pose refreshes do not rebuild hierarchy index",
    stats.before.indexBuilds === stats.after.indexBuilds,
  );
  await p.locator("#layer-test [role=tree]").focus();
  await p.keyboard.press("End");
  check(
    "Keyboard End reaches virtualized last row",
    await p.evaluate(() => document.activeElement.dataset.key === "figure:1"),
  );
  await p.screenshot({ path: "artifacts/layer-panel-20000.png" });
  check("No browser errors", errors.length === 0);
  await writeFile(
    "artifacts/layer-panel-verification.json",
    JSON.stringify({ checks, errors, stats }, null, 2),
  );
} finally {
  await b.close();
}
