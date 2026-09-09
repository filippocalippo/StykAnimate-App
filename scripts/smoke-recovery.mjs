import { _electron as electron } from 'playwright';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(appRoot, 'artifacts');
const packaged = process.argv.includes('--packaged');
const executablePath = packaged ? process.env.STYK_PACKAGED_EXECUTABLE || path.join(appRoot, 'release', 'win-unpacked', 'StykAnimate.exe') : undefined;
const profile = path.join(output, packaged ? 'recovery-packaged-profile' : 'recovery-desktop-profile');
await mkdir(profile, { recursive: true });
for (const filename of ['recovery.styk', 'recovery.json']) {
  await unlink(path.join(profile, filename)).catch((error) => { if (error.code !== 'ENOENT') throw error; });
}
const launch = () => electron.launch({ executablePath, args: packaged ? [] : [appRoot], cwd: appRoot, timeout: 45000, env: { ...process.env, STYK_USER_DATA_DIR: profile } });
const applications = [];
try {
  const first = await launch();
  applications.push(first);
  const page = await first.firstWindow();
  await page.waitForFunction(() => window.styk?.ready, undefined, { timeout: 20000 });
  const saved = await page.evaluate(async () => {
    const response = await fetch('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ document: window.styk.editor.serialize(), format: 'styk', filename: 'Recovery restart.styk' }) });
    if (!response.ok) throw new Error('Could not encode recovery fixture.');
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    const data = btoa(binary);
    const result = await window.stykDesktop.saveRecovery({ data, name: 'Recovery restart' });
    return { data, result, origin: location.origin, byteLength: bytes.length };
  });
  assert.equal(saved.result.saved, true);
  const firstClosed = first.waitForEvent('close');
  await first.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await firstClosed;

  const second = await launch();
  applications.push(second);
  const restartedPage = await second.firstWindow();
  await restartedPage.waitForFunction(() => window.styk?.ready, undefined, { timeout: 20000 });
  const recovered = await restartedPage.evaluate(async () => ({ recovery: await window.stykDesktop.getRecovery(), origin: location.origin }));
  assert.equal(recovered.recovery.data, saved.data);
  assert.equal(recovered.recovery.name, 'Recovery restart');
  assert.notEqual(recovered.origin, saved.origin, 'This restart must exercise a changed loopback origin.');
  await restartedPage.evaluate(() => window.stykDesktop.deleteRecovery());
  assert.equal(await restartedPage.evaluate(() => window.stykDesktop.getRecovery()), null);
  const evidence = { passed: true, packaged, survivesProcessRestart: true, survivesOriginChange: true, firstOrigin: saved.origin, secondOrigin: recovered.origin, bytes: saved.byteLength, name: recovered.recovery.name, deleted: true, checkedAt: new Date().toISOString() };
  await writeFile(path.join(output, packaged ? 'desktop-packaged-recovery-smoke.json' : 'desktop-recovery-smoke.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  for (const app of applications) await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
}
