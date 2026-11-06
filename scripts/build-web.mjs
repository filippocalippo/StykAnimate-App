// Builds the editor as a static site in build/web: the same files the desktop
// app serves from its resources, the Pivot codec included (its WebAssembly module is
// in src/engine/pkg/, built by node scripts/engine-build.mjs).
//
//   npm run web:build        build/web
//   npm run web:verify       checks the result before it is deployed
//   npm run web:deploy       build, verify, then `wrangler deploy` (see docs/WEB.md)
//
// There is no bundler: the browser loads the same ES modules the desktop app
// does. The file set comes from the desktop packaging filter in package.json, so
// the two builds cannot drift apart.
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The Pivot codec's module: fetched after the editor when the app installs, and on the first Pivot file otherwise. */
export const CODEC_FILES = ['src/engine/pkg/styk_codec.js', 'src/engine/pkg/styk_codec_bg.wasm'];

/** The desktop app's `web` resource filter, so both builds ship the same files. */
export async function webFilter(root = appRoot) {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const web = pkg.build.extraResources.find((item) => item.to === 'web');
  if (!web?.filter?.length) throw new Error('package.json has no "web" resource filter to build the site from.');
  return { filter: web.filter, version: pkg.version };
}

async function* walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

/** Files under `root` selected by patterns of the forms `name`, `*.ext` and `dir/**\/*`. */
export async function selectFiles(root, patterns) {
  const selected = new Set();
  for (const pattern of patterns) {
    if (pattern.endsWith('/**/*')) {
      const directory = path.join(root, pattern.slice(0, -5));
      try { for await (const file of walk(directory)) selected.add(path.relative(root, file)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    } else if (pattern.startsWith('*.')) {
      const extension = pattern.slice(1);
      for (const entry of await readdir(root, { withFileTypes: true })) if (entry.isFile() && entry.name.endsWith(extension)) selected.add(entry.name);
    } else if (!/[*?]/.test(pattern)) {
      try { if ((await stat(path.join(root, pattern))).isFile()) selected.add(pattern); } catch { /* absent files are simply not shipped */ }
    } else throw new Error(`Unsupported packaging pattern: ${pattern}`);
  }
  return [...selected].sort();
}

const INSTALL_TAGS = [
  '<script src="./src/web-support.js"></script>',
  '<link rel="manifest" href="./manifest.webmanifest" />',
  '<link rel="apple-touch-icon" href="./icons/apple-touch-icon.png" />',
  '<meta name="mobile-web-app-capable" content="yes" />',
  '<meta name="apple-mobile-web-app-capable" content="yes" />',
  '<meta name="apple-mobile-web-app-title" content="StykAnimate" />',
  // The installed app draws under the status bar; the touch layouts keep their controls inside the safe areas.
  '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />',
  '<script type="module" src="./src/web-offline.mjs"></script>',
];

/** The tags that make the page installable and usable offline. The desktop page does not carry them. */
export function markInstallable(html) {
  if (html.includes('rel="manifest"')) return html;
  const end = html.indexOf('</head>');
  if (end < 0) throw new Error('index.html has no </head> to add the install tags to.');
  const before = html.slice(0, end), indent = /[ \t]*$/.exec(before)[0];
  return `${before}  ${INSTALL_TAGS.join(`\n${indent}  `)}\n${indent}${html.slice(end)}`;
}

// Everything the service worker stores, except what is not part of the app. The Pivot codec is a separate group
// because the worker fetches it after the editor.
const NOT_PRECACHED = new Set(['_headers', 'sw.js', 'build-info.json', 'robots.txt']);
const isCodecFile = (name) => CODEC_FILES.includes(name);

/** The files of a built site as [path, hash] pairs in two groups, and a version that changes when any of them does. The page is the empty path. */
export async function precacheList(root) {
  const core = [], codec = [];
  for await (const file of walk(root)) {
    const name = path.relative(root, file).split(path.sep).join('/');
    if (NOT_PRECACHED.has(name)) continue;
    const hash = createHash('sha256').update(await readFile(file)).digest('hex').slice(0, 20);
    (isCodecFile(name) ? codec : core).push([name === 'index.html' ? '' : name, hash]);
  }
  const byPath = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  core.sort(byPath);
  codec.sort(byPath);
  const version = createHash('sha256').update(JSON.stringify([core, codec])).digest('hex').slice(0, 16);
  return { version, core, codec };
}

/** Writes sw.js into a built site: web/sw.js with this site's file list. */
export async function writeServiceWorker(root, source = appRoot) {
  const template = await readFile(path.join(source, 'web', 'sw.js'), 'utf8');
  const declaration = /^const PRECACHE = .*;[ \t]*\r?$/m;
  if (template.split(declaration).length !== 2) throw new Error('web/sw.js must declare PRECACHE on one line.');
  const precache = await precacheList(root);
  await writeFile(path.join(root, 'sw.js'), template.replace(declaration, () => `const PRECACHE = ${JSON.stringify(precache)};`));
  return precache;
}

export function markCodecMode(html) {
  const tag = '<meta name="styk-codec" content="browser" />';
  if (html.includes('name="styk-codec"')) return html;
  const head = html.indexOf('<head>');
  if (head < 0) throw new Error('index.html has no <head> to mark.');
  return `${html.slice(0, head + 6)}\n    ${tag}${html.slice(head + 6)}`;
}

export async function buildWeb({ root = appRoot, output = path.join(root, 'build', 'web') } = {}) {
  const { filter, version } = await webFilter(root);
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });

  const files = await selectFiles(root, filter);
  for (const relative of files) {
    const target = path.join(output, relative);
    await mkdir(path.dirname(target), { recursive: true });
    if (relative === 'index.html') await writeFile(target, markInstallable(markCodecMode(await readFile(path.join(root, relative), 'utf8'))));
    else await copyFile(path.join(root, relative), target);
  }

  // The Pivot codec's module is built, not committed: a site without it could not open Pivot files.
  const shipped = new Set(files.map((name) => name.split(path.sep).join('/')));
  for (const name of CODEC_FILES) if (!shipped.has(name)) throw new Error(`${name} is missing. Build the engine first: node scripts/engine-build.mjs`);
  let codec;
  try { codec = JSON.parse(await readFile(path.join(root, 'src', 'engine', 'pkg', 'build-info.json'), 'utf8')).codec; }
  catch { codec = null; }
  if (!codec?.sha256) throw new Error('src/engine/pkg/build-info.json does not describe the Pivot codec. Build the engine first: node scripts/engine-build.mjs');

  await copyFile(path.join(root, 'web', '_headers'), path.join(output, '_headers'));
  await copyFile(path.join(root, 'web', 'robots.txt'), path.join(output, 'robots.txt'));

  // The install manifest and its icons, then the service worker, which lists every file above.
  await copyFile(path.join(root, 'web', 'manifest.webmanifest'), path.join(output, 'manifest.webmanifest'));
  await mkdir(path.join(output, 'icons'), { recursive: true });
  for (const icon of await readdir(path.join(root, 'web', 'icons'))) await copyFile(path.join(root, 'web', 'icons', icon), path.join(output, 'icons', icon));
  const precache = await writeServiceWorker(output, root);

  let bytes = 0, count = 0;
  for await (const file of walk(output)) { bytes += (await stat(file)).size; count++; }
  // No timestamp: the same inputs produce the same site.
  await writeFile(path.join(output, 'build-info.json'), JSON.stringify({ app: 'StykAnimate', version, codec: { wasmBytes: codec.wasmBytes, sha256: codec.sha256 }, offline: precache.version, files: count + 1 }, null, 2) + '\n');
  return { output, files: count + 1, bytes, version };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await buildWeb();
  console.log(`Built ${result.files} files (${(result.bytes / 1048576).toFixed(1)} MiB) for StykAnimate ${result.version} in ${path.relative(process.cwd(), result.output)}`);
}

