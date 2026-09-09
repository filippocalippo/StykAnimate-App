/** Verify actual editor event routing against the application's worker mirror. */
import {chromium} from 'playwright';
import {createRequire} from 'node:module';
import {mkdir, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';
const {startBackend} = createRequire(import.meta.url)('../desktop/backend.cjs');
const appRoot = fileURLToPath(new URL('..', import.meta.url)), artifacts = path.join(appRoot, 'artifacts');
await mkdir(artifacts, {recursive: true});
const report = emptyDocument(); report.keyframes = [100, 200, 300].map(x => createFrame([createObject(report.figure_types[0], 1, x, 250)], 100));
const fixture = new Editor({demo: false}).load(report), fixturePath = path.join(artifacts, 'playback-patch-source.styk');
await writeFile(fixturePath, JSON.stringify(fixture.serialize()));
const backend = await startBackend({appRoot}), checks = [], errors = []; let browser;
try {
  browser = await chromium.launch({channel: 'chrome', headless: true});
  const page = await browser.newPage({viewport: {width: 1400, height: 900}});
  page.on('pageerror', error => errors.push(error.stack || error.message));
  await page.goto(backend.origin); await page.waitForFunction(() => styk?.ready);
  await page.evaluate(async () => {
    const {PlaybackCache} = await import('/src/playback.mjs'), original = PlaybackCache.prototype.prepareRange;
    PlaybackCache.prototype.prepareRange = function(...args) { globalThis.reviewPlayback = this; return original.apply(this, args); };
    globalThis.previousReport = styk.editor.report;
  });
  await page.locator('#file-input').setInputFiles(fixturePath);
  await page.waitForFunction(() => styk.editor.report !== globalThis.previousReport && globalThis.reviewPlayback?.report === styk.editor.report);
  await page.evaluate(() => reviewPlayback.prepareRange([0]));
  async function matches(name, ticks) {
    // Observe either the immediate local patch or the idle full-mirror handoff
    // before inspecting packets (authored/structural history stays conservative).
    await page.waitForFunction(() => styk.state.playbackRevision === styk.editor.revision);
    const results = await page.evaluate(async ticks => {
      const {compilePlaybackPacket} = await import('/src/playback-worker.mjs');
      const results = [];
      for (const tick of ticks) {
        await reviewPlayback.prepareRange([tick]);
        const actual = reviewPlayback.get(tick), expected = await compilePlaybackPacket(styk.editor.report, tick, {scale: reviewPlayback.scale});
        const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
        results.push({tick, shapes: same([...actual.shapes], [...expected.shapes]), transforms: same([...actual.transforms], [...expected.transforms]),
          frame: same(actual.frame, expected.frame), actualUids: [...actual.uids], expectedUids: [...expected.uids], loadKind: reviewPlayback.stats.loadKind});
      }
      return results;
    }, ticks);
    assert.ok(results.every(row => row.shapes && row.transforms && row.frame), `${name}: ${JSON.stringify(results)}`);
    checks.push({name, results}); console.log('PASS', name);
  }
  await matches('Initial native document mirror matches direct evaluation', [0, 29, 100]);
  await page.evaluate(() => {styk.editor.seek(100); styk.editor.select(1); styk.editor.moveSelection(13, -7);});
  await matches('Native local edit matches direct evaluation', [0, 29, 100, 200]);
  await page.evaluate(() => {globalThis.retainedHistoryPacket = reviewPlayback.get(200); styk.editor.undo();});
  assert.equal(await page.evaluate(() => reviewPlayback.get(200) === retainedHistoryPacket), true, 'Local undo retains independent packets.');
  await matches('Native local undo retains correct worker packets', [0, 29, 100, 200]);
  await page.evaluate(() => styk.editor.redo());
  assert.equal(await page.evaluate(() => reviewPlayback.get(200) === retainedHistoryPacket), true, 'Local redo retains independent packets.');
  await matches('Native local redo retains correct worker packets', [0, 29, 100, 200]);
  await page.evaluate(() => {styk.editor.seek(0); styk.editor.addFigure();});
  await matches('Adding a native figure updates playback despite its layer membership event', [0]);
  await page.evaluate(() => styk.editor.duplicateFigure());
  await matches('Duplicating a native figure updates its worker frame', [0]);
  await page.evaluate(() => styk.editor.deleteFigure());
  await matches('Deleting a native figure updates its worker frame', [0]);
  await page.evaluate(() => {styk.editor.select(1); styk.editor.moveSelectionInFrames(75, -15, [0, 1, 2]);});
  await matches('Multi-frame translation sends every changed native frame', [0, 100, 200]);
  await page.evaluate(() => styk.editor.setCameraValues({x: 35, y: 20, scale: 1.25, angle_rad: .2}, [0, 1]));
  await matches('Native Camera range updates retain all changed frames', [0, 29, 100]);
  await page.evaluate(() => styk.editor.setSceneColor(0xffddffee, {indices: [0, 1]}));
  await matches('Scene asset changes use a complete mirror when its table changes', [0, 100]);
  await page.evaluate(() => {
    const editor = styk.editor;
    editor.nativePoseChannel({kind: 'layer', id: 'layer-1'});
    editor.addAnimationKey({kind: 'layer', id: 'layer-1'}, 'pose', 29, {frameId: null});
  });
  await matches('A blank authored pose starts at exact tick29 in worker playback', [28, 29, 30, 100]);
  await page.evaluate(() => styk.editor.addAnimationKeys([
    {target: {kind: 'camera'}, property: 'x', tick: 0, value: 0}, {target: {kind: 'camera'}, property: 'x', tick: 250, value: 250},
    {target: {kind: 'scene'}, property: 'color', tick: 0, value: 0xff112233}, {target: {kind: 'scene'}, property: 'color', tick: 250, value: 0xffaabbcc},
  ]));
  await matches('Authored metadata patches extend the worker timeline and compose fixed tracks', [29, 249, 250]);
  await page.evaluate(() => {styk.editor.seek(10); styk.editor.select(1); styk.editor.moveSelection(22, 11);});
  await matches('An authored canvas pose capture transfers its new retained source', [10, 11]);
  await page.evaluate(() => styk.editor.undo());
  await matches('Undo replaces the worker document without stale authored sources', [10, 11]);
  await page.evaluate(() => styk.editor.redo());
  await matches('Redo restores the authored capture in the worker', [10, 11]);
  assert.deepEqual(errors, []);
  await writeFile(path.join(artifacts, 'playback-app-patch.json'), JSON.stringify({checks, errors}, null, 2));
} finally {await browser?.close(); backend.stop();}
