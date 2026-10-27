import { chromium } from "./support/playwright.mjs";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1560, height: 1000 } }),
  checks = [],
  errors = [],
  out = "artifacts/style-keyframes";
page.on("pageerror", (e) => errors.push(e.message));
page.setDefaultTimeout(10000);
const check = (name, result) => {
  assert.ok(result, name);
  checks.push(name);
  console.log("PASS", name);
};
const field = (key) => page.locator(`#inspector [data-property="${key}"]`);
const near = (a, b) => Math.abs(a - b) < 1e-5;
async function type(key, value) {
  await field(key).fill(String(value));
  await field(key).press("Enter");
  await page.waitForTimeout(70);
}
async function seek(tick) {
  await page.evaluate((tick) => styk.editor.seek(tick), tick);
  await page.waitForTimeout(70);
}
async function drag(key, dx) {
  const label = page.locator(
    `#inspector [data-property-row="${key}"] [data-property-scrub]`,
  );
  await label.scrollIntoViewIfNeeded();
  const r = await label.boundingBox(),
    x = r.x + r.width / 2,
    y = r.y + r.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(70);
}
async function setup(key, property) {
  await page.evaluate((property) => {
    const e = styk.editor;
    e.newDocument();
    e.select(e.selectedUid, 0);
    e.updateFigureStyle({
      name: "Keyed gradient",
      outlineWidth: 4,
      outlineColor: "#0d99ff",
      outlineOpacity: 0.8,
    });
    e.updateSegmentStyle({
      color: "#ef3068",
      opacity: 0.7,
      thickness: 16,
      gradient: { color: "#25c987", opacity: 0.6 },
    });
    const uid = e.selectedUid;
    e.addFigure(e.figure.figure_type_id);
    const other = e.selectedUid;
    e.sheetSetDuration(21);
    e.seek(0);
    e.select(uid, 0);
    window.styleTest = {
      uid,
      other,
      property,
      target: { kind: "segment", uid, handleId: e.figure.segments[0].segment_id },
      base: JSON.stringify(e.figure),
    };
  }, property);
  await field(key).waitFor();
  await page.waitForTimeout(80);
}
const state = () =>
  page.evaluate(() => {
    const e = styk.editor,
      t = window.styleTest,
      track = e.report._styk.layerSheet.tracks[e.layerForUid(t.uid)];
    return {
      tick: e.tick,
      undo: e._undo.length,
      channels: e.animationChannels.length,
      keys: track.keys
        .filter((key) => key.sourceTick === undefined)
        .map((key) => ({ tick: key.tick, empty: Boolean(key.empty) })),
      unchanged: JSON.stringify(e.figure) === t.base,
      selected: e.selectedUid,
      joint: e.selectedJoint,
    };
  });
