/** Real worker snapshots, binary fidelity, cancellation, and UI responsiveness. */
import {chromium} from './support/playwright.mjs';
import {createRequire} from 'node:module';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const {startDesktopHost} = require('../desktop/web-host.cjs');
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
const backend = await startDesktopHost({appRoot});
let browser;
try {
  try { browser = await chromium.launch({headless: true}); }
  catch { browser = await chromium.launch({channel: 'chrome', headless: true}); }
  const page = await browser.newPage();
  await page.goto(`${backend.origin}/tests/fixtures/blank.html`);
  await page.setContent('<input type="file" id="fixture">');
  await page.evaluate(async () => {
    const {DocumentExporter} = await import('/src/document-export.mjs');
    const {ImportClient} = await import('/src/import-client.mjs');
    const {Editor} = await import('/src/editor.mjs'), {installEngineOwner} = await import('/src/engine/engine-owner.mjs');
    const {loadEngine} = await import('/src/engine/engine.mjs'), {useEngine} = await import('/src/engine/engine-open.mjs');
    useEngine(await loadEngine());
    window.exporter = new DocumentExporter(); window.importer = new ImportClient(); window.nativeFiles = [];
    // Pivot and figure files are made by the engine from the document it holds: the imported document is opened in an editor the engine owns.
    window.owners = [];
    window.openInEngine = imported => {
      for (const owner of owners.splice(0)) owner.release();
      const editor = new Editor({demo: false, layerTimeline: true}); editor.load(imported.document);
      owners.push(installEngineOwner(editor, {verify: false}));
      if (!editor._shown.active) throw new Error('The engine did not take the document.');
      return editor;
    };
    window.enginePart = (editor, imported, format, name) => ({sourceId: imported.sourceId, format, name, revision: editor.revision});
    window.hash = async blob => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))]
      .map(n => n.toString(16).padStart(2, '0')).join('');
  });
  const checks = [];
  for (const fixture of fixtures) {
    await page.locator('#fixture').setInputFiles(fixture.filename);
    const result = await page.evaluate(async original => {
      const imported = await importer.importFile(document.querySelector('#fixture').files[0]);
      window.current = imported;
      // A figure file opened in an editor is exported by the engine as its figures again: the bytes are the codec's own encoding of them.
      const figureFile = original.format === 'stk', reference = figureFile ? JSON.stringify((await importer.importFile(document.querySelector('#fixture').files[0])).document) : null;
      const editor = openInEngine(imported), identities = editor.report.keyframes.map(frame => frame._styk?.frameId);
      // Opening the document is not the export: its task ends before the measurement starts.
      await new Promise(resolve => setTimeout(resolve, 100));
      let active = true, previous = performance.now(), maxGap = 0;
      const tasks = [], observer = new PerformanceObserver(list => tasks.push(...list.getEntries().map(e => e.duration)));
      observer.observe({type: 'longtask', buffered: false});
      function tick(now) { maxGap = Math.max(maxGap, now - previous); previous = now; if (active) requestAnimationFrame(tick); }
      requestAnimationFrame(tick);
      const output = await exporter.export(editor.report, enginePart(editor, imported, original.format, original.name));
      const timings = {...exporter.lastTimings};
      const service = timings.service_ms;
      if (!service || !Number.isSafeInteger(timings.request_bytes) || timings.request_bytes <= 0 ||
          ['receive', 'parse', 'validate', 'source_digest', 'provenance', 'document_digest', 'encode', 'total'].some(
            stage => !Number.isFinite(service[stage]) || service[stage] < 0 || service[stage] > service.total))
        throw new Error('Export service attribution was missing or invalid.');
      active = false; await new Promise(resolve => setTimeout(resolve, 30)); observer.disconnect();
      const sha256 = await hash(output);
      if (figureFile) {
        const again = await importer.importFile(new File([output], original.name));
        if (JSON.stringify(again.document) !== reference) throw new Error(`${original.name} lost figures through the engine export.`);
      } else if (output.size !== original.bytes || sha256 !== original.sha256) {
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
      if (editor.report.keyframes.some((frame, index) => frame._styk?.frameId !== identities[index]))
        throw new Error('Pivot export mutated editable frame identities.');
      const native = await exporter.export(imported.document, {sourceId: imported.sourceId, format: 'styk', name: original.name});
      window.nativeFiles.push({original: figureFile ? {...original, bytes: output.size, sha256} : original, blob: native});
      return {name: original.name, bytes: output.size, sha256, nativeBytes: native.size,
        timings, nativeTimings: {...exporter.lastTimings}, longTasks: tasks, maxAnimationFrameGapMs: maxGap};
    }, fixture);
    checks.push(result); console.log(JSON.stringify(result));
  }
  const behaviorFixture = fixtures.find(fixture => fixture.format === 'piv') ?? fixtures[0];
  await page.locator('#fixture').setInputFiles(behaviorFixture.filename);
  const behavior = await page.evaluate(async () => {
    const cancelled = new AbortController(); cancelled.abort();
    let before = false, during = false, revision = false;
    try { await exporter.export(current.document, {signal: cancelled.signal}); } catch (error) { before = error.name === 'AbortError'; }
    const mid = new AbortController();
    const originalPostMessage = Worker.prototype.postMessage;
    let snapshotHook = () => mid.abort(), exportHook = null;
    Worker.prototype.postMessage = function (message, ...args) {
      const result = originalPostMessage.call(this, message, ...args);
      if (message.operation === 'chunk') snapshotHook?.();
      if (message.operation === 'export') exportHook?.();
      return result;
    };
    const ongoing = exporter.export(current.document, {signal: mid.signal});
    try { await ongoing; } catch (error) { during = error.name === 'AbortError'; }
    let rev = 1;
    snapshotHook = () => rev++;
    const changed = exporter.export(current.document, {getRevision: () => rev});
    try { await changed; } catch (error) { revision = error.name === 'AbortError'; }
    snapshotHook = null;
    // A Pivot export cancelled while the engine works raises the flag it polls, the worker gives its thread back, and the next export joins again.
    const engineEditor = openInEngine(current), engineCancel = new AbortController();
    exportHook = () => engineCancel.abort();
    let engineAborted = false;
    try { await exporter.export(engineEditor.report, {...enginePart(engineEditor, current, 'piv', 'cancelled'), signal: engineCancel.signal}); } catch (error) { engineAborted = error.name === 'AbortError'; }
    exportHook = null;
    const afterCancel = await exporter.export(engineEditor.report, enginePart(engineEditor, current, 'piv', 'again'));
    if (!engineAborted || !(afterCancel.size > 0)) throw new Error(`Engine export cancellation failed: ${JSON.stringify({engineAborted, size: afterCancel.size})}`);
    Worker.prototype.postMessage = originalPostMessage;
    const small = await importer.importFile(document.querySelector('#fixture').files[0]);
    let expired = false;
    try { const editor = openInEngine(small); await exporter.export(editor.report, enginePart(editor, {sourceId: 'missing-source'}, 'piv')); }
    catch (error) { expired = error.code === 'source_expired' && error.status === 410; }
    if (!expired) throw new Error('Worker export lost the actionable expired-source error.');
    small.document.keyframes[0].objects[0].root_x += .25;
    const expected = small.document.keyframes[0].objects[0].root_x;
    small.document.custom_opaque_asset = {bytes: 'a'.repeat(800000), exact: ['01', null, true, {fraction: .125}]};
    const native = await exporter.export(small.document, {sourceId: small.sourceId, format: 'styk', name: 'Worker edited'});
    window.editedNative = {blob: native, expected};
    if (!before || !during || !revision) throw new Error(`Cancellation failed: ${JSON.stringify({before, during, revision})}`);
    return {preAborted: before, midSnapshotAborted: during, changedRevisionAborted: revision, engineExportCancelled: engineAborted,
      reusedAfterCancellation: true, expiredSourceErrorPreserved: expired};
  });
  // Restart the codec: its worker and everything it cached are gone, as when the codec service restarted.
  await page.evaluate(async () => (await import('/src/codec-web-host.mjs')).browserCodecHost().dispose());
  const restored = await page.evaluate(async () => {
    const results = [];
    for (const {original, blob} of nativeFiles) {
      const reopened = await importer.importFile(new File([blob], 'restored.styk'));
      const editor = openInEngine(reopened);
      const output = await exporter.export(editor.report, enginePart(editor, reopened, original.format));
      const sha256 = await hash(output);
      if (output.size !== original.bytes || sha256 !== original.sha256) throw new Error(`${original.name} lost native restart fidelity (${output.size} bytes).`);
      results.push({name: original.name, bytes: output.size, sha256});
    }
    const reopened = await importer.importFile(new File([editedNative.blob], 'edited.styk'));
    if (reopened.document._styk?.name !== 'Worker edited') throw new Error('The native project lost its authored name.');
    if (reopened.document.custom_opaque_asset?.bytes !== 'a'.repeat(800000) || reopened.document.custom_opaque_asset.exact[3].fraction !== .125)
      throw new Error('Worker snapshot lost unknown nested metadata or a large string.');
    const editor = openInEngine(reopened);
    const edited = await exporter.export(editor.report, enginePart(editor, reopened, 'piv'));
    const checked = await importer.importFile(new File([edited], 'edited.piv'));
    if (checked.document.keyframes[0].objects[0].root_x !== editedNative.expected) throw new Error('Worker export lost a real fractional edit.');
    exporter.dispose(); importer.dispose();
    return {results, unknownMetadataPreserved: true, editedNativeRestartPreserved: true};
  });
  const report = {checks, behavior, restored, codecRestarted: true, checkedAt: new Date().toISOString()};
  const output = path.resolve(process.env.STYK_BENCH_OUT || path.join(appRoot, 'artifacts'));
  await mkdir(output, {recursive: true});
  const tag = fixturePaths.some(value => /Akane/i.test(value)) ? '-akane' : '';
  await writeFile(path.join(output, `document-export-browser${tag}.json`), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await browser?.close(); backend.stop(); }
