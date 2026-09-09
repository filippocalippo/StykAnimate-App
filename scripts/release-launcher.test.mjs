import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const required=['app.asar','web/index.html','sidecar/styk-codec/styk-codec.exe','sidecar/styk-codec/_internal/native/styk-piv-frame-scan.dll','video-encoder/ffmpeg.exe','vfw/x86/styk-vfw.exe','vfw/x64/styk-vfw.exe'];
async function fixture(run) {
  await mkdir(path.join(root,'artifacts'),{recursive:true});
  const directory=await mkdtemp(path.join(root,'artifacts','launcher-test-'));
  try {
    const script=path.join(directory,'Start-StykAnimate-webapp.ps1');
    await writeFile(script,await readFile(path.join(root,'..','Start-StykAnimate-webapp.ps1')));
    await mkdir(path.join(directory,'StykAnimate-webapp','release'),{recursive:true});
    const create=async(version,{marker=true,complete=true}={})=>{
      const release=path.join(directory,'StykAnimate-webapp','release',version),exe=path.join(release,'win-unpacked','StykAnimate.exe');
      await mkdir(path.dirname(exe),{recursive:true});await writeFile(exe,'fixture');
      if(marker)await writeFile(path.join(release,'verified-release.json'),JSON.stringify({version,packagedSmokePassed:true}));
      for(const file of required.slice(0,complete?required.length:required.length-1)) {
        const target=path.join(release,'win-unpacked','resources',file);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,'fixture');
      }
      return exe;
    };
    const launch=async()=>{
      const runner=path.join(directory,'runner.ps1');
      const quoted=script.replaceAll("'","''");
      await writeFile(runner,`function global:Start-Process { param($FilePath,$WorkingDirectory,$WindowStyle,$ArgumentList) @{path=$FilePath;hidden=($WindowStyle -eq 'Hidden');arguments=@($ArgumentList)} | ConvertTo-Json -Compress }\n& '${quoted}' 'scene with spaces.piv'\n`);
      const result=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',runner],{encoding:'utf8'});
      assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout.trim());
    };
    await run({create,launch,directory});
  } finally {
    const artifacts=path.resolve(root,'artifacts')+path.sep;
    if(!path.resolve(directory).startsWith(artifacts))throw new Error('Refusing cleanup outside the launcher test artifacts.');
    await rm(directory,{recursive:true,force:true});
  }
}
test('Windows launcher selects newest complete verified numeric release and retains file arguments',{skip:process.platform!=='win32'},async()=>fixture(async({create,launch})=>{
  await create('0.3.0');const expected=await create('0.10.0');await create('0.11.0',{marker:false});await create('0.12.0',{complete:false});
  const result=await launch();assert.equal(result.path,expected);assert.equal(result.hidden,true);assert.deepEqual(result.arguments,['"scene with spaces.piv"']);
}));
test('Windows launcher falls back to preserved older executable when no new release is verified',{skip:process.platform!=='win32'},async()=>fixture(async({create,launch,directory})=>{
  await create('0.3.0',{marker:false});const expected=path.join(directory,'StykAnimate-webapp','release','win-unpacked','StykAnimate.exe');
  await mkdir(path.dirname(expected),{recursive:true});await writeFile(expected,'fixture');assert.equal((await launch()).path,expected);
}));
