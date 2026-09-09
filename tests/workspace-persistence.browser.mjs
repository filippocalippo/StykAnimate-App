import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({
    viewport: { width: 1560, height: 1000 },
  }),
  page = await context.newPage();
const checks = [],
  errors = [];
context.on("page", (p) => p.on("pageerror", (e) => errors.push(e.message)));
page.on("pageerror", (e) => errors.push(e.message));
const check = (name, ok = true) => {
  assert.ok(ok, name);
  checks.push(name);
  console.log("PASS", name);
};
const firstURL = process.env.STYK_URL || "http://127.0.0.1:47831";
try {
  await page.goto(firstURL);
  await page.waitForFunction(() => window.styk?.ready);
  await page.evaluate(async () => {
    const { initWorkspaceLayout, WORKSPACE_STORAGE_KEY } = await import(
      "/src/workspace-layout.mjs"
    );
    document.querySelector(".workspace")._stykLayout.destroy();
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify({ left: 400 }));
    window.nativeSnapshots = [];
    window.nativeInFlight = 0;
    window.nativeMaxInFlight = 0;
    window.portableLayout = initWorkspaceLayout({
      preferences: { left: 278, right: 292, timeline: 250 },
      onPersist: async (snapshot) => {
        window.nativeInFlight++;
        window.nativeMaxInFlight = Math.max(
          window.nativeMaxInFlight,
          window.nativeInFlight,
        );
        await new Promise((resolve) => setTimeout(resolve, 40));
        window.nativeSnapshots.push(snapshot);
        window.nativeInFlight--;
      },
    });
  });
  check(
    "Native preferences override stale origin-local preferences",
    await page.evaluate(
      () =>
        portableLayout.sizes.left === 278 && portableLayout.sizes.right === 292,
    ),
  );
  await page.locator('[data-panel-toggle="left"]').click();
  await page.evaluate(async () => {
    await portableLayout.flushPreferences();
    nativeSnapshots.length = 0;
  });
  const grip = await page.locator('[data-panel-move="left"]').boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + 180, grip.y + 80, { steps: 12 });
  check(
    "Active pointer movement does not send native preference writes",
    await page.evaluate(() => nativeSnapshots.length === 0),
  );
  await page.mouse.up();
  await page.locator('[data-panel-move="left"]').focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await page.evaluate(() => portableLayout.flushPreferences());
  check(
    "Settled changes coalesce into one native snapshot",
    await page.evaluate(() => nativeSnapshots.length === 1),
  );
  const portable = await page.evaluate(() => portableLayout.preferences);
  check(
    "Portable snapshot includes dock widths and floating bounds",
    portable.left === 278 &&
      portable.right === 292 &&
      portable.timeline === 250 &&
      portable.floating.left.width >= 220,
  );
  const secondURL = new URL(firstURL);
  secondURL.hostname =
    secondURL.hostname === "localhost" ? "127.0.0.1" : "localhost";
  const second = await context.newPage();
  await second.goto(secondURL.href);
  await second.waitForFunction(() => window.styk?.ready);
  check(
    "Second browser origin has an independent empty preference store",
    await second.evaluate(async () => {
      const { WORKSPACE_STORAGE_KEY } = await import(
        "/src/workspace-layout.mjs"
      );
      return localStorage.getItem(WORKSPACE_STORAGE_KEY) === null;
    }),
  );
  await second.evaluate(async (preferences) => {
    const { initWorkspaceLayout } = await import("/src/workspace-layout.mjs");
    document.querySelector(".workspace")._stykLayout.destroy();
    window.restoredLayout = initWorkspaceLayout({
      preferences,
      onPersist: (snapshot) => {
        window.latestNativeSnapshot = snapshot;
      },
    });
  }, portable);
  check(
    "Portable preferences restore at a different browser origin",
    JSON.stringify(await second.evaluate(() => restoredLayout.preferences)) ===
      JSON.stringify(portable),
  );
  check(
    "Floating position and dimensions restore identically",
    JSON.stringify(
      await second.evaluate(() => restoredLayout.floating.left),
    ) ===
      JSON.stringify(await page.evaluate(() => portableLayout.floating.left)),
  );
  await second.locator('[data-panel-toggle="left"]').click();
  await second.evaluate(() => restoredLayout.flushPreferences());
  check(
    "Redocking updates shared native preference snapshot",
    await second.evaluate(
      () => !latestNativeSnapshot.floating && latestNativeSnapshot.left === 278,
    ),
  );
  // Delayed callbacks are serialized so a slower earlier write cannot overwrite a newer edit.
  await page.evaluate(async () => {
    portableLayout.dock("left");
    const first = portableLayout.flushPreferences();
    portableLayout.float("right");
    const second = portableLayout.flushPreferences();
    await Promise.all([first, second]);
  });
  check(
    "Asynchronous native writes are ordered",
    await page.evaluate(
      () =>
        nativeMaxInFlight === 1 &&
        nativeSnapshots.at(-1).floating.right &&
        !nativeSnapshots.at(-1).floating.left,
    ),
  );
  await second.evaluate(() => {
    restoredLayout.reset();
  });
  await second.waitForFunction(
    () =>
      window.latestNativeSnapshot &&
      Object.keys(latestNativeSnapshot).length === 0,
  );
  check("Reset clears portable native preferences through debounce", true);
  assert.deepEqual(errors, []);
  check("No browser errors");
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    "artifacts/workspace-persistence-verification.json",
    JSON.stringify(
      {
        checks,
        errors,
        origins: [new URL(firstURL).origin, secondURL.origin],
        portable,
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
