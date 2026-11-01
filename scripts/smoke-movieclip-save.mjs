#!/usr/bin/env node
// Movieclip gestures and every way the app writes a project, through the real desktop app (off-screen, dialogs replaced).
//
//   node scripts/smoke-movieclip-save.mjs <seed> [steps=40] [--big] [--blank] [--every=4] [--root <checkout>]
//
// A seeded run makes movieclips the ways a person does (from a selection or a range, empty, placed, nested, edited inside, duplicated,
// deleted, renamed, joined figures, undo and redo) and, every few gestures, writes the project by one of the ways the app does and opens
// what was written through the app's own open: Save and Save As (after which the opened document must be the document that was saved),
// a Save that is cancelled, a Save with an edit arriving during it, the autosave recovery copy and the copy of a project parked in a tab
// (written while a movieclip is being edited), then, at the end, a kill and the recovery that follows, and the dirty-close Save.
// The check is that every file opens and, for the saves, that it is the same document. `--big` gives the project a figure of 60
// segments (pose arrays of 32 numbers or more); `--blank` starts from the blank document. The same seed gives the same gestures.
// Exit 1 and the gestures leading up to it when a file does not open or differs. Nothing is written outside a temporary folder,
// which is deleted.
import {copyFileSync, existsSync, readdirSync, statSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const args = process.argv.slice(2);
const option = name => { const at = args.indexOf(name); if (at < 0) return null; const [, value] = args.splice(at, 2); return value; };
const root = path.resolve(option('--root') ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const flag = name => args.includes(name);
const numbers = args.filter(a => /^\d+$/.test(a)).map(Number);
const seed = numbers[0] ?? 1, steps = numbers[1] ?? 40, every = Number((args.find(a => a.startsWith('--every=')) ?? '--every=4').slice(8));
const big = flag('--big'), blank = flag('--blank');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const {_electron: electron} = await import(pathToFileURL(path.join(root, 'tests/support/playwright.mjs')).href);
const profile = await mkdtemp(path.join(os.tmpdir(), 'styk-mcsave-'));
const folder = path.join(profile, 'files');
await import('node:fs/promises').then(fs => fs.mkdir(folder, {recursive: true}));
const pageErrors = [], failures = [], log = [], summary = {seed, steps, big, blank, saves: 0, opened: 0};
let app, page, pid, serial = 0;

async function launch() {
  const env = {...process.env, STYK_USER_DATA_DIR: profile, STYK_LIBRARY_DIR: path.join(profile, 'library'), STYK_STARTUP_VIEW: 'editor', STYK_BACKGROUND_WINDOW: '1'};
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({args: [root], cwd: root, env, timeout: 120000, executablePath: path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')});
  pid = app.process().pid;
  page = await app.firstWindow({timeout: 120000});
  page.on('pageerror', error => pageErrors.push(String(error?.stack ?? error?.message ?? error).slice(0, cap)));
  // A native prompt would hold the run for ever: every dialog is answered here.
  await app.evaluate(({dialog}) => {
    globalThis.__save = {next: null, hold: false, release: null, count: 0}; globalThis.__open = null; globalThis.__close = 2;
    dialog.showSaveDialog = async () => {
      const state = globalThis.__save; state.count++;
      if (state.hold) { state.hold = false; await new Promise(resolve => { state.release = resolve; }); }
      const filePath = state.next; state.next = null;
      return filePath ? {canceled: false, filePath} : {canceled: true};
    };
    dialog.showOpenDialog = async () => ({canceled: false, filePaths: [globalThis.__open]});
    dialog.showMessageBox = async () => ({response: globalThis.__close, checkboxChecked: false});
  });
  await page.waitForFunction(() => window.styk?.ready && window.styk.state.documentToken && window.styk.editor, null, {timeout: 120000, polling: 100});
  await page.locator('.release-splash [aria-label="Close welcome screen"]').click({timeout: 1500}).catch(() => {});
}
async function stop() {
  if (!app) return;
  const closed = await Promise.race([app.close().then(() => true, () => true), sleep(15000).then(() => false)]);
  if (!closed && pid) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {stdio: 'ignore'}); } catch { /* gone */ } }
  app = null;
}
const kill = () => { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {stdio: 'ignore'}); } catch { /* gone */ } app = null; };

