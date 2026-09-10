'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash} = require('node:crypto');
const { Arch } = require('builder-util');

module.exports = async function beforePack(context) {
  const appRoot = context.packager.info.appDir;
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const notes = JSON.parse(await fs.readFile(path.join(appRoot, 'desktop', 'release-info.json'), 'utf8'));
  if (notes.version !== context.packager.appInfo.version) throw new Error('Release notes must match the packaged version. Run npm run release:prepare.');
  const manifestPath = path.join(context.packager.info.appDir, 'build', 'sidecar', 'build-info.json');
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')); }
  catch { throw new Error('Build the pinned native codec on this OS before packaging: npm run build:sidecar'); }
  const architecture = typeof context.arch === 'number' ? Arch[context.arch] : context.arch;
  if (manifest.platform !== context.electronPlatformName || manifest.architecture !== architecture) {
    throw new Error(`Codec ${manifest.platform}/${manifest.architecture} cannot be packaged for ${context.electronPlatformName}/${architecture}. Build the sidecar on the target OS and architecture.`);
  }
  if (manifest.orjson !== '3.12.0') throw new Error('The desktop release requires the pinned orjson 3.12.0 sidecar.');
  for (const filename of (await fs.readdir(path.join(appRoot, 'codecs'))).filter(name => name.endsWith('.py'))) {
    if (manifest.codecSources?.[filename] !== hash(await fs.readFile(path.join(appRoot, 'codecs', filename))))
      throw new Error(`The frozen codec is stale for ${filename}; run npm run build:sidecar.`);
  }
  for (const filename of ['server.py','fast_decode.py','import_wire.py','native_scan.py','native_format.py']) {
    if (manifest.runtimeSources?.[filename] !== hash(await fs.readFile(path.join(appRoot,'backend',filename))))
      throw new Error(`The frozen codec is stale for ${filename}; run npm run build:sidecar.`);
  }
  const scanner = manifest.nativeScanner;
  if (scanner?.abiVersion !== 1 || scanner.platform !== context.electronPlatformName || scanner.architecture !== architecture ||
      scanner.source?.sha256 !== hash(await fs.readFile(path.join(appRoot,'native','piv-frame-scan.cpp'))))
    throw new Error('Build and freeze the current native PIV scanner before packaging.');
  const scannerName=context.electronPlatformName==='win32'?'styk-piv-frame-scan.dll':context.electronPlatformName==='darwin'?'libstyk-piv-frame-scan.dylib':'libstyk-piv-frame-scan.so';
  if(scanner.library?.sha256!==hash(await fs.readFile(path.join(appRoot,'build','sidecar','styk-codec','_internal','native',scannerName))))
    throw new Error('The frozen native PIV scanner differs from its verified build.');
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
};
