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
    const { EditorSettings, DEFAULT_EDITOR_SETTINGS } = await import(
      "/src/settings.mjs"
    );
    window.settingsDefaults = DEFAULT_EDITOR_SETTINGS;
    window.preferencesPatches = [];
    window.preferencesSaves = [];
    window.preferences = new EditorSettings({
      onChange: (p, n) => window.preferencesPatches.push({ p, n }),
      onPersist: (n) => window.preferencesSaves.push(n),
      onResetWorkspace: () => {
        window.workspaceReset = true;
      },
    });
    window.preferences.dialog.id = "test-settings";
    window.preferences.open();
  });
  await p.screenshot({ path: "artifacts/settings-interface.png" });
  check(
    "Native default handle sizing, outlines and onion count are preserved",
    await p.evaluate(
      () =>
        settingsDefaults.autoSizeHandles === true &&
        settingsDefaults.outlineHandles === true &&
        settingsDefaults.onionCount === 0,
    ),
  );
  await p
    .locator("#test-settings [data-setting=timelineMode][value=simple]")
    .check();
  check(
    "Timeline mode emits working preference patch",
    await p.evaluate(
      () => window.preferencesPatches.at(-1).n.timelineMode === "simple",
    ),
  );
  await p.locator("#test-settings [data-tab=canvas]").click();
  await p
    .locator("#test-settings [data-setting=showUnselectedHandles]")
    .uncheck();
  await p.locator("#test-settings [data-setting=handleSize]").fill("8");
  await p
    .locator("#test-settings [data-setting=handleSize]")
    .dispatchEvent("change");
  await p.screenshot({ path: "artifacts/settings-canvas.png" });
  check(
    "Node preview uses exact native colors and black outlines",
    await p
      .locator("#test-settings .styk-settings-node")
      .evaluateAll((nodes) => {
        const colors = nodes.map(
          (node) => getComputedStyle(node).backgroundColor,
        );
        return (
          colors.join("|") ===
            "rgb(255, 0, 0)|rgb(255, 136, 0)|rgb(0, 0, 255)|rgb(255, 255, 255)|rgb(128, 128, 128)" &&
          nodes.every(
            (node) => getComputedStyle(node).borderColor === "rgb(0, 0, 0)",
          )
        );
      }),
  );
  check(
    "Handle display and size settings emit values",
    await p.evaluate(
      () =>
        window.preferences.value.showUnselectedHandles === false &&
        window.preferences.value.handleSize === 8,
    ),
  );
  await p.locator("#test-settings [data-setting=autoSizeHandles]").uncheck();
  await p.locator("#test-settings [data-setting=outlineHandles]").uncheck();
  check(
    "Handle sizing and outline controls emit boolean settings",
    await p.evaluate(
      () =>
        preferences.value.autoSizeHandles === false &&
        preferences.value.outlineHandles === false &&
        preferencesPatches.at(-1).p.outlineHandles === false,
    ),
  );
  check(
    "Outline setting updates the native node preview",
    await p
      .locator("#test-settings .styk-settings-node")
      .evaluateAll((nodes) =>
        nodes.every((node) => getComputedStyle(node).borderWidth === "0px"),
      ),
  );
  await p.locator("#test-settings [data-setting=outlineHandles]").check();
  await p.locator("#test-settings [data-tab=animation]").click();
  await p.locator("#test-settings [data-setting=onionCount]").fill("9");
  await p.locator("#test-settings [data-setting=onionCount]").press("Tab");
  await p.locator("#test-settings [data-setting=onionOpacity]").fill("27");
  await p.locator("#test-settings [data-setting=onionOpacity]").press("Tab");
  await p
    .locator("#test-settings [data-setting=autosaveSeconds]")
    .selectOption("30");
  await p.screenshot({ path: "artifacts/settings-animation.png" });
  check(
    "Onion opacity converts percent to fraction",
    await p.evaluate(
      () =>
        window.preferences.value.onionCount === 9 &&
        window.preferences.value.onionOpacity === 0.27,
    ),
  );
  check(
    "Autosave interval is numeric",
    await p.evaluate(() => window.preferences.value.autosaveSeconds === 30),
  );
  await p.locator("#test-settings [data-tab=shortcuts]").click();
  await p.screenshot({ path: "artifacts/settings-shortcuts.png" });
  check(
    "Shortcuts show actual existing bindings",
    (await p.locator("#test-settings .styk-settings-shortcuts").count()) === 3,
  );
  await p.getByRole("button", { name: "Close settings", exact: true }).click();
  await p.evaluate(() => window.preferences.flush());
  check(
    "Latest complete preferences persisted on close",
    await p.evaluate(
      () =>
        window.preferencesSaves.at(-1).timelineMode === "simple" &&
        window.preferencesSaves.at(-1).autosaveSeconds === 30,
    ),
  );
  await p.evaluate(() => window.preferences.open("canvas"));
  await p.keyboard.press("Escape");
  check(
    "Escape closes the independent settings modal",
    await p.locator("#test-settings").evaluate((e) => !e.open),
  );
  const retry = await p.evaluate(async () => {
    let attempts = 0;
    window.preferences.onPersist = async (value) => {
      if (++attempts === 1)
        throw new Error("Temporary preferences write failure");
      window.retrySaved = value;
    };
    window.preferences.commit({ onionCount: 4 });
    const first = await window.preferences.flush(),
      second = await window.preferences.flush();
    return { first, second, attempts, saved: window.retrySaved.onionCount };
  });
  check(
    "Failed preference writes retain the latest state for retry",
    retry.first === false &&
      retry.second === true &&
      retry.attempts === 2 &&
      retry.saved === 4,
  );
  check("No browser errors", errors.length === 0);
  await writeFile(
    "artifacts/settings-verification.json",
    JSON.stringify(
      {
        checks,
        errors,
        settings: await p.evaluate(() => window.preferences.value),
      },
      null,
      2,
    ),
  );
} finally {
  await b.close();
}
