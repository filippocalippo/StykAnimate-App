/** Real worker snapshots, binary fidelity, cancellation, and UI responsiveness. */
import {chromium} from 'playwright';
import {createRequire} from 'node:module';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const {startBackend} = require('../desktop/backend.cjs');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePaths = process.argv.slice(2);
if (!fixturePaths.length) fixturePaths.push('Pivot Animator v5/Animations/tween_camera.piv',
  'Pivot Animator v5/Figures/sheep.stk', 'Pivot Animator v5/Animations/Legacy/walking.piv',
  'Pivot Animator v5/Animations/Legacy/cursor.piv', 'Pivot Animator v5/Animations/Legacy/sprite_demo.piv',
  'Goku_Broly_Movie_by_Killer1.piv',
  'PIVOT ANIMATOR SCENE TEST/Shroobs_JJK_Pack.piv');
const fixtures = await Promise.all(fixturePaths.map(async relative => {
  const filename = path.resolve(appRoot, '..', relative), source = await readFile(filename);
  return {filename, name: path.basename(filename), format: path.extname(filename).slice(1),
    bytes: source.length, sha256: createHash('sha256').update(source).digest('hex')};
}));
let backend = await startBackend({appRoot}), browser;
try {
  try { browser = await chromium.launch({headless: true}); }
  catch { browser = await chromium.launch({channel: 'chrome', headless: true}); }
  const page = await browser.newPage();
  await page.goto(`${backend.origin}/api/health`);
  await page.setContent('<input type="file" id="fixture">');
  await page.evaluate(async () => {
    const {DocumentExporter} = await import('/src/document-export.mjs');
    const {ImportClient} = await import('/src/import-client.mjs');
    window.exporter = new DocumentExporter(); window.importer = new ImportClient(); window.nativeFiles = [];
    window.hash = async blob => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))]
      .map(n => n.toString(16).padStart(2, '0')).join('');
  });
  const checks = [];
  for (const fixture of fixtures) {
    await page.locator('#fixture').setInputFiles(fixture.filename);
    const result = await page.evaluate(async original => {
      const imported = await importer.importFile(document.querySelector('#fixture').files[0]);
      window.current = imported;
      let active = true, previous = performance.now(), maxGap = 0;
      const tasks = [], observer = new PerformanceObserver(list => tasks.push(...list.getEntries().map(e => e.duration)));
      observer.observe({type: 'longtask', buffered: false});
      function tick(now) { maxGap = Math.max(maxGap, now - previous); previous = now; if (active) requestAnimationFrame(tick); }
      requestAnimationFrame(tick);
      const output = await exporter.export(imported.document, {sourceId: imported.sourceId, format: original.format, name: original.name});
      const timings = {...exporter.lastTimings};
      active = false; await new Promise(resolve => setTimeout(resolve, 30)); observer.disconnect();
      const sha256 = await hash(output);
      if (output.size !== original.bytes || sha256 !== original.sha256) {
        const {synchronizeExistingDerived} = await import('/src/document-normalize.mjs');
        const normalized = structuredClone(imported.document); synchronizeExistingDerived(normalized);
        const differences = [];
        function compare(a, b, path = '') {
          if (differences.length >= 12 || Object.is(a, b)) return;
          if (a && b && typeof a === 'object' && typeof b === 'object') {
            for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) compare(a[key], b[key], `${path}/${key}`);
          } else differences.push({path, before: a, after: b});
        }
        compare(imported.document, normalized);
        throw new Error(`${original.name} worker no-op export changed bytes (${output.size} vs ${original.bytes}; ${sha256}). Derived differences: ${JSON.stringify(differences)}`);
      }
      const native = await exporter.export(imported.document, {sourceId: imported.sourceId, format: 'styk', name: original.name});
      window.nativeFiles.push({original, blob: native});
      return {name: original.name, bytes: output.size, sha256, nativeBytes: native.size,
        timings, nativeTimings: {...exporter.lastTimings}, longTasks: tasks, maxAnimationFrameGapMs: maxGap};
    }, fixture);
    checks.push(result); console.log(JSON.stringify(result));
  }
  const behavior = await page.evaluate(async () => {
    const cancelled = new AbortController(); cancelled.abort();
    let before = false, during = false, revision = false;
    try { await exporter.export(current.document, {signal: cancelled.signal}); } catch (error) { before = error.name === 'AbortError'; }
    const mid = new AbortController();
    const ongoing = exporter.export(current.document, {signal: mid.signal});
    setTimeout(() => mid.abort(), 5);
    try { await ongoing; } catch (error) { during = error.name === 'AbortError'; }
    let rev = 1;
    const changed = exporter.export(current.document, {getRevision: () => rev});
    setTimeout(() => rev++, 5);
    try { await changed; } catch (error) { revision = error.name === 'AbortError'; }
    const small = await importer.openSample('Pivot Animator v5/Animations/tween_camera.piv');
    let expired = false;
    try { await exporter.export(small.document, {sourceId: 'missing-source', format: 'piv'}); }
    catch (error) { expired = error.code === 'source_expired' && error.status === 410; }
    if (!expired) throw new Error('Worker export lost the actionable expired-source error.');
    small.document.keyframes[0].objects[0].root_x += .25;
    const expected = small.document.keyframes[0].objects[0].root_x;
    small.document.custom_opaque_asset = {bytes: 'a'.repeat(800000), exact: ['01', null, true, {fraction: .125}]};
    const native = await exporter.export(small.document, {sourceId: small.sourceId, format: 'styk', name: 'Worker edited'});
    window.editedNative = {blob: native, expected};
    if (!before || !during || !revision) throw new Error(`Cancellation failed: ${JSON.stringify({before, during, revision})}`);
    return {preAborted: before, midSnapshotAborted: during, changedRevisionAborted: revision,
      reusedAfterCancellation: true, expiredSourceErrorPreserved: expired};
  });
  const port = backend.port, stopped = once(backend.child, 'exit'); backend.stop(); await stopped;
  backend = await startBackend({appRoot, port});
  const restored = await page.evaluate(async () => {
    const results = [];
    for (const {original, blob} of nativeFiles) {
      const reopened = await importer.importFile(new File([blob], 'restored.styk'));
      const output = await exporter.export(reopened.document, {sourceId: reopened.sourceId, format: original.format});
      const sha256 = await hash(output);
      if (output.size !== original.bytes || sha256 !== original.sha256) throw new Error(`${original.name} lost native restart fidelity (${output.size} bytes).`);
      results.push({name: original.name, bytes: output.size, sha256});
    }
    const reopened = await importer.importFile(new File([editedNative.blob], 'edited.styk'));
    if (reopened.document._styk?.name !== 'Worker edited') throw new Error('The native project lost its authored name.');
    if (reopened.document.custom_opaque_asset?.bytes !== 'a'.repeat(800000) || reopened.document.custom_opaque_asset.exact[3].fraction !== .125)
      throw new Error('Worker snapshot lost unknown nested metadata or a large string.');
    const edited = await exporter.export(reopened.document, {sourceId: reopened.sourceId, format: 'piv'});
    const checked = await importer.importFile(new File([edited], 'edited.piv'));
    if (checked.document.keyframes[0].objects[0].root_x !== editedNative.expected) throw new Error('Worker export lost a real fractional edit.');
    exporter.dispose(); importer.dispose();
    return {results, unknownMetadataPreserved: true, editedNativeRestartPreserved: true};
  });
  const report = {checks, behavior, restored, backendRestarted: true, checkedAt: new Date().toISOString()};
  await mkdir(path.join(appRoot, 'artifacts'), {recursive: true});
  const tag = fixturePaths.some(value => /Akane/i.test(value)) ? '-akane' : '';
  await writeFile(path.join(appRoot, 'artifacts', `document-export-browser${tag}.json`), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await browser?.close(); backend.stop(); }
