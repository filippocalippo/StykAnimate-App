import test from 'node:test';
import assert from 'node:assert/strict';
import gpu from '../desktop/gpu-switches.cjs';

const {gpuSwitches, applyGpuSwitches} = gpu;

function commandLine(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    hasSwitch: name => values.has(name),
    getSwitchValue: name => values.get(name) ?? '',
    appendSwitch: (name, value = '') => { values.set(name, value); },
  };
}

test('Linux opts in to WebGPU through Vulkan without any environment variable', () => {
  assert.deepEqual(gpuSwitches({platform: 'linux', env: {}}), {switches: ['enable-unsafe-webgpu'], features: ['Vulkan'], ozone: null});
});

test('Windows and macOS keep Chromium defaults', () => {
  for (const platform of ['win32', 'darwin']) assert.deepEqual(gpuSwitches({platform, env: {}}), {switches: [], features: [], ozone: null});
});

test('STYK_GPU_UNSAFE=1 still forces the opt-in on every platform', () => {
  assert.deepEqual(gpuSwitches({platform: 'win32', env: {STYK_GPU_UNSAFE: '1'}}), {switches: ['enable-unsafe-webgpu'], features: [], ozone: null});
  assert.deepEqual(gpuSwitches({platform: 'darwin', env: {STYK_GPU_UNSAFE: '1'}}).switches, ['enable-unsafe-webgpu']);
});

test('STYK_GPU_UNSAFE=0 leaves the driver allowlist untouched, even on Linux', () => {
  assert.deepEqual(gpuSwitches({platform: 'linux', env: {STYK_GPU_UNSAFE: '0'}}), {switches: [], features: [], ozone: null});
});

test('the command line receives the switches and merges user features instead of replacing them', () => {
  const plain = commandLine();
  applyGpuSwitches(plain, {platform: 'linux', env: {}});
  assert.equal(plain.values.has('enable-unsafe-webgpu'), true);
  assert.equal(plain.values.get('enable-features'), 'Vulkan');

  const user = commandLine({'enable-features': 'UseOzonePlatform,Vulkan'});
  applyGpuSwitches(user, {platform: 'linux', env: {}});
  assert.equal(user.values.get('enable-features'), 'UseOzonePlatform,Vulkan');

  const other = commandLine({'enable-features': 'VaapiVideoDecoder'});
  applyGpuSwitches(other, {platform: 'linux', env: {}});
  assert.equal(other.values.get('enable-features'), 'VaapiVideoDecoder,Vulkan');
});

test('nothing is appended where no switch is needed', () => {
  const windows = commandLine();
  applyGpuSwitches(windows, {platform: 'win32', env: {}});
  assert.equal(windows.values.size, 0);
});

test('a Wayland session runs through XWayland, because Chromium cannot present Vulkan on Wayland', () => {
  const wayland = {XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0'};
  assert.equal(gpuSwitches({platform: 'linux', env: wayland}).ozone, 'x11');
  assert.equal(gpuSwitches({platform: 'linux', env: {DISPLAY: ':0'}}).ozone, null, 'an X11 session needs nothing');
  assert.equal(gpuSwitches({platform: 'linux', env: {...wayland, DISPLAY: ''}}).ozone, null, 'no XWayland to fall back to');
  assert.equal(gpuSwitches({platform: 'linux', env: {...wayland, STYK_WAYLAND: '1'}}).ozone, null, 'native Wayland can be kept');
  assert.equal(gpuSwitches({platform: 'linux', env: {...wayland, STYK_GPU_UNSAFE: '0'}}).ozone, null, 'no Vulkan, no need');
  assert.equal(gpuSwitches({platform: 'win32', env: wayland}).ozone, null);
});

function fakeApp(switches = {}) { return {commandLine: commandLine(switches)}; }
function relaunch(app, env, extra = {}) {
  const calls = [], handlers = {}, proc = {on: (signal, fn) => { handlers[signal] = fn; }};
  const child = {on: (event, fn) => { handlers['child:' + event] = fn; }, kill: signal => calls.push(['kill', signal])};
  const taken = gpu.relaunchOnX11(app, {platform: 'linux', env, argv: ['/e/electron', '.', 'a.styk'], execPath: '/e/electron',
    spawn: (path, args, options) => { calls.push(['spawn', path, args, options.env.STYK_DISPLAY_RELAUNCHED]); return child; },
    exit: code => calls.push(['exit', code]), proc, ...extra});
  return {taken, calls, handlers};
}
const wayland = {XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0'};

test('under Wayland the app restarts once with the real switch and the same arguments', () => {
  const {taken, calls, handlers} = relaunch(fakeApp(), wayland);
  assert.equal(taken, true);
  assert.deepEqual(calls[0], ['spawn', '/e/electron', ['--ozone-platform=x11', '.', 'a.styk'], '1']);
  handlers['child:exit'](3, null);
  handlers.SIGINT();
  assert.deepEqual(calls.slice(1), [['exit', 3], ['kill', 'SIGINT']], 'exit codes and signals pass through');
});

test('the restart never loops and never overrides a choice', () => {
  for (const flags of [['--ozone-platform=wayland'], ['--ozone-platform', 'wayland'], ['--ozone-platform=x11']]) {
    assert.equal(relaunch(fakeApp({'ozone-platform': 'wayland'}), wayland, {argv: ['/e/electron', '.', ...flags]}).taken, false, 'a platform given on the command line wins');
  }
  assert.equal(relaunch(fakeApp(), {...wayland, STYK_DISPLAY_RELAUNCHED: '1'}).taken, false, 'the copy does not restart again');
  assert.equal(relaunch(fakeApp(), {DISPLAY: ':0'}).taken, false, 'X11 sessions start directly');
  assert.equal(relaunch(fakeApp(), {...wayland, STYK_WAYLAND: '1'}).taken, false);
  assert.equal(relaunch(fakeApp(), wayland, {platform: 'win32'}).taken, false);
});

test('Electron auto-selecting Wayland does not prevent the XWayland restart', () => {
  assert.equal(relaunch(fakeApp({'ozone-platform': 'wayland'}), wayland).taken, true);
});

test('the restart switch comes before the end-of-options marker', () => {
  const {taken, calls} = relaunch(fakeApp(), wayland, {argv: ['/e/electron', '.', '--', '--ozone-platform=wayland']});
  assert.equal(taken, true);
  assert.deepEqual(calls[0][2], ['--ozone-platform=x11', '.', '--', '--ozone-platform=wayland']);
});
