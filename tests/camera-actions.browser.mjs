import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
const browser = await chromium.launch({ channel: "chrome", headless: true }),
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
  checks = [],
  errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const check = (name, condition) => {
  assert.ok(condition, name);
  checks.push(name);
  console.log("PASS", name);
};
const camera = () => page.evaluate(() => ({ ...styk.editor.frame.camera }));
const click = async (action) => {
  await page.locator(`#inspector [data-action="${action}"]`).click();
  await page.waitForTimeout(50);
};
try {
  await page.goto(process.env.STYK_URL || "http://127.0.0.1:47831");
  await page.waitForFunction(() => styk?.ready);
  await page.evaluate(() => {
    const e = styk.editor;
    e.newDocument();
    e.addFrame();
    e.addFrame();
    e.selectFrame(1);
    e.setCameraValues({ x: 10, y: 20, scale: 1.2, angle_rad: 0.1 }, [0]);
    e.setCameraValues({ x: 30, y: 40, scale: 1.1, angle_rad: 0.3 }, [2]);
    e.setCameraValues({ x: 5, y: 6 }, [1]);
    e.select(e.frame.objects[0].unique_id);
  });
  await page
    .locator('.styk-tree-row[data-kind="camera"] .styk-tree-name')
    .click();
  check(
    "Camera selection retains figure targets and enables centering",
    (await page.evaluate(() => styk.editor.selectedUids.size === 1)) &&
      (await page
        .locator('#inspector [data-action="camera-center"]')
        .isEnabled()),
  );
  await click("camera-copy");
  check(
    "Copy enables the paste action",
    await page.locator('#inspector [data-action="camera-paste"]').isEnabled(),
  );
  await page.locator('#inspector [data-property="camera_x"]').fill("25");
  await page.locator('#inspector [data-property="camera_x"]').press("Enter");
  await click("camera-paste");
  check(
    "Paste restores the copied camera pose",
    (await camera()).x === 5 && (await camera()).y === 6,
  );
  await click("camera-reset");
  check(
    "Reset restores the identity camera",
    (await camera()).x === 0 &&
      (await camera()).y === 0 &&
      (await camera()).scale === 1,
  );
  await page.evaluate(() => styk.editor.setCameraValues({ x: 123, y: 456 }));
  await page.waitForTimeout(50);
  await click("camera-center-x");
  check(
    "Horizontal center changes only X",
    (await camera()).x !== 123 && (await camera()).y === 456,
  );
  const cx = (await camera()).x;
  await click("camera-center-y");
  check(
    "Vertical center changes only Y",
    (await camera()).x === cx && (await camera()).y !== 456,
  );
  await page.evaluate(() => styk.editor.setCameraValues({ x: 123, y: 456 }));
  await page.waitForTimeout(50);
  await click("camera-center");
  check(
    "Center both axes uses the retained figure selection",
    (await camera()).x !== 123 && (await camera()).y !== 456,
  );
  await click("camera-locate-previous");
  check(
    "Previous camera pose copies the previous native frame",
    (await camera()).x === 10 &&
      (await camera()).y === 20 &&
      (await camera()).scale === 1.2,
  );
  await click("camera-locate-next");
  check(
    "Next camera pose copies the next native frame",
    (await camera()).x === 30 &&
      (await camera()).y === 40 &&
      (await camera()).scale === 1.1,
  );
  await click("camera-align-view");
  check(
    "Align camera to viewport produces a valid finite view",
    Object.values(await camera())
      .filter((value) => typeof value === "number")
      .every(Number.isFinite),
  );
  await page.evaluate(() =>
    styk.editor.setCameraValues({ x: 10, y: 15, scale: 1.25, angle_rad: 0.1 }),
  );
  await page.waitForTimeout(50);
  const before = await page.evaluate(() => ({
    undo: styk.editor._undo.length,
    x: styk.editor.object.root_x,
  }));
  await click("camera-apply-figures");
  check(
    "Apply to figures bakes camera and creates one undo",
    await page.evaluate(
      ({ undo, x }) =>
        styk.editor._undo.length === undo + 1 &&
        styk.editor.frame.camera.is_default &&
        styk.editor.object.root_x !== x,
      before,
    ),
  );
  await page.evaluate(() => styk.editor.undo());
  check(
    "Undo restores the baked camera",
    (await camera()).x === 10 && (await camera()).scale === 1.25,
  );
  check("No camera action page errors", errors.length === 0);
  await mkdir("artifacts/camera-actions", { recursive: true });
  await page.screenshot({ path: "artifacts/camera-actions/inspector.png" });
  await writeFile(
    "artifacts/camera-actions/report.json",
    JSON.stringify({ checks, errors }, null, 2),
  );
} finally {
  await browser.close();
}
