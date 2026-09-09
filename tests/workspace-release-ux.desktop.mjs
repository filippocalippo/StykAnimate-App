/** Final finite desktop UX acceptance. --packaged requires a freshly verified matching package. */
import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const root = path.resolve(import.meta.dirname, ".."),
  packaged = process.argv.includes("--packaged");
const out = path.join(root, "artifacts", "workspace-release-ux");
await mkdir(out, { recursive: true });
const executablePath = packaged
  ? process.env.STYK_PACKAGED_EXECUTABLE ||
    path.join(root, "release", "win-unpacked", "StykAnimate.exe")
  : undefined;
const sourceFiles = [
  "index.html",
  "src/style.css",
  "src/app.mjs",
  "src/workspace-layout.mjs",
  "src/workspace-panels.mjs",
  "src/settings.mjs",
  "src/layer-panel.mjs",
  "src/inspector-view.mjs",
  "src/property-controls.mjs",
  "src/native-property-edit.mjs",
  "src/timeline.mjs",
  "src/simple-timeline.mjs",
  "src/editor.mjs",
  "src/editor-frame-draft.mjs",
  "src/pivot-frame-draft.mjs",
];
const sourceHashes = Object.fromEntries(
  await Promise.all(
    sourceFiles.map(async (file) => [
      file,
      createHash("sha256")
        .update(await readFile(path.join(root, file)))
        .digest("hex"),
    ]),
  ),
);
let manifest;
if (packaged) {
  manifest = JSON.parse(
    await readFile(
      path.join(root, "artifacts", "package-manifest.json"),
      "utf8",
    ),
  );
  for (const [file, digest] of Object.entries(sourceHashes))
    assert.equal(
      manifest.files.find((entry) => entry.path === file)?.sha256,
      digest,
      "Current package manifest: " + file,
    );
}
const checks = [],
  errors = [],
  layouts = [];
