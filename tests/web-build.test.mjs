import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, cp, access} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {buildWeb, markCodecMode, markInstallable, precacheList, selectFiles, webFilter, writeServiceWorker, CODEC_FILES} from '../scripts/build-web.mjs';
import {verifyWeb, relativeReferences, LIMITS} from '../scripts/verify-web.mjs';
import {parseHeaders, headersFor, startWebServer} from '../scripts/serve-web.mjs';

const root = path.resolve(import.meta.dirname, '..');
let shared;
async function site(t) {
  shared ??= await mkdtemp(path.join(os.tmpdir(), 'styk-web-unit-')).then(async directory => ({directory, ...(await buildWeb({output: path.join(directory, 'site')}))}));
  const copy = await mkdtemp(path.join(os.tmpdir(), 'styk-web-copy-'));
  await cp(shared.output, copy, {recursive: true});
  t.after(() => rm(copy, {recursive: true, force: true}));
  return copy;
}
test.after(() => shared && rm(shared.directory, {recursive: true, force: true}));

test('the site ships exactly what the desktop app ships, plus the codec', async t => {
  const {filter} = await webFilter(root);
  const desktop = await selectFiles(root, filter);
  const built = await site(t);
  const missing = [];
  for (const file of desktop) { try { await readFile(path.join(built, file)); } catch { missing.push(file); } }
  assert.deepEqual(missing, [], 'every desktop web resource is in the site');
  // The Pivot codec is the WebAssembly module the engine build made; no Python runtime ships.
  for (const name of CODEC_FILES) assert.ok((await readFile(path.join(built, name))).equals(await readFile(path.join(root, name))), name);
  for (const gone of ['vendor/pyodide', 'python']) await assert.rejects(access(path.join(built, gone)), {code: 'ENOENT'}, gone);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(path.join(built, 'build-info.json'), 'utf8')).codec), ['wasmBytes', 'sha256']);
});

test('the built site passes verification, and each kind of mistake is caught', async t => {
  const built = await site(t);
  assert.deepEqual((await verifyWeb(built)).problems, []);

  await rm(path.join(built, 'src', 'engine', 'pkg', 'styk_codec_bg.wasm'));
  assert.ok((await verifyWeb(built)).problems.includes('Missing src/engine/pkg/styk_codec_bg.wasm.'), 'a site without the codec module');

  await rm(path.join(built, 'src', 'codec-request.mjs'));
  assert.ok((await verifyWeb(built)).problems.some(problem => /codec-request\.mjs, which is not in the site/.test(problem)), 'a missing module');

  await writeFile(path.join(built, 'index.html'), '<html><head></head><body></body></html>');
  assert.ok((await verifyWeb(built)).problems.some(problem => /in-browser codec/.test(problem)), 'a page without the codec marker');

  await mkdir(path.join(built, 'backend'), {recursive: true});
  await writeFile(path.join(built, 'backend', 'server.py'), '');
  await writeFile(path.join(built, '.env'), 'SECRET=1');
  const problems = (await verifyWeb(built)).problems.join('\n');
  assert.match(problems, /backend\/server\.py must not be part of the public site/);
  assert.match(problems, /\.env must not be part of the public site/);

  await writeFile(path.join(built, '_headers'), '/*\n  X-Only: this\n');
  assert.ok((await verifyWeb(built)).problems.some(problem => /Content-Security-Policy/.test(problem)), 'a site without a script policy');
});

test('oversized files are reported against the Cloudflare limit', async t => {
  const built = await site(t);
  await writeFile(path.join(built, 'huge.bin'), Buffer.alloc(LIMITS.fileBytes + 1));
  assert.ok((await verifyWeb(built)).problems.some(problem => /huge\.bin is 25\.0 MiB/.test(problem)));
});

