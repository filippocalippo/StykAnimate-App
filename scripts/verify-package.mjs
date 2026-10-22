import { readdir, readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { checkMachOTree, macMinimumVersion, sameBinary } from './macos-binaries.mjs';

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
  const sidecarBinary = process.platform === 'win32' ? 'styk-codec.exe' : 'styk-codec';
  for (const [relative, sourcePath] of [
    ['backend/server.py', path.join(appRoot, 'backend', 'server.py')],
    ...['fast_decode.py','import_wire.py','native_scan.py','native_format.py','jobs.py'].map(filename=>[`backend/${filename}`,path.join(appRoot,'backend',filename)]),
    ['codec_bridge.py', path.join(appRoot, 'codecs', 'codec_bridge.py')],
    ['sidecar/build-info.json', path.join(appRoot, 'build', 'sidecar', 'build-info.json')],
    [`sidecar/styk-codec/${sidecarBinary}`, path.join(appRoot, 'build', 'sidecar', 'styk-codec', sidecarBinary)],
  ]) {
    const source = await readFile(sourcePath), packaged = await readFile(path.join(resources, relative));
    if (hash(source) !== hash(packaged) && !(await sameBinary(sourcePath, path.join(resources, relative)))) throw new Error(`Packaged runtime differs from the verified build: ${relative}`);
    manifest.push({ path: relative, sha256: hash(packaged), bytes: packaged.length });
  }
  const scannerName=process.platform==='win32'?'styk-piv-frame-scan.dll':process.platform==='darwin'?'libstyk-piv-frame-scan.dylib':'libstyk-piv-frame-scan.so';
  const scannerRelative=`sidecar/styk-codec/_internal/native/${scannerName}`;
  const scannerSource=await readFile(path.join(appRoot,'build',scannerRelative)),scannerPackaged=await readFile(path.join(resources,scannerRelative));
  if(hash(scannerSource)!==hash(scannerPackaged)&&!(await sameBinary(path.join(appRoot,'build',scannerRelative),path.join(resources,scannerRelative))))throw new Error('Packaged PIV scanner differs from its verified sidecar.');
  manifest.push({path:scannerRelative,sha256:hash(scannerPackaged),bytes:scannerPackaged.length});
  for (const filename of await readdir(path.join(appRoot, 'build', 'video-encoder'))) {
    const relative = `video-encoder/${filename}`;
    const source = await readFile(path.join(appRoot, 'build', relative)), packaged = await readFile(path.join(resources, relative));
    if (hash(source) !== hash(packaged) && !(await sameBinary(path.join(appRoot, 'build', relative), path.join(resources, relative)))) throw new Error(`Packaged video encoder differs from the staged build: ${relative}`);
    manifest.push({path: relative, sha256: hash(packaged), bytes: packaged.length});
  }
  if (process.platform === 'win32') for (const filename of ['build-info.json','x86/styk-vfw.exe','x64/styk-vfw.exe']) {
    const relative = `vfw/${filename}`, source = await readFile(path.join(appRoot,'native','bin',filename)), packaged = await readFile(path.join(resources,relative));
    if (hash(source) !== hash(packaged)) throw new Error(`Packaged Windows codec helper differs from its verified build: ${relative}`);
    manifest.push({path:relative,sha256:hash(packaged),bytes:packaged.length});
  }
}
let bundle = '';
if (process.platform === 'darwin') {
  // Packaging signs every native file, so the comparisons above ignore code signatures (sameBinary);
  // the bundle's own signature must then seal them, and each must run on the declared oldest macOS.
  const app = path.resolve(resources, '..', '..'), minimum = await macMinimumVersion(appRoot);
  const { count, problems } = await checkMachOTree(app, { arch: process.arch, minimum });
  if (problems.length) throw new Error(`The app has native code that cannot run on macOS ${minimum} (${process.arch}):\n${problems.slice(0, 12).join('\n')}`);
  try { await promisify(execFile)('codesign', ['--verify', '--deep', '--strict', app]); }
  catch (error) { throw new Error(`The app bundle's code signature is not intact; package it with npm run dist:mac:local (ad hoc) or a signing identity.\n${(error.stderr || error.message).trim()}`); }
  bundle = ` ${count} ${process.arch} Mach-O files target macOS ${minimum} or earlier; bundle signature intact.`;
}
await mkdir(manifestDirectory, { recursive: true });
manifest.push({ path: 'app.asar/package.json', sha256: hash(packagedMetadata), bytes: packagedMetadata.length });
await writeFile(path.join(manifestDirectory, snapshot ? `package-baseline-${version}.json` : 'package-manifest.json'), JSON.stringify({ version, snapshot, verifiedAt: new Date().toISOString(), synchronized, files: manifest }, null, 2));
console.log(snapshot ? `${files.length} web assets and ${nativeFiles.length} native modules hashed for the ${version} baseline.` : `Version ${version}: ${files.length} web assets and ${nativeFiles.length} native modules match source; ${synchronized} web files synchronized.${bundle}`);
