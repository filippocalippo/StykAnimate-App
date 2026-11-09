#!/usr/bin/env node
// Builds the desktop app with Tauri (engine/crates/styk-desktop): the Windows Setup installer (NSIS), the portable
// executable and both update feeds, in release/<version>/.
//
//   node scripts/tauri-build.mjs                 the shipping build: Setup, Portable, latest.json, latest.yml
//   node scripts/tauri-build.mjs --developer     the developer build (WebView2 inspector on, `devtools` feature)
//   node scripts/tauri-build.mjs --exe           only the executable (engine/target/release), no installer
//
// Before it: `npm run engine:build` (the engine's WebAssembly) and, for exports, the encoder and codec helpers.
// The page's files are bundled (scripts/build-app.mjs), staged (scripts/tauri-stage-web.mjs) and embedded in the
// executable. The installer is unsigned, as the Electron release was (package.json "signExecutable": false); the
// update payload is signed for tauri-plugin-updater with TAURI_SIGNING_PRIVATE_KEY (a key or a path), else with
// ~/.tauri/stykanimate-updater.key when it exists, else no update artifacts are made.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const crate = path.join(root, 'engine', 'crates', 'styk-desktop');
const args = process.argv.slice(2);
const developer = args.includes('--developer');
const exeOnly = args.includes('--exe');
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const out = path.join(root, 'release', developer ? `${version}-developer` : version);
const RELEASES = 'https://github.com/filippocalippo/styk-animate-releases/releases';