test('module references are found in every import form and ignored in comments', () => {
  const source = `
    import a from './a.mjs';
    import {b,
      c} from "../b/c.mjs";
    export * from './d.mjs';
    export {e} from './e.mjs';
    const f = await import('./f.mjs');
    const worker = new Worker(new URL('./w.mjs', import.meta.url), {type: 'module'});
    const dir = new URL('../vendor/resvg/', import.meta.url);
    // import ignored from './commented.mjs';
    /* import alsoIgnored from './block.mjs'; */
    import remote from 'https://example.com/x.mjs';
    import bare from 'node:fs';`;
  assert.deepEqual(relativeReferences(source).sort(), ['../b/c.mjs', '../vendor/resvg/', './a.mjs', './d.mjs', './e.mjs', './f.mjs', './w.mjs']);
});

test('the index page is marked once, in the head', () => {
  const marked = markCodecMode('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
  assert.equal(marked.match(/styk-codec/g).length, 1);
  assert.ok(marked.indexOf('styk-codec') < marked.indexOf('charset'));
  assert.equal(markCodecMode(marked), marked, 'marking twice changes nothing');
  assert.throws(() => markCodecMode('<html></html>'), /no <head>/);
});

test('the install tags and the offline registration are added to the web page only', async () => {
  const marked = markInstallable('<!doctype html>\n<html>\n  <head>\n    <meta charset="utf-8" />\n  </head>\n  <body></body>\n</html>\n');
  assert.match(marked, /    <link rel="manifest" href=".\/manifest.webmanifest" \/>\n    <link rel="apple-touch-icon"/, 'tags are indented like the head');
  assert.ok(marked.indexOf('rel="manifest"') < marked.indexOf('</head>') && marked.indexOf('web-offline.mjs') < marked.indexOf('</head>'));
  assert.match(marked, /<script src="\.\/src\/web-support\.js"><\/script>/, 'the browser check is a classic script, so it runs before the editor\'s modules');
  assert.equal(markInstallable(marked), marked, 'marking twice changes nothing');
  assert.throws(() => markInstallable('<html></html>'), /no <\/head>/);
  const desktopPage = await readFile(path.join(root, 'index.html'), 'utf8');
  assert.ok(!/manifest|web-offline/.test(desktopPage), 'the desktop page does not carry them');
});

test('the built site is installable and its service worker lists exactly its files', async t => {
  const built = await site(t);
  const html = await readFile(path.join(built, 'index.html'), 'utf8');
  assert.match(html, /<link rel="manifest" href=".\/manifest.webmanifest"/);
  const manifest = JSON.parse(await readFile(path.join(built, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.display, 'standalone');
  for (const icon of manifest.icons) assert.ok((await readFile(path.join(built, icon.src))).length > 100, icon.src);

  const source = await readFile(path.join(built, 'sw.js'), 'utf8');
  const precache = JSON.parse(/^const PRECACHE = (.*);$/m.exec(source)[1]);
  assert.deepEqual(precache, await precacheList(built), 'the list is the built files, hashed');
  const paths = group => new Set(group.map(([name]) => name));
  for (const name of ['', 'src/app.mjs', 'manifest.webmanifest', 'vendor/resvg/index_bg.wasm']) assert.ok(paths(precache.core).has(name), `${name || 'the page'} is stored with the editor`);
  assert.deepEqual([...paths(precache.codec)].sort(), [...CODEC_FILES].sort(), 'the Pivot codec is stored after the editor');
  for (const name of CODEC_FILES) assert.ok(!paths(precache.core).has(name), `${name} is not stored with the editor`);
  for (const name of ['sw.js', '_headers', 'build-info.json', 'robots.txt']) assert.ok(!paths(precache.core).has(name) && !paths(precache.codec).has(name), `${name} is not stored`);
  assert.ok(!paths(precache.core).has('index.html'), 'the page is stored under its own address');
  assert.equal(JSON.parse(await readFile(path.join(built, 'build-info.json'), 'utf8')).offline, precache.version);

  // The version follows the content: the same files give the same version, any change gives another.
  assert.equal((await precacheList(built)).version, precache.version);
  const theme = path.join(built, 'src', 'theme-bootstrap.js');
  await writeFile(theme, (await readFile(theme, 'utf8')) + '\n// changed\n');
  const changed = await writeServiceWorker(built);
  assert.notEqual(changed.version, precache.version);
  assert.deepEqual(changed.core.filter(([, hash], index) => hash !== precache.core[index][1]).map(([name]) => name), ['src/theme-bootstrap.js'], 'only the changed file has a new hash');
  assert.deepEqual((await verifyWeb(built)).problems, []);
});

test('verification catches an install manifest or service worker that would not work', async t => {
  const problemsOf = async built => (await verifyWeb(built)).problems.join('\n');

  let built = await site(t);
  await rm(path.join(built, 'icons', 'icon-192.png'));
  assert.match(await problemsOf(built), /icons\/icon-192\.png, which is not in the site/);

  built = await site(t);
  const manifest = JSON.parse(await readFile(path.join(built, 'manifest.webmanifest'), 'utf8'));
  await writeFile(path.join(built, 'manifest.webmanifest'), JSON.stringify({...manifest, display: 'browser', icons: manifest.icons.filter(icon => icon.purpose !== 'maskable')}));
  const manifestProblems = await problemsOf(built);
  assert.match(manifestProblems, /app window/);
  assert.match(manifestProblems, /no 512x512 maskable icon/);

  built = await site(t);
  await writeFile(path.join(built, 'src', 'added-after-build.mjs'), 'export {};');
  assert.match(await problemsOf(built), /sw\.js lists files that differ/, 'a file the worker does not list');

  built = await site(t);
  await cp(path.join(root, 'web', 'sw.js'), path.join(built, 'sw.js'));
  assert.match(await problemsOf(built), /development template/);

  built = await site(t);
  await writeFile(path.join(built, '_headers'), (await readFile(path.join(built, '_headers'), 'utf8')).replace(/\/sw\.js\n\s+Cache-Control: no-cache\n/, ''));
  assert.match(await problemsOf(built), /_headers must serve \/sw\.js with Cache-Control: no-cache/);

  built = await site(t);
  await writeFile(path.join(built, 'index.html'), (await readFile(path.join(built, 'index.html'), 'utf8')).replace(/\s*<script type="module" src=".\/src\/web-offline.mjs"><\/script>/, ''));
  assert.match(await problemsOf(built), /does not load the offline registration/);

  built = await site(t);
  await writeFile(path.join(built, 'index.html'), (await readFile(path.join(built, 'index.html'), 'utf8')).replace(/\s*<script src="\.\/src\/web-support\.js"><\/script>/, ''));
  assert.match(await problemsOf(built), /does not check the browser/);
});

test('_headers rules match like Cloudflare: splats, joined values, comments', () => {
  const rules = parseHeaders('# comment\n/*\n  X-A: one\n\n/src/*\n  X-A: two\n  Cache-Control: no-cache\n/exact\n  X-B: yes\n');
  assert.deepEqual(headersFor(rules, '/src/app.mjs').map(({name, value}) => [name, value]), [['X-A', 'one, two'], ['Cache-Control', 'no-cache']]);
  assert.deepEqual(headersFor(rules, '/exact').map(({name}) => name), ['X-A', 'X-B']);
  assert.deepEqual(headersFor(rules, '/other').map(({name}) => name), ['X-A']);
  assert.throws(() => parseHeaders('  Orphan: header\n'), /Invalid _headers line/);
});

test('the preview server applies _headers, revalidates with ETags, and stays inside the site', async t => {
  const built = await site(t);
  const server = await startWebServer({root: built});
  t.after(server.close);
  const page = await fetch(server.origin + '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self' 'wasm-unsafe-eval'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  const module = await fetch(server.origin + '/src/app.mjs');
  assert.match(module.headers.get('content-type'), /text\/javascript/);
  const again = await fetch(server.origin + '/src/app.mjs', {headers: {'If-None-Match': module.headers.get('etag')}});
  assert.equal(again.status, 304);
  assert.equal((await fetch(server.origin + '/src/engine/pkg/styk_codec_bg.wasm', {method: 'HEAD'})).headers.get('content-type'), 'application/wasm');
  assert.equal((await fetch(server.origin + '/missing.txt')).status, 404);
  assert.equal((await fetch(server.origin + '/..%2f..%2fetc/passwd')).status, 403);
});
