import {readNativeDocument} from './read-native-document.mjs';
import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir, writeFile, readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), out = path.join(root, 'artifacts');
const directory = path.join(out, `simple-native-${Date.now()}`), profile = path.join(directory, 'profile'), saved = path.join(directory, 'Working draft.styk');
await mkdir(directory, {recursive: true});
const checks = [], errors = [], applications = [];
const record = name => { checks.push(name); console.log(`PASS ${name}`); };
const launch = () => electron.launch({args: [root], cwd: root, timeout: 45000, env: {...process.env, STYK_USER_DATA_DIR: profile}});
let clipboardApp;
try {
  const app = await launch(); applications.push(app); clipboardApp = app;
  const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.styk?.ready);
  await page.evaluate(async () => {
    styk.settingsUI.commit({timelineMode: 'simple', autosaveSeconds: 0}); await styk.settingsUI.flush();
    const {emptyDocument, createFrame, createObject} = await import('/src/demo.mjs');
    const report = emptyDocument(), figure = report.figure_types[0];
    report.keyframes = [0, 1, 2].map(i => createFrame([createObject(figure, 1, 100 + i * 20, 180)], 3));
    styk.editor.load(report); styk.editor.enableFrameDrafts({mode: 'add', index: 2, restoreSaved: false});
    window.__setX = async value => {
      const {beginNativePropertyEdit, previewNativePropertyEdit, commitNativePropertyEdit} = await import('/src/native-property-edit.mjs');
      styk.editor.select(1); const token = beginNativePropertyEdit(styk.editor, 'root_x'); previewNativePropertyEdit(token, value); commitNativePropertyEdit(token);
    };
  });
  const main = page.locator('#timeline .styk-simple-update');
  await page.evaluate(() => __setX(220)); await main.click();
  assert.deepEqual(await page.evaluate(() => styk.editor.report.keyframes.map(frame => frame.objects[0].root_x)), [100, 120, 140, 220]);
  assert.equal(await main.textContent(), 'Add frame'); record('Add appends the working pose while preserving the previous saved frame.');
  await page.locator('#timeline [data-frame="1"] button').click(); assert.equal(await main.textContent(), 'Update frame');
  await page.evaluate(() => __setX(330));
  await page.locator('#timeline [data-frame="1"] button').click();
  await page.locator('#keep-frame-draft').click();
  assert.equal(await page.evaluate(() => styk.editor.frame.objects[0].root_x), 330);
  await page.locator('#timeline [data-frame="1"] button').click(); await page.locator('#discard-frame-draft').click();
  await page.waitForFunction(() => styk.editor.frame.objects[0].root_x === 120);
  assert.equal(await page.evaluate(() => styk.editor.frame.objects[0].root_x), 120);
  record('Actual reclick dialog: Keep preserves the draft and Discard restores the saved pose.');
  await page.evaluate(() => styk.editor.undo()); assert.equal(await page.evaluate(() => styk.editor.frame.objects[0].root_x), 330);
  await page.evaluate(() => styk.editor.redo()); assert.equal(await page.evaluate(() => styk.editor.frame.objects[0].root_x), 120); record('Discard supports Undo and Redo.');
  await page.evaluate(() => __setX(350)); await page.locator('#timeline [data-frame="2"] button').click();
  assert.equal(await page.evaluate(() => styk.editor.report.keyframes[1].objects[0].root_x), 350); record('Selecting another frame commits the edited frame.');
  await page.evaluate(() => __setX(360)); await main.click(); assert.equal(await main.textContent(), 'Add frame');
  assert.equal(await page.evaluate(() => styk.editor.frameIndex), 3);
  assert.equal(await page.evaluate(() => styk.editor.frame.objects[0].root_x), 220);
  await page.evaluate(() => __setX(370)); await main.click();
  assert.equal(await page.evaluate(() => styk.editor.report.keyframes[2].objects[0].root_x), 360);
  assert.equal(await page.evaluate(() => styk.editor.frame.objects[0].root_x), 370); record('Update transitions to Add; the next working pose appends at the end.');

  // Preserve all common clipboard representations privately inside Electron main.
  const supported = await app.evaluate(({clipboard}) => {
    const formats = clipboard.availableFormats(), allowed = new Set(['text/plain', 'text/html', 'text/rtf', 'image/png', 'text/uri-list']);
    if (formats.some(format => !allowed.has(format))) return false;
    globalThis.__originalClipboard = {text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(), image: clipboard.readImage()};
    return true;
  });
  assert.ok(supported, 'Clipboard contains only representations this smoke can restore safely.');
  try {
    await page.evaluate(() => { styk.editor.select(1, 1); styk.actions['segment-values'](); });
    await page.locator('#segment-values-copy').click();
    await page.waitForFunction(() => document.getElementById('segment-values-status').textContent === 'Segment values copied.');
    assert.match(await app.evaluate(({clipboard}) => clipboard.readText()), /^[-\d.]+:[-\d.]+:[-\d.]+$/);
    await app.evaluate(({clipboard}) => clipboard.writeText('45:0:50'));
    await page.locator('#segment-values-paste').click(); await page.waitForFunction(() => document.getElementById('segment-values-status').textContent === 'Pasted 3 values.');
    assert.equal(await page.locator('#segment-angle').inputValue(), '45'); assert.equal(await page.locator('#segment-length').inputValue(), '50');
    await page.locator('#segment-values-apply').click(); record('Actual Segment Values Copy/Paste buttons use the native text clipboard.');
    assert.equal(await page.evaluate(async () => { try { await stykDesktop.writeClipboardText('x'.repeat(101)); return false; } catch { return true; } }), true);
    await app.evaluate(({clipboard}) => clipboard.writeText('x'.repeat(101)));
    assert.equal(await page.evaluate(async () => { try { await stykDesktop.readClipboardText(); return false; } catch { return true; } }), true);
    record('Native clipboard rejects text longer than 100 characters.');
  } finally { await app.evaluate(({clipboard}) => { clipboard.write(globalThis.__originalClipboard); delete globalThis.__originalClipboard; }); }

  await page.evaluate(() => { styk.editor.beginFrameDraft({mode: 'add'}); }); await page.evaluate(() => __setX(450));
  const thumbnails = await page.evaluate(async () => {
    const {ThumbnailRenderer} = await import('/src/thumbnail-renderer.mjs');
    const {Editor} = await import('/src/editor.mjs'); const {storedFrameReport} = await import('/src/pivot-frame-draft.mjs');
    const baseline = new Editor({demo:false}).load(structuredClone(storedFrameReport(styk.editor.report)));
    const expected = new ThumbnailRenderer(baseline), working = new ThumbnailRenderer(styk.editor);
    const canvases = Array.from({length:3}, () => { const canvas = document.createElement('canvas'); canvas.width=180; canvas.height=120; return canvas; });
    try {
      const rendered = [await styk.timeline.renderThumbnail(4,canvases[0]), await expected.renderThumbnail(4,canvases[1]), await working.renderThumbnail(4,canvases[2])];
      const pixels = canvases.map(canvas => canvas.toDataURL());
      return {rendered,storedMatches:pixels[0]===pixels[1],workingDiffers:pixels[0]!==pixels[2]};
    } finally { expected.destroy(); working.destroy(); }
  });
  assert.deepEqual(thumbnails.rendered,[true,true,true]); assert.equal(thumbnails.storedMatches,true); assert.equal(thumbnails.workingDiffers,true);
  record('Actual Simple thumbnail callback renders the stored baseline, distinct from the visible Add draft.');
  await page.evaluate(() => {
    styk.state.loop=false; window.__playbackSamples=[];
    const sample=()=>{ const packet=styk.state.playbackPacket; if(packet) __playbackSamples.push({tick:packet.tick,x:packet.transforms[4],stored:packet.storedFrames}); if(styk.state.playing) requestAnimationFrame(sample); };
    styk.actions.play(); requestAnimationFrame(sample);
  });
  await page.waitForFunction(() => !styk.state.playing, null, {timeout:15000});
  const playback = await page.evaluate(() => ({samples:__playbackSamples,draft:styk.editor.frameDraft,index:styk.editor.frameIndex,x:styk.editor.frame.objects[0].root_x}));
  assert.ok(playback.samples.length); assert.ok(playback.samples.every(sample=>sample.x!==450 && sample.stored));
  assert.ok(playback.samples.some(sample=>sample.x===370)); assert.equal(playback.index,4); assert.equal(playback.x,450); assert.equal(playback.draft.dirty,true);
  record('Actual Play uses stored frames; Stop restores the Add working pose and checkpoint.');
  // Save must commit a still-held native gesture before taking its snapshot.
  await page.evaluate(() => { styk.editor.select(1); styk.editor.beginTranslationDrag(); styk.editor.moveSelection(20,0,{fromStart:true}); });
  await app.evaluate(({dialog}, filename) => { dialog.showSaveDialog = async () => ({canceled: false, filePath: filename}); }, saved);
  await page.evaluate(() => styk.actions.save());
  const native = await readNativeDocument(saved);
  assert.equal(native.keyframes.length, 5); assert.equal(native._styk.simpleFrameDraft.mode, 'add');
  assert.equal(native._styk.simpleFrameDraft.baseline.objects[0].root_x, 370); assert.equal(native.keyframes[4].objects[0].root_x, 470);
  const recent = await page.evaluate(() => stykDesktop.listRecentFiles()); assert.equal(recent[0].name, 'Working draft.styk');
  assert.equal(await page.evaluate(async () => { try { await stykDesktop.openRecentFile('../../outside.styk'); return false; } catch { return true; } }), true);
  record('Save commits a held gesture, preserves the STYK draft without appending, and adds an opaque Recent Files entry.');
  const origin = new URL(page.url()).origin;
  await page.evaluate(async () => { await stykDesktop.setDocumentState({dirty: false}); }); await app.close(); applications.splice(applications.indexOf(app), 1); clipboardApp = null;
  const restarted = await launch(); applications.push(restarted);
  const reopened = await restarted.firstWindow(); reopened.on('pageerror', error => errors.push(error.message)); await reopened.waitForFunction(() => window.styk?.ready);
  assert.notEqual(new URL(reopened.url()).origin, origin);
  await reopened.evaluate(() => styk.actions['open-recent']()); await reopened.locator('[data-recent-id]').first().click();
  await reopened.waitForFunction(() => styk.editor.name==='Working draft' && styk.editor.frameDraft?.dirty, null, {timeout:15000});
  const restored=await reopened.evaluate(async()=>({recent:(await stykDesktop.listRecentFiles())[0].name,count:styk.editor.report.keyframes.length,draft:styk.editor.frameDraft,x:styk.editor.frame.objects[0].root_x}));
  assert.equal(restored.recent, 'Working draft.styk'); assert.equal(restored.count, 5); assert.equal(restored.draft.mode, 'add'); assert.equal(restored.draft.dirty, true); assert.equal(restored.x, 470);
  await reopened.evaluate(() => styk.actions['open-recent']()); await reopened.locator('#clear-recent').click();
  await reopened.waitForFunction(()=>document.querySelector('.recent-files')?.textContent==='No recent files.');
  assert.deepEqual(await reopened.evaluate(() => stykDesktop.listRecentFiles()), []); await readFile(saved);
  record('Whole-app restart on a new origin restores Recent Files and the saved Add draft; clearing history retains files.');
  assert.deepEqual(errors, []);
  await writeFile(path.join(out, 'simple-native-smoke.json'), JSON.stringify({timestamp: new Date().toISOString(), checks, errors, restored, thumbnails, playback, profile}, null, 2));
} finally {
  if (clipboardApp) await clipboardApp.evaluate(({clipboard}) => { if (globalThis.__originalClipboard) clipboard.write(globalThis.__originalClipboard); }).catch(() => {});
  for (const app of applications.reverse()) await app.close().catch(() => {});
}
