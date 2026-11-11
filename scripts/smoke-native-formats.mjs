#!/usr/bin/env node
// Desktop round trip of the three native formats through the Pivot codec the app ships
// (docs/engine/formats-piv.md): for a .piv, a .stk and a .styk, open the file through
// File → Open, edit it, save it as a project, export it back to its own format where that
// format is Pivot's, then open every written file again and check the edit survived.
// An animation (.piv, .styk) gets a figure moved; a figure (.stk, which opening adds to
// the animation on screen) gets a segment's thickness and colour changed. The source
// files are never written.
//
//   xvfb-run -a node scripts/smoke-native-formats.mjs [--piv <file>] [--stk <file>] [--styk <file>]
//
// Defaults: files of the private corpus where present (~/Downloads), else files in the
// repository. Run it under xvfb-run so no window appears. Output in
// artifacts/native-formats-<time>/: the written files and report.json. Exit code 1 when a
// step fails.
import {_electron as electron} from '../tests/support/playwright.mjs';
import {mkdir, readFile, stat, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const pick = (...files) => files.find(existsSync) ?? files.at(-1);
const option = (name, ...fallback) => { const at = args.indexOf(name); return at < 0 ? pick(...fallback) : path.resolve(args[at + 1]); };
const home = os.homedir();
const sources = {
  piv: option('--piv', path.join(home, 'Downloads/pivs/AyameDemo.piv'), path.join(root, 'engine/crates/styk-piv/tests/fixtures/legacy-v2.piv')),
  stk: option('--stk', path.join(home, 'Downloads/WafflesPack/Mix\'N\'Match Extra - UNFINISHED/Receivers/Revolver Receiver.stk'), path.join(root, 'engine/crates/styk-piv/tests/fixtures/figure-modern.stk')),
  styk: option('--styk', path.join(root, 'AssetReleases/3D-Guns/Scenes/Demos/01-Fire-and-Reload.styk')),
};
const run = path.join(root, 'artifacts', `native-formats-${Date.now()}`);
await mkdir(run, {recursive: true});
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const before = Object.fromEntries(await Promise.all(Object.entries(sources).map(async ([kind, file]) => [kind, await hash(file)])));
const env = {...process.env, STYK_USER_DATA_DIR: path.join(run, 'profile'), STYK_LIBRARY_DIR: path.join(run, 'library'), STYK_STARTUP_VIEW: 'editor'};
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({args: [root], cwd: root, env, timeout: 60000});
const report = {sources, steps: [], errors: []};
let failed = false;
try {
  const page = await app.firstWindow({timeout: 60000});
  page.on('pageerror', error => report.errors.push(error.message.slice(0, 300)));
  await page.waitForFunction(() => window.styk?.ready === true, null, {timeout: 60000});
  await page.evaluate(() => { document.querySelector('.styk-privacy [data-decline]')?.click(); for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close(); });
  // The native dialogs answer from a queue: an Open or Save the smoke did not plan fails it.
  await app.evaluate(({dialog}) => {
    globalThis.__opens = []; globalThis.__saves = [];
    dialog.showOpenDialog = async () => { const next = globalThis.__opens.shift(); if (!next) throw new Error('An unexpected Open dialog appeared.'); return {canceled: false, filePaths: [next]}; };
    dialog.showSaveDialog = async () => { const next = globalThis.__saves.shift(); if (!next) throw new Error('An unexpected Save dialog appeared.'); return {canceled: false, filePath: next}; };
  });
  const queue = (key, file) => app.evaluate((_electron, {key, file}) => { globalThis[key].push(file); }, {key, file});
  /** Opens `file` through File → Open and waits until the editor has it. */
  const open = async file => {
    const token = await page.evaluate(() => (window.__openCount = (window.__openCount ?? 0) + 1));
    await queue('__opens', file);
    await page.evaluate(async () => { await window.styk.actions.open(); });
    await page.waitForFunction(() => !window.styk.state.importing, null, {timeout: 120000});
    const name = await page.evaluate(() => window.styk.editor.name ?? document.title);
    return {token, name};
  };
  /** The first figure of the frame on show: its identity and where its root is. */
  const figure = () => page.evaluate(() => {
    const object = window.styk.editor.evaluatedFrame.objects.find(o => !o.join) ?? window.styk.editor.evaluatedFrame.objects[0];
    return object ? {uid: object.unique_id, x: object.root_x, y: object.root_y, figures: window.styk.editor.evaluatedFrame.objects.length} : null;
  });
  const step = async (name, body) => {
    const started = Date.now();
    try { const detail = await body(); report.steps.push({name, ok: true, ms: Date.now() - started, ...(detail ?? {})}); console.log(`ok   ${name}`); }
    catch (error) { failed = true; report.steps.push({name, ok: false, error: String(error?.message ?? error).slice(0, 500)}); console.log(`FAIL ${name}: ${String(error?.message ?? error).split('\n')[0]}`); }
  };
  /** The figures on show, by identity. */
  const shown = () => page.evaluate(() => window.styk.editor.evaluatedFrame.objects.map(object => object.unique_id));
  /** Segment 0 of the definition of the figure `uid` shows. */
  const segment = uid => page.evaluate(uid => {
    const editor = window.styk.editor, object = editor.evaluatedFrame.objects.find(o => o.unique_id === uid);
    const figure = editor.report.figure_types.find(f => f.figure_type_id === object?.figure_type_id);
    return figure ? {name: figure.name, thickness: figure.segments[0].thickness, color: figure.segments[0].color_rgb} : null;
  }, uid);
  const DEFINITION = {thickness: 7.5, color_rgb: [12, 200, 34]};
  for (const [kind, source] of Object.entries(sources)) {
    // The tick the edit is made at: a file opened again starts elsewhere, so checks seek back.
    let moved = null, added = null, tick = 0;
    await step(`${kind}: open ${path.basename(source)}`, async () => {
      const previous = await shown();
      await open(source);
      const now = await shown();
      added = now.find(uid => !previous.includes(uid)) ?? null;
      tick = await page.evaluate(() => window.styk.editor.tick);
      assert.ok(now.length, 'the opened file shows a figure');
      if (kind === 'stk') assert.ok(added !== null, 'opening the figure added it to the animation');
      return {figures: now.length, tick};
    });
    if (kind === 'stk') await step('stk: change a segment of the figure', async () => {
      await page.evaluate(({uid, patch}) => { const editor = window.styk.editor; editor.select(uid, 0); if (!editor.updateSegment(patch)) throw new Error('updateSegment refused'); }, {uid: added, patch: DEFINITION});
      const after = await segment(added);
      assert.deepEqual([after.thickness, after.color], [DEFINITION.thickness, DEFINITION.color_rgb]);
    });
    else await step(`${kind}: move a figure`, async () => {
      const first = await figure();
      await page.evaluate(uid => { const editor = window.styk.editor; editor.select(uid, -1); editor.moveSelection(17, -9); }, first.uid);
      const after = await figure();
      assert.equal(after.uid, first.uid);
      assert.ok(Math.abs(after.x - first.x - 17) < 1e-6 && Math.abs(after.y - first.y + 9) < 1e-6, `the figure moved by (17, -9): ${JSON.stringify({first, after})}`);
      moved = after;
    });
    const project = path.join(run, `${kind}-edited.styk`);
    await step(`${kind}: save as a project`, async () => {
      await queue('__saves', project);
      await page.evaluate(async () => { await window.styk.actions['save-as'](); });
      await page.waitForFunction(() => !window.styk.editor.dirty, null, {timeout: 120000});
      return {bytes: (await stat(project)).size};
    });
    const exported = kind === 'styk' ? null : path.join(run, `${kind}-edited.${kind}`);
    if (exported) await step(`${kind}: export as .${kind}`, async () => {
      // A figure export writes the selected figure.
      if (kind === 'stk') await page.evaluate(uid => window.styk.editor.select(uid, -1), added);
      await queue('__saves', exported);
      await page.evaluate(async action => { await window.styk.actions[action](); }, `export-${kind}`);
      for (let i = 0; i < 600 && !(await stat(exported).catch(() => null)); i++) await new Promise(resolve => setTimeout(resolve, 100));
      return {bytes: (await stat(exported)).size};
    });
    for (const written of [project, exported].filter(Boolean)) await step(`${kind}: open ${path.basename(written)} again`, async () => {
      const previous = await shown();
      await open(written);
      // An added figure is checked where opening put it; an edit, where it was made.
      if (!(kind === 'stk' && written.endsWith('.stk'))) await page.evaluate(tick => window.styk.editor.seek(tick), tick);
      if (kind === 'stk' && written.endsWith('.stk')) {
        // The figure is added to the animation again, as a new figure with its definition.
        const again = (await shown()).find(uid => !previous.includes(uid));
        assert.ok(again !== undefined, 'opening the exported figure added it');
        const definition = await segment(again);
        assert.deepEqual([definition.thickness, definition.color], [DEFINITION.thickness, DEFINITION.color_rgb], `the segment change survived: ${JSON.stringify(definition)}`);
        return;
      }
      if (kind === 'stk') {
        const definition = await segment(added);
        assert.ok(definition, `figure ${added} is in ${path.basename(written)}`);
        assert.deepEqual([definition.thickness, definition.color], [DEFINITION.thickness, DEFINITION.color_rgb]);
        return;
      }
      const again = await page.evaluate(uid => { const object = window.styk.editor.evaluatedFrame.objects.find(o => o.unique_id === uid); return object ? {x: object.root_x, y: object.root_y} : null; }, moved.uid);
      assert.ok(again, `figure ${moved.uid} is in ${path.basename(written)}`);
      // Pivot files store coordinates in single precision.
      const tolerance = written.endsWith('.styk') ? 1e-9 : 1e-3;
      assert.ok(Math.abs(again.x - moved.x) <= tolerance && Math.abs(again.y - moved.y) <= tolerance, `the move survived: ${JSON.stringify({moved, again})}`);
    });
  }
  await step('the source files were not written', async () => {
    for (const [kind, file] of Object.entries(sources)) assert.equal(await hash(file), before[kind], `${kind} source unchanged`);
  });
  if (report.errors.length) { failed = true; console.log(`FAIL page errors: ${report.errors.join(' | ').slice(0, 600)}`); }
} finally {
  // The last document may be unsaved: leave without the save-before-close question.
  await Promise.race([app.evaluate(({app}) => app.exit(0)).catch(() => {}), new Promise(resolve => setTimeout(resolve, 5000))]);
  await app.close().catch(() => {});
  await writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 1));
}
console.log(`${report.steps.filter(s => s.ok).length}/${report.steps.length} steps passed; ${path.relative(root, run)}`);
process.exit(failed ? 1 : 0);
