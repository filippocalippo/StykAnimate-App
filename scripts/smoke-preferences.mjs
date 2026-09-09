import { _electron as electron } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(appRoot, 'artifacts');
const packaged = process.argv.includes('--packaged');
const executablePath = packaged ? process.env.STYK_PACKAGED_EXECUTABLE || path.join(appRoot, 'release', 'win-unpacked', 'StykAnimate.exe') : undefined;
const profile = path.join(output, `${packaged ? 'preferences-packaged' : 'preferences-desktop'}-profile-${Date.now()}`);
await mkdir(output, { recursive: true });
const launch = () => electron.launch({ executablePath, args: packaged ? [] : [appRoot], cwd: appRoot, timeout: 45000, env: { ...process.env, STYK_USER_DATA_DIR: profile } });
const applications = [];
try {
  const first = await launch(); applications.push(first);
  const page = await first.firstWindow();
  await page.waitForFunction(() => window.styk?.ready && window.styk.workspace, undefined, { timeout: 20000 });
  await page.evaluate(() => window.stykDesktop.setWorkspacePreferences({ left: 268, right: 310, timeline: 240 }));
  await page.reload();
  await page.waitForFunction(() => window.styk?.ready && window.styk.workspace, undefined, { timeout: 20000 });
  const saved = await page.evaluate(async () => {
    window.styk.workspace.float('right');
    await window.styk.workspace.flushPreferences();
    window.styk.settingsUI.commit({locale:'it'});
    await window.styk.settingsUI.flush();
    const snapshot = window.styk.workspace.preferences;
    const disk = await window.stykDesktop.getWorkspacePreferences();
    let invalidRejected = false, oversizedRejected = false;
    try { await window.stykDesktop.setWorkspacePreferences([]); } catch { invalidRejected = true; }
    try { await window.stykDesktop.setWorkspacePreferences({ padding: 'x'.repeat(17000) }); } catch { oversizedRejected = true; }
    return { origin: location.origin, snapshot, disk, editorSettings: await window.stykDesktop.getEditorSettings(), afterRejected: await window.stykDesktop.getWorkspacePreferences(), invalidRejected, oversizedRejected };
  });
  assert.deepEqual(saved.snapshot, saved.disk);
  assert.deepEqual(saved.afterRejected, saved.disk);
  assert.ok(saved.snapshot.floating.right);
  assert.equal(saved.invalidRejected, true);
  assert.equal(saved.oversizedRejected, true);
  assert.equal(saved.editorSettings.locale,'it');
  const closed = first.waitForEvent('close');
  await first.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await closed;
  const second = await launch(); applications.push(second);
  const restoredPage = await second.firstWindow();
  await restoredPage.waitForFunction(() => window.styk?.ready && window.styk.workspace, undefined, { timeout: 20000 });
  const restored = await restoredPage.evaluate(async () => ({ origin: location.origin, snapshot: window.styk.workspace.preferences, disk: await window.stykDesktop.getWorkspacePreferences(), floating: window.styk.workspace.floating, locale:window.styk.settingsUI.value.locale, documentLocale:document.documentElement.lang, editorSettings:await window.stykDesktop.getEditorSettings() }));
  assert.notEqual(restored.origin, saved.origin);
  assert.deepEqual(restored.snapshot, saved.snapshot);
  assert.deepEqual(restored.disk, saved.snapshot);
  assert.ok(restored.floating.right);
  assert.equal(restored.locale,'it');assert.equal(restored.documentLocale,'it');assert.deepEqual(restored.editorSettings,saved.editorSettings);
  await restoredPage.evaluate(async () => { window.styk.workspace.reset(); await window.styk.workspace.flushPreferences(); });
  const evidence = { passed: true, packaged, survivesProcessRestart: true, survivesOriginChange: true, firstOrigin: saved.origin, secondOrigin: restored.origin, snapshot: saved.snapshot, invalidRejected: saved.invalidRejected, oversizedRejected: saved.oversizedRejected, restoredFloatingPanel: true, restoredLocale:restored.locale, renderedDocumentLocale:restored.documentLocale, restoredEditorSettings:true, checkedAt: new Date().toISOString() };
  await writeFile(path.join(output, packaged ? 'desktop-packaged-preferences-smoke.json' : 'desktop-preferences-smoke.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  for (const app of applications) await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
}
