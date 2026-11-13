#!/usr/bin/env node
// A large Pivot project in the real desktop app (off-screen, dialogs replaced): a Pivot file padded with noise up to a size is opened, exported
// as Pivot unchanged (the file again, byte for byte) and edited, saved as a project, and the project is opened again. An open that ends with a
// message instead of a document fails the check (the app saying why is what a file too large for the memory gets, which the Rust tests state).
// See docs/engine/memory.md ("Opening a Pivot file").
//
//   node scripts/smoke-padded-pivot.mjs <file.piv> <size in MB> [--no-edit] [--root <checkout>]
//
// `--no-edit` leaves out the export of the edited project: the codec takes the edited document as JSON, within 256 MiB, and the padding is
// in the document twice over (a project that large exports edited only below about 115 MB).
//
// The padding is random bytes after the project, stored without compression (the file is as large as what it inflates to). The file and
// the padded copies are the person's own and are deleted.
import {createHash, randomBytes} from 'node:crypto';
import {existsSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import {inflateSync, deflateSync} from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const args = process.argv.slice(2);
const option = name => { const at = args.indexOf(name); if (at < 0) return null; const [, value] = args.splice(at, 2); return value; };
const root = path.resolve(option('--root') ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const noEdit = args.includes('--no-edit') && !!args.splice(args.indexOf('--no-edit'), 1);
const [source, megabytes] = args;
if (!source || !Number(megabytes)) { console.error('usage: smoke-padded-pivot.mjs <file.piv> <size in MB> [--no-edit] [--root checkout]'); process.exit(2); }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const {_electron: electron} = await import(pathToFileURL(path.join(root, 'tests/support/playwright.mjs')).href);

const folder = await mkdtemp(path.join(os.tmpdir(), 'styk-padded-'));
const padded = path.join(folder, 'Padded.piv');
const payload = inflateSync(readFileSync(source));
writeFileSync(padded, deflateSync(Buffer.concat([payload, randomBytes(Math.max(0, Math.round(Number(megabytes) * 1e6) - payload.length - 64))]), {level: 0}));
console.log(`padded file: ${statSync(padded).size} bytes (the project inflates to ${payload.length})`);

const profile = path.join(folder, 'profile');
const env = {...process.env, STYK_USER_DATA_DIR: profile, STYK_LIBRARY_DIR: path.join(profile, 'library'), STYK_STARTUP_VIEW: 'editor', STYK_BACKGROUND_WINDOW: '1'};
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({args: [root], cwd: root, env, timeout: 120000,
  executablePath: path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')});
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
try {
  const page = await app.firstWindow({timeout: 120000});
  await page.waitForFunction(() => window.styk?.editor && window.styk?.actions, null, {timeout: 120000, polling: 50});
  await page.waitForTimeout(2000);
  await page.evaluate(() => { for (const d of document.querySelectorAll('dialog[open]')) d.close(); });
  const point = (open, save) => app.evaluate(({dialog}, [openPath, savePath]) => {
    dialog.showOpenDialog = async () => ({canceled: false, filePaths: [openPath]});
    dialog.showSaveDialog = async () => ({canceled: false, filePath: savePath});
    dialog.showMessageBox = async () => ({response: 2, checkboxChecked: false});
  }, [open, save]);
  /** Opens `file` with the menu's action; resolves to {opened, message}: the document that opened, or what the app said instead. */
  const open = async file => {
    await point(file, path.join(folder, 'unused'));
    const started = Date.now();
    await page.evaluate(() => { window.__before = window.styk.editor.report; window.styk.actions.open(); });
    for (;;) {
      await sleep(250);
      const state = await page.evaluate(() => {
        const e = window.styk.editor;
        return {opened: e.report !== window.__before && !window.styk.state.importing && e.totalTicks > 0, busy: document.querySelector('#status-dot')?.classList.contains('busy'),
          message: [...document.querySelectorAll('[role=alert], .toast')].map(t => t.innerText).join(' | ') || document.querySelector('#status')?.innerText};
      });
      if (state.opened) return {opened: true, ms: Date.now() - started};
      if (!state.busy && Date.now() - started > 3000 && state.message && !/opening/i.test(state.message)) return {opened: false, message: state.message, ms: Date.now() - started};
      if (Date.now() - started > 300000) return {opened: false, message: 'still opening after 300 s', ms: Date.now() - started, hung: true};
    }
  };
  const saveTo = async (action, name) => {
    const target = path.join(folder, name);
    await point(padded, target);
    await page.evaluate(action => window.styk.actions[action](), action);
    for (let i = 0; i < 6000 && !existsSync(target); i++) await sleep(100);
    await sleep(500);
    return existsSync(target) ? target : null;
  };

  const first = await open(padded);
  {
    check(first.opened, `the padded project opens (${first.ms} ms${first.message ? ': ' + first.message.slice(0, 120) : ''})`);
    if (first.opened) {
      const unchanged = await saveTo('export-piv', 'unchanged.piv');
      check(unchanged && sha256(unchanged) === sha256(padded), 'exporting it unchanged gives the file again, byte for byte');
      if (!noEdit) {
        await page.evaluate(() => window.styk.editor.addAnimationKeys([{target: {kind: 'camera'}, property: 'x', tick: 0, value: 23}]));
        await sleep(1500);
        const edited = await saveTo('export-piv', 'edited.piv');
        check(edited && statSync(edited).size > 1e6, `exporting it edited works (${edited ? statSync(edited).size : 0} bytes)`);
      }
      const project = await saveTo('save-as', 'project.styk');
      check(project !== null, `saving it as a project works (${project ? statSync(project).size : 0} bytes)`);
      if (project) {
        const again = await open(project);
        check(again.opened, `the project it was saved as opens again (${again.ms ?? ''} ms${again.message ? ': ' + again.message.slice(0, 120) : ''})`);
      }
    }
  }
} finally {
  const closed = await Promise.race([app.close().then(() => true, () => true), sleep(15000).then(() => false)]);
  if (!closed) { try { process.kill(app.process().pid, 'SIGKILL'); } catch { /* gone */ } }
  await sleep(500);
  await rm(folder, {recursive: true, force: true}).catch(() => {});
}
process.exit(failed ? 1 : 0);
