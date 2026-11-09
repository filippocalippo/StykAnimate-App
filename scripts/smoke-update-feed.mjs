// The real updater against a local feed: tauri-plugin-updater checks it, downloads the Setup and verifies its
// signature, and Restart to update hands the verified bytes to the installer step, which the test hooks record
// instead of running (an agent never installs on the machine it runs on). What must be refused is refused:
// bytes that are not the signed ones, and a feed that announces another version than the one signed.
//
//   node scripts/tauri-build.mjs            makes release/<version>/StykAnimate-<version>-Setup-x64.exe and its .sig
//   cargo build -p styk-desktop             the development build: it accepts a plain-HTTP feed (STYK_UPDATE_FEED)
//   node scripts/smoke-update-feed.mjs
//
// The offered version (9.9.9) is signed here, in a scratch folder, with the updater key (TAURI_SIGNING_PRIVATE_KEY_PATH,
// default ~/.tauri/stykanimate-updater.key). Every launch uses a scratch profile (tests/support/tauri-app.mjs).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { tauri } from '../tests/support/tauri-app.mjs';

const root = path.resolve(import.meta.dirname, '..');
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const setupPath = process.env.STYK_UPDATE_SETUP || path.join(root, 'release', version, `StykAnimate-${version}-Setup-x64.exe`);
const key = process.env.TAURI_SIGNING_PRIVATE_KEY_PATH || path.join(os.homedir(), '.tauri', 'stykanimate-updater.key');
const OFFERED = '9.9.9';
const work = mkdtempSync(path.join(os.tmpdir(), 'styk-feed-'));
const offered = path.join(work, `StykAnimate_${OFFERED}_x64-setup.exe`);
copyFileSync(setupPath, offered);
// The key comes from its file only: the signer refuses a key variable beside a key path, even an empty one.
const signerEnv = { ...process.env };
delete signerEnv.TAURI_SIGNING_PRIVATE_KEY;
delete signerEnv.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
const signed = spawnSync('npx', ['--yes', '@tauri-apps/cli@2.12.4', 'signer', 'sign', '-f', `"${key}"`, '-p', '""', '--app-version', OFFERED, `"${offered}"`],
  { shell: process.platform === 'win32', encoding: 'utf8', env: signerEnv });
if (signed.status !== 0) throw new Error(`Signing the offered version failed:\n${signed.stdout}\n${signed.stderr}`);
const setup = readFileSync(offered);
const signatures = { offered: readFileSync(`${offered}.sig`, 'utf8').trim(), release: readFileSync(`${setupPath}.sig`, 'utf8').trim() };

let served = 0, mode = 'good';
const server = http.createServer((request, response) => {
  if (request.url === '/latest.json') {
    const url = `http://127.0.0.1:${server.address().port}/setup.exe${mode === 'bytes' ? '?changed' : ''}`;
    // 'version': the release's own signature (made for its own version) under a feed that announces another.
    const entry = { signature: mode === 'version' ? signatures.release : signatures.offered, url };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ version: OFFERED, notes: 'test', pub_date: new Date().toISOString(), platforms: { 'windows-x86_64': entry, 'windows-x86_64-nsis': entry } }));
    return;
  }
  if (request.url.startsWith('/setup.exe')) {
    served++;
    const body = request.url.includes('changed') ? Buffer.concat([setup, Buffer.from('changed')]) : setup;
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length });
    response.end(body);
    return;
  }
  response.writeHead(404); response.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const feed = `http://127.0.0.1:${server.address().port}/latest.json`;

async function run(expectReady) {
  const hooks = mkdtempSync(path.join(work, 'hooks-'));
  writeFileSync(path.join(hooks, 'answers.json'), JSON.stringify({ message: ['discard', 'discard'] }));
  const app = await tauri.launch({ env: { ...process.env, STYK_UPDATE_FEED: feed, STYK_TEST_HOOKS: hooks } });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => window.stykDesktop?.checkForUpdates, undefined, { timeout: 60000 });
    const first = await page.evaluate(() => window.stykDesktop.checkForUpdates());
    assert.ok(['checking', 'downloading', 'ready'].includes(first.status), `the check starts (${first.status})`);
    let end;
    for (const until = Date.now() + 120000; Date.now() < until; await new Promise(resolve => setTimeout(resolve, 250))) {
      end = await page.evaluate(() => window.stykDesktop.getUpdateState());
      if (['ready', 'error', 'current'].includes(end.status)) break;
    }
    if (!expectReady) {
      assert.equal(end.status, 'error', JSON.stringify(end));
      assert.equal(await page.evaluate(() => window.stykDesktop.restartForUpdate()), false, 'nothing to install');
      return end;
    }
    assert.equal(end.status, 'ready', JSON.stringify(end));
    assert.equal(end.version, OFFERED);
    assert.equal(end.percent, 100);
    assert.equal(await page.evaluate(() => window.stykDesktop.restartForUpdate()), true);
    const events = readFileSync(path.join(hooks, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const install = events.find(event => event.kind === 'update-install');
    assert.deepEqual(install?.value, { version: OFFERED, bytes: setup.length }, 'the verified Setup reached the installer step');
    return end;
  } finally {
    await app.close();
  }
}

try {
  const good = await run(true);
  console.log(`PASS the update was found, downloaded (${setup.length} bytes), verified and handed to the installer step (${good.status} ${good.version})`);
  mode = 'bytes';
  console.log(`PASS bytes that are not the signed ones end in "${(await run(false)).status}", never "ready"`);
  mode = 'version';
  console.log(`PASS a feed announcing another version than the signed one ends in "${(await run(false)).status}", never "ready"`);
  console.log(`(${served} downloads served)`);
} finally {
  server.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
