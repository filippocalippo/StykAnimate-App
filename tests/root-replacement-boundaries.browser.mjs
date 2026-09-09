import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const out = "artifacts/root-replacement-boundaries",
  checks = [],
  errors = [];
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--disable-gpu"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(10000);
page.on("pageerror", (error) => errors.push(error.message));
const check = (name, value) => {
  assert.ok(value, name);
  checks.push(name);
  console.log("PASS", name);
};
async function setup() {
  await page.evaluate(async () => {
    const { emptyDocument, createFrame, createObject } = await import(
      "/src/demo.mjs"
    );
    const report = emptyDocument();
    report.keyframes = [
      createFrame([createObject(report.figure_types[0], 90, 400, 250)]),
    ];
    styk.editor.load(report, "Replacement boundary");
    styk.settingsUI.commit({ timelineMode: "simple" });
    styk.editor.beginFrameDraft({ mode: "add", index: 0 });
    styk.editor.select(90);
    styk.editor.markSaved();
    styk.fit();
    window.replaceBefore = {
      report: styk.editor.report,
      x: styk.editor.object.root_x,
      undo: styk.editor._undo.length,
    };
  });
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
}
async function hold() {
  const p = await page.evaluate(() => {
    const r = document.querySelector("#viewport").getBoundingClientRect(),
      v = styk.state.view,
      o = styk.editor.object;
    return {
      x: r.x + v.x + o.root_x * v.scale,
      y: r.y + v.y + o.root_y * v.scale,
    };
  });
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + 31, p.y + 11, { steps: 3 });
}
try {
  await page.goto(process.env.STYK_URL || "http://127.0.0.1:47831");
  await page.waitForFunction(() => window.styk?.ready);
  await setup();
  await hold();
  await page.evaluate(() => {
    window.pendingNew = Promise.race([
      styk.actions.new(),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Replacement dialog did not resolve")),
          9000,
        ),
      ),
    ]);
  });
  await page.locator("#keep-editing").waitFor();
  check(
    "New finalizes a held gesture before asking to replace",
    await page.evaluate(
      () =>
        !styk.state.drag &&
        !styk.editor._drag &&
        !document.querySelector("#overlay").hasPointerCapture(1) &&
        styk.editor._undo.length === replaceBefore.undo + 1,
    ),
  );
  await page.locator("#keep-editing").click();
  await page.mouse.up();
  check(
    "Cancelling New retains the edited document and one undo",
    await page.evaluate(async () => {
      await pendingNew;
      return (
        styk.editor.report === replaceBefore.report &&
        styk.editor.object.root_x !== replaceBefore.x &&
        styk.editor._undo.length === replaceBefore.undo + 1
      );
    }),
  );
  await setup();
  await hold();
  await page.evaluate(() => {
    window.pendingNew = Promise.race([
      styk.actions.new(),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Replacement dialog did not resolve")),
          9000,
        ),
      ),
    ]);
  });
  await page.locator("#discard-changes").click();
  await page.evaluate(async () => {
    await pendingNew;
    window.newRoot = JSON.stringify(styk.editor.frame.objects);
  });
  await page.mouse.up();
  check(
    "Discard and New leave a clean zero-frame document without an old drag",
    await page.evaluate(
      () =>
        styk.editor.report !== replaceBefore.report &&
        styk.editor.totalTicks === 0 &&
        !styk.state.drag &&
        !styk.editor._drag &&
        !styk.editor.canUndo &&
        !styk.editor.dirty &&
        JSON.stringify(styk.editor.frame.objects) === newRoot,
    ),
  );
  check(
    "New footer reports zero stored keys",
    (await page.locator("#timeline-summary").count())
      ? await page
          .locator("#timeline-summary")
          .innerText()
          .then((text) => text.startsWith("0 keys"))
      : await page.evaluate(() =>
          document.body.innerText.includes("0 keys · 0 frames"),
        ),
  );
  await setup();
  await hold();
  await page
    .locator("#file-input")
    .setInputFiles(
      path.resolve("../Pivot Animator v5/Animations/tween_pendulum.piv"),
    );
  await page.locator("#discard-changes").waitFor();
  check(
    "File import finalizes the held gesture before replacing",
    await page.evaluate(
      () => !styk.state.drag && !styk.editor._drag && styk.editor.dirty,
    ),
  );
  await page.locator("#discard-changes").click();
  await page.waitForFunction(() => styk.editor.name === "tween_pendulum");
  await page.evaluate(() => {
    window.importedRoot = JSON.stringify(styk.editor.frame.objects);
  });
  await page.mouse.up();
  check(
    "Async import opens the final stored key and ignores the old pointer release",
    await page.evaluate(
      () =>
        styk.editor.frameIndex === styk.editor.report.keyframes.length - 1 &&
        !styk.state.drag &&
        !styk.editor._drag &&
        !styk.editor.dirty &&
        JSON.stringify(styk.editor.frame.objects) === importedRoot,
    ),
  );
  check("No unhandled renderer errors", errors.length === 0);
  await mkdir(out, { recursive: true });
  await writeFile(
    `${out}/report.json`,
    JSON.stringify({ passed: true, checks, errors }, null, 2),
  );
} catch (error) {
  await mkdir(out, { recursive: true });
  await page.screenshot({ path: `${out}/failure.png` });
  await writeFile(
    `${out}/report.json`,
    JSON.stringify(
      { passed: false, checks, errors, error: error.stack },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await browser.close();
}
