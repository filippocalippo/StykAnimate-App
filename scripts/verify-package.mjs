import { readdir, readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const appRoot = process.env.STYK_PACKAGE_SOURCE_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestDirectory = process.env.STYK_PACKAGE_MANIFEST_DIR || path.join(appRoot, 'artifacts');
const platformResources = process.platform === 'win32' ? ['win-unpacked', 'resources']
  : process.platform === 'darwin' ? [process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'StykAnimate.app', 'Contents', 'Resources']
  : [process.arch === 'arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked', 'resources'];
const resources = process.env.STYK_PACKAGED_RESOURCES || path.join(appRoot, 'release', ...platformResources);
const webRoot = path.join(resources, 'web');
const sync = process.argv.includes('--sync');
const snapshot = process.argv.includes('--snapshot');
if (snapshot && sync) throw new Error('A package snapshot cannot also synchronize advancing source files.');
const asar = createRequire(import.meta.url)('@electron/asar');
const packagedMetadata = asar.extractFile(path.join(resources, 'app.asar'), 'package.json');
const version = JSON.parse(packagedMetadata).version;
if (!/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(version)) throw new Error('The packaged version is invalid.');
if (!snapshot) {
  const sourceMetadata = JSON.parse(await readFile(path.join(appRoot, 'package.json'), 'utf8'));
  if (sourceMetadata.version !== version) throw new Error(`Packaged version ${version} differs from source ${sourceMetadata.version}; run npm run pack before synchronizing.`);
}
const files = ['index.html', 'mark.svg', 'symbol.svg'];
async function walk(relative) {
  let entries;
  try { entries = await readdir(path.join(snapshot ? webRoot : appRoot, relative), { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    const filename = path.join(relative, entry.name);
    if (entry.isDirectory()) await walk(filename);
    else if (entry.isFile()) files.push(filename);
  }
}
for (const directory of ['src', 'vendor', 'assets']) await walk(directory);
// The engine, the Pivot codec and the drawing raster engine are WebAssembly modules built into src/engine/pkg (node scripts/engine-build.mjs).
if (!snapshot) for (const required of ['styk_engine_bg.wasm', 'styk_codec_bg.wasm', 'styk_codec.js', 'styk_drawing_bg.wasm', 'styk_drawing.js'].map((name) => path.join('src', 'engine', 'pkg', name)))
  if (!files.includes(required)) throw new Error(`${required.replaceAll('\\', '/')} is missing; build it with node scripts/engine-build.mjs.`);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifest = [];
let synchronized = 0;
for (const filename of files) {
  const source = await readFile(path.join(snapshot ? webRoot : appRoot, filename));
  const destination = path.join(webRoot, filename);
  let packaged;
  try { packaged = await readFile(destination); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!packaged || hash(source) !== hash(packaged)) {
    if (!sync) throw new Error(`Packaged web asset differs from source: ${filename}`);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(appRoot, filename), destination);
    packaged = await readFile(destination);
    synchronized++;
  }
  if (hash(source) !== hash(packaged)) throw new Error(`Failed to synchronize ${filename}`);
  manifest.push({ path: filename.replaceAll('\\', '/'), sha256: hash(packaged), bytes: packaged.length });
}
const nativeFiles = snapshot ? asar.listPackage(path.join(resources, 'app.asar')).map((filename) => filename.replaceAll('\\', '/')).filter((filename) => /^\/?desktop\/[^/]+\.cjs$/.test(filename)).map((filename) => filename.split('/').at(-1))
  : (await readdir(path.join(appRoot, 'desktop'))).filter((filename) => filename.endsWith('.cjs'));
for (const filename of nativeFiles) {
  const packaged = asar.extractFile(path.join(resources, 'app.asar'), `desktop/${filename}`);
  if (!snapshot) {
    const source = await readFile(path.join(appRoot, 'desktop', filename));
    if (hash(source) !== hash(packaged)) throw new Error(`Packaged native module differs from source; run npm run pack: ${filename}`);
  }
  manifest.push({ path: `app.asar/desktop/${filename}`, sha256: hash(packaged), bytes: packaged.length });
}
if (!snapshot) {
  // No Python codec ships: the Pivot codec is the WebAssembly module among the web assets above.
  for (const leftover of ['backend', 'tools', 'sidecar', 'codec_bridge.py'])
    if (existsSync(path.join(resources, leftover))) throw new Error(`The package still carries the retired Python codec: ${leftover}`);
  for (const filename of await readdir(path.join(appRoot, 'build', 'video-encoder'))) {
    const relative = `video-encoder/${filename}`;
    const source = await readFile(path.join(appRoot, 'build', relative)), packaged = await readFile(path.join(resources, relative));
    if (hash(source) !== hash(packaged)) throw new Error(`Packaged video encoder differs from the staged build: ${relative}`);
    manifest.push({path: relative, sha256: hash(packaged), bytes: packaged.length});
  }
  if (process.platform === 'win32') for (const filename of ['build-info.json','x86/styk-vfw.exe','x64/styk-vfw.exe']) {
    const relative = `vfw/${filename}`, source = await readFile(path.join(appRoot,'native','bin',filename)), packaged = await readFile(path.join(resources,relative));
    if (hash(source) !== hash(packaged)) throw new Error(`Packaged Windows codec helper differs from its verified build: ${relative}`);
    manifest.push({path:relative,sha256:hash(packaged),bytes:packaged.length});
  }
}
await mkdir(manifestDirectory, { recursive: true });
manifest.push({ path: 'app.asar/package.json', sha256: hash(packagedMetadata), bytes: packagedMetadata.length });
await writeFile(path.join(manifestDirectory, snapshot ? `package-baseline-${version}.json` : 'package-manifest.json'), JSON.stringify({ version, snapshot, verifiedAt: new Date().toISOString(), synchronized, files: manifest }, null, 2));
console.log(snapshot ? `${files.length} web assets and ${nativeFiles.length} native modules hashed for the ${version} baseline.` : `Version ${version}: ${files.length} web assets and ${nativeFiles.length} native modules match source; ${synchronized} web files synchronized.`);
