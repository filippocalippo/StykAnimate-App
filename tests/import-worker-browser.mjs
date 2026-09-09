/** Real browser acceptance for transferable uploads and worker JSON parsing.
 * Run: node tests/import-worker-browser.mjs
 */
import {chromium} from 'playwright';
import {createRequire} from 'node:module';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const {startBackend} = require('../desktop/backend.cjs');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = await readFile(path.resolve(appRoot, '../Pivot Animator v5/Animations/tween_camera.piv'));
const backend = await startBackend({appRoot});
let browser;
try {
  try { browser = await chromium.launch({headless: true}); }
  catch { browser = await chromium.launch({channel: 'chrome', headless: true}); }
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${backend.origin}/api/health`);
  const result = await page.evaluate(async ({bytes, origin}) => {
    const {ImportClient} = await import(`${origin}/src/import-client.mjs`);
    const assert = (value, message) => { if (!value) throw new Error(message); };
    const checks = [];
    const importer = new ImportClient();
    try {
      const source = Uint8Array.from(bytes).buffer;
      const imported = await importer.importFile({name: 'camera.piv', size: source.byteLength,
        arrayBuffer: async () => source});
      assert(source.byteLength === 0, 'Upload bytes were cloned instead of transferred.');
      assert(imported.document.version === 5 && imported.document.keyframes.length === 4, 'Real PIV import failed.');
      assert(typeof imported.timings.worker_parse_ms === 'number', 'Worker parse timings are missing.');
      checks.push('Raw upload buffer transferred; real PIV decoded and parsed in worker.');

      const [sample, figure] = await Promise.all([
        importer.openSample('Pivot Animator v5/Animations/tween_camera.piv'),
        importer.openSample('Pivot Animator v5/Figures/sheep.stk'),
      ]);
      assert(sample.sourceId === imported.sourceId && sample.timings.cache_hit, 'Import cache did not reuse source.');
      assert(figure.kind === 'stk' && figure.document.figure_types[1].segments.length > 0, 'Concurrent STK request was misrouted.');
      checks.push('Concurrent sample operations preserve request identity and reuse source cache.');

      imported.document.keyframes[0].objects[0].root_x += 79.5;
      const saved = await fetch('/api/export', {method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({document: imported.document, sourceId: imported.sourceId, format: 'styk'})});
      assert(saved.ok, 'Native export failed.');
      const native = await importer.importNative(new File([await saved.arrayBuffer()], 'saved.styk'));
      assert(native.kind === 'styk', 'Native import was misclassified.');
      assert(native.document._stykSource?.source_base64, 'Native source bytes were not retained.');
      assert(native.document.keyframes[0].objects[0].root_x === imported.document.keyframes[0].objects[0].root_x,
        'Native import lost edited pose.');
      checks.push('Native project saves and worker imports retain source bytes and edited pose.');

      const wrapped = {format: 'stykanimate', version: 1, name: 'Early project', document: sample.document};
      const early = await importer.importNative(new File([JSON.stringify(wrapped)], 'early.json'));
      assert(early.document.version === 5 && early.kind === 'styk', 'Early JSON wrapper compatibility failed.');
      checks.push('Early native wrappers and JSON filename alias import correctly.');

      const large = await importer.openSample('PIVOT ANIMATOR SCENE TEST/Shroobs_JJK_Pack.piv');
      assert(large.timings.document_chunks > 1, 'Large native document did not use bounded transfer batches.');
      const referenceResponse = await fetch('/api/open', {method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({path: 'PIVOT ANIMATOR SCENE TEST/Shroobs_JJK_Pack.piv'})});
      const reference = await referenceResponse.json();
      assert(JSON.stringify(large.document) === JSON.stringify(reference.document), 'Batched import changed native fields or opaque annotations.');
      const exportOriginal = await fetch('/api/export', {method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({document: large.document, sourceId: large.sourceId, format: 'piv'})});
      const exportedOriginal = await exportOriginal.arrayBuffer();
      assert(exportOriginal.ok, `Batched native export failed (${exportOriginal.status}).`);
      assert(exportedOriginal.byteLength === large.timings.source_bytes, 'Unedited batched document did not preserve original native source bytes.');
      const directExport = await fetch('/api/export', {method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({document: reference.document, sourceId: reference.sourceId, format: 'piv'})});
      assert(directExport.ok, 'Reference native export failed.');
      const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].join(',');
      assert(await hash(exportedOriginal) === await hash(await directExport.arrayBuffer()), 'Batched import changed authoritative writer output.');
      checks.push('37 MB native document transfers in bounded batches with every field identical, original native byte size, and byte-identical writer output to the direct decoder response.');

      let malformed;
      try { await importer.importFile(new File(['broken file'], 'broken.piv')); }
      catch (error) { malformed = error; }
      assert(malformed?.code === 'invalid_project' && malformed.status === 422, 'Worker error metadata was lost.');
      checks.push('Malformed source returns actionable codec status and error code.');

      const disposable = new ImportClient();
      const outstanding = disposable.openSample('Pivot Animator v5/Animations/tween_camera.piv');
      disposable.dispose();
      let disposed;
      try { await outstanding; } catch (error) { disposed = error; }
      assert(disposed?.message.includes('disposed'), 'Dispose left an unresolved import.');
      checks.push('Dispose terminates worker and rejects outstanding requests.');
      return {checks, importTimings: sample.timings, largeImportTimings: large.timings};
    } finally { importer.dispose(); }
  }, {bytes: [...fixture], origin: backend.origin});
  if (errors.length) throw new Error(errors.join('\n'));
  await mkdir(path.join(appRoot, 'artifacts'), {recursive: true});
  await writeFile(path.join(appRoot, 'artifacts/import-worker-browser.json'),
    JSON.stringify({...result, errors, checkedAt: new Date().toISOString()}, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  backend.stop();
}
