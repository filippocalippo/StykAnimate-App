// The Tauri app harness (tests/support/tauri-app.mjs) never starts the app on the owner's data folder: every launch
// gets a scratch STYK_USER_DATA_DIR, and the owner's folder is refused.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { launchEnvironment, ownerDataFolder, tauri } from './support/tauri-app.mjs';

const someone = { APPDATA: 'C:\\Users\\someone\\AppData\\Roaming' };

test('a launch without a data folder gets a fresh scratch one', () => {
  const first = launchEnvironment(someone);
  const second = launchEnvironment(someone);
  try {
    assert.ok(first.env.STYK_USER_DATA_DIR && existsSync(first.env.STYK_USER_DATA_DIR));
    assert.notEqual(first.env.STYK_USER_DATA_DIR, second.env.STYK_USER_DATA_DIR);
    assert.ok(path.resolve(first.env.STYK_USER_DATA_DIR).startsWith(path.resolve(os.tmpdir())));
    assert.equal(first.scratch, first.env.STYK_USER_DATA_DIR);
    assert.equal(first.env.STYK_BACKGROUND_WINDOW, '1');
  } finally { for (const run of [first, second]) rmSync(run.scratch, { recursive: true, force: true }); }
});

test("the owner's data folder, or one inside it, is refused", () => {
  const owner = ownerDataFolder(someone);
  assert.throws(() => launchEnvironment({ ...someone, STYK_USER_DATA_DIR: owner }), /owner's data folder/);
  assert.throws(() => launchEnvironment({ ...someone, STYK_USER_DATA_DIR: path.join(owner, 'webview') }), /owner's data folder/);
  assert.throws(() => launchEnvironment({ ...someone, STYK_USER_DATA_DIR: owner.toUpperCase() }), /owner's data folder/);
  const own = path.join(os.tmpdir(), 'styk-own-profile');
  assert.equal(launchEnvironment({ ...someone, STYK_USER_DATA_DIR: own }).env.STYK_USER_DATA_DIR, own);
});

test('the harness never starts the app without its own data folder', async () => {
  const started = [];
  const spawnImpl = (_file, _args, options) => {
    started.push(options.env);
    const child = Object.assign(new EventEmitter(), { pid: 0, stdout: new PassThrough(), stderr: new PassThrough() });
    setImmediate(() => child.emit('exit', 1, null));
    return child;
  };
  const env = { ...process.env };
  delete env.STYK_USER_DATA_DIR;
  await assert.rejects(tauri.launch({ executablePath: process.execPath, env, spawnImpl, timeout: 2000 }), /exited/);
  await assert.rejects(tauri.launch({ executablePath: process.execPath, env: { ...env, STYK_USER_DATA_DIR: ownerDataFolder(env) }, spawnImpl }), /owner's data folder/);
  assert.equal(started.length, 1, 'the refused launch never started a process');
  assert.ok(started[0].STYK_USER_DATA_DIR);
  assert.notEqual(path.resolve(started[0].STYK_USER_DATA_DIR).toLowerCase(), path.resolve(ownerDataFolder(env)).toLowerCase());
});
