// A real NSIS download/install/relaunch probe with a unique application identity.
// It never installs over the user's StykAnimate application.
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, copyFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { build, Platform, Arch } = require('electron-builder');
if (process.platform !== 'win32') throw new Error('The installer probe requires Windows.');
const root = process.cwd(), id = Date.now().toString(36);
const probe = path.join(root, 'artifacts', 'updates', `install-probe-${id}`);
const fixture = path.join(probe, 'app'), target = path.join(probe, 'target');
const install = path.join(probe, 'installed');
await mkdir(fixture, { recursive: true });
await copyFile('desktop/updates.cjs', path.join(fixture, 'updates.cjs'));
const requests = [];
const server = createServer(async (request, response) => {
  const name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname.slice(1));
  if (!/^(latest\.yml|update-test-0\.0\.[12]\.exe(?:\.blockmap)?)$/.test(name)) { response.writeHead(404).end(); return; }
  try {
    const file = path.join(target, name), info = await stat(file);
    requests.push(name);
    response.writeHead(200, { 'Content-Length': info.size, 'Content-Type': 'application/octet-stream' });
    createReadStream(file).pipe(response);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
await writeFile(path.join(fixture, 'probe.json'), JSON.stringify({ root: probe, install }));
await writeFile(path.join(fixture, 'main.cjs'), `
const {app}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const config=require('./probe.json');
app.setPath('userData',path.join(config.root,'profile'));
app.whenReady().then(async()=>{
  fs.appendFileSync(path.join(config.root,'launches.jsonl'),JSON.stringify({version:app.getVersion(),exe:process.execPath})+'\\n');
  if(app.getVersion()==='0.0.2'){fs.writeFileSync(path.join(config.root,'updated.json'),JSON.stringify({version:app.getVersion(),exe:process.execPath}));app.quit();return;}
  const {autoUpdater}=require('electron-updater');
  autoUpdater.installDirectory=config.install;
  autoUpdater.disableDifferentialDownload=true;
  const {UpdateService}=require('./updates.cjs');
  const service=new UpdateService({updater:autoUpdater,currentVersion:app.getVersion(),onState:state=>{
    fs.appendFileSync(path.join(config.root,'states.jsonl'),JSON.stringify(state)+'\\n');
    if(state.status==='ready')setTimeout(()=>service.restart(async()=>true),100);
    if(state.status==='error')app.exit(1);
  }});
  await service.check();
}).catch(error=>{fs.writeFileSync(path.join(config.root,'error.txt'),error.stack);app.exit(1);});
`);
function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: 'pipe', ...options });
    let output = '';
    child.stdout?.on('data', chunk => { output += chunk; }); child.stderr?.on('data', chunk => { output += chunk; });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve(output) : reject(new Error(`${file} exited ${code}: ${output.slice(-5000)}`)));
  });
}
const metadata = { name: `styk-update-probe-${id}`, version: '0.0.1', main: 'main.cjs', description: 'Isolated updater verification', author: 'StykAnimate', dependencies: { 'electron-updater': '6.6.2' } };
let installed = false;
try {
  await writeFile(path.join(fixture, 'package.json'), JSON.stringify(metadata));
  const npm = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  await run(process.execPath, [npm, 'install', '--no-audit', '--no-fund', '--cache', path.join(root, '.npm-cache')], { cwd: fixture });
  for (const version of ['0.0.1', '0.0.2']) {
    metadata.version = version;
    await writeFile(path.join(fixture, 'package.json'), JSON.stringify(metadata));
    await build({ projectDir: fixture, targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64), publish: 'never',
      config: { appId: `app.stykanimate.updater-test.${id}`, productName: 'StykAnimate Update Test',
        electronVersion: '39.8.10', electronDist: path.join(root, 'node_modules', 'electron', 'dist'),
        directories: { app: fixture, output: version === '0.0.1' ? path.join(probe, 'baseline') : target },
        files: ['main.cjs', 'updates.cjs', 'probe.json', 'package.json'],
        publish: [{ provider: 'generic', url }],
        win: { signAndEditExecutable: false },
        nsis: { oneClick: true, perMachine: false, allowElevation: false, createDesktopShortcut: false, createStartMenuShortcut: false, runAfterFinish: false, artifactName: 'update-test-${version}.exe' },
      },
    });
  }
  await run(path.join(probe, 'baseline', 'update-test-0.0.1.exe'), ['/S', `/D=${install}`]);
  installed = true;
  const original = run(path.join(install, 'StykAnimate Update Test.exe'), []);
  const deadline = Date.now() + 120000;
  let updated;
  while (Date.now() < deadline) {
    try { updated = JSON.parse(await readFile(path.join(probe, 'updated.json'), 'utf8')); break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  await original;
  assert.equal(updated?.version, '0.0.2', 'The new version did not relaunch.');
  assert.equal(path.resolve(updated.exe), path.join(install, 'StykAnimate Update Test.exe'));
  const states = (await readFile(path.join(probe, 'states.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(states.some(state => state.status === 'downloading' && state.transferred > 0));
  assert.ok(states.some(state => state.status === 'ready'));
  assert.ok(states.some(state => state.status === 'restarting'));
  assert.ok(requests.includes('update-test-0.0.2.exe'));
  const evidence = { passed: true, from: '0.0.1', to: updated.version, realNSISInstall: true, realDownload: true, realRelaunch: true, isolatedIdentity: metadata.name, directory: probe };
  await writeFile(path.join(root, 'artifacts', 'updates', 'installer-smoke.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  server.close();
  if (installed) await run(path.join(install, 'Uninstall StykAnimate Update Test.exe'), ['/S']).catch(error => console.warn('Probe uninstall:', error.message));
}