/** The gestures, run in the page on the app's own editor, drawn from the seed. */
async function install(prepare = true) {
  await page.evaluate(({seed, big, blank}) => {
    const {editor} = window.styk;
    let s = seed >>> 0;
    const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    const pick = list => list[Math.floor(rnd() * list.length)], int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
    const isClip = f => Boolean(f?._styk?.movieclip);
    const objects = () => editor.evaluatedFrame?.objects ?? [], clips = () => (editor.report.figure_types ?? []).filter(isClip);
    const one = () => { const o = objects(); if (!o.length) return null; const u = pick(o).unique_id; editor.select(u, -1); return u; };
    const gestures = {
      seek() { editor.seek(int(0, Math.max(0, Math.floor(editor.totalTicks) - 1))); },
      selectOne() { one(); },
      selectSome() { const ids = objects().filter(() => rnd() < 0.5).map(o => o.unique_id); if (ids.length) editor.selectMany(ids); },
      createRange() { one(); const start = editor.tick; editor.createMovieclip({start, end: Math.min(start + int(1, 8), Math.max(editor.totalTicks, start + 1))}); },
      createStatic() { one(); editor.createMovieclip({}); },
      createEmpty() { editor.createEmptyMovieclip(`Empty ${int(1, 99)}`); },
      enter() { const c = clips(); if (c.length) editor.enterMovieclip(pick(c).figure_type_id); },
      enterSelected() { editor.enterMovieclip(); },
      leave() { editor.leaveMovieclip(); },
      addClipInstance() { const c = clips(); if (c.length) editor.addFigure(pick(c).figure_type_id); },
      addFigure() { const t = editor.report.figure_types.filter(f => !isClip(f)); editor.addFigure(t.length ? pick(t).figure_type_id : undefined); },
      move() { one(); editor.moveSelection(int(-30, 30), int(-30, 30)); },
      duplicate() { one(); editor.duplicateSelection(); },
      del() { one(); editor.deleteSelection(); },
      rename() { one(); editor.renameMovieclip(`Clip ${int(1, 999)}`); },
      unique() { one(); editor.makeMovieclipUnique(); },
      breakApart() { one(); editor.breakApartMovieclip(); },
      split() { one(); editor.splitMovieclip(); },
      playback() { one(); editor.setMovieclipPlayback({speed: pick([0.5, 1, 2]), mode: pick(['loop', 'once', 'hold'])}); },
      pose() { const u = one(); if (u !== null) editor.rotateJoint?.(1, rnd() * 0.5); },
      addFrame() { editor.sheetAppendFrame?.(); }, duplicateFrame() { editor.sheetDuplicateFrameAfter?.(); }, insertKey() { editor.sheetInsertKey?.(); },
      join() { const o = objects(); if (o.length < 2) return; const a = pick(o), b = pick(o.filter(x => x !== a)); editor.select(a.unique_id, -1); editor.joinFigure(b.unique_id, int(0, 2)); },
      unjoin() { one(); editor.unjoinFigure(); },
      createLayer() { editor.createLayer(`Layer ${int(1, 99)}`); },
      moveLayer() { one(); const order = editor.report._styk?.layers?.order ?? []; if (order.length) editor.moveSelectionLayer(pick(order)); },
      vfx() { const o = objects(); if (o.length) editor.addVfx({kind: 'figure', uid: pick(o).unique_id}, 'glow'); },
      vfxClip() { const o = objects(); if (o.length) editor.addVfxClip({kind: 'figure', uid: pick(o).unique_id}, 'glow'); },
      key() { const o = objects(); if (o.length) editor.addAnimationKey({kind: 'figure', uid: pick(o).unique_id}, 'pose', editor.tick); },
      camera() { editor.addCameraMotion('shake', {start: int(0, 10), duration: int(6, 24)}); },
      drawingLayer() { editor.createDrawingLayer(); },
      undo() { return editor.undo(); }, redo() { return editor.redo(); },
      deleteInstances() { const c = clips(); if (!c.length) return; const id = pick(c).figure_type_id; for (const o of objects()) if (o.figure_type_id === id) { editor.select(o.unique_id, -1); editor.deleteSelection(); } },
    };
    const weights = {seek: 2, selectOne: 2, selectSome: 1, createRange: 4, createStatic: 2, createEmpty: 1, enter: 4, enterSelected: 1, leave: 3, addClipInstance: 3, addFigure: 2, move: 2, duplicate: 2, del: 2,
      join: 3, unjoin: 1, createLayer: 1, moveLayer: 1, vfx: 1, vfxClip: 1, key: 1, camera: 1, drawingLayer: 1, rename: 1, unique: 1, breakApart: 1, split: 1, playback: 1, pose: 1, addFrame: 1, duplicateFrame: 1, insertKey: 1, undo: 3, redo: 2, deleteInstances: 1};
    const table = Object.entries(weights).flatMap(([k, w]) => Array(w).fill(k));
    const segment = (i) => ({segment_id: i + 1, parent_id: i < 1 ? 0 : (i % 7 === 0 ? 1 : i), length: 20 + (i % 5), angle_rad: -1.2 + (i % 9) * 0.31, thickness: 4, bend_rad: 0, primitive_code: 0, aux_code: 0,
      flags: 0, segment_type: 'line', segment_kind: 'line', color_rgb: [20, 20, 20], transparency: 0, visible: true, z_order: i + 1});
    window.__fz = {
      rnd, pick, int,
      async prepare() {
        const {createDemo, createObject} = await import('/src/demo.mjs');
        if (blank) { window.styk.actions.new(); return; }
        const doc = createDemo();
        if (big) {
          const figure = {figure_type_id: 4, name: 'Big 60', segment_count: 60, segments: Array.from({length: 60}, (_, i) => segment(i)), polyfills: [], image_assets: [], text_assets: []};
          doc.figure_types.push(figure);
          for (const [i, frame] of doc.keyframes.entries()) {
            const o = createObject(figure, 4, 300 + i, 250); o.angles = o.angles.map((a, j) => a + Math.sin(i * 0.4 + j) * 0.2);
            frame.objects.push(o); o.object_slot = frame.objects.length - 1; frame.object_draw_order.push(o.object_slot); frame.object_draw_order_unique_ids.push(4);
          }
        }
        editor.load(doc);
      },
      step() { const name = pick(table); try { const d = gestures[name](); return `${name}${d === undefined || d === null ? '' : ' ' + d}`; } catch (error) { return `${name}!refused ${String(error?.message ?? error).slice(0, 40)}`; } },
      depth: () => editor._movieclipScopes?.length ?? 0,
      leaveAll() { while (editor._movieclipScopes?.length) editor.leaveMovieclip(); },
      edit() { gestures.move(); return editor.dirty; },
      canonical() {
        const out = [];
        const walk = (v, p) => {
          if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
          else if (v && typeof v === 'object') { for (const k of Object.keys(v)) { if (k === 'frameId' || (p === '._styk' && ['name', 'format', 'format_version'].includes(k)) || (k.startsWith('_') && !['_styk', '_stykMovieclip', '_stykStyle'].includes(k))) continue; walk(v[k], `${p}.${k}`); } }
          else if (!p.endsWith('._styk.layers.version') && !p.endsWith('._styk.layers.activeId')) out.push([p, JSON.stringify(v)]);
        };
        walk(JSON.parse(JSON.stringify(editor.report)), '');
        return out;
      },
    };
  }, {seed, big, blank});
  if (prepare) {
    const token = await page.evaluate(() => window.styk.state.documentToken);
    await page.evaluate(() => window.__fz.prepare());
    // A new project takes the window over asynchronously: the first gestures wait for it.
    if (blank) await page.waitForFunction(token => window.styk.state.documentToken !== token, token, {timeout: 30000, polling: 100}).catch(() => {});
    await sleep(1000);
  }
}

