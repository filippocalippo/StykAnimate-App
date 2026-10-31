// Checks a built site (build/web) before it is deployed. Everything here is a
// mistake that would otherwise only show up in production: a module the app
// imports that was not shipped, a file over Cloudflare's size limit, a headers
// file Cloudflare would reject, a private file that leaked into the site, or an
// install manifest or service worker that would not work.
//
//   node scripts/verify-web.mjs [build/web]
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CODEC_FILES, precacheList } from './build-web.mjs';
import { headersFor, parseHeaders } from './serve-web.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Cloudflare Workers static assets: https://developers.cloudflare.com/workers/static-assets/
export const LIMITS = { files: 20000, fileBytes: 25 * 1024 * 1024, headerRules: 100, headerLine: 2000 };
const REQUIRED = ['index.html', '_headers', 'build-info.json', 'src/app.mjs', 'src/codec-web-worker.mjs', 'src/codec-engine.mjs',
  'src/web-offline.mjs', 'src/web-support.js', 'src/web-library.mjs', 'src/community-library.mjs', 'sw.js', 'manifest.webmanifest', 'robots.txt', ...CODEC_FILES];
const PRIVATE = /(^|\/)(\.env[^/]*|telemetry-build\.json|[^/]+\.(pem|key|p12)|desktop|backend|codecs|cloud|node_modules)(\/|$)/;

async function listFiles(root, directory = root, out = new Map()) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await listFiles(root, full, out);
    else out.set(path.relative(root, full).split(path.sep).join('/'), (await stat(full)).size);
  }
  return out;
}

