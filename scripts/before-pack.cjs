'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash} = require('node:crypto');
const { Arch } = require('builder-util');

module.exports = async function beforePack(context) {
  await (await import('./build-brand-assets.mjs')).buildBrandAssets();
  const appRoot = context.packager.info.appDir;
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const notes = JSON.parse(await fs.readFile(path.join(appRoot, 'desktop', 'release-info.json'), 'utf8'));
  if (notes.version !== context.packager.appInfo.version) throw new Error('Release notes must match the packaged version. Run npm run release:prepare.');
  const architecture = typeof context.arch === 'number' ? Arch[context.arch] : context.arch;
  // The engine, the Pivot codec and the drawing raster engine ship as WebAssembly modules among the web resources (src/engine/pkg).
  let modules;
  try { modules = JSON.parse(await fs.readFile(path.join(appRoot, 'src', 'engine', 'pkg', 'build-info.json'), 'utf8')); }
  catch { throw new Error('Build the engine and the Pivot codec before packaging: node scripts/engine-build.mjs'); }
  for (const [name, expected] of [['styk_engine_bg.wasm', modules.sha256], ['styk_codec_bg.wasm', modules.codec?.sha256], ['styk_drawing_bg.wasm', modules.drawing?.sha256]]) {
    let bytes;
    try { bytes = await fs.readFile(path.join(appRoot, 'src', 'engine', 'pkg', name)); }
    catch { throw new Error(`${name} is missing; build it with node scripts/engine-build.mjs`); }
    if (!expected || hash(bytes) !== expected) throw new Error(`src/engine/pkg/${name} differs from its build record; rebuild with node scripts/engine-build.mjs`);
  }
  let video;
  try { video = JSON.parse(await fs.readFile(path.join(context.packager.info.appDir, 'build', 'video-encoder', 'build-info.json'), 'utf8')); }
  catch { throw new Error('Stage the pinned offline video encoder before packaging: npm run build:video-encoder'); }
  if (video.platform !== context.electronPlatformName || video.architecture !== architecture) {
    throw new Error('The video encoder must be staged on the target OS and architecture.');
  }
  if (!video.encoders?.includes('libvpx-vp9')) throw new Error('Restage the offline encoder with verified VP9 alpha support: npm run build:video-encoder');
  if (context.electronPlatformName === 'win32') {
    let vfw;
    try { vfw = JSON.parse(await fs.readFile(path.join(appRoot,'native','bin','build-info.json'),'utf8')); }
    catch { throw new Error('Build both installed-codec helpers before packaging Windows: npm run build:vfw'); }
    if (vfw.schemaVersion !== 1 || vfw.source?.sha256 !== hash(await fs.readFile(path.join(appRoot,'native','vfw-bridge.cpp'))))
      throw new Error('The Windows codec helpers are stale; run npm run build:vfw.');
    for (const arch of ['x86','x64']) {
      const item = vfw.helpers?.find(item=>item.architecture===arch);
      const bytes = await fs.readFile(path.join(appRoot,'native','bin',arch,'styk-vfw.exe'));
      if (!item || item.sha256 !== hash(bytes) || item.bytes !== bytes.length) throw new Error(`Rebuild the ${arch} Windows codec helper before packaging.`);
    }
  }
  await require('./build-telemetry-info.cjs').buildTelemetryInfo(appRoot);
};
