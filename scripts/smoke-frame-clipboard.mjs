import {_electron as electron} from 'playwright';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(appRoot, 'artifacts'), profile = path.join(output, `clipboard-profile-${Date.now()}`);
await mkdir(profile, {recursive: true});
const launch = () => electron.launch({args: [appRoot], cwd: appRoot, timeout: 45000, env: {...process.env, STYK_USER_DATA_DIR: profile}});
const applications = [], errors = [], checks = [];
try {
  const app = await launch(); applications.push(app); const page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.styk?.ready, undefined, {timeout: 45000});
  const firstOrigin = new URL(page.url()).origin;
  const results = await page.evaluate(async () => {
    const {Editor} = await import('/src/editor.mjs');
    const {ImportClient} = await import('/src/import-client.mjs');
    const {DocumentExporter} = await import('/src/document-export.mjs');
    const {installNativeFrameClipboard} = await import('/src/frame-clipboard-storage.mjs');
    const {emptyDocument, createFrame, createObject} = await import('/src/demo.mjs');
    const {buildGeometry, evaluatedFrame, timeline} = await import('/src/pivot/geometry.mjs');
    const {validateScene} = await import('/src/pivot/model.mjs');
    const importer = new ImportClient(), exporter = new DocumentExporter(), results = [];
    const check = (value, message) => { if (!value) throw new Error(message); };
    const geometry = (report, index) => buildGeometry(report, evaluatedFrame(report, index, 0)).drawables.map(shape => ({type: shape.type,
      x: Math.round(shape.start.x * 1000) / 1000, y: Math.round(shape.start.y * 1000) / 1000, rgb: shape.rgb}));
    for (const fixture of ['Pivot Animator v5/Animations/text_bike.piv', 'Pivot Animator v5/Animations/Legacy/sprite_demo.piv', 'Pivot Animator v5/Animations/tween_NY_day-night.piv']) {
      const source = await importer.openSample(fixture), editor = new Editor({demo: false}).load(source.document);
      const indices = [...new Set([0, source.document.keyframes.length - 1])];
      const expected = indices.map(index => geometry(editor.report, index));
      editor.copyFrames(indices); editor.load(emptyDocument()); const before = JSON.stringify(editor.report);
      editor.appendClipboardFrames(); validateScene(editor.report);
      const styk = await exporter.export(editor.report, {format: 'styk', name: 'Clipboard roundtrip'});
      const reopened = await importer.importFile(new File([styk], 'Clipboard roundtrip.styk'));
      check(JSON.stringify(expected) === JSON.stringify(indices.map((_, index) => geometry(reopened.document, index + 1))), `${fixture}: STYK geometry changed`);
      const piv = await exporter.export(editor.report, {format: 'piv', name: 'Clipboard roundtrip'}).catch(error => {
        throw new Error(`${fixture}: ${error.message}; assets ${JSON.stringify(editor.report.figure_types.flatMap(figure => [...(figure.image_assets ?? []), ...(figure.text_assets ?? [])].map(asset => ({kind: asset.kind, keys: Object.keys(asset)}))))}`);
      });
      const pivot = await importer.importFile(new File([piv], 'Clipboard roundtrip.piv'));
      check(JSON.stringify(expected) === JSON.stringify(indices.map((_, index) => geometry(pivot.document, index + 1))), `${fixture}: native PIV geometry changed`);
      editor.undo(); check(JSON.stringify(editor.report) === before, `${fixture}: undo failed`); editor.redo(); validateScene(editor.report);
      results.push({fixture, copiedFrames: indices.length, stykBytes: styk.size, pivBytes: piv.size,
        figures: reopened.document.figure_types.length, backgrounds: reopened.document.backgrounds.length});
    }
    const nativeText = await importer.openSample('Pivot Animator v5/Animations/text_bike.piv');
    const authoredEditor = new Editor({demo: false}).load(nativeText.document); authoredEditor.copyFrames([0]);
    const authored = emptyDocument(); authored.keyframes = [0, 40, 80].map((x, index) => createFrame([createObject(authored.figure_types[0], 1, x, 250)], index === 2 ? 1 : 4));
    authoredEditor.load(authored); authoredEditor.adoptNativePoseTrack({kind: 'layer', id: 'layer-1'});
    authoredEditor.addAnimationKeys([{target: {kind: 'camera'}, property: 'x', tick: 0, value: 0}, {target: {kind: 'camera'}, property: 'x', tick: 20, value: 100},
      {target: {kind: 'scene'}, property: 'color', tick: 0, value: 0xff002244}, {target: {kind: 'scene'}, property: 'color', tick: 20, value: 0xff88aabb}]);
    authoredEditor.pasteFrames(1);
    const authoredPiv = await exporter.export(authoredEditor.report, {format: 'piv', name: 'Authored frame clipboard'});
    const authoredReopen = await importer.importFile(new File([authoredPiv], 'Authored frame clipboard.piv'));
    const signatureAt = (report, tick) => {
      const rows = timeline(report); let index = 0; while (index < rows.length - 1 && rows[index + 1].start <= tick) index++;
      const row = rows[index], frame = evaluatedFrame(report, index, row.count ? (tick - row.start) / row.count : 0, tick);
      return buildGeometry(report, frame).drawables.map(shape => ({type: shape.type, x: Math.round(shape.start.x * 1000) / 1000, y: Math.round(shape.start.y * 1000) / 1000, rgb: shape.rgb}));
    };
    const duration = authoredEditor.totalTicks;
    for (let tick = 0; tick < duration; tick++) check(JSON.stringify(signatureAt(authoredEditor.report, tick)) === JSON.stringify(signatureAt(authoredReopen.document, tick)), `Authored native frame clipboard differs at tick ${tick}`);
    results.push({fixture: 'Authored destination plus real native text clipboard', validatedOutputTicks: duration, pivBytes: authoredPiv.size});
    window.clipboardEditor = new Editor({demo: false});
    window.clipboardStore = installNativeFrameClipboard(clipboardEditor, window.stykDesktop, {onError: error => { window.clipboardError = error.message; }});
    await clipboardStore.ready;
    const text = await importer.openSample('Pivot Animator v5/Animations/text_bike.piv');
    clipboardEditor.load(text.document); clipboardEditor.copyFrames([0]);
    await clipboardStore.flush(); check(!window.clipboardError, window.clipboardError);
    window.clipboardExpected = geometry(text.document, 0);
    const transaction = await window.stykDesktop.beginClipboardWrite({size: 9, destination: 'C:/untrusted/ignored.styk'});
    await window.stykDesktop.writeFileChunk(transaction.token, new Uint8Array([1, 2, 3]).buffer);
    await window.stykDesktop.cancelFileWrite(transaction.token);
    let rejected = false;
    try { await window.stykDesktop.beginClipboardWrite({size: 257 * 1024 * 1024}); } catch { rejected = true; }
    check(rejected, 'Oversized clipboard accepted');
    importer.dispose(); exporter.dispose(); return {results, expected: window.clipboardExpected};
  });
  checks.push('Real text, legacy sprite, and blended-background frame copies export/reopen as both STYK and native PIV, with geometry preserved and one undo');
  checks.push('Clipboard worker export saves via bounded native chunks; partial cancelled/oversized overwrite preserves last complete clipboard');
  const saved = await readFile(path.join(profile, 'frame-clipboard.styk'));
  assert.ok(saved.length > 1000);
  await page.evaluate(() => clipboardStore.dispose()); await app.close();
  const restarted = await launch(); applications.push(restarted); const next = await restarted.firstWindow();
  next.on('pageerror', error => errors.push(error.message));
  await next.waitForFunction(() => window.styk?.ready, undefined, {timeout: 45000});
  const secondOrigin = new URL(next.url()).origin;
  const restored = await next.evaluate(async expected => {
    const {Editor} = await import('/src/editor.mjs'), {installNativeFrameClipboard} = await import('/src/frame-clipboard-storage.mjs');
    const {buildGeometry, evaluatedFrame} = await import('/src/pivot/geometry.mjs');
    const editor = new Editor({demo: false}), store = installNativeFrameClipboard(editor, window.stykDesktop);
    const didRestore = await store.ready; await store.flush();
    editor.appendClipboardFrames();
    const actual = buildGeometry(editor.report, evaluatedFrame(editor.report, 1, 0)).drawables.map(shape => ({type: shape.type,
      x: Math.round(shape.start.x * 1000) / 1000, y: Math.round(shape.start.y * 1000) / 1000, rgb: shape.rgb}));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Restored clipboard geometry differs after full process restart');
    store.dispose(); return {didRestore, count: editor.clipboardFrameCount};
  }, results.expected);
  assert.equal(restored.didRestore, true); assert.equal(restored.count, 1); assert.equal(errors.length, 0);
  checks.push('A new desktop process/backend origin restores embedded native text assets and pasted geometry from the persistent app clipboard');
  const report = {checkedAt: new Date().toISOString(), checks, fixtures: results.results, persistedBytes: saved.length, firstOrigin, secondOrigin, restored, errors};
  await writeFile(path.join(output, 'desktop-frame-clipboard-smoke.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const app of applications.reverse()) await app.close().catch(() => {});
}