function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** Relative module and asset references in a source file that must exist in the site. */
export function relativeReferences(source) {
  const text = withoutComments(source), found = new Set();
  const patterns = [
    /(?:^|[\n;}])\s*(?:import|export)\s*(?:[^'";]*?\sfrom\s*)?(['"])(\.{1,2}\/[^'"\n]+)\1/g,
    /\bimport\(\s*(['"])(\.{1,2}\/[^'"\n]+)\1\s*\)/g,
    /new URL\(\s*(['"])(\.{1,2}\/[^'"\n]+)\1\s*,\s*import\.meta\.url\s*\)/g,
  ];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) found.add(match[2].split(/[?#]/)[0]);
  return [...found];
}

/** The install manifest: installable (name, app-window display, start URL, 192 and 512 icons, one maskable) with icons that are the sizes they claim. */
async function verifyManifest(root, files, fail) {
  let manifest;
  try { manifest = JSON.parse(await readFile(path.join(root, 'manifest.webmanifest'), 'utf8')); }
  catch (error) { fail(`manifest.webmanifest is unreadable: ${error.message}`); return; }
  for (const key of ['name', 'short_name', 'start_url', 'scope']) if (typeof manifest[key] !== 'string' || !manifest[key]) fail(`manifest.webmanifest has no ${key}.`);
  if (!['standalone', 'fullscreen', 'minimal-ui'].includes(manifest.display)) fail('manifest.webmanifest must ask for an app window (display: standalone).');
  const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
  const has = (size, purpose) => icons.some((icon) => icon.sizes === size && (icon.purpose ?? 'any').split(' ').includes(purpose));
  for (const [size, purpose] of [['192x192', 'any'], ['512x512', 'any'], ['512x512', 'maskable']]) if (!has(size, purpose)) fail(`manifest.webmanifest has no ${size} ${purpose} icon.`);
  for (const icon of icons) {
    const name = path.posix.normalize(icon.src ?? '');
    if (!files.has(name)) { fail(`manifest.webmanifest names ${icon.src}, which is not in the site.`); continue; }
    const png = await readFile(path.join(root, name)), [width, height] = [png.readUInt32BE(16), png.readUInt32BE(20)];
    if (png.subarray(1, 4).toString() !== 'PNG' || `${width}x${height}` !== icon.sizes) fail(`${icon.src} is ${width}x${height}, not ${icon.sizes}.`);
  }
}

/** The service worker's file list must be exactly this site's files, or the app would start offline with a piece missing or stale. */
async function verifyServiceWorker(root, fail) {
  const declared = /^const PRECACHE = (.*);[ \t]*\r?$/m.exec(await readFile(path.join(root, 'sw.js'), 'utf8'));
  let precache = null;
  try { precache = JSON.parse(declared?.[1] ?? ''); } catch { /* The template's own line is not JSON. */ }
  if (!precache?.core?.length) fail('sw.js is the development template, not this build\'s file list; build the site with npm run web:build.');
  else if (JSON.stringify(precache) !== JSON.stringify(await precacheList(root))) fail('sw.js lists files that differ from the site; rebuild it with npm run web:build.');
}

export async function verifyWeb(root = path.join(appRoot, 'build', 'web')) {
  const problems = [];
  const files = await listFiles(root);
  const fail = (message) => problems.push(message);

  for (const name of REQUIRED) if (!files.has(name)) fail(`Missing ${name}.`);
  if (files.size > LIMITS.files) fail(`${files.size} files exceed Cloudflare's ${LIMITS.files}-file limit.`);
  for (const [name, size] of files) {
    if (size > LIMITS.fileBytes) fail(`${name} is ${(size / 1048576).toFixed(1)} MiB, over Cloudflare's ${LIMITS.fileBytes / 1048576} MiB per-file limit.`);
    if (PRIVATE.test(name)) fail(`${name} must not be part of the public site.`);
  }

  if (files.has('index.html')) {
    const html = await readFile(path.join(root, 'index.html'), 'utf8');
    if (!/<meta name="styk-codec" content="browser"\s*\/?>/.test(html)) fail('index.html does not select the in-browser codec.');
    if (!/<link rel="manifest" href="\.\/manifest\.webmanifest"/.test(html)) fail('index.html does not link the install manifest.');
    if (!/<link rel="apple-touch-icon" href="\.\/icons\//.test(html)) fail('index.html has no Apple touch icon.');
    if (!/<script type="module" src="\.\/src\/web-offline\.mjs"/.test(html)) fail('index.html does not load the offline registration.');
    if (!/<script src="\.\/src\/web-support\.js"/.test(html)) fail('index.html does not check the browser before the editor loads.');
    for (const match of html.matchAll(/(?:src|href)="(\.\/[^"#?]+)/g)) {
      if (!files.has(match[1].slice(2))) fail(`index.html references ${match[1]}, which is not in the site.`);
    }
  }

  // Every module the app can load must have been shipped.
  for (const name of files.keys()) {
    if (!/\.(mjs|js)$/.test(name)) continue;
    const directory = path.posix.dirname(name);
    for (const reference of relativeReferences(await readFile(path.join(root, name), 'utf8'))) {
      const target = path.posix.normalize(path.posix.join(directory, reference));
      // A reference ending in "/" names a directory, which must contain files.
      const present = reference.endsWith('/') ? [...files.keys()].some((file) => file.startsWith(target)) : files.has(target);
      if (!present) fail(`${name} imports ${reference}, which is not in the site.`);
    }
  }

  if (files.has('_headers')) {
    const text = await readFile(path.join(root, '_headers'), 'utf8');
    try {
      const rules = parseHeaders(text);
      if (rules.length > LIMITS.headerRules) fail(`_headers has ${rules.length} rules; Cloudflare accepts ${LIMITS.headerRules}.`);
    } catch (error) { fail(error.message); }
    for (const line of text.split(/\r?\n/)) if (line.length > LIMITS.headerLine) fail(`A _headers line is ${line.length} characters; Cloudflare accepts ${LIMITS.headerLine}.`);
    if (!/^\s*Content-Security-Policy:.*script-src 'self'/m.test(text)) fail('_headers has no Content-Security-Policy that restricts scripts.');
    // A cached worker or manifest would keep an installed app on an old version.
    const rules = (() => { try { return parseHeaders(text); } catch { return []; } })();
    for (const name of ['/sw.js', '/manifest.webmanifest']) {
      const cache = headersFor(rules, name).find((header) => header.name.toLowerCase() === 'cache-control');
      if (!/no-cache/.test(cache?.value ?? '')) fail(`_headers must serve ${name} with Cache-Control: no-cache.`);
    }
  }

  if (files.has('manifest.webmanifest')) await verifyManifest(root, files, fail);
  if (files.has('sw.js')) await verifyServiceWorker(root, fail);

  if (files.has('build-info.json')) {
    const info = JSON.parse(await readFile(path.join(root, 'build-info.json'), 'utf8'));
    const pkg = JSON.parse(await readFile(path.join(appRoot, 'package.json'), 'utf8'));
    if (info.version !== pkg.version) fail(`The build is version ${info.version} but package.json is ${pkg.version}; rebuild.`);
  }
  return { problems, files: files.size, bytes: [...files.values()].reduce((sum, size) => sum + size, 0) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.resolve(process.argv[2] ?? path.join(appRoot, 'build', 'web'));
  const result = await verifyWeb(root).catch((error) => ({ problems: [error.code === 'ENOENT' ? 'Nothing is built. Run npm run web:build first.' : error.message], files: 0, bytes: 0 }));
  if (result.problems.length) {
    console.error(`The site is not ready to deploy (${result.problems.length} problem${result.problems.length === 1 ? '' : 's'}):`);
    for (const problem of result.problems) console.error(` - ${problem}`);
    process.exitCode = 1;
  } else console.log(`The site is ready to deploy: ${result.files} files, ${(result.bytes / 1048576).toFixed(1)} MiB.`);
}
