'use strict';

// Chromium switches that decide whether the editor gets a hardware WebGPU
// adapter. Windows and macOS need none: Chromium enables WebGPU through D3D12
// and Metal. Electron's Chromium does not enable Linux WebGPU by default, so the
// engine would silently draw with its WebGL2 backend even on a capable GPU
// (or land on SwiftShader). Vulkan plus the WebGPU opt-in reaches the real
// device on Mesa and NVIDIA drivers.
//
// The engine keeps its own safety net: no WebGPU adapter selects its WebGL2
// backend, so a driver that cannot do WebGPU still edits and plays back
// correctly.
//
// STYK_GPU_UNSAFE=1 forces the opt-in on any platform; STYK_GPU_UNSAFE=0 leaves
// Chromium's own driver allowlist untouched everywhere (useful when diagnosing
// a driver problem).

const LINUX_FEATURES = ['Vulkan'];

// Chromium's Wayland surface cannot present Vulkan-backed content: with the
// Vulkan feature on it logs "'--ozone-platform=wayland' is not compatible with
// Vulkan" and the window stays empty. Under a Wayland session the app therefore
// runs through XWayland (X11) unless a platform was chosen on the command line,
// or STYK_WAYLAND=1 keeps the native Wayland surface (and its WebGPU-less path).
// Chromium chooses the platform before any application code runs, so it cannot
// be switched from inside the process: relaunchOnX11 starts the app again with
// the switch on the real command line.
function ozonePlatform({ platform, env, features }) {
  if (platform !== 'linux' || !features.length || env.STYK_WAYLAND === '1') return null;
  const wayland = env.XDG_SESSION_TYPE === 'wayland' || Boolean(env.WAYLAND_DISPLAY);
  return wayland && env.DISPLAY && !env.ELECTRON_OZONE_PLATFORM_HINT ? 'x11' : null;
}

function gpuSwitches({ platform = process.platform, env = process.env } = {}) {
  const forced = env.STYK_GPU_UNSAFE;
  if (forced === '0') return { switches: [], features: [], ozone: null };
  const enable = forced === '1' || platform === 'linux';
  const features = platform === 'linux' ? [...LINUX_FEATURES] : [];
  return {
    switches: enable ? ['enable-unsafe-webgpu'] : [],
    features,
    ozone: ozonePlatform({ platform, env, features }),
  };
}

// `commandLine` is Electron's app.commandLine. A --enable-features the user
// passed on the command line is merged, never replaced.
function applyGpuSwitches(commandLine, options) {
  const { switches, features, ozone } = gpuSwitches(options);
  for (const name of switches) commandLine.appendSwitch(name);
  if (features.length) {
    const existing = commandLine.hasSwitch('enable-features') ? commandLine.getSwitchValue('enable-features').split(',') : [];
    const merged = [...new Set([...existing, ...features].filter(Boolean))];
    commandLine.appendSwitch('enable-features', merged.join(','));
  }
  return { switches, features, ozone };
}

// Returns true when this process handed over to a copy started with
// --ozone-platform=x11; the caller must then do nothing else (main.cjs returns).
// The parent stays as a thin supervisor so the terminal, exit codes and signals
// behave as if the app had started directly.
function relaunchOnX11(app, { platform = process.platform, env = process.env, argv = process.argv, execPath = process.execPath,
  spawn = require('node:child_process').spawn, exit = (code) => process.exit(code), proc = process } = {}) {
  // Electron inserts its auto-selected platform into app.commandLine before
  // main runs. Only an original argv flag represents the user's choice.
  const argumentEnd = argv.indexOf('--');
  const launchArgs = argv.slice(1, argumentEnd < 0 ? undefined : argumentEnd);
  if (launchArgs.some(arg => arg === '--ozone-platform' || arg.startsWith('--ozone-platform=')) || env.STYK_DISPLAY_RELAUNCHED === '1') return false;
  if (!gpuSwitches({ platform, env }).ozone) return false;
  console.log('[stykanimate] Wayland cannot show WebGPU content; restarting under XWayland (STYK_WAYLAND=1 keeps Wayland).');
  const child = spawn(execPath, ['--ozone-platform=x11', ...argv.slice(1)], { stdio: 'inherit', env: { ...env, STYK_DISPLAY_RELAUNCHED: '1' } });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) proc.on(signal, () => child.kill(signal));
  child.on('error', () => exit(1));
  child.on('exit', (code, signal) => exit(code ?? (signal ? 1 : 0)));
  return true;
}

module.exports = { gpuSwitches, applyGpuSwitches, relaunchOnX11 };
