#!/usr/bin/env node
// Stages the page's files for the packaged desktop app (engine/crates/styk-desktop embeds `build/tauri-web`):
// the same files the Electron app shipped as `resources/web` (index.html, the root styles and images, src, assets,
// vendor), with the app bundle (`build/app`, scripts/build-app.mjs) laid over the modules, as the web host answered
// them. `--bundle <dir>` names another bundle; `--no-bundle` stages the modules alone.
//   node scripts/tauri-stage-web.mjs [--bundle build/app | --no-bundle]
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'build', 'tauri-web');
const args = process.argv.slice(2);
const bundleArg = args.indexOf('--bundle');
const bundle = args.includes('--no-bundle') ? null : path.resolve(root, bundleArg >= 0 ? args[bundleArg + 1] : 'build/app');

if (!existsSync(path.join(root, 'src', 'engine', 'pkg', 'styk_engine_bg.wasm')))
  throw new Error('The engine is not built: run `npm run engine:build` first.');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const name of readdirSync(root)) {
  if (/^index\.html$|\.(css|svg|png)$/i.test(name) && statSync(path.join(root, name)).isFile()) cpSync(path.join(root, name), path.join(out, name));
}
for (const folder of ['src', 'assets', 'vendor']) {
  if (existsSync(path.join(root, folder))) cpSync(path.join(root, folder), path.join(out, folder), { recursive: true, filter: source => !path.basename(source).startsWith('.') });
}
let overlaid = 0;
if (bundle && existsSync(bundle)) {
  cpSync(bundle, out, { recursive: true, force: true, filter: source => { if (statSync(source).isFile()) overlaid++; return true; } });
}
let files = 0, bytes = 0;
(function count(dir) { for (const entry of readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) count(full); else { files++; bytes += statSync(full).size; } } })(out);
console.log(`staged ${files} files (${(bytes / 1048576).toFixed(1)} MB) in ${path.relative(root, out)}${bundle ? `, ${overlaid} from the bundle` : ''}`);
