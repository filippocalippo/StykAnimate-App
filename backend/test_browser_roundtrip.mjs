/** Real ECMAScript JSON normalization + restart-safe native source identity. */
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
const paths = ['Goku_Broly_Movie_by_Killer1.piv', 'PIVOT ANIMATOR SCENE TEST/Shroobs_JJK_Pack.piv'];
const expected = await Promise.all(paths.map(async relative => {
  const source = await readFile(path.resolve(appRoot, '..', relative));
  return {path: relative, bytes: source.length, sha256: createHash('sha256').update(source).digest('hex')};
}));
let backend = await startBackend({appRoot}), browser;
try {
  try { browser = await chromium.launch({headless: true}); }
  catch { browser = await chromium.launch({channel: 'chrome', headless: true}); }
  const page = await browser.newPage();
  await page.goto(`${backend.origin}/api/health`);
  const imported = await page.evaluate(async expected => {
    window.nativeRoundtripFiles = [];
    const checks = [];
    const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
    const post = async (url, request) => {
      const response = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(request)});
      if (!response.ok) throw new Error(await response.text());
      return response;
    };
    for (const original of expected) {
      // These are real browser JSON.parse/stringify operations, not a Python
      // imitation of ECMAScript's integer-valued Number serialization.
      const result = await (await post('/api/open', {path: original.path})).json();
      const output = await (await post('/api/export', {document: result.document, sourceId: result.sourceId, format: 'piv'})).arrayBuffer();
      const actual = await hash(output);
      if (output.byteLength !== original.bytes || actual !== original.sha256) throw new Error(`${original.path} changed after browser JSON roundtrip: ${output.byteLength} bytes.`);
      const native = await (await post('/api/export', {document: result.document, sourceId: result.sourceId, format: 'styk'})).arrayBuffer();
      window.nativeRoundtripFiles.push({original, bytes: native});
      checks.push({path: original.path, bytes: output.byteLength, sha256: actual, nativeBytes: native.byteLength});
    }
    const small = await (await post('/api/open', {path: 'Pivot Animator v5/Animations/tween_camera.piv'})).json();
    small.document.keyframes[0].objects[0].root_x += 0.25;
    window.nativeEditedExpected = small.document.keyframes[0].objects[0].root_x;
    window.nativeEditedFile = await (await post('/api/export', {document: small.document, sourceId: small.sourceId, format: 'styk'})).arrayBuffer();
    return checks;
  }, expected);

  const port = backend.port, stopped = once(backend.child, 'exit');
  backend.stop();
  await stopped;
  backend = await startBackend({appRoot, port});
  const restored = await page.evaluate(async () => {
    const checks = [];
    const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
    const post = async (url, request) => {
      const response = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(request)});
      if (!response.ok) throw new Error(await response.text());
      return response;
    };
    for (const {original, bytes} of window.nativeRoundtripFiles) {
      const response = await fetch('/api/import?filename=restored.styk', {method: 'POST', headers: {'Content-Type': 'application/octet-stream'}, body: bytes});
      if (!response.ok) throw new Error(await response.text());
      const reopened = await response.json();
      const output = await (await post('/api/export', {document: reopened.document, sourceId: reopened.sourceId, format: 'piv'})).arrayBuffer();
      const actual = await hash(output);
      if (output.byteLength !== original.bytes || actual !== original.sha256) throw new Error(`${original.path} changed after native restore: ${output.byteLength} bytes.`);
      checks.push({path: original.path, bytes: output.byteLength, sha256: actual, digestVersion: reopened.document._stykSource.document_digest_version});
    }
    const reopened = await (await fetch('/api/import?filename=edited.styk', {method: 'POST', body: window.nativeEditedFile})).json();
    const encoded = await (await post('/api/export', {document: reopened.document, sourceId: reopened.sourceId, format: 'piv'})).arrayBuffer();
    const checked = await (await fetch('/api/import?filename=edited.piv', {method: 'POST', body: encoded})).json();
    if (checked.document.keyframes[0].objects[0].root_x !== window.nativeEditedExpected) throw new Error('Canonical hashing discarded a genuine fractional pose edit.');
    return {checks, fractionalEditPreserved: true};
  });
  const report = {imported, restored, backendRestarted: true, checkedAt: new Date().toISOString()};
  await mkdir(path.join(appRoot, 'artifacts'), {recursive: true});
  await writeFile(path.join(appRoot, 'artifacts/codec-browser-roundtrip.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await browser?.close(); backend.stop(); }
