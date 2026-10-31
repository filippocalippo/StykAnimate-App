#!/usr/bin/env node
// Byte gate for saving: opens each file in the real desktop app (off-screen, dialogs replaced), does Save As without any edit, and compares
// the SHA-256 of what was written with the value a trusted build wrote for the same file. An unchanged document must save to the bytes
// it always saved to (docs/engine/document.md, "Saving a project"); a different hash is a different file even when it reads back the same.
//
//   node scripts/smoke-save-bytes.mjs --expected hashes.json [--root <checkout>] [file ...]     compare (exit 1 on a difference)
//   node scripts/smoke-save-bytes.mjs --record hashes.json [--root <checkout>] file ...         write the hashes this checkout saves
//
// `hashes.json` maps a file's path to the hex SHA-256 of its saved bytes (a prefix of at least 8 characters is accepted when comparing);
// without file arguments every key of `--expected` is run. The files and the hashes are the person's own: nothing here names them, and
// the saved copies are deleted. `STYK_SAVE_BYTES` may name the `--expected` file. `--root` runs another checkout of the app (the build the
// hashes came from, to record them).
import {createHash} from 'node:crypto';
import {createReadStream, existsSync, readFileSync, writeFileSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const args = process.argv.slice(2);
const option = name => { const at = args.indexOf(name); if (at < 0) return null; const [, value] = args.splice(at, 2); return value; };
const root = path.resolve(option('--root') ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const recordTo = option('--record'), expectedFile = option('--expected') ?? process.env.STYK_SAVE_BYTES ?? null;
const expected = expectedFile && !recordTo ? JSON.parse(readFileSync(expectedFile, 'utf8')) : {};
const files = args.length ? args.map(file => path.resolve(file)) : Object.keys(expected);
if (!files.length || (!recordTo && !expectedFile)) {
  console.error('usage: smoke-save-bytes.mjs (--expected hashes.json | --record hashes.json) [--root checkout] [file ...]');
  process.exit(2);
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = file => new Promise((resolve, reject) => {
  const hash = createHash('sha256');
  createReadStream(file).on('data', chunk => hash.update(chunk)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
});
const {_electron: electron} = await import(pathToFileURL(path.join(root, 'tests/support/playwright.mjs')).href);

/** One file in a fresh app: opened, saved with Save As, hashed. Returns {sha256, bytes} or throws. */
async function saveOnce(file) {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'styk-save-bytes-'));
  const target = path.join(profile, 'saved.styk');
  const env = {...process.env, STYK_USER_DATA_DIR: profile, STYK_LIBRARY_DIR: path.join(profile, 'library'), STYK_STARTUP_VIEW: 'editor', STYK_BACKGROUND_WINDOW: '1'};
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({args: [root], cwd: root, env, timeout: 120000,
    executablePath: path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')});
  const pid = app.process().pid;
  try {
    const page = await app.firstWindow({timeout: 120000});
    // A native prompt would hold the run for ever: every dialog is answered here, "don't save" for the unsaved-changes one.
    await app.evaluate(({dialog}, [source, destination]) => {
      dialog.showOpenDialog = async () => ({canceled: false, filePaths: [source]});
      dialog.showSaveDialog = async () => ({canceled: false, filePath: destination});
      dialog.showMessageBox = async () => ({response: 2, checkboxChecked: false});
    }, [file, target]);
    await page.waitForFunction(() => window.styk?.editor && window.styk?.actions, null, {timeout: 120000, polling: 50});
    await page.evaluate(() => { window.__saveBytes = {report: window.styk.editor.report, name: window.styk.editor.name}; window.styk.actions.open(); });
    await page.waitForFunction(() => { const e = window.styk.editor, b = window.__saveBytes;
      return (e.report !== b.report || e.name !== b.name) && !window.styk.state.importing && e.totalTicks > 0; }, null, {timeout: 600000, polling: 100});
    await sleep(2000);
    await page.evaluate(() => { window.styk.actions['save-as'](); });
    let saved = false;
    for (let i = 0; i < 3000 && !saved; i++) { await sleep(100); saved = existsSync(target) && await page.evaluate(() => !window.styk.editor.dirty).catch(() => false); }
    if (!saved) throw new Error('the save did not finish');
    return {sha256: await sha256(target), bytes: (await import('node:fs')).statSync(target).size};
  } finally {
    const closed = await Promise.race([app.close().then(() => true, () => true), sleep(15000).then(() => false)]);
    if (!closed && pid) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {stdio: 'ignore'}); } catch { /* gone */ } }
    await sleep(500);
    await rm(profile, {recursive: true, force: true}).catch(() => {});
  }
}

const results = {};
let failed = 0;
for (const file of files) {
  const label = path.basename(file).replace(/^.*(\.[a-z]+)$/i, 'file$1');
  try {
    const {sha256: digest, bytes} = await saveOnce(file);
    results[file] = digest;
    const want = expected[file] ?? expected[path.resolve(file)];
    if (recordTo) console.log(`${label}: ${bytes} bytes, ${digest.slice(0, 12)}…`);
    else if (!want) { failed++; console.log(`${label}: ${bytes} bytes, ${digest.slice(0, 12)}…: no expected value`); }
    else if (want.length >= 8 && digest.startsWith(want.toLowerCase())) console.log(`${label}: ${bytes} bytes, ${digest.slice(0, 12)}…: identical`);
    else { failed++; console.log(`${label}: ${bytes} bytes, ${digest.slice(0, 12)}…: DIFFERENT from ${want.slice(0, 12)}…`); }
  } catch (error) { failed++; console.log(`${label}: FAILED ${String(error?.message ?? error).split('\n')[0]}`); }
}
if (recordTo) writeFileSync(recordTo, JSON.stringify(results, null, 2));
process.exit(failed ? 1 : 0);
