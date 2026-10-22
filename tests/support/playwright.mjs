// The one place browser and Electron launch policy lives.
//
// Test and profiling scripts import `chromium` and `_electron` from here instead
// of from 'playwright', and keep calling `chromium.launch({channel: 'chrome',
// headless: true})` exactly as before. This module makes that call work on every
// machine the project is developed on:
//
//  - Google Chrome is used when it is installed (the Windows developer and CI
//    setup, unchanged). When it is not (a typical Linux machine, a clean CI
//    image) the browser Playwright downloads is used instead.
//  - On Linux, Chromium has no hardware WebGPU by default, so the editor uses its
//    Canvas 2D renderer, whose output tests can read back reliably. Set
//    STYK_BROWSER_GPU=1 to add Vulkan and the WebGPU opt-in (the switches the
//    desktop app applies, desktop/gpu-switches.cjs). Whether that paints depends
//    on the browser build and driver: on NVIDIA with Chromium 153 a bare WebGPU
//    clear presents nothing, so it is opt-in, never the default.
//  - Electron launches never inherit ELECTRON_RUN_AS_NODE. Terminals started by
//    another Electron app (VS Code, several agent hosts) export it, and Electron
//    then runs main.cjs as plain Node where `app` is undefined.
//
//  - A page starts in the editor, not on Home (src/home/home.mjs): tests and
//    profiling scripts drive the editor. Every browser context gets
//    `window.stykStartupView = 'editor'` and Electron STYK_STARTUP_VIEW=editor; a
//    test of Home at startup defines the value itself ('home') before the page loads.
//
// Overrides: STYK_BROWSER_PATH (executable), STYK_BROWSER_CHANNEL (for example
// "chromium" or "chrome-beta"), STYK_BROWSER_GPU=1 (add the Linux GPU switches).
import { existsSync } from 'node:fs';
import * as playwright from 'playwright';
import { gpuSwitches } from '../../desktop/gpu-switches.cjs';

export * from 'playwright';

export const LINUX_WEBGPU_ARGS = ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan'];

/** Adds the Linux GPU switches, merging any --enable-features the caller passed. */
export function chromiumArguments(args = [], { platform = process.platform, env = process.env } = {}) {
  if (platform !== 'linux' || env.STYK_BROWSER_GPU !== '1') return [...args];
  const merged = [...args];
  for (const arg of LINUX_WEBGPU_ARGS) {
    const [name, value] = arg.split('=');
    if (name !== '--enable-features') { if (!merged.includes(arg)) merged.push(arg); continue; }
    const index = merged.findIndex((item) => item.startsWith('--enable-features='));
    if (index < 0) { merged.push(arg); continue; }
    const features = new Set(merged[index].slice('--enable-features='.length).split(',').filter(Boolean));
    for (const feature of value.split(',')) features.add(feature);
    merged[index] = `--enable-features=${[...features].join(',')}`;
  }
  return merged;
}

export function isMissingBrowser(error) {
  return /distribution '.+' is not found|Executable doesn't exist|browserType\.launch: .*(not found|ENOENT)/i.test(String(error?.message ?? error));
}

export function electronEnvironment(env = process.env) {
  const { ELECTRON_RUN_AS_NODE: _ignored, ...clean } = env;
  return { STYK_STARTUP_VIEW: 'editor', ...clean };
}

/** Runs before the page's scripts; a value the test defined first stays. */
export const EDITOR_FIRST = `globalThis.stykStartupView ??= 'editor';`;

/** Every context of `browser` starts its pages in the editor (browser.newPage() makes its context through newContext). */
export function editorFirst(browser) {
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => {
    const context = await newContext(...args);
    await context.addInitScript(EDITOR_FIRST);
    return context;
  };
  return browser;
}

// What's new closes with its footer button: in a window under about 830 px tall, a recovery notice
// shown at the same time covers the close button in its corner.
const PROMPT_CLOSERS = { 'release-notes': '.release-splash[open] .splash-footer button', 'privacy-first-run': '.styk-privacy[open] [data-decline]' };
/**
 * Closes the desktop app's startup prompts as they open: What's new (once per process) and, on a
 * profile without a privacy choice, that choice. They open one at a time after the first frame
 * (src/ui/overlay-manager.mjs), so closing them at a fixed moment races them. Resolves once none is
 * open or waiting. The privacy prompt is queued only once that choice has loaded, possibly after this
 * returns, so scripts that need a quiet editor record the choice in their profile first.
 */
export async function closeStartupPrompts(page, { timeout = 30000 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const active = await page.waitForFunction(() => {
      const overlays = window.styk?.ui?.overlays;
      return overlays && (overlays.activePrompt ?? (overlays.pendingPrompts().length ? false : 'none'));
    }, undefined, { timeout: Math.max(1, deadline - Date.now()) }).then(handle => handle.jsonValue());
    if (active === 'none') return;
    if (!PROMPT_CLOSERS[active]) throw new Error(`Unexpected startup prompt: ${active}`);
    await page.locator(PROMPT_CLOSERS[active]).click({ timeout: Math.max(1, deadline - Date.now()) });
    await page.waitForFunction(id => window.styk.ui.overlays.activePrompt !== id, active, { timeout: Math.max(1, deadline - Date.now()) });
  }
}

// Attach Playwright to the process that owns the window. The app normally
// relaunches from Wayland into X11; attaching to that supervisor cannot find it.
export function electronArguments(args = [], {platform = process.platform, env = process.env} = {}) {
  const ozone = gpuSwitches({platform, env}).ozone;
  const end = args.indexOf('--');
  const flags = end < 0 ? args : args.slice(0, end);
  if (!ozone || flags.some(arg => arg === '--ozone-platform' || arg.startsWith('--ozone-platform='))) return [...args];
  return [`--ozone-platform=${ozone}`, ...args];
}

/**
 * Launch with the requested browser; if that browser is not installed, retry
 * with the one Playwright downloads. `browserType` is injectable for tests.
 */
export async function launchChromium(options = {}, { browserType = playwright.chromium, platform = process.platform, env = process.env, exists = existsSync } = {}) {
  const requested = { ...options, args: chromiumArguments(options.args, { platform, env }) };
  if (env.STYK_BROWSER_PATH) { requested.executablePath = env.STYK_BROWSER_PATH; delete requested.channel; }
  else if (env.STYK_BROWSER_CHANNEL) { requested.channel = env.STYK_BROWSER_CHANNEL; delete requested.executablePath; }
  if (requested.executablePath && !exists(requested.executablePath)) delete requested.executablePath;
  try {
    return await browserType.launch(requested);
  } catch (error) {
    const channelled = requested.channel || options.executablePath || options.channel;
    if (!isMissingBrowser(error) || !channelled || requested.channel === 'chromium') throw error;
    const { channel: _channel, executablePath: _path, ...rest } = requested;
    try {
      // "chromium" is the full browser Playwright installs, which supports
      // WebGPU headlessly; the default headless shell does not.
      return await browserType.launch({ ...rest, channel: 'chromium' });
    } catch (fallbackError) {
      if (isMissingBrowser(fallbackError)) fallbackError.message += '\nInstall a browser for the tests: npx playwright install chromium';
      throw fallbackError;
    }
  }
}

export const chromium = new Proxy(playwright.chromium, {
  get(target, property) {
    if (property === 'launch') return async (options) => editorFirst(await launchChromium(options));
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

export const _electron = new Proxy(playwright._electron, {
  get(target, property) {
    if (property === 'launch') return (options = {}) => target.launch({ ...options,
      args: electronArguments(options.args, {env: options.env ?? process.env}), env: electronEnvironment(options.env ?? process.env) });
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