function run(command, commandArgs, options = {}) {
  console.log(`> ${command} ${commandArgs.join(' ')}`);
  // Only npx needs a shell on Windows (it is a .cmd); a shell would split a path with spaces such as node's.
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', shell: process.platform === 'win32' && command === 'npx', ...options });
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`);
}

run(process.execPath, [path.join(root, 'scripts', 'engine-verify-pkg.mjs')]);
run(process.execPath, [path.join(root, 'scripts', 'build-app.mjs')]);
run(process.execPath, [path.join(root, 'scripts', 'tauri-stage-web.mjs')]);

const env = { ...process.env };
const defaultKey = path.join(os.homedir(), '.tauri', 'stykanimate-updater.key');
if (!env.TAURI_SIGNING_PRIVATE_KEY && existsSync(defaultKey)) env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(defaultKey, 'utf8').trim();
env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= '';
const signed = Boolean(env.TAURI_SIGNING_PRIVATE_KEY) && !exeOnly;
const tauriArgs = ['--yes', '@tauri-apps/cli@2.12.4', 'build', '--ci'];
if (developer) tauriArgs.push('--features', 'devtools');
if (exeOnly) tauriArgs.push('--no-bundle');
else tauriArgs.push('--bundles', 'nsis');
// The installer carries the encoder and the codec helpers (area 3); only packaging needs them staged.
if (!exeOnly) tauriArgs.push('--config', path.join(crate, 'tauri.bundle.json'));
if (!signed) {
  // A file, not inline JSON: npx runs through cmd.exe, which strips the quotes of an inline value.
  const config = path.join(root, 'build', 'tauri-unsigned.json');
  mkdirSync(path.dirname(config), { recursive: true });
  writeFileSync(config, JSON.stringify({ bundle: { createUpdaterArtifacts: false } }));
  tauriArgs.push('--config', config);
}
run('npx', tauriArgs, { cwd: crate, env });

const target = path.join(root, 'engine', 'target', 'release');
const exe = path.join(target, 'StykAnimate.exe');
if (exeOnly) { console.log(`\nBuilt ${path.relative(root, exe)} (${(statSync(exe).size / 1048576).toFixed(1)} MB)`); process.exit(0); }

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const nsisDir = path.join(target, 'bundle', 'nsis');
const built = readdirSync(nsisDir).find(name => name.endsWith('-setup.exe') && name.includes(version));
if (!built) throw new Error(`No NSIS installer for ${version} in ${nsisDir}`);
// Today's public names, so the release page and the download links keep their shape.
const setupName = `StykAnimate-${version}-Setup-x64.exe`;
copyFileSync(path.join(nsisDir, built), path.join(out, setupName));
const setupBytes = readFileSync(path.join(out, setupName));

// The portable copy: one executable that unpacks the app beside nothing and runs it from a temporary folder, as the
// Electron portable did. STYK_PORTABLE_DIR tells the app it is portable (no self-update).
const makensis = [process.env.STYK_MAKENSIS, path.join(process.env.LOCALAPPDATA || '', 'tauri', 'NSIS', 'makensis.exe'), path.join(process.env.LOCALAPPDATA || '', 'tauri', 'NSIS', 'Bin', 'makensis.exe')].find(file => file && existsSync(file));
const portableName = `StykAnimate-${version}-Portable-x64.exe`;
if (makensis) {
  const script = path.join(out, 'portable.nsi');
  const resources = path.join(target, 'resources');
  writeFileSync(script, [
    'Unicode true', 'SetCompressor /SOLID lzma', 'SilentInstall silent', 'RequestExecutionLevel user',
    `Name "StykAnimate"`, `OutFile "${path.join(out, portableName)}"`, `Icon "${path.join(crate, 'icons', 'icon.ico')}"`,
    `VIProductVersion "${version}.0"`, `VIAddVersionKey "ProductName" "StykAnimate"`, `VIAddVersionKey "FileVersion" "${version}"`,
    `VIAddVersionKey "FileDescription" "StykAnimate (portable)"`, `VIAddVersionKey "LegalCopyright" "StykAnimate"`,
    '!include FileFunc.nsh',
    'Section',
    '  InitPluginsDir',
    '  SetOutPath "$PLUGINSDIR\\app"',
    `  File "${exe}"`,
    ...(existsSync(resources) ? [`  File /r "${resources}"`] : []),
    '  System::Call \'Kernel32::SetEnvironmentVariable(t "STYK_PORTABLE_DIR", t "$EXEDIR")i\'',
    '  ${GetParameters} $0',
    '  ExecWait \'"$PLUGINSDIR\\app\\StykAnimate.exe" $0\' $1',
    '  SetOutPath "$TEMP"',
    '  SetErrorLevel $1',
    'SectionEnd', '',
  ].join('\r\n'));
  run(makensis, ['/V2', script]);
  rmSync(script);
} else console.warn('makensis was not found (Tauri downloads it on the first installer build); no portable executable.');

const sha512 = bytes => createHash('sha512').update(bytes).digest('base64');
const releaseDate = new Date().toISOString();
const downloads = `${RELEASES}/download/v${version}`;
// tauri-plugin-updater's feed (the app checks .../releases/latest/download/latest.json).
const signature = path.join(nsisDir, `${built}.sig`);
if (signed && existsSync(signature)) {
  copyFileSync(signature, path.join(out, `${setupName}.sig`));
  const notes = (() => { try { return JSON.parse(readFileSync(path.join(root, 'desktop', 'release-info.json'), 'utf8')).title || ''; } catch { return ''; } })();
  const entry = { signature: readFileSync(signature, 'utf8').trim(), url: `${downloads}/${setupName}` };
  writeFileSync(path.join(out, 'latest.json'), `${JSON.stringify({ version, notes, pub_date: releaseDate, platforms: { 'windows-x86_64': entry, 'windows-x86_64-nsis': entry } }, null, 2)}\n`);
} else console.warn('No updater signing key: latest.json was not written (installed copies cannot update to this build).');
// electron-updater's feed, which every Electron copy (1.x) reads: it downloads this Setup, checks its SHA-512 and
// runs it with --updated /S --force-run; the installer removes the Electron copy and starts this app
// (docs/tauri/updater-migration.md).
const yml = [`version: ${version}`, 'files:', `  - url: ${setupName}`, `    sha512: ${sha512(setupBytes)}`, `    size: ${setupBytes.length}`,
  `path: ${setupName}`, `sha512: ${sha512(setupBytes)}`, `releaseDate: '${releaseDate}'`, ''].join('\n');
writeFileSync(path.join(out, 'latest.yml'), yml);

const sums = readdirSync(out).filter(name => statSync(path.join(out, name)).isFile() && name !== 'SHA256SUMS.txt').sort()
  .map(name => `${createHash('sha256').update(readFileSync(path.join(out, name))).digest('hex')}  ${name}`);
writeFileSync(path.join(out, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`);
console.log(`\n${path.relative(root, out)}:`);
for (const name of readdirSync(out)) console.log(`  ${name}  ${(statSync(path.join(out, name)).size / 1048576).toFixed(1)} MB`);