const diff = (a, b) => {
  const m = new Map(b); for (const [p, v] of a) if (!m.has(p)) return `${p} missing after reopen`; else if (m.get(p) !== v) return `${p}: ${v.slice(0, 60)} != ${m.get(p).slice(0, 60)}`;
  // A movieclip made empty has no layer state until it is opened, which gives it one: that is not a difference of the document.
  const x = new Map(a); for (const [p] of b) if (!x.has(p) && !p.includes('._styk.layers.')) return `${p} appeared after reopen`;
  return null;
};
const where = (kind) => `after [${log.slice(-4).join(' | ')}] depth ${log.depth ?? '?'} kind ${kind}`;
const cap = process.env.STYK_FULL_ERRORS ? 4000 : 300;
const fail = (kind, phase, error) => failures.push({kind, phase, error: String(error).slice(0, cap), after: log.slice(-6), step: log.length});
async function waitSaved(timeout = 30000) {
  await page.waitForFunction(() => !window.styk.editor.dirty, null, {timeout, polling: 100});
}
/** Opens `file` through the app's own open, reads the document, and closes the tab it opened in. Returns {report} or throws. */
async function reopen(file) {
  await app.evaluate((_e, f) => { globalThis.__open = f; }, file);
  const before = await page.evaluate(() => window.styk.state.documentToken);
  await page.evaluate(() => { window.__before = window.styk.editor.report; window.styk.actions.open(); });
  try { await page.waitForFunction(token => window.styk.state.documentToken !== token && !window.styk.state.importing && window.styk.editor.report !== window.__before, before, {timeout: 60000, polling: 100}); }
  catch { if (process.env.STYK_KEEP_FAILED) copyFileSync(file, process.env.STYK_KEEP_FAILED); const text = await page.evaluate(() => `${document.getElementById('status')?.textContent ?? ''} | tabs ${window.styk.projects?.tabs?.size} importing ${window.styk.state.importing} | dialogs ${[...document.querySelectorAll('dialog[open],[role=dialog],[role=alertdialog]')].map(e => e.textContent.trim().slice(0, 120)).join(' / ')} | ${[...document.querySelectorAll('[role=alert],[role=status],.toast,.styk-toast')].map(e => e.textContent.trim()).filter(Boolean).join(' / ')}`); throw new Error(`did not open: ${text.slice(0, 200)}`); }
  await sleep(300);
  const repairs = await page.evaluate(() => [...document.querySelectorAll('[role=alert],[role=status],.toast,.styk-toast')].some(e => /damaged movieclip data/.test(e.textContent)));
  const canonical = await page.evaluate(() => window.__fz.canonical());
  return {canonical, repairs};
}
async function closeOpened() {
  // The tab the file opened in is the one in front: closing it returns to the project being edited.
  await page.evaluate(() => window.styk.actions['close-project']());
  await page.waitForFunction(() => !window.styk.state.importing, null, {timeout: 20000});
  await sleep(200);
}
const file = name => path.join(folder, `${name}-${++serial}.styk`);

