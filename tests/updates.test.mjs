import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const { UpdateService, updateAvailability } = createRequire(import.meta.url)('../desktop/updates.cjs');
function fixture() {
  const updater = new EventEmitter();
  const states = [];
  updater.checkForUpdates = async () => { updater.emit('update-available', { version: '0.5.0' }); return {}; };
  updater.downloadUpdate = async () => { updater.emit('download-progress', { percent: 48, transferred: 48, total: 100 }); updater.emit('update-downloaded', { version: '0.5.0' }); };
  updater.quitAndInstall = (...args) => { updater.installed = args; };
  const service = new UpdateService({ updater, currentVersion: '0.4.0', onState: state => states.push(state) });
  return { updater, states, service };
}
test('downloads automatically, exposes real progress, waits for explicit restart', async () => {
  const { updater, states, service } = fixture();
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.allowPrerelease, false);
  assert.equal(updater.allowDowngrade, false);
  assert.equal(await service.restart(async () => true), false);
  await service.check();
  assert.ok(states.some(s => s.status === 'downloading' && s.percent === 48));
  assert.equal(service.snapshot().status, 'ready');
  assert.equal(updater.installed, undefined);
  assert.equal(await service.restart(async () => false), false);
  assert.equal(service.snapshot().status, 'ready');
  assert.equal(await service.restart(async () => true), true);
  assert.deepEqual(updater.installed, [true, true]);
});
test('a failed or cancelled download never offers installation and can retry', async () => {
  const { updater, service } = fixture();
  updater.downloadUpdate = async () => { throw new Error('Checksum mismatch'); };
  await service.check();
  assert.equal(service.snapshot().status, 'error');
  assert.equal(await service.restart(async () => true), false);
  updater.downloadUpdate = async () => updater.emit('update-downloaded', { version: '0.5.0' });
  await service.check();
  assert.equal(service.snapshot().status, 'ready');
});
test('repeated requests do not duplicate downloads or installers', async () => {
  const { updater, service } = fixture();
  let complete, calls = 0;
  updater.downloadUpdate = () => { calls++; return new Promise(resolve => { complete = () => { updater.emit('update-downloaded', { version: '0.5.0' }); resolve(); }; }); };
  const check = service.check();
  await new Promise(resolve => setImmediate(resolve));
  await service.check();
  assert.equal(calls, 1);
  complete(); await check;
  let prepare;
  const first = service.restart(() => new Promise(resolve => { prepare = resolve; }));
  assert.equal(await service.restart(async () => true), false);
  prepare(true); await first;
});
test('install failure restores application close protection', async () => {
  const { updater, service } = fixture();
  await service.check();
  updater.quitAndInstall = () => updater.emit('error', new Error('Installer missing'));
  let restored = false;
  assert.equal(await service.restart(async () => true, () => { restored = true; }), false);
  assert.equal(restored, true);
  assert.equal(service.snapshot().status, 'error');
});
test('current, development, portable and unsupported copies report the correct state', async () => {
  const { updater, service } = fixture();
  updater.checkForUpdates = async () => { updater.emit('update-not-available'); return {}; };
  await service.check(); assert.equal(service.snapshot().status, 'current');
  const installed = { packaged: true, platform: 'win32', portable: false, installed: true };
  assert.equal(updateAvailability(installed), '');
  for (const overrides of [{ packaged: false }, { portable: true }, { installed: false }, { platform: 'darwin' }]) {
    const unavailable = updateAvailability({ ...installed, ...overrides });
    assert.ok(unavailable);
    const disabled = new UpdateService({ currentVersion: '0.5.0', unavailable });
    assert.equal((await disabled.check()).status, 'unavailable');
    disabled.start(); assert.equal(disabled.timer, undefined);
  }
});
test('checks after startup and every hour, without duplicate timers', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { service } = fixture();
  let checks = 0;
  service.check = async () => { checks++; };
  service.start(); service.start();
  t.mock.timers.tick(9999); assert.equal(checks, 0);
  t.mock.timers.tick(1); assert.equal(checks, 1);
  t.mock.timers.tick(3590000); assert.equal(checks, 2);
  t.mock.timers.tick(3600000); assert.equal(checks, 3);
  service.dispose();
  t.mock.timers.tick(3600000); assert.equal(checks, 3);
});
