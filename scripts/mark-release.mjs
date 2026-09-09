import {readFile,writeFile,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const metadata=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
if(process.platform!=='win32')throw new Error('This launcher release marker verifies the Windows desktop artifacts.');
if(!/^\d+\.\d+\.\d+$/.test(metadata.version))throw new Error('A numeric release version is required.');
const directory=path.join(root,'release',metadata.version), executable=path.join(directory,'win-unpacked','StykAnimate.exe');
const resources=path.join(directory,'win-unpacked','resources'), hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const manifest=JSON.parse(await readFile(path.join(root,'artifacts','package-manifest.json'),'utf8'));
const smoke=JSON.parse(await readFile(path.join(root,'artifacts','desktop-packaged-smoke.json'),'utf8'));
const filesHash=hash(JSON.stringify([...manifest.files].sort((a,b)=>a.path.localeCompare(b.path))));
if(manifest.version!==metadata.version||smoke.version!==metadata.version||path.resolve(smoke.executablePath??'')!==executable||smoke.packageFilesSha256!==filesHash||!smoke.closeSavedAndClosed||smoke.errors?.length)
  throw new Error('Verify and smoke-test this exact versioned package before making it the launcher default.');
const asar=createRequire(import.meta.url)('@electron/asar');
for(const entry of manifest.files) {
  const bytes=entry.path.startsWith('app.asar/')?asar.extractFile(path.join(resources,'app.asar'),entry.path.slice(9)):
    await readFile(path.join(resources,/^(backend|sidecar|video-encoder|vfw)\//.test(entry.path)||entry.path==='codec_bridge.py'?entry.path:`web/${entry.path}`));
  if(hash(bytes)!==entry.sha256)throw new Error(`Release changed after verification: ${entry.path}`);
}
const binaries=[executable,path.join(directory,`StykAnimate-${metadata.version}-Setup-x64.exe`),path.join(directory,`StykAnimate-${metadata.version}-Portable-x64.exe`)];
for(const binary of binaries)await access(binary);
const marker={version:metadata.version,verifiedAt:new Date().toISOString(),packagedSmokePassed:true,packageFilesSha256:filesHash,
  artifacts:await Promise.all(binaries.map(async binary=>{const bytes=await readFile(binary);return {path:path.relative(directory,binary).replaceAll('\\','/'),bytes:bytes.length,sha256:hash(bytes)};}))};
await writeFile(path.join(directory,'verified-release.json'),JSON.stringify(marker,null,2)+'\n');
await writeFile(path.join(root,'artifacts',`windows-release-${metadata.version}.json`),JSON.stringify(marker,null,2)+'\n');
console.log(`Verified ${metadata.version} is ready for the desktop launcher.`);