async function checkSave(kind) {
  const target = file(kind);
  await app.evaluate((_e, f) => { globalThis.__save.next = f; }, target);
  // Save leaves every movieclip being edited: that is how the app saves.
  await page.evaluate(kind => window.styk.actions[kind === 'save-as' ? 'save-as' : 'save'](), kind);
  try { await waitSaved(); } catch (error) { fail(kind, 'save', `the save did not finish (${error.message.split('\n')[0]})`); return; }
  // Save writes nothing for a project with no change since it was saved: Save As then writes the file.
  for (let i = 0; i < 30 && !existsSync(target); i++) await sleep(100);
  if (!existsSync(target)) {
    await app.evaluate((_e, f) => { globalThis.__save.next = f; }, target);
    await page.evaluate(() => window.styk.actions['save-as']());
    for (let i = 0; i < 300 && !existsSync(target); i++) await sleep(100);
    try { await waitSaved(); } catch (error) { fail(kind, 'save', `Save As did not finish (${error.message.split('\n')[0]})`); return; }
  }
  summary.saves++;
  const expected = await page.evaluate(() => window.__fz.canonical());
  try {
    const {canonical, repairs} = await reopen(target);
    summary.opened++;
    if (repairs) fail(kind, 'repaired', 'the app said the file needed mending');
    const d = diff(expected, canonical); if (d) { fail(kind, 'differs', d); if (process.env.STYK_KEEP_FAILED) copyFileSync(target, process.env.STYK_KEEP_FAILED); }
    await closeOpened();
  } catch (error) { fail(kind, 'open', error.message); }
}
async function checkCancelled() {
  await page.evaluate(() => window.__fz.edit());
  await app.evaluate(() => { globalThis.__save.next = null; });
  const dirtyBefore = await page.evaluate(() => window.styk.editor.dirty);
  await page.evaluate(() => window.styk.actions['save-as']());
  await sleep(1500);
  const state = await page.evaluate(() => ({dirty: window.styk.editor.dirty, status: document.getElementById('status')?.textContent}));
  if (dirtyBefore && !state.dirty) fail('cancelled-save', 'lost', 'a cancelled save marked the project saved');
}
async function checkEditDuringSave() {
  const target = file('during');
  await app.evaluate((_e, f) => { globalThis.__save.next = f; globalThis.__save.hold = true; globalThis.__save.release = null; }, target);
  await page.evaluate(() => { window.__fz.edit(); window.styk.actions['save-as'](); });
  for (let i = 0; i < 200 && !(await app.evaluate(() => typeof globalThis.__save.release === 'function')); i++) await sleep(25);
  const revision = await page.evaluate(() => window.styk.editor.revision);
  await page.evaluate(() => window.__fz.edit());
  // A gesture that changes nothing (no figure to move) leaves the project as the save left it.
  const changed = await page.evaluate(revision => window.styk.editor.revision !== revision, revision);
  await app.evaluate(() => { globalThis.__save.release(); globalThis.__save.release = null; });
  await sleep(2500);
  const dirty = await page.evaluate(() => window.styk.editor.dirty);
  if (changed && !dirty) fail('edit-during-save', 'lost', 'the edit made while the save ran was marked saved');
  if (existsSync(target)) {
    try { await reopen(target); summary.opened++; await closeOpened(); } catch (error) { fail('edit-during-save', 'open', error.message); }
  }
}
async function newestRecovery(after) {
  for (let i = 0; i < 400; i++) {
    const found = readdirSync(profile).filter(n => /^recovery(-.+)?\.styk$/.test(n)).map(n => [n, statSync(path.join(profile, n)).mtimeMs]).filter(([, t]) => t > after).sort((a, b) => b[1] - a[1]);
    if (found.length) return path.join(profile, found[0][0]);
    await sleep(100);
  }
  return null;
}
async function checkRecovery() {
  // Edits inside a movieclip (when one is being edited) and then waiting for the autosave copy.
  const since = Date.now();
  const revision = await page.evaluate(() => window.styk.editor.revision);
  await page.evaluate(() => window.__fz.edit());
  // A gesture that changes nothing (no figure to move) leaves nothing new to keep.
  if (await page.evaluate(revision => window.styk.editor.revision === revision, revision)) return;
  const recovery = await newestRecovery(since);
  if (!recovery) { fail('recovery', 'missing', 'no recovery copy was written'); return; }
  await sleep(1500);
  const copy = file('recovery'); copyFileSync(recovery, copy);
  try { await reopen(copy); summary.opened++; await closeOpened(); } catch (error) { fail('recovery', 'open', error.message); }
}
async function checkParked() {
  // A project with unsaved changes rests in a tab while another opens: its recovery copy is written for it.
  const since = Date.now();
  await page.evaluate(() => { window.__fz.edit(); window.styk.actions.new(); });
  const recovery = await newestRecovery(since);
  if (!recovery) { fail('parked', 'missing', 'no copy was written for the resting project'); }
  else { await sleep(800); const copy = file('parked'); copyFileSync(recovery, copy); try { await reopen(copy); summary.opened++; await closeOpened(); } catch (error) { fail('parked', 'open', error.message); } }
  // Back to the project being edited.
  await page.evaluate(() => window.styk.actions['previous-project']());
  await sleep(500);
}

