import { chromium } from "./support/playwright.mjs";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
  checks = [],
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const check = (name, condition = true) => {
  assert.ok(condition, name);
  checks.push(name);
  console.log("PASS", name);
};
const snapshot = () =>
  page.evaluate(() => ({
    values: window.props.values,
    history: window.props.history,
    events: window.props.events,
    active: window.props.controls.active,
    errors: window.props.errors,
  }));
const field = (key) => page.locator(`#property-test [data-property="${key}"]`);
const label = (key) =>
  page.locator(
    `#property-test [data-property-row="${key}"] [data-property-scrub]`,
  );
async function beginDrag(key) {
  const r = await label(key).boundingBox();
  const p = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  return p;
}
async function render(context, width = 264) {
  await page.evaluate(
    ({ context, width }) => window.props.render(context, width),
    { context, width },
  );
}
try {
  await page.route("**/src/app.mjs", (route) =>
    route.fulfill({ contentType: "text/javascript", body: "" }),
  );
  await page.goto(process.env.STYK_URL || "http://127.0.0.1:47831");
  await page.evaluate(async () => {
    await (await import("/tests/support/page-editor.mjs")).registerPageEngine();
    const [{ PropertyControls }, { inspectorView }, { pageEditor }] =
      await Promise.all([
        import("/src/property-controls.mjs"),
        import("/src/inspector-view.mjs"),
        import("/tests/support/page-editor.mjs"),
      ]);
    const host = document.createElement("aside");
    host.id = "property-test";
    host.style.cssText =
      "position:fixed;z-index:2000;right:24px;top:60px;bottom:24px;width:264px;background:#fff;border:1px solid #ddd;overflow:auto;box-shadow:0 8px 32px #0002;" +
      // #inspector's own inline padding (features/inspector.css): sections span its content box, titles and sub-module markup reach its edges.
      "box-sizing:border-box;padding:0 var(--island-pad)";
    document.body.append(host);
    const editor = pageEditor({ demo: true }),
      values = {
        camera_x: 10.123456,
        camera_y: 20,
        camera_scale: 100,
        camera_angle: 0,
      },
      history = [],
      events = [],
      errors = [];
    const controls = new PropertyControls(host, {
      getValue: (key) => values[key],
      canHandle: (key) => Object.hasOwn(values, key),
      begin: ({ key, initialValue }) => {
        events.push(["begin", key]);
        return initialValue;
      },
      preview: ({ key, value }) => {
        values[key] = value;
        events.push(["preview", key, value]);
      },
      commit: ({ key, value, token }) => {
        history.push({ key, before: token, after: value });
        events.push(["commit", key]);
      },
      cancel: ({ key, token }) => {
        values[key] = token;
        events.push(["cancel", key]);
      },
      onError: (e) => errors.push(e.message),
    });
    window.props = {
      editor,
      values,
      history,
      events,
      errors,
      controls,
      render(context, width) {
        controls.cancel();
        host.style.width = `${width}px`;
        host.innerHTML = inspectorView({
          editor,
          context,
          propertyState: (key) => ({ value: values[key] }),
        });
      },
    };
    props.render("camera", 264);
  });
  let p = await beginDrag("camera_x");
  await page.mouse.move(p.x + 20, p.y, { steps: 10 });
  await page.mouse.up();
  let s = await snapshot();
  check(
    "Continuous pointer preview commits once",
    s.history.length === 1 &&
      Math.abs(s.values.camera_x - 30.123) < 0.0001 &&
      s.events.filter((e) => e[0] === "preview").length > 3,
  );
  check(
    "The exact starting value is retained in the undo token",
    s.history[0].before === 10.123456,
  );
  p = await beginDrag("camera_x");
  await page.mouse.move(p.x + 10, p.y);
  await page.keyboard.down("Shift");
  await page.mouse.move(p.x + 20, p.y);
  await page.keyboard.up("Shift");
  await page.keyboard.down("Alt");
  await page.mouse.move(p.x + 30, p.y);
  await page.keyboard.up("Alt");
  await page.mouse.up();
  s = await snapshot();
  check(
    "Modifier switches are continuous: 10px + Shift 1px + Alt .1px",
    s.history.length === 2 && Math.abs(s.values.camera_x - 41.223) < 0.0001,
  );
  p = await beginDrag("camera_x");
  await page.mouse.move(p.x + 70, p.y);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  s = await snapshot();
  check(
    "Escape during captured drag restores its baseline without undo",
    s.history.length === 2 &&
      Math.abs(s.values.camera_x - 41.223) < 0.0001 &&
      !s.active,
  );
  check(
    "Cancelled scrub releases cursor and capture",
    await page.evaluate(
      () => !document.body.classList.contains("styk-property-scrubbing"),
    ),
  );
  await field("camera_x").fill("62.123456");
  await page.keyboard.press("Enter");
  s = await snapshot();
  check(
    "Typing retains full precision and creates one undo",
    s.history.length === 3 && s.values.camera_x === 62.123456,
  );
  await field("camera_x").fill("80");
  await page.keyboard.press("Escape");
  await field("camera_y").click();
  s = await snapshot();
  check(
    "Escape during typing survives blur without recommitting cancelled text",
    s.history.length === 3 && s.values.camera_x === 62.123456,
  );
  await field("camera_y").fill("28.125");
  await field("camera_x").click();
  s = await snapshot();
  check(
    "A blur commits one typed value",
    s.history.length === 4 && s.values.camera_y === 28.125,
  );
  await page.keyboard.down("ArrowUp");
  await page.keyboard.down("ArrowUp");
  await page.keyboard.down("ArrowUp");
  await page.keyboard.up("ArrowUp");
  s = await snapshot();
  check(
    "Repeated arrow presses form one keyboard gesture",
    s.history.length === 5 && Math.abs(s.values.camera_x - 65.123) < 0.0001,
  );
  p = await beginDrag("camera_x");
  await page.mouse.move(p.x + 5, p.y);
  await page.mouse.up();
  s = await snapshot();
  check(
    "Scrubbing an already focused field uses pointer mode",
    s.history.length === 6 && Math.abs(s.values.camera_x - 70.123) < 0.0001,
  );
  await field("camera_scale").fill("-1");
  await page.keyboard.press("Enter");
  s = await snapshot();
  check(
    "Out-of-range values cancel without a history entry",
    s.history.length === 6 && s.values.camera_scale === 100,
  );
  s = await snapshot();
  check(
    "Layer-sheet property rows render no per-property key controls",
    (await page
      .locator("#property-test [data-property-key], #property-test [data-property-nav]")
      .count()) === 0,
  );
  await mkdir("artifacts/property-controls", { recursive: true });
  await page.setViewportSize({ width: 900, height: 760 });
  await page.evaluate(() => (props.editor.selectedJoint = 0));
  for (const context of ["camera", "scene", "frame", "figure", "layer"]) {
    await render(context, 209);
    check(
      `${context} inspector fits a compact 209px panel`,
      await page
        .locator("#property-test")
        .evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
    );
    check(
      `${context} numeric fields remain usable`,
      await page
        .locator("#property-test input[type=number]")
        // The field is the target (its label focuses the value, which sizes to its text and its unit).
        .evaluateAll((inputs) =>
          inputs.every((e) => (e.closest(".ui-field, .ui-stepper") ?? e).getBoundingClientRect().width >= 23),
        ),
    );
    await page
      .locator("#property-test")
      .screenshot({ path: `artifacts/property-controls/${context}.png` });
  }
  // The value field (inspector-kit `range`, `default`, `angle`; docs/design/components.md): one control for every
  // bounded number of the effects panel, on the same PropertyControls as the fields above.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(async () => {
    const { renderRow } = await import("/src/inspector-kit.mjs");
    const { PropertyControls } = await import("/src/property-controls.mjs");
    const host = document.createElement("div");
    host.id = "value-test";
    host.style.cssText = "position:fixed;z-index:2001;left:40px;top:60px;width:240px;display:grid;gap:6px;padding:12px;background:var(--surface)";
    document.body.append(host);
    const values = { count: 40, radius: 12, direction: -90 }, history = [], events = [];
    host.innerHTML = [
      renderRow({ kind: "number", key: "count", label: "Count", value: 40, min: 1, max: 5000, step: 1, precision: 0, range: true, scale: "log", knee: 1, default: 40 }),
      renderRow({ kind: "number", key: "radius", label: "Radius", value: 12, min: 0, max: 128, step: 1, precision: 2, unit: "px", range: true, default: 12 }),
      renderRow({ kind: "number", key: "direction", label: "Direction", value: -90, min: -180, max: 180, step: 1, precision: 0, unit: "°", angle: true, default: -90 }),
    ].join("");
    const controls = new PropertyControls(host, {
      getValue: (key) => values[key],
      canHandle: (key) => Object.hasOwn(values, key),
      begin: ({ initialValue }) => initialValue,
      preview: ({ key, value }) => { values[key] = value; events.push(["preview", key, value]); },
      commit: ({ key, value, token }) => { history.push({ key, before: token, after: value }); },
      cancel: ({ key, token }) => { values[key] = token; },
    });
    window.valueTest = { values, history, events, controls };
  });
  const vt = () => page.evaluate(() => ({ values: { ...valueTest.values }, history: valueTest.history.length, events: valueTest.events.length, active: valueTest.controls.active }));
  const box = async (key, part = "") => (await page.locator(`#value-test [data-property-row="${key}"]${part}`).boundingBox());
  const fill = (key) => page.locator(`#value-test [data-property-row="${key}"]`).evaluate((row) => parseFloat(row.style.getPropertyValue("--_p")));
  const drag = async (key, dx, { at = 0.45, keys = [], cancel = false } = {}) => {
    const r = await box(key);
    const x = r.x + r.width * at, y = r.y + r.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (const k of keys) await page.keyboard.down(k);
    await page.mouse.move(x + dx, y, { steps: 12 });
    if (cancel) await page.keyboard.press("Escape");
    for (const k of keys) await page.keyboard.up(k);
    await page.mouse.up();
  };
  const { positionToValue, valueToPosition } = await import("../src/ui/value-scale.mjs");
  const countRange = { scale: "log", min: 1, max: 5000, knee: 1 };
  let v = await vt();
  const fieldWidth = (await box("count")).width;
  check("A value field draws where its value sits along a log travel", Math.abs((await fill("count")) - valueToPosition(40, countRange) * 100) < 0.1);
  await drag("count", 3);
  v = await vt();
  // Three pixels from where the value is: the value moves by three pixels' worth of its travel, never to where the pointer is.
  const small = positionToValue(valueToPosition(40, countRange) + 3 / fieldWidth, countRange);
  check("A small drag from anywhere on the field moves the value a little, with no jump", v.history === 1 && v.values.count > 40 && Math.abs(v.values.count - small) <= 1.5);
  await drag("count", 60);
  v = await vt();
  const expected = positionToValue(valueToPosition(v.values.count, countRange), countRange);
  check("Dragging moves along the field's own scale and lands on whole steps", Number.isInteger(v.values.count) && Math.abs(expected - v.values.count) < 1 && v.values.count > 100);
  check("The fill follows the value", Math.abs((await fill("count")) - valueToPosition(v.values.count, countRange) * 100) < 0.6);
  let before = v.values.radius;
  await drag("radius", 50, { keys: ["Shift"] });
  v = await vt();
  const fine = v.values.radius - before;
  check("Shift scrubs ten times finer", fine > 0 && Math.abs(fine - (50 / fieldWidth) * 128 * 0.1) < 0.6);
  before = v.values.radius;
  await drag("radius", 20, { keys: ["Control"] });
  v = await vt();
  check("Ctrl scrubs coarsely", v.values.radius - before > (20 / fieldWidth) * 128 * 3);
  const history = v.history;
  await drag("radius", 40, { cancel: true });
  v = await vt();
  check("Escape during a drag puts the value back without an edit", v.history === history && !v.active);
  const r = await box("radius");
  await page.mouse.click(r.x + r.width * 0.3, r.y + r.height / 2);
  check("A tap types the value", await page.evaluate(() => document.activeElement?.dataset.property === "radius" && document.activeElement.matches("input")));
  await page.mouse.click(r.x + r.width * 0.3, r.y + r.height / 2);
  v = await vt();
  check("A second tap resets the value to its default, as one edit", v.values.radius === 12 && v.history === history + 1);
  check("The default sits under its tick", Math.abs((await fill("radius")) - (12 / 128) * 100) < 0.1);
  await page.keyboard.type("36");
  await page.keyboard.press("Enter");
  v = await vt();
  check("A typed value commits once", v.values.radius === 36 && v.history === history + 2);
  await page.locator('#value-test [data-property="radius"]').focus();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("PageUp");
  v = await vt();
  check("Arrow keys step and Page Up moves a tenth of the travel", v.values.radius > 37 && v.values.radius >= 37 + 128 * 0.1 - 1);
  check("A screen reader hears the value with its unit", /^\d+(\.\d+)? px$/.test(await page.locator('#value-test [data-property="radius"]').getAttribute("aria-valuetext")));
  check("The focused field shows the focus ring", await page.locator('#value-test [data-property-row="radius"]').evaluate((row) => getComputedStyle(row).boxShadow !== "none"));
  check("Only the value is a tab stop: the label scrubs and holds focus while dragged", await page.locator('#value-test [data-property-row="radius"] [data-property-scrub]').getAttribute("tabindex") === "-1");
  const dial = await box("direction", " [data-property-dial]");
  await page.mouse.move(dial.x + dial.width / 2, dial.y + dial.height / 2);
  await page.mouse.down();
  await page.mouse.move(dial.x + dial.width / 2 + 40, dial.y + dial.height / 2, { steps: 4 });
  await page.mouse.up();
  v = await vt();
  check("An angle's dial turns to the pointer", Math.abs(v.values.direction) < 2);
  check("The dial shows the new angle", Math.abs(parseFloat(await page.locator('#value-test [data-property-dial]').evaluate((d) => d.style.getPropertyValue("--_a")))) < 2);
  await page.locator("#value-test").screenshot({ path: "artifacts/property-controls/value-fields.png" });
  await page.evaluate(() => { valueTest.controls.destroy(); document.getElementById("value-test").remove(); });

  await render("camera", 264);
  p = await beginDrag("camera_x");
  await page.mouse.move(p.x + 30, p.y);
  await page.evaluate(() => props.controls.destroy());
  s = await snapshot();
  check(
    "Destroy cancels an unfinished transaction",
    s.history.length === 6 &&
      Math.abs(s.values.camera_x - 70.123) < 0.0001 &&
      !s.active,
  );
  check(
    "No controller or page errors",
    s.errors.length === 0 && errors.length === 0,
  );
  await writeFile(
    "artifacts/property-controls/report.json",
    JSON.stringify({ checks, errors, snapshot: s }, null, 2),
  );
} finally {
  await browser.close();
}