const check = (name, value = true, detail) => {
  assert.ok(value, `${name}${detail ? " " + JSON.stringify(detail) : ""}`);
  checks.push(name);
  console.log("PASS", name);
};
let app, page, metadata;
try {
  app = await electron.launch({
    executablePath,
    args: packaged ? [] : [root],
    cwd: root,
    timeout: 45000,
    env: {
      ...process.env,
      STYK_USER_DATA_DIR: path.join(out, `profile-${Date.now()}`),
    },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForFunction(() => window.styk?.ready);
  metadata = await app.evaluate(({ app, BrowserWindow }) => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    minimum: BrowserWindow.getAllWindows()[0].getMinimumSize(),
  }));
  if (packaged) {
    assert.equal(metadata.version, manifest.version);
    metadata.executablePath = executablePath;
    metadata.executableSha256 = createHash("sha256")
      .update(await readFile(executablePath))
      .digest("hex");
  }
  const servedHashes = await page.evaluate(
    async (files) =>
      Object.fromEntries(
        await Promise.all(
          files.map(async (file) => {
            const response = await fetch("/" + file);
            if (!response.ok) throw new Error("Missing source " + file);
            const digest = await crypto.subtle.digest(
              "SHA-256",
              await response.arrayBuffer(),
            );
            return [
              file,
              [...new Uint8Array(digest)]
                .map((v) => v.toString(16).padStart(2, "0"))
                .join(""),
            ];
          }),
        ),
      ),
    sourceFiles,
  );
  check(
    "The running desktop serves the recorded current workspace, inspector and timeline sources",
    JSON.stringify(servedHashes) === JSON.stringify(sourceHashes),
  );
  await page.evaluate(async () => {
    styk.settingsUI.commit({
      timelineMode: "advanced",
      autosaveSeconds: 0,
      locale: "en",
    });
    await styk.settingsUI.flush();
    const { emptyDocument, createFrame, createObject } = await import(
      "/src/demo.mjs"
    );
    const report = emptyDocument(),
      figure = report.figure_types[0];
    report.keyframes = [100, 120, 140].map((x) =>
      createFrame([createObject(figure, 1, x, 180)], 3),
    );
    styk.editor.load(report, "Workspace acceptance");
    styk.editor.select(1);
    styk.editor.markSaved();
    styk.fit();
    document.querySelector(".workspace")._stykLayout.reset();
    window.layoutBaseline = {
      report: JSON.stringify(styk.editor.report),
      undo: styk.editor._undo.length,
      revision: styk.editor.revision,
    };
  });
  const settle = () =>
    page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
  const resize = async (width, height, stress = false) => {
    await app.evaluate(
      ({ BrowserWindow }, { width, height, stress }) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (stress) win.setMinimumSize(760, 600);
        win.setContentSize(width, height);
      },
      { width, height, stress },
    );
    await page.waitForFunction(
      ({ width, height }) => innerWidth === width && innerHeight === height,
      { width, height },
    );
    await settle();
  };
  const panel = (name) => page.locator(`[data-workspace-panel="${name}"]`),
    grip = (name) => page.locator(`[data-panel-move="${name}"]`),
    toggle = (name) => page.locator(`[data-panel-toggle="${name}"]`);
  const layout = () =>
    page.evaluate(() => {
      const l = document.querySelector(".workspace")._stykLayout;
      return { sizes: l.sizes, floating: l.floating };
    });
  const documentUnchanged = () =>
    page.evaluate(() => {
      const e = styk.editor,
        b = window.layoutBaseline;
      return (
        JSON.stringify(e.report) === b.report &&
        e._undo.length === b.undo &&
        e.revision === b.revision
      );
    });
  const drag = async (locator, dx, dy, { cancel = false } = {}) => {
    const r = await locator.boundingBox();
    assert.ok(r, "Visible drag target");
    await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
    await page.mouse.down();
    await page.mouse.move(r.x + r.width / 2 + dx, r.y + r.height / 2 + dy, {
      steps: 6,
    });
    if (cancel) await page.keyboard.press("Escape");
    await page.mouse.up();
    await settle();
  };
  const gpuSized = () =>
    page.evaluate(() => {
      const v = document.querySelector("#viewport"),
        c = document.querySelector("#scene");
      return (
        Math.abs(c.width / devicePixelRatio - v.clientWidth) <= 1 &&
        Math.abs(c.height / devicePixelRatio - v.clientHeight) <= 1
      );
    });
  const chromeFits = () =>
    page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > innerWidth,
      controls: [...document.querySelectorAll(".styk-panel-controls")].every(
        (el) => {
          const r = el.getBoundingClientRect(),
            p = el.parentElement.getBoundingClientRect();
          return r.left >= p.left - 0.5 && r.right <= p.right + 0.5;
        },
      ),
      stage: document.querySelector("#viewport").clientWidth,
    }));
  await resize(1560, 1000);
  const initial = await layout();
  for (const [name, dx, dy] of [
    ["left", 54, 0],
    ["right", -40, 0],
    ["timeline", 0, -45],
  ])
    await drag(
      page.locator(`.styk-workspace-splitter[data-panel="${name}"]`),
      dx,
      dy,
    );
  const resized = await layout();
  check(
    "Wide desktop splitters resize both sidebars and the timeline",
    Math.abs(resized.sizes.left - initial.sizes.left - 54) < 1 &&
      Math.abs(resized.sizes.right - initial.sizes.right - 40) < 1 &&
      Math.abs(resized.sizes.timeline - initial.sizes.timeline - 45) < 1,
  );
  check(
    "Resizing updates the WebGPU surface without changing the document",
    (await gpuSized()) && (await documentUnchanged()),
  );
  await page.screenshot({ path: path.join(out, "wide-docked.png") });
  await toggle("left").click();
  const floating = await layout();
  await drag(grip("left"), 220, 60);
  const moved = await layout();
  check(
    "Layers undocks and moves as a floating panel",
    Math.abs(moved.floating.left.x - floating.floating.left.x - 220) < 1 &&
      Math.abs(moved.floating.left.y - floating.floating.left.y - 60) < 1 &&
      (await panel("left").evaluate(
        (el) => getComputedStyle(el).position === "fixed",
      )),
  );
  await drag(panel("left").locator('[data-edge="se"]'), 64, 30);
  const expanded = await layout();
  check(
    "Floating corner resizes width and height",
    Math.abs(expanded.floating.left.width - moved.floating.left.width - 64) <
      1 &&
      Math.abs(
        expanded.floating.left.height - moved.floating.left.height - 30,
      ) < 1,
  );
  await grip("left").focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+ArrowDown");
  await settle();
  const keyboard = await layout();
  check(
    "Focused panel keyboard movement stays out of the canvas document",
    keyboard.floating.left.x === expanded.floating.left.x + 10 &&
      keyboard.floating.left.y === expanded.floating.left.y + 1 &&
      (await documentUnchanged()),
  );
  await drag(grip("left"), 30, 20, { cancel: true });
  check(
    "Escape cancels a floating move and releases pointer capture",
    JSON.stringify((await layout()).floating.left) ===
      JSON.stringify(keyboard.floating.left) &&
      (await page.evaluate(
        () =>
          ![...document.querySelectorAll("[data-panel-move],[data-edge]")].some(
            (el) => el.hasPointerCapture(1),
          ),
      )),
  );
  await toggle("right").click();
  await toggle("timeline").click();
  await settle();
  check(
    "Layers, Properties and Timeline can float together",
    Object.keys((await layout()).floating).length === 3 && (await gpuSized()),
  );
  await page.screenshot({ path: path.join(out, "wide-floating.png") });
  await resize(900, 760, true);
  const constrained = await layout();
  check(
    "900px stress resize keeps every floating panel reachable",
    await page.evaluate(() => {
      const l = document.querySelector(".workspace")._stykLayout,
        h = document.querySelector(".workspace").clientHeight;
      return Object.values(l.floating).every(
        (r) =>
          r.x >= 0 &&
          r.y >= 0 &&
          r.x + r.width <= innerWidth + 1 &&
          r.y + r.height <= h + 1,
      );
    }),
  );
  await toggle("timeline").click();
  await toggle("right").click();
  const r = await grip("left").boundingBox();
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width / 2 - 20, r.y + r.height / 2 + 20, {
    steps: 3,
  });
  const zone = await page.locator(".styk-panel-dock-zone").boundingBox();
  await page.mouse.move(zone.x + zone.width / 2, zone.y + zone.height / 2, {
    steps: 3,
  });
  check(
    "Dragging into a dock target displays its active preview",
    (await page.locator(".styk-panel-dock-zone[data-active]").count()) === 1,
  );
  await page.mouse.up();
  await settle();
  check(
    "Drag redocking restores all panels and leaves document history untouched",
    Object.keys((await layout()).floating).length === 0 &&
      (await documentUnchanged()),
  );
  // Check docked controls at the supported native minimum after the floating stress test.
  await resize(1000, 760);
  await page.locator('.brand[data-action="menu"]').click();
  await page.locator('#menu [data-action="settings"]').click();
  await page.locator("[data-settings-reset]").click();
  await page.locator(".styk-settings-head button").click();
  await settle();
  const compact = await chromeFits();
  check(
    "1000px docked workspace retains a usable stage and visible panel controls",
    !compact.overflow && compact.controls && compact.stage >= 300,
    compact,
  );
  layouts.push(
    { size: "wide", layout: resized },
    { size: "900-floating", layout: constrained },
    { size: "1000-docked", layout: await layout(), chrome: compact },
  );
  const row = (kind) =>
    page
      .locator(`.styk-tree-row[data-kind="${kind}"]:visible .styk-tree-name`)
      .first();
  const field = (key) => page.locator(`#inspector [data-property="${key}"]`);
  const fixedKinds = await page
    .locator(".styk-tree-row:visible")
    .evaluateAll((rows) => rows.map((row) => row.dataset.kind));
  check(
    "Scene and Camera remain distinct fixed rows before user layers",
    fixedKinds[0] === "scene" &&
      fixedKinds[1] === "camera" &&
      fixedKinds.filter((k) => k === "scene").length === 1 &&
      fixedKinds.filter((k) => k === "camera").length === 1,
    fixedKinds,
  );
  await row("camera").click();
  await field("camera_x").waitFor();
  check(
    "Camera selection shows camera properties without figure or scene fields",
    (await field("root_x").count()) === 0 &&
      (await field("canvas_width").count()) === 0,
  );
  const propertyLayout = await page.locator("#inspector").evaluate((el) => ({
    overflow: el.scrollWidth > el.clientWidth + 1,
    rows: [...el.querySelectorAll(".property-key-controls")].map((row) => {
      const p = el.getBoundingClientRect(),
        rects = [...row.children].map((n) => n.getBoundingClientRect());
      return (
        rects.length === 3 &&
        rects.every(
          (r) =>
            r.width >= 17 &&
            Math.abs(r.top - rects[0].top) < 1 &&
            r.left >= p.left &&
            r.right <= p.right + 1,
        )
      );
    }),
  }));
  check(
    "1000px camera diamonds and previous/next controls are complete, aligned and unclipped",
    !propertyLayout.overflow &&
      propertyLayout.rows.length > 0 &&
      propertyLayout.rows.every(Boolean),
    propertyLayout,
  );
  await page.locator('#inspector [data-property-key="camera_x"]').click();
  await page.locator("#scene").focus();
  await page.keyboard.press('End');
  await field("camera_x").fill("21.25");
  await field("camera_x").press("Enter");
  await settle();
  const cameraTick = await page.evaluate(() => styk.editor.tick);
  await page
    .locator('#inspector [data-property-nav="camera_x"][data-direction="-1"]')
    .click();
  check(
    "Previous camera key control navigates to the earlier key",
    await page.evaluate((t) => styk.editor.tick < t, cameraTick),
  );
  await page
    .locator('#inspector [data-property-nav="camera_x"][data-direction="1"]')
    .click();
  check(
    "Next camera key control restores the edited key and precise value",
    (await page.evaluate((t) => styk.editor.tick === t, cameraTick)) &&
      Number(await field("camera_x").inputValue()) === 21.25,
  );
  await page.screenshot({ path: path.join(out, "compact-camera.png") });
  const beforeScrub = await page.evaluate(() => ({
    report: JSON.stringify(styk.editor.report),
    undo: styk.editor._undo.length,
  }));
  await drag(
    page.locator(
      '#inspector [data-property-row="camera_x"] [data-property-scrub]',
    ),
    24,
    0,
    { cancel: true },
  );
  check(
    "Escape cancels a contextual property scrub without a history item or stuck gesture",
    await page.evaluate(
      (b) =>
        JSON.stringify(styk.editor.report) === b.report &&
        styk.editor._undo.length === b.undo &&
        !styk.properties.active,
      beforeScrub,
    ),
  );
  await field("camera_x").focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("Escape");
  check(
    "Typing-space focus never starts playback or changes the number of figures",
    await page.evaluate(
      () => !styk.state.playing && styk.editor.frame.objects.length === 1,
    ),
  );
  await row("scene").click();
  await field("canvas_width").waitFor();
  check(
    "Scene context presents canvas settings without camera or figure controls",
    (await field("camera_x").count()) === 0 &&
      (await field("root_x").count()) === 0,
  );
  await page.screenshot({ path: path.join(out, "compact-scene.png") });
  await row("layer").click();
  await page.locator("#inspector-layer-name").waitFor();
  check(
    "Layer selection has its own property hierarchy",
    (await field("canvas_width").count()) === 0 &&
      (await field("camera_x").count()) === 0,
  );
  const timelineKinds = await page
    .locator("#timeline .styk-timeline-label:visible")
    .evaluateAll((rows) => rows.map((row) => row.dataset.kind));
  check(
    "Advanced timeline exposes Scene and Camera above the user layer",
    timelineKinds[0] === "scene" &&
      timelineKinds[1] === "camera" &&
      timelineKinds.includes("layer"),
    timelineKinds,
  );
  check(
    "Advanced footer reports output duration without a misleading native key total",
    /^\d+ frames · [\d.]+s$/.test(
      await page.locator("#timeline-summary").textContent(),
    ),
  );
  // Reset only the test document so the mode transition oracle has three exact native poses.
  await page.evaluate(async () => {
    const { emptyDocument, createFrame, createObject } = await import(
      "/src/demo.mjs"
    );
    const report = emptyDocument(),
      f = report.figure_types[0];
    report.keyframes = [100, 120, 140].map((x) =>
      createFrame([createObject(f, 1, x, 180)], 3),
    );
    styk.editor.load(report, "Stored and working poses");
    styk.editor.selectFrame(2);
    styk.editor.select(1);
    styk.fit();
  });
  const settings = async () => {
    await page.locator('.brand[data-action="menu"]').click();
    await page.locator('#menu [data-action="settings"]').click();
    await page.locator(".styk-settings").waitFor();
  };
  const mode = async (name) => {
    await settings();
    await page
      .locator(`.styk-settings [data-setting="timelineMode"][value="${name}"]`)
      .check();
    await page.locator(".styk-settings-head button").click();
    await settle();
  };
  await mode("simple");
  await page.locator(".styk-simple-update").waitFor();
  check(
    "Simple mode fits Add/Update and inbetween controls at 1000px",
    (await page.locator(".styk-simple-controls").evaluate((el) => {
      const p = el.getBoundingClientRect();
      return [...el.querySelectorAll("button,input")].every((e) => {
        const r = e.getBoundingClientRect();
        return (
          r.top >= p.top &&
          r.bottom <= p.bottom + 1 &&
          r.left >= p.left &&
          r.right <= p.right + 1
        );
      });
    })) && (await layout()).sizes.timeline >= 205,
  );
  await page.locator(".styk-simple-update").click();
  await row("figure").click();
  await field("root_x").fill("230");
  await field("root_x").press("Enter");
  const working = await page.evaluate(async () => {
    const { storedFrameReport } = await import("/src/pivot-frame-draft.mjs");
    return {
      stored: storedFrameReport(styk.editor.report).keyframes.map(
        (f) => f.objects[0].root_x,
      ),
      working: styk.editor.object.root_x,
      mode: styk.editor.frameDraft.mode,
    };
  });
  check(
    "Simple Add keeps stored poses distinct from the live working pose",
    JSON.stringify(working.stored) === "[100,120,140]" &&
      working.working === 230 &&
      working.mode === "add",
    working,
  );
  check(
    "Simple footer retains the native stored-key count while the Add pose is unsaved",
    /^3 keys · \d+ frames · [\d.]+s$/.test(
      await page.locator("#timeline-summary").textContent(),
    ),
  );
  await page.screenshot({ path: path.join(out, "compact-simple-working.png") });
  await mode("advanced");
  check(
    "Simple to Advanced preserves saved poses and appends the distinct working pose once",
    await page.evaluate(
      () =>
        !styk.editor.frameDraft &&
        JSON.stringify(
          styk.editor.report.keyframes.map((f) => f.objects[0].root_x),
        ) === "[100,120,140,230]" &&
        styk.editor.frameIndex === 3,
    ),
  );
  await mode("simple");
  await row("figure").click();
  await field("root_x").fill("250");
  await field("root_x").press("Enter");
  check(
    "Advanced to Simple restores Update mode at the same selected frame",
    await page.evaluate(
      () =>
        styk.editor.frameDraft.mode === "update" &&
        styk.editor.frameIndex === 3 &&
        styk.editor.object.root_x === 250,
    ),
  );
  await mode("advanced");
  check(
    "Switching an Update draft commits that frame without appending another",
    await page.evaluate(
      () =>
        JSON.stringify(
          styk.editor.report.keyframes.map((f) => f.objects[0].root_x),
        ) === "[100,120,140,250]",
    ),
  );
  await mode("simple");
  await settings();
  await page.locator("[data-settings-reset]").click();
  await page.locator(".styk-settings-head button").click();
  await settle();
  check(
    "The actual Preferences reset returns a compact docked Simple workspace",
    Object.keys((await layout()).floating).length === 0 &&
      (await layout()).sizes.timeline >= 205 &&
      !(await chromeFits()).overflow &&
      (await chromeFits()).controls,
  );
  await resize(1560, 1000);
  await page.screenshot({ path: path.join(out, "wide-simple.png") });
  check(
    "Final viewport has no stale focus in detached controls or active gestures",
    await page.evaluate(
      () =>
        document.activeElement.isConnected &&
        !styk.properties.active &&
        !styk.editor.dragging &&
        !document.querySelector(".styk-settings").open,
    ),
  );
  check("No uncaught application errors", errors.length === 0, errors);
  await page.evaluate(async () => {
    styk.editor.markSaved();
    await styk.settingsUI.flush();
    await document.querySelector(".workspace")._stykLayout.flushPreferences();
  });
  await writeFile(
    path.join(out, "report.json"),
    JSON.stringify(
      {
        checks,
        errors,
        metadata,
        packaged,
        sourceHashes,
        layouts,
        notes: [
          "900px is an explicit responsive stress size below the normal native 1000px minimum; only this isolated test window minimum was changed.",
          "Small deterministic three-frame fixture; this is functional UX acceptance, not a large-scene latency benchmark.",
        ],
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ checks: checks.length, errors, packaged }));
} catch (error) {
  await page
    ?.screenshot({ path: path.join(out, "failure.png") })
    .catch(() => {});
  await writeFile(
    path.join(out, "failure.json"),
    JSON.stringify({ checks, errors, metadata, error: error.stack }, null, 2),
  );
  throw error;
} finally {
  if (app) {
    await page
      ?.evaluate(() => window.styk?.editor?.markSaved())
      .catch(() => {});
    await app.close();
  }
}
