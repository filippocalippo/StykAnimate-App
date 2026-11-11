import test from 'node:test';
import assert from 'node:assert/strict';
import {chromiumArguments, editorFirst, EDITOR_FIRST, electronArguments, electronEnvironment, isMissingBrowser, launchChromium, LINUX_WEBGPU_ARGS} from './support/playwright.mjs';

const missing = channel => Object.assign(new Error(`browserType.launch: Chromium distribution '${channel}' is not found at /opt/google/chrome/chrome`));
function fakeType(behaviour) {
  const calls = [];
  return {calls, launch: async options => { calls.push(options); return behaviour(options, calls.length); }};
}

test('Linux Chromium keeps its own defaults unless the GPU switches are requested', () => {
  assert.deepEqual(chromiumArguments(['--x'], {platform: 'linux', env: {}}), ['--x'], 'a bare WebGPU clear does not present on every Linux driver, so it is opt-in');
  assert.deepEqual(chromiumArguments([], {platform: 'linux', env: {STYK_BROWSER_GPU: '1'}}), LINUX_WEBGPU_ARGS);
  for (const platform of ['win32', 'darwin']) assert.deepEqual(chromiumArguments(['--x'], {platform, env: {STYK_BROWSER_GPU: '1'}}), ['--x']);
});

test('caller features are merged and caller switches are never duplicated', () => {
  const merged = chromiumArguments(['--enable-features=PointerLockOptions', '--enable-unsafe-webgpu'], {platform: 'linux', env: {STYK_BROWSER_GPU: '1'}});
  assert.equal(merged.filter(a => a.startsWith('--enable-features=')).length, 1);
  assert.ok(merged.includes('--enable-features=PointerLockOptions,Vulkan'));
  assert.equal(merged.filter(a => a === '--enable-unsafe-webgpu').length, 1);
});

test('installed Chrome is used unchanged', async () => {
  const type = fakeType(() => 'browser');
  assert.equal(await launchChromium({channel: 'chrome', headless: true}, {browserType: type, platform: 'win32', env: {}}), 'browser');
  assert.deepEqual(type.calls, [{channel: 'chrome', headless: true, args: ['--disable-gpu-process-crash-limit']}]);
});

test('a missing Chrome falls back to the browser Playwright installs', async () => {
  const type = fakeType(options => { if (options.channel === 'chrome') throw missing('chrome'); return 'bundled'; });
  assert.equal(await launchChromium({channel: 'chrome', headless: true}, {browserType: type, platform: 'linux', env: {STYK_BROWSER_GPU: '1'}}), 'bundled');
  assert.equal(type.calls.length, 2);
  assert.equal(type.calls[1].channel, 'chromium');
  assert.ok(type.calls[1].args.includes('--enable-unsafe-webgpu'), 'the fallback browser keeps the requested GPU switches');
});

test('other launch failures are not masked by the fallback', async () => {
  const type = fakeType(() => { throw new Error('browserType.launch: Target page, context or browser has been closed'); });
  await assert.rejects(launchChromium({channel: 'chrome'}, {browserType: type, platform: 'linux', env: {}}), /has been closed/);
  assert.equal(type.calls.length, 1);
});

test('a machine with no browser at all gets an actionable message', async () => {
  const type = fakeType(() => { throw missing('chromium'); });
  await assert.rejects(launchChromium({channel: 'chrome'}, {browserType: type, platform: 'linux', env: {}}), /npx playwright install chromium/);
});

test('environment overrides pick the executable or channel', async () => {
  const path = fakeType(() => 'ok');
  await launchChromium({channel: 'chrome'}, {browserType: path, platform: 'win32', env: {STYK_BROWSER_PATH: '/opt/chromium/chrome'}, exists: () => true});
  assert.equal(path.calls[0].executablePath, '/opt/chromium/chrome');
  assert.equal('channel' in path.calls[0], false);
  const channel = fakeType(() => 'ok');
  await launchChromium({channel: 'chrome'}, {browserType: channel, platform: 'win32', env: {STYK_BROWSER_CHANNEL: 'chrome-beta'}});
  assert.equal(channel.calls[0].channel, 'chrome-beta');
});

test('a hard-coded executable that does not exist is dropped instead of failing', async () => {
  const type = fakeType(() => 'ok');
  await launchChromium({executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true}, {browserType: type, platform: 'linux', env: {}, exists: () => false});
  assert.equal('executablePath' in type.calls[0], false);
});

test('missing-browser detection matches Playwright messages only', () => {
  assert.equal(isMissingBrowser(missing('chrome')), true);
  assert.equal(isMissingBrowser(new Error("browserType.launch: Executable doesn't exist at /x")), true);
  assert.equal(isMissingBrowser(new Error('Timeout 30000ms exceeded')), false);
});

test('Electron never inherits ELECTRON_RUN_AS_NODE, and starts in the editor unless asked for Home', () => {
  const clean = electronEnvironment({ELECTRON_RUN_AS_NODE: '1', PATH: '/bin', STYK_USER_DATA_DIR: '/p'});
  assert.deepEqual(clean, {STYK_STARTUP_VIEW: 'editor', PATH: '/bin', STYK_USER_DATA_DIR: '/p'});
  assert.equal(electronEnvironment({STYK_STARTUP_VIEW: 'home'}).STYK_STARTUP_VIEW, 'home');
});

test('browser pages start in the editor; a test that defines the view first keeps it', async () => {
  const scripts = [];
  const browser = {newContext: async () => ({addInitScript: async script => scripts.push(script)})};
  editorFirst(browser);
  await browser.newContext();
  assert.deepEqual(scripts, [EDITOR_FIRST]);
  const page = {stykStartupView: 'home'};
  new Function('globalThis', EDITOR_FIRST)(page);
  assert.equal(page.stykStartupView, 'home');
  const fresh = {};
  new Function('globalThis', EDITOR_FIRST)(fresh);
  assert.equal(fresh.stykStartupView, 'editor');
});

test('Electron attaches directly to the X11 window on a Wayland desktop', () => {
  const env = {XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0'};
  assert.deepEqual(electronArguments(['.'], {platform: 'linux', env}), ['--ozone-platform=x11', '.']);
  assert.deepEqual(electronArguments(['--ozone-platform=wayland', '.'], {platform: 'linux', env}), ['--ozone-platform=wayland', '.']);
  for (const options of [{platform: 'win32', env}, {platform: 'linux', env: {}}, {platform: 'linux', env: {...env, STYK_WAYLAND: '1'}}, {platform: 'linux', env: {...env, STYK_GPU_UNSAFE: '0'}}]) {
    assert.deepEqual(electronArguments(['.'], options), ['.']);
  }
});