try {
  await page.goto(process.env.STYK_URL || "http://127.0.0.1:47831");
  await page.waitForFunction(() => window.styk?.ready);
  await mkdir(out, { recursive: true });
  for (const [key, property] of [
    ["segment_opacity", "opacity"],
  ]) {
    await setup(key, property);
    let before = await state();
    check(
      `${key}: property rows render no per-property key controls`,
      (await page
        .locator(
          `#inspector [data-property-key="${key}"], #inspector [data-property-nav="${key}"]`,
        )
        .count()) === 0,
    );
    await type(key, 20);
    let after = await state();
    check(
      `${key}: typing writes one authored layer key`,
      after.keys.length === 1 &&
        after.keys[0].tick === 0 &&
        !after.keys[0].empty &&
        after.undo === before.undo + 1 &&
        after.channels === 0,
    );
    await page.evaluate(() =>
      styk.editor.sheetInsertKey(
        [styk.editor.layerForUid(window.styleTest.uid)],
        10,
      ),
    );
    await seek(10);
    await type(key, 80);
    after = await state();
    check(
      `${key}: an inserted key takes an independent style pose`,
      after.keys.length === 2 && after.keys[1].tick === 10,
    );
    await seek(5);
    after = await state();
    check(
      `${key}: inspector displays the held authored value`,
      near(Number(await field(key).inputValue()), 20),
    );
    check(
      `${key}: authored style affects only its selected layer`,
      after.unchanged,
    );
    before = await state();
    const widthLabel = page.locator(
      '#inspector [data-property-row="thickness"] [data-property-scrub]',
    );
    await widthLabel.scrollIntoViewIfNeeded();
    const box = await widthLabel.boundingBox();
    assert.ok(box && box.width > 5, `${key}: thickness scrub label is interactive`);
    const width = page.locator('#inspector [data-property="thickness"]'),
      widthBefore = Number(await width.inputValue());
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 10, box.y + box.height / 2, {
      steps: 8,
    });
    await page.mouse.up();
    await page.waitForTimeout(70);
    after = await state();
    check(
      `${key}: scrubbing edits the sheet pose in one undo`,
      after.undo === before.undo + 1 &&
        Number(await width.inputValue()) !== widthBefore,
    );
    await page.evaluate(() => styk.editor.undo());
    await page.waitForTimeout(60);
    check(
      `${key}: sheet style edits are undoable`,
      near(Number(await field(key).inputValue()), 20),
    );
    await seek(5);
    before = await state();
    await page.evaluate(() => {
      const e = styk.editor;
      e.copySelection();
      e.pasteSelection();
      e.select(e.selectedUid, 0);
      window.styleTest.pasted = e.selectedUid;
    });
    await page.waitForTimeout(80);
    const captured = Number(await field(key).inputValue());
    await type(key, 31);
    check(
      `${key}: pasted figure stays editable through its own layer key`,
      near(Number(await field(key).inputValue()), 31),
    );
    check(
      `${key}: pasted edits add a boundary without disturbing the source pose`,
      await page.evaluate(() => {
        const e = styk.editor,
          t = window.styleTest,
          v5 = e.animationValue(t.target, t.property, 5),
          v4 = e.animationValue(t.target, t.property, 4);
        return Math.abs(v5 - v4) < 0.02 && Math.abs(v5 - 0.31) > 0.02;
      }),
    );
    await page.evaluate(() => styk.editor.undo());
    await page.waitForTimeout(60);
    check(
      `${key}: pasted edit undo restores its displayed value`,
      near(Number(await field(key).inputValue()), captured),
    );
    await page.evaluate(() => styk.editor.redo());
    await page.waitForTimeout(60);
    check(
      `${key}: pasted edit redo restores its displayed value`,
      near(Number(await field(key).inputValue()), 31),
    );
  }
  await page.evaluate(() => {
    styk.editor.select(styleTest.uid, 0);
  });
  await page.waitForTimeout(60);
  check(
    "Layer track carries the authored style keys",
    await page.evaluate(() => {
      const e = styk.editor,
        keys =
          e.report._styk.layerSheet.tracks[e.layerForUid(styleTest.uid)].keys;
      return (
        keys.filter((key) => key.sourceTick === undefined).length >= 2 &&
        e.animationChannels.length === 0
      );
    }),
  );
  for (const [width, height] of [
    [1560, 1000],
    [1280, 800],
    [1100, 740],
  ]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() =>
      document.getElementById("inspector").scrollTo(0, 1e6),
    );
    check(
      `${width}px inspector has no horizontal clipping`,
      await page
        .locator("#inspector")
        .evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
    );
    check(
      `${width}px property rows fit and retain useful targets`,
      await page.locator("#inspector").evaluate((panel) => {
        const panelBox = panel.getBoundingClientRect();
        return [...panel.querySelectorAll(".property-row")].every((row) => {
          const box = row.getBoundingClientRect();
          return (
            box.width > 0 &&
            box.left >= panelBox.left - 1 &&
            box.right <= panelBox.right + 1
          );
        });
      }),
    );
    await page.screenshot({ path: `${out}/inspector-${width}.png` });
  }
  check("No uncaught application errors", errors.length === 0);
  await writeFile(
    `${out}/report.json`,
    JSON.stringify({ checks, errors }, null, 2),
  );
} finally {
  await browser.close();
}
