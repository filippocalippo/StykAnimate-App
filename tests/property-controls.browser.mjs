import { chromium } from "playwright";
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
    const [{ PropertyControls }, { inspectorView }, { Editor }] =
      await Promise.all([
        import("/src/property-controls.mjs"),
        import("/src/inspector-view.mjs"),
        import("/src/editor.mjs"),
      ]);
    const host = document.createElement("aside");
    host.id = "property-test";
    host.style.cssText =
      "position:fixed;z-index:2000;right:24px;top:60px;bottom:24px;width:264px;background:#fff;border:1px solid #ddd;overflow:auto;box-shadow:0 8px 32px #0002";
    document.body.append(host);
    const editor = new Editor(),
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
      keyframe: ({ key }) => events.push(["key", key]),
      navigate: ({ key, direction }) =>
        events.push(["navigate", key, direction]),
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
          propertyState: (key) => ({
            value: values[key],
            keyed: key === "camera_y",
            animated: true,
            previous: { tick: 0 },
            next: { tick: 20 },
          }),
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
  await page.locator('#property-test [data-property-key="camera_x"]').click();
  await page
    .locator(
      '#property-test [data-property-nav="camera_x"][data-direction="-1"]',
    )
    .click();
  await page
    .locator(
      '#property-test [data-property-nav="camera_x"][data-direction="1"]',
    )
    .click();
  s = await snapshot();
  check(
    "Diamond and previous/next controls route exact property callbacks",
    s.events.some((e) => e[0] === "key" && e[1] === "camera_x") &&
      s.events.filter((e) => e[0] === "navigate" && e[1] === "camera_x")
        .length === 2,
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
        .evaluateAll((inputs) =>
          inputs.every((e) => e.getBoundingClientRect().width >= 23),
        ),
    );
    await page
      .locator("#property-test")
      .screenshot({ path: `artifacts/property-controls/${context}.png` });
  }
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
