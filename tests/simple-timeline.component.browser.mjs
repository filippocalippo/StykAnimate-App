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
    const { SimpleTimeline } = await import("/src/simple-timeline.mjs"),
      { Editor } = await import("/src/editor.mjs"),
      { buildGeometry, drawGeometry } = await import("/src/pivot/geometry.mjs");
    const host = document.createElement("div");
    host.id = "simple-test";
    host.style.cssText =
      "position:fixed;bottom:30px;left:225px;right:260px;height:190px;z-index:50;background:white;border:1px solid #ddd";
    document.body.append(host);
    window.simpleEditor = new Editor({ demo: true });
    window.simpleRanges = [];
    window.simpleUI = new SimpleTimeline(host, window.simpleEditor, {
      onRangeChange: (r) => window.simpleRanges.push(r),
      renderThumbnail: (index, canvas) => {
        const ctx = canvas.getContext("2d"),
          r = window.simpleEditor.report;
        ctx.fillStyle = "white";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.scale(
          canvas.width / r.canvas_width,
          canvas.height / r.canvas_height,
        );
        drawGeometry(ctx, buildGeometry(r, r.keyframes[index]));
      },
      onError: (e) => {
        throw e;
      },
    });
    window.simpleEditor.addEventListener("change", () =>
      window.simpleUI.update(),
    );
  });
  await p.waitForFunction(() => window.simpleUI.stats.cachedPreviews >= 4);
  check(
    "Filmstrip has native rendered frame thumbnails",
    (await p.locator("#simple-test canvas").count()) >= 4,
  );
  await p.locator('#simple-test [data-frame="0"] button').click();
  await p
    .locator('#simple-test [data-frame="2"] button')
    .click({ modifiers: ["Control"] });
  check(
    "Ctrl toggles separate frame selections",
    await p.evaluate(
      () => JSON.stringify(window.simpleUI.selectedFrameIndices) === "[0,2]",
    ),
  );
  await p
    .locator('#simple-test [data-frame="4"] button')
    .click({ modifiers: ["Shift"] });
  check(
    "Shift selects inclusive anchored range",
    await p.evaluate(
      () => JSON.stringify(window.simpleUI.selectedFrameIndices) === "[2,3,4]",
    ),
  );
  await p.locator('#simple-test [aria-label="Frame inbetweens"]').fill("7");
  await p.locator('#simple-test [aria-label="Frame inbetweens"]').press("Tab");
  check(
    "Inbetweens map to native duration plus keyframe",
    await p.evaluate(() =>
      [2, 3, 4].every(
        (i) => window.simpleEditor.report.keyframes[i].duration_raw === 8,
      ),
    ),
  );
  await p.locator("#simple-test [data-simple-action=update]").click();
  check(
    "Update commits editing and restores Add mode",
    await p.locator("#simple-test [data-simple-action=add]").isVisible(),
  );
  await p.locator("#simple-test [data-simple-action=add]").click();
  check(
    "Add duplicates a pose into next frame",
    await p.evaluate(() => window.simpleEditor.report.keyframes.length === 25),
  );
  await p.evaluate(() => window.simpleUI.selectFrame(0));
  await p.locator("#simple-test [data-simple-action=copy]").click();
  check(
    "Frame clipboard populated",
    await p.evaluate(() => window.simpleEditor.hasFrameClipboard),
  );
  await p.locator("#simple-test [data-simple-action=paste-end]").click();
  check(
    "Paste appends exact copied frame",
    await p.evaluate(() => window.simpleEditor.report.keyframes.length === 26),
  );
  await p.evaluate(() => window.simpleUI.selectFrame(0));
  await p.locator("#simple-test [data-simple-action=insert]").click();
  check(
    "Insert duplicates before frame and preserves clipboard",
    await p.evaluate(
      () =>
        window.simpleEditor.report.keyframes.length === 27 &&
        window.simpleEditor.hasFrameClipboard,
    ),
  );
  await p.evaluate(() => window.simpleUI.selectFrame(0));
  const beforeId = await p.evaluate(() => window.simpleEditor.getFrameId(0));
  await p
    .locator('#simple-test [data-frame="0"]')
    .dragTo(p.locator('#simple-test [data-frame="2"]'), {
      targetPosition: { x: 100, y: 45 },
    });
  check(
    "Single frame drag reorders stable frame identity",
    await p.evaluate(
      (id) => window.simpleEditor.getFrameId(2) === id,
      beforeId,
    ),
  );
  await p.evaluate(() => window.simpleEditor.undo());
  check(
    "Frame move undo restores original identity",
    await p.evaluate(
      (id) => window.simpleEditor.getFrameId(0) === id,
      beforeId,
    ),
  );
  await p.evaluate(() => window.simpleUI.selectFrame(0));
  await p
    .locator('#simple-test [data-frame="0"] button')
    .click({ button: "right" });
  check(
    "Context menu exposes insert and reverse",
    await p
      .getByRole("menuitem", { name: "Reverse selected", exact: true })
      .isVisible(),
  );
  await p.keyboard.press("Escape");
  await p.screenshot({ path: "artifacts/simple-timeline-native.png" });
  await p.locator("#simple-test .styk-simple-strip").hover();
  await p.mouse.wheel(0, 600);
  await p.waitForTimeout(60);
  check(
    "Vertical mouse wheel scrolls filmstrip horizontally",
    await p
      .locator("#simple-test .styk-simple-strip")
      .evaluate((e) => e.scrollLeft > 0),
  );
  await p.evaluate(() => {
    const r = window.simpleEditor.serialize(),
      frame = r.keyframes[0];
    r.keyframes = Array.from({ length: 10000 }, () => structuredClone(frame));
    for (const f of r.keyframes) delete f._styk;
    delete r._styk.simpleFrameDraft;
    window.simpleEditor.load(r);
  });
  check(
    "10,000 keyframes create bounded visible card DOM",
    (await p.locator("#simple-test [data-frame]").count()) <= 9,
  );
  await p.locator("#simple-test .styk-simple-strip").focus();
  await p.keyboard.press("End");
  check(
    "Keyboard End reaches final native key",
    await p.evaluate(() => window.simpleEditor.frameIndex === 9999),
  );
  await p.waitForTimeout(200);
  await p.screenshot({ path: "artifacts/simple-timeline-10000.png" });
  check(
    "Thumbnail memory remains bounded",
    await p.evaluate(() => window.simpleUI.stats.cachedPreviews <= 72),
  );
  await p.locator("#simple-test [data-simple-action=copy]").focus();
  await p.keyboard.press("Space");
  check(
    "Keyboard activates filmstrip controls without canvas pan",
    await p.evaluate(() => !window.styk.state.space),
  );
  check("No browser errors", errors.length === 0);
  await writeFile(
    "artifacts/simple-timeline-verification.json",
    JSON.stringify(
      { checks, errors, stats: await p.evaluate(() => window.simpleUI.stats) },
      null,
      2,
    ),
  );
} finally {
  await b.close();
}
