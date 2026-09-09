import { _electron as electron } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(appRoot, 'artifacts');
const directory = path.join(output, `app-save-${Date.now()}`);
const profile = path.join(directory, 'profile');
await mkdir(directory, { recursive: true });
const targets = Object.fromEntries(['First', 'Second', 'New', 'Pivot', 'Closed'].map(name => [name, path.join(directory, `${name}.styk`)]));
const pivot = path.join(appRoot, '..', 'Goku_Broly_Movie_by_Killer1.piv');
const pivotDigest = createHash('sha256').update(await readFile(pivot)).digest('hex');
const applications = [], checks = [], errors = [];
const launch = () => electron.launch({ args: [appRoot], cwd: appRoot, timeout: 45000, env: { ...process.env, STYK_USER_DATA_DIR: profile } });
const documentAt = async filename => JSON.parse(await readFile(filename, 'utf8'));
const record = name => { checks.push(name); console.log(`PASS ${name}`); };
async function mocks(app) {
  await app.evaluate(({ dialog }) => {
    globalThis.__choices = []; globalThis.__saveCount = 0; globalThis.__closeChoices = []; globalThis.__closeCount = 0;
    dialog.showSaveDialog = async () => {
      globalThis.__saveCount++;
      if (globalThis.__holdNextSave) {
        globalThis.__holdNextSave = false;
        await new Promise(resolve => { globalThis.__releaseSave = resolve; });
      }
      if (!globalThis.__choices.length) throw new Error('An unexpected native Save chooser appeared.');
      const filePath = globalThis.__choices.shift();
      return filePath ? { canceled: false, filePath } : { canceled: true };
    };
    dialog.showMessageBox = async () => {
      globalThis.__closeCount++;
      if (!globalThis.__closeChoices.length) throw new Error('An unexpected native dirty-close prompt appeared.');
      return { response: globalThis.__closeChoices.shift() };
    };
  });
}
try {
  const app = await launch(); applications.push(app); await mocks(app);
  const page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message));
  await page.waitForFunction(() => window.styk?.ready && window.styk.state.documentToken, undefined, { timeout: 30000 });
  const initialToken = await page.evaluate(() => window.styk.state.documentToken);
  const choose = choice => app.evaluate((_e, value) => { globalThis.__choices.push(value); }, choice);
  const count = () => app.evaluate(() => globalThis.__saveCount);
  const edit = async width => { await page.evaluate(width => window.styk.editor.setCanvasSize(width, window.styk.editor.report.canvas_height), width); await page.waitForFunction(() => window.styk.editor.dirty); };
  const saved = () => page.waitForFunction(() => !window.styk.editor.dirty && document.getElementById('status').textContent === 'Project saved', undefined, { timeout: 20000 });
  const open = async filename => { await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, filename); await page.evaluate(() => window.styk.actions.open()); };

  await page.evaluate(() => window.styk.actions.settings());
  await page.locator('.styk-settings [data-tab="canvas"]').click();
  await page.locator('[data-setting="handleSize"]').fill('7'); await page.locator('[data-setting="handleSize"]').press('Tab');
  await page.locator('.styk-settings [data-tab="animation"]').click();
  await page.locator('[data-setting="autosaveSeconds"]').selectOption('0');
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await page.evaluate(() => window.styk.settingsUI.flush());
  assert.equal(await page.evaluate(() => window.styk.state.settings.handleSize), 7);

  await edit(961); await choose(targets.First); await page.locator('[data-action="save"]').first().click(); await saved();
  assert.equal((await documentAt(targets.First)).canvas_width, 961); assert.equal(await count(), 1);
  await edit(962); await page.keyboard.press('Control+s'); await saved();
  assert.equal((await documentAt(targets.First)).canvas_width, 962); assert.equal(await count(), 1);
  record('Save button chooses once; Ctrl+S reuses the current project path.');

  await edit(963); await choose(null); await page.keyboard.press('Control+Shift+s');
  await page.waitForFunction(() => document.getElementById('status').textContent === 'Save cancelled');
  assert.equal(await page.evaluate(() => window.styk.editor.dirty), true); assert.equal(await count(), 2);
  await page.keyboard.press('Control+s'); await saved();
  assert.equal((await documentAt(targets.First)).canvas_width, 963); assert.equal(await count(), 2);
  record('Ctrl+Shift+S cancellation retains the dirty document and existing target.');

  await edit(964); await choose(targets.Second);
  await app.evaluate(({ Menu }) => {
    const file = Menu.getApplicationMenu().items.find(item => item.label === 'File');
    const saveAs = file.submenu.items.find(item => item.label === 'Save as…');
    saveAs.click();
  });
  await saved(); assert.equal((await documentAt(targets.Second)).canvas_width, 964);
  await edit(965); await page.keyboard.press('Control+s'); await saved();
  assert.equal((await documentAt(targets.Second)).canvas_width, 965); assert.equal((await documentAt(targets.First)).canvas_width, 963); assert.equal(await count(), 3);
  record('Native menu Save As changes the target; the prior file remains unchanged.');

  await page.evaluate(() => window.styk.actions.new());
  assert.notEqual(await page.evaluate(() => window.styk.state.documentToken), initialToken);
  await edit(966); await choose(targets.New); await page.keyboard.press('Control+s'); await saved(); assert.equal(await count(), 4);
  assert.equal((await documentAt(targets.New)).canvas_width, 966); assert.equal((await documentAt(targets.Second)).canvas_width, 965);
  record('New creates a fresh save capability and cannot reuse the previous document path.');

  await open(targets.Second); const reopenedToken = await page.evaluate(() => window.styk.state.documentToken);
  await edit(967); await page.keyboard.press('Control+s'); await saved();
  assert.equal((await documentAt(targets.Second)).canvas_width, 967); assert.equal(await count(), 4);
  const figures = await page.evaluate(() => window.styk.editor.frame.objects.length);
  await open(path.join(appRoot, '..', 'Samples.stk'));
  assert.equal(await page.evaluate(() => window.styk.state.documentToken), reopenedToken);
  assert.equal(await page.evaluate(() => window.styk.editor.frame.objects.length), figures + 1);
  await page.keyboard.press('Control+s'); await saved(); assert.equal(await count(), 4);
  record('Opening native STYK restores its target; adding STK figures preserves it.');

  await open(pivot); assert.notEqual(await page.evaluate(() => window.styk.state.documentToken), reopenedToken);
  await edit(968); await choose(targets.Pivot); await page.keyboard.press('Control+s'); await saved();
  assert.equal(await count(), 5); assert.equal((await documentAt(targets.Pivot)).canvas_width, 968);
  assert.equal(createHash('sha256').update(await readFile(pivot)).digest('hex'), pivotDigest);
  record('Opening PIV chooses a new STYK destination and preserves original source bytes.');

  await edit(969); await app.evaluate(() => { globalThis.__closeChoices.push(0); });
  const firstClosed = app.waitForEvent('close'); await page.locator('#window-controls [data-action="close"]').click(); await firstClosed;
  assert.equal((await documentAt(targets.Pivot)).canvas_width, 969);
  record('Dirty-close Save reuses the current target and persists the final edit before closing.');

  const second = await launch(); applications.push(second); await mocks(second);
  const next = await second.firstWindow(); next.on('pageerror', e => errors.push(e.message));
  await next.waitForFunction(() => window.styk?.ready && window.styk.state.documentToken, undefined, { timeout: 30000 });
  assert.equal(await next.evaluate(() => window.styk.state.settings.handleSize), 7);
  assert.equal(await next.evaluate(() => window.styk.state.settings.autosaveSeconds), 0);
  record('Settings changed through the actual UI restore after an application restart.');
  await next.evaluate(() => window.styk.editor.setCanvasSize(970, window.styk.editor.report.canvas_height));
  await second.evaluate(() => { globalThis.__closeChoices.push(1); });
  await next.locator('#window-controls [data-action="close"]').click();
  await next.waitForTimeout(100); assert.equal(next.isClosed(), false); assert.equal(await next.evaluate(() => window.styk.editor.dirty), true);
  await second.evaluate(() => { globalThis.__closeChoices.push(0); globalThis.__choices.push(null); });
  await next.locator('#window-controls [data-action="close"]').click();
  await next.waitForFunction(() => document.getElementById('status').textContent === 'Save cancelled');
  assert.equal(next.isClosed(), false); assert.equal(await next.evaluate(() => window.styk.editor.dirty), true);
  record('Dirty-close Cancel and first-save chooser cancellation both keep the document open.');
  await second.evaluate((_e, filename) => { globalThis.__closeChoices.push(0); globalThis.__choices.push(filename); globalThis.__holdNextSave = true; }, targets.Closed);
  await next.locator('#window-controls [data-action="close"]').click();
  let held = false;
  for (let attempt = 0; attempt < 250; attempt++) {
    held = await second.evaluate(() => typeof globalThis.__releaseSave === 'function');
    if (held) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(held, true, 'The native chooser must be reached after the save snapshot is prepared.');
  await next.evaluate(() => window.styk.editor.setCanvasSize(971, window.styk.editor.report.canvas_height));
  await second.evaluate(() => { globalThis.__releaseSave(); globalThis.__releaseSave = null; });
  await next.waitForTimeout(600);
  let copied;
  try { copied = await documentAt(targets.Closed); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  console.log('Concurrent-save result', await next.evaluate(() => ({ status: document.getElementById('status').textContent, dirty: window.styk.editor.dirty, width: window.styk.editor.report.canvas_width })));
  assert.equal(next.isClosed(), false); assert.equal(await next.evaluate(() => window.styk.editor.dirty), true);
  assert.equal(await next.evaluate(() => window.styk.editor.report.canvas_width), 971);
  if (copied) assert.equal(copied.canvas_width, 970);
  record('An edit arriving during Save keeps the newer revision dirty and prevents closing.');
  await second.evaluate((_e, destination) => { globalThis.__closeChoices.push(0); if (destination) globalThis.__choices.push(destination); }, copied ? null : targets.Closed);
  const closed = second.waitForEvent('close'); await next.locator('#window-controls [data-action="close"]').click(); await closed;
  assert.equal((await documentAt(targets.Closed)).canvas_width, 971);
  record('Retrying dirty-close Save writes a complete new STYK project and closes.');

  assert.deepEqual(errors, []);
  const evidence = { passed: true, checks, errors, targets, checkedAt: new Date().toISOString() };
  await writeFile(path.join(output, 'desktop-app-save-smoke.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally { for (const app of applications) await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); }
