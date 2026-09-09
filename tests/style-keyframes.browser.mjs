import { chromium } from "playwright";
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
const diamond = (key) =>
  page.locator(`#inspector [data-property-key="${key}"]`);
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
async function setup(key, kind, property) {
  await page.evaluate(
    ({ kind, property }) => {
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
      for (const segment of e.figure.segments) {
        segment.segment_id *= 11;
        segment.parent_id *= 11;
      }
      e._invalidate();
      const uid = e.selectedUid;
      e.addFigure(e.figure.figure_type_id);
      const other = e.selectedUid;
      e.setFramesDuration([0], 21);
      e.addFrame();
      e.selectFrame(0);
      e.select(uid, 0);
      window.styleTest = {
        uid,
        other,
        kind,
        property,
        target: kind === "figure" ? { kind, uid } : { kind, uid, handleId: 11 },
        base: JSON.stringify(e.figure),
      };
    },
    { kind, property },
  );
  await field(key).waitFor();
  await page.waitForTimeout(80);
}
const state = () =>
  page.evaluate(() => {
    const e = styk.editor,
      t = window.styleTest,
      channel = e.animationChannel(t.target, t.property);
    return {
      tick: e.tick,
      undo: e._undo.length,
      keys: channel?.keys.map((k) => ({ tick: k.tick, value: k.value })) ?? [],
      source: e.animationValue(t.target, t.property),
      other: e.animationValue({ ...t.target, uid: t.other }, t.property),
      unchanged: JSON.stringify(e.figure) === t.base,
      selected: e.selectedUid,
      joint: e.selectedJoint,
    };
  });