try {
  await launch();
  await install();
  const rng = (() => { let s = (seed * 7919) >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; })();
  const checks = ['save', 'save-as', 'save', 'recovery', 'parked', 'cancelled', 'during'];
  for (let i = 1; i <= steps && !failures.length; i++) {
    log.push(await page.evaluate(() => window.__fz.step()));
    if (i % every === 0) {
      const kind = checks[Math.floor(rng() * checks.length)];
      log.depth = await page.evaluate(() => window.__fz.depth());
      if (kind === 'save' || kind === 'save-as') await checkSave(kind);
      else if (kind === 'recovery') await checkRecovery();
      else if (kind === 'parked') await checkParked();
      else if (kind === 'cancelled') await checkCancelled();
      else await checkEditDuringSave();
    }
  }
  // The end of a session: a kill with unsaved changes leaves a recovery copy that the next launch holds (what it holds is opened as the
  // project to go on with), and the project is saved last the way it is when a person closes the window.
  if (!failures.length) {
    const since = Date.now();
    await page.evaluate(() => window.__fz.edit());
    const recovery = await newestRecovery(since);
    if (recovery) {
      await sleep(1500);
      kill();
      // What the killed process left, before the next launch decides about it.
      const copy = file('killed'); copyFileSync(recovery, copy);
      await launch(); await install(false);
      await sleep(4000); // the launch looks at the recovery copy the kill left before anything else is opened
      try { await reopen(copy); summary.opened++; } catch (error) { fail('kill', 'open', error.message); }
    } else fail('kill', 'missing', 'no recovery copy was written before the kill');
  }
  if (!failures.length) {
    // The project is given a file, edited once more and closed with Save: the prompt's Save writes that file.
    await page.evaluate(() => window.__fz.leaveAll()).catch(() => {});
    const trace = summary.trace = [];
    const mark = async name => trace.push(`${name}: sources ${await page.evaluate(() => Object.keys(window.styk.editor.report._styk.frameSources ?? {}).join(',').replace(/frame-/g, ''))} dirty ${await page.evaluate(() => window.styk.editor.dirty)} rev ${await page.evaluate(() => window.styk.editor.revision)}`);
    await mark('before save as');
    const target = file('closed');
    await app.evaluate((_e, f) => { globalThis.__save.next = f; }, target);
    await page.evaluate(() => window.styk.actions['save-as']());
    for (let i = 0; i < 300 && !existsSync(target); i++) await sleep(100);
    try { await waitSaved(); } catch (error) { fail('close-save', 'save', `Save As did not finish (${error.message.split('\n')[0]})`); }
    await mark('after save as');
    if (!failures.length) {
      await page.evaluate(() => window.__fz.edit());
      await mark('after edit and leave');
      await page.evaluate(() => window.__fz.leaveAll()).catch(() => {});
      summary.closing = await page.evaluate(() => ({dirty: window.styk.editor.dirty, tabs: window.styk.projects?.tabs?.size, name: window.styk.editor.name}));
      const expected = await page.evaluate(() => window.__fz.canonical());
      await app.evaluate(() => { globalThis.__close = 0; });
      const closing = new Promise(resolve => app.once('close', () => resolve(true)));
      // The close button is pressed in the page: a notice over it would stop a click that checks what is in front.
      await page.evaluate(() => document.querySelector('#window-controls [data-action="close"]').click()).catch(() => {});
      if (await Promise.race([closing, sleep(30000).then(() => false)])) {
        app = null;
        summary.files = readdirSync(folder).map(n => `${n}:${statSync(path.join(folder, n)).size}`);
        await launch(); await install(false);
        await sleep(3000);
        try { const {canonical} = await reopen(target); summary.opened++; const d = diff(expected, canonical); if (d) { fail('close-save', 'differs', d); if (process.env.STYK_KEEP_FAILED) { copyFileSync(target, process.env.STYK_KEEP_FAILED + '.closed'); const killed = readdirSync(folder).find(n => n.startsWith('killed-')); if (killed) copyFileSync(path.join(folder, killed), process.env.STYK_KEEP_FAILED + '.killed'); } } } catch (error) { fail('close-save', 'open', error.message); }
      } else fail('close-save', 'hang', 'the window did not close after Save');
    }
  }
  summary.failures = failures.slice(0, 3);
  if (pageErrors.length) summary.pageErrors = pageErrors.slice(0, 3);
  if (failures.length) summary.tail = log.slice(-12);
  console.log(JSON.stringify(summary, null, quiet() ? 0 : 1));
} catch (error) {
  failures.push({kind: 'driver', error: String(error?.stack ?? error).slice(0, 600)});
  console.log(JSON.stringify({...summary, failures, tail: log.slice(-8)}, null, 1));
} finally {
  await stop().catch(() => {});
  await sleep(500);
  await rm(profile, {recursive: true, force: true}).catch(() => {});
}
function quiet() { return flag('--quiet'); }
process.exit(failures.length ? 1 : 0);
