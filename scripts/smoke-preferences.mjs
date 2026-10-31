import { _electron as electron } from '../tests/support/playwright.mjs';
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
  // A 1.1 blob migrates to the v2 layout; `float('right')` floats the right dock's floatable panel (VFX).
  // A saved layout and the timeline's width (under the stage) must survive the restart too.
  const migrated = await page.evaluate(() => ({sizes: window.styk.workspace.layout.shared.sizes, right: window.styk.workspace.sizes.right}));
  assert.deepEqual([migrated.sizes.right, migrated.sizes.bottom, migrated.right], [310, 240, 310]);
  const saved = await page.evaluate(async () => {
    window.styk.workspace.saveLayout('Smoke layout');
    window.styk.workspace.float('vfx');
    window.styk.workspace.setTimelineSpan('stage');
    await window.styk.workspace.flushPreferences();
    await (await import('/src/localization.mjs')).loadLocale('it'); window.styk.settingsUI.commit({locale:'it',theme:'dark'});
    await window.styk.settingsUI.flush();
    const snapshot = window.styk.workspace.preferences;
    const disk = await window.stykDesktop.getWorkspacePreferences();
    let invalidRejected = false, oversizedRejected = false;
    try { await window.stykDesktop.setWorkspacePreferences([]); } catch { invalidRejected = true; }
    try { await window.stykDesktop.setWorkspacePreferences({ padding: 'x'.repeat(17000) }); } catch { oversizedRejected = true; }
    return { snapshot, disk, editorSettings: await window.stykDesktop.getEditorSettings(), afterRejected: await window.stykDesktop.getWorkspacePreferences(), invalidRejected, oversizedRejected };
  });
  assert.deepEqual(saved.snapshot, saved.disk);
  assert.deepEqual(saved.afterRejected, saved.disk);
  assert.equal(saved.snapshot.layoutVersion, 2);
  assert.equal(saved.snapshot.studioVersion, 1, 'the v1 mirror a 1.1 app reads');
  assert.equal(saved.snapshot.right, 310);
  assert.ok(saved.snapshot.modes.animate.panels.some(record => record.id === 'vfx' && record.dock === 'float'));
  assert.equal(saved.snapshot.modes.animate.bottomSpan, 'stage');
  assert.deepEqual(saved.snapshot.saved.map(item => item.name), ['Smoke layout']);
  assert.equal(saved.invalidRejected, true);
  assert.equal(saved.oversizedRejected, true);
  const nativeSave = await first.evaluate(({Menu}) => Menu.getApplicationMenu().items.flatMap(item => item.submenu?.items ?? []).some(item => item.label === 'Salva'));
  assert.equal(nativeSave, true, 'the native menu updates from the same saved locale');
  assert.equal(saved.editorSettings.locale,'it');
  assert.equal(saved.editorSettings.theme,'dark');
  if (!packaged) {
    const guidance=await page.evaluate(async()=>{
      const state=await window.stykDesktop.getUpdateState();await window.styk.actions['check-updates']();
      const notice=document.querySelector('.update-notice');return {state,visible:!notice.hidden,text:notice.querySelector('.update-copy span').textContent,expected:window.styk.localization.t(state.messageKey)};
    });
    assert.equal(guidance.state.status,'unavailable');assert.equal(guidance.state.messageKey,'desktop.updates.developmentUnavailable');
    assert.equal(guidance.visible,true);assert.equal(guidance.text,guidance.expected);
    assert.notEqual(guidance.text,guidance.state.message,'the real update IPC preserves English diagnostics and displays Italian guidance');
  }
  const closed = first.waitForEvent('close');
  await first.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await closed;
  const second = await launch(); applications.push(second);
  const restoredPage = await second.firstWindow();
  await restoredPage.waitForFunction(() => window.styk?.ready && window.styk.workspace, undefined, { timeout: 20000 });
  const restored = await restoredPage.evaluate(async () => ({ snapshot: window.styk.workspace.preferences, disk: await window.stykDesktop.getWorkspacePreferences(), floating: window.styk.workspace.floating, layouts: window.styk.workspace.layouts.map(item => item.name), span: document.querySelector('.workspace').dataset.bottomSpan, locale:window.styk.settingsUI.value.locale, documentLocale:document.documentElement.lang, editorSettings:await window.stykDesktop.getEditorSettings() }));
  assert.deepEqual(restored.snapshot, saved.snapshot);
  assert.deepEqual(restored.disk, saved.snapshot);
  assert.deepEqual(restored.floating.map(item => item.panel), ['vfx']);
  assert.deepEqual(restored.layouts, ['Smoke layout']);
  assert.equal(restored.span, 'stage');
  assert.equal(await restoredPage.locator('html').getAttribute('data-theme'),'dark');
  assert.equal(restored.editorSettings.theme,'dark');
  assert.equal(await second.evaluate(({Menu}) => Menu.getApplicationMenu().items.flatMap(item => item.submenu?.items ?? []).some(item => item.label === 'Salva')), true, 'the native menu restores its language before the renderer');
  assert.equal(restored.locale,'it');assert.equal(restored.documentLocale,'it');assert.deepEqual(restored.editorSettings,saved.editorSettings);
  await restoredPage.evaluate(async () => {
    for (const item of window.styk.workspace.layouts) window.styk.workspace.deleteLayout(item.id);
    window.styk.workspace.reset();
    await window.styk.workspace.flushPreferences();
  });
  const evidence = { passed: true, packaged, survivesProcessRestart: true, snapshot: saved.snapshot, invalidRejected: saved.invalidRejected, oversizedRejected: saved.oversizedRejected, restoredFloatingPanel: true, restoredSavedLayout: true, restoredTimelineSpan: true, restoredLocale:restored.locale, renderedDocumentLocale:restored.documentLocale, restoredEditorSettings:true, checkedAt: new Date().toISOString() };
  await writeFile(path.join(output, packaged ? 'desktop-packaged-preferences-smoke.json' : 'desktop-preferences-smoke.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  for (const app of applications) await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
}
