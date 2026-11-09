// The real updater against a local feed: tauri-plugin-updater checks it, downloads the signed Setup and verifies its
// signature, and Restart to update hands the verified bytes to the installer step, which the test hooks record
// instead of running (an agent never installs on the machine it runs on). A Setup whose signature does not match
// must end in an error, never in "ready".
//
//   node scripts/tauri-build.mjs            makes release/<version>/StykAnimate-<version>-Setup-x64.exe and its .sig
//   cargo build -p styk-desktop             the development build: it accepts a plain-HTTP feed (STYK_UPDATE_FEED)
//   node scripts/smoke-update-feed.mjs
//
// Every launch uses a scratch profile (tests/support/tauri-app.mjs).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { tauri } from '../tests/support/tauri-app.mjs';

const root = path.resolve(import.meta.dirname, '..');
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const setupPath = process.env.STYK_UPDATE_SETUP || path.join(root, 'release', version, `StykAnimate-${version}-Setup-x64.exe`);
const setup = readFileSync(setupPath);
const signature = readFileSync(`${setupPath}.sig`, 'utf8').trim();
const OFFERED = '9.9.9';

let served = 0, mode = 'good';
const server = http.createServer((request, response) => {
  if (request.url === '/latest.json') {
    const url = `http://127.0.0.1:${server.address().port}/setup.exe`;
    // A wrong signature: the one for different bytes (the Setup's own signature over a changed payload).
    const bad = mode === 'bad';
    const entry = { signature, url: bad ? `${url}?tampered` : url };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ version: OFFERED, notes: 'test', pub_date: new Date().toISOString(), platforms: { 'windows-x86_64': entry, 'windows-x86_64-nsis': entry } }));
    return;
  }
  if (request.url.startsWith('/setup.exe')) {
    served++;
    const body = request.url.includes('tampered') ? Buffer.concat([setup, Buffer.from('tampered')]) : setup;
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length });
    response.end(body);
    return;
  }
  response.writeHead(404); response.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const feed = `http://127.0.0.1:${server.address().port}/latest.json`;

async function run(expectReady) {
  const hooks = mkdtempSync(path.join(os.tmpdir(), 'styk-feed-hooks-'));
  writeFileSync(path.join(hooks, 'answers.json'), JSON.stringify({ message: ['discard', 'discard'] }));
  const app = await tauri.launch({ env: { ...process.env, STYK_UPDATE_FEED: feed, STYK_TEST_HOOKS: hooks } });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => window.stykDesktop?.checkForUpdates, undefined, { timeout: 60000 });
    const first = await page.evaluate(() => window.stykDesktop.checkForUpdates());
    assert.ok(['checking', 'downloading', 'ready'].includes(first.status), `the check starts (${first.status})`);
    const end = await page.waitForFunction(async () => {
      const state = await window.stykDesktop.getUpdateState();
      return ['ready', 'error', 'current'].includes(state.status) && state;
    }, undefined, { timeout: 120000, polling: 250 }).then(handle => handle.jsonValue());
    if (!expectReady) {
      assert.equal(end.status, 'error', 'a Setup whose signature does not match is refused');
      return end;
    }
    assert.equal(end.status, 'ready');
    assert.equal(end.version, OFFERED);
    assert.equal(end.percent, 100);
    assert.equal(await page.evaluate(() => window.stykDesktop.restartForUpdate()), true);
    const events = readFileSync(path.join(hooks, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const install = events.find(event => event.kind === 'update-install');
    assert.deepEqual(install?.value, { version: OFFERED, bytes: setup.length }, 'the verified Setup reached the installer step');
    return end;
  } finally {
    await app.close();
    rmSync(hooks, { recursive: true, force: true });
  }
}

try {
  const good = await run(true);
  console.log(`PASS the update was found, downloaded (${served} request, ${setup.length} bytes), verified and handed to the installer step (${good.status} ${good.version})`);
  mode = 'bad';
  const bad = await run(false);
  console.log(`PASS a Setup that does not match its signature ends in "${bad.status}", never "ready"`);
} finally { server.close(); }