try {
  await page.goto(process.env.STYK_URL || "http://127.0.0.1:47831");
  await page.waitForFunction(() => window.styk?.ready);
  await mkdir(out, { recursive: true });
  for (const [key, kind, property] of [
    ["outline_opacity", "figure", "outlineOpacity"],
    ["segment_opacity", "segment", "opacity"],
    ["segment_gradient_opacity", "segment", "gradientOpacity"],
  ]) {
    await setup(key, kind, property);
    let before = await state();
    check(`${key}: diamond is available`, await diamond(key).isVisible());
    await diamond(key).click();
    await page.waitForTimeout(70);
    let after = await state();
    check(
      `${key}: diamond inserts one property key`,
      after.keys.length === 1 &&
        after.undo === before.undo + 1 &&
        after.keys[0].tick === 0,
    );
    await type(key, 20);
    await seek(10);
    await type(key, 80);
    after = await state();
    check(
      `${key}: editing a keyed field inserts the second key`,
      after.keys.length === 2 &&
        near(after.keys[0].value, 0.2) &&
        near(after.keys[1].value, 0.8),
    );
    await seek(5);
    after = await state();
    check(
      `${key}: inspector displays interpolated opacity`,
      near(Number(await field(key).inputValue()), 50) &&
        near(after.source, 0.5),
    );
    check(
      `${key}: authored opacity affects only its selected instance`,
      after.unchanged && near(after.other, before.other),
    );
    await page
      .locator(`#inspector [data-property-nav="${key}"][data-direction="-1"]`)
      .click();
    await page.waitForTimeout(60);
    check(
      `${key}: previous key navigation seeks frame zero`,
      (await state()).tick === 0,
    );
    await page
      .locator(`#inspector [data-property-nav="${key}"][data-direction="1"]`)
      .click();
    await page.waitForTimeout(60);
    check(
      `${key}: next key navigation seeks frame ten`,
      (await state()).tick === 10,
    );
    before = await state();
    await drag(key, -10);
    after = await state();
    check(
      `${key}: keyed scrubbing changes one key in one undo`,
      after.keys.length === 2 &&
        after.undo === before.undo + 1 &&
        near(after.source, 0.7),
    );
    await diamond(key).click();
    await page.waitForTimeout(60);
    check(
      `${key}: diamond removes only the current key`,
      (await state()).keys.length === 1,
    );
    await page.evaluate(() => styk.editor.undo());
    await page.waitForTimeout(60);
    check(
      `${key}: removing a key is undoable`,
      (await state()).keys.length === 2,
    );
    await seek(5);
    before = await state();
    await page.evaluate(() => {
      const e = styk.editor;
      e.copyFigure();
      e.pasteFigure();
      e.select(e.selectedUid, 0);
      window.styleTest.pasted = e.selectedUid;
    });
    await page.waitForTimeout(80);
    const captured = Number(await field(key).inputValue());
    await type(key, 31);
    check(
      `${key}: pasted captured opacity remains editable without a scalar key`,
      await page.evaluate(() => {
        const e = styk.editor,
          t = styleTest,
          target = { ...t.target, uid: t.pasted };
        return (
          !e.animationChannel(target, t.property) &&
          Math.abs(e.animationValue(target, t.property) - 0.31) < 1e-8
        );
      }),
    );
    check(
      `${key}: captured edits preserve the animated source`,
      near((await state()).source, before.source),
    );
    await page.evaluate(() => styk.editor.undo());
    await page.waitForTimeout(60);
    check(
      `${key}: captured edit undo restores its displayed value`,
      near(Number(await field(key).inputValue()), captured),
    );
    await page.evaluate(() => styk.editor.redo());
    await page.waitForTimeout(60);
    check(
      `${key}: captured edit redo restores its displayed value`,
      near(Number(await field(key).inputValue()), 31),
    );
  }
  await page.evaluate(() => {
    const e = styk.editor;
    e.select(styleTest.uid, 0);
  });
  await page.waitForTimeout(60);
  const layerId = await page.evaluate(() =>
    styk.editor.layerForUid(styleTest.uid),
  );
  const layer = page.locator(
    `.styk-timeline-label[data-track-id="${layerId}"]`,
  );
  if ((await layer.getAttribute("aria-expanded")) !== "true")
    await layer.locator(".styk-timeline-label-disclosure").click();
  await page.waitForTimeout(60);
  await page.evaluate(() => {
    styk.timeline.scroll.scrollTop = 60;
  });
  await page.waitForTimeout(60);
  const uid = await page.evaluate(() => styleTest.uid),
    figureRow = page.locator(
      `.styk-timeline-label[data-track-id="figure:${uid}"]`,
    );
  if ((await figureRow.getAttribute("aria-expanded")) !== "true")
    await figureRow.locator(".styk-timeline-label-disclosure").click();
  await page.waitForTimeout(60);
  const segmentPosition = await page.evaluate(() =>
    styk.timeline.tracks.findIndex(
      (row) => row.id === `segment:${styleTest.uid}:11`,
    ),
  );
  await page.evaluate((position) => {
    styk.timeline.scroll.scrollTop = Math.max(0, position * 30 - 30);
  }, segmentPosition);
  await page.waitForTimeout(60);
  await page
    .locator(
      `.styk-timeline-label[data-track-id="segment:${uid}:11"] .styk-timeline-label-select`,
    )
    .click();
  await page.waitForTimeout(60);
  check(
    "Clicking a segment timeline row selects its stable handle in Design inspector",
    (await state()).selected === uid &&
      (await state()).joint === 0 &&
      (await field("segment_gradient_opacity").isVisible()),
  );
  for (const [width, height] of [
    [1560, 1000],
    [1280, 800],
    [1100, 740],
  ]) {
    await page.setViewportSize({ width, height });
    await page
      .locator('#inspector [data-action="mirror-branch-vertical"]')
      .scrollIntoViewIfNeeded();
    check(
      `${width}px inspector has no horizontal clipping`,
      await page
        .locator("#inspector")
        .evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
    );
    check(
      `${width}px key controls stay on one line`,
      await page
        .locator("#inspector .property-key-controls")
        .evaluateAll((rows) =>
          rows.every((row) => {
            const boxes = [...row.children].map((e) =>
              e.getBoundingClientRect(),
            );
            return boxes.every((b) => Math.abs(b.top - boxes[0].top) < 1);
          }),
        ),
    );
    check(
      `${width}px builder actions fit and retain useful targets`,
      await page
        .locator('#inspector [data-action="split-segment"]')
        .evaluate((e) => {
          const rows = [e.parentElement, e.parentElement.nextElementSibling];
          return rows.every((row) => {
            const box = row.getBoundingClientRect();
            return [...row.children].every((button) => {
              const b = button.getBoundingClientRect();
              return (
                b.width >= 26 &&
                b.left >= box.left - 1 &&
                b.right <= box.right + 1
              );
            });
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
