import { _electron as electron } from 'playwright';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(appRoot, 'artifacts');
const runDirectory = path.join(output, `native-project-${Date.now()}`);
const profile = path.join(runDirectory, 'profile');
await mkdir(runDirectory, { recursive: true });
const paths = { first: path.join(runDirectory, 'First.styk'), second: path.join(runDirectory, 'Save As.styk'), aborted: path.join(runDirectory, 'Aborted.styk'), pivotSave: path.join(runDirectory, 'Pivot converted.styk'), piv: path.join(appRoot, '..', 'Goku_Broly_Movie_by_Killer1.piv') };
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pivotHash = hash(await readFile(paths.piv));
const launch = () => electron.launch({ args: [appRoot], cwd: appRoot, timeout: 45000, env: { ...process.env, STYK_USER_DATA_DIR: profile } });
const applications = [];
const checks = [];
try {
  const app = await launch(); applications.push(app);
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.styk?.ready, undefined, { timeout: 30000 });
  const rendererErrors = [];
  page.on('pageerror', (error) => rendererErrors.push(error.message));
  await app.evaluate(({ dialog }) => {
    globalThis.__saveChoices = [];
    globalThis.__saveDialogCount = 0;
    dialog.showSaveDialog = async () => {
      globalThis.__saveDialogCount++;
      if (!globalThis.__saveChoices.length) throw new Error('An unexpected Save dialog appeared.');
      const choice = globalThis.__saveChoices.shift();
      return choice ? { canceled: false, filePath: choice } : { canceled: true };
    };
  });
  const choose = (value) => app.evaluate((_electron, choice) => { globalThis.__saveChoices.push(choice); }, value);
  const count = () => app.evaluate(() => globalThis.__saveDialogCount);
  await page.evaluate(async () => {
    const response = await fetch('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ document: window.styk.editor.serialize(), format: 'styk' }) });
    if (!response.ok) throw new Error('Could not create a valid native project fixture.');
    const {ImportClient} = await import('/src/import-client.mjs');
    const importer = new ImportClient();
    try { window.__projectBase = (await importer.importFile(new File([await response.blob()], 'fixture.styk'))).document; }
    finally { importer.dispose(); }
    window.__saveHelper = (await import('/src/native-files.mjs')).writeNativeBlob;
    window.__projectSession = await window.stykDesktop.activateDocument({});
  });
  const save = (marker, options = {}) => page.evaluate(async ({ marker, options }) => {
    const text = JSON.stringify({ ...window.__projectBase, smokeMarker: marker });
    const saved = await window.__saveHelper(window.stykDesktop, new Blob([text]), { documentToken: window.__projectSession.documentToken, defaultPath: 'Untitled.styk', ...options });
    return { saved, text };
  }, { marker, options });

  await choose(paths.first);
  const first = await save('first');
  assert.equal(first.saved, true); assert.equal(await readFile(paths.first, 'utf8'), first.text);
  assert.equal(await count(), 1);
  const second = await save('normal-save');
  assert.equal(await count(), 1); assert.equal(await readFile(paths.first, 'utf8'), second.text);
  checks.push('First Save chooses a native STYK destination; subsequent Save reuses it without a dialog.');

  await choose(null);
  assert.equal((await save('cancelled-dialog', { saveAs: true })).saved, false);
  const afterCancel = await save('after-cancel');
  assert.equal(await count(), 2); assert.equal(await readFile(paths.first, 'utf8'), afterCancel.text);
  checks.push('Cancelling Save As retains the existing target.');

  await choose(paths.aborted);
  const aborted = await page.evaluate(async () => {
    const controller = new AbortController();
    try {
      await window.__saveHelper(window.stykDesktop, new Blob(['cancel this staged write']), { documentToken: window.__projectSession.documentToken, saveAs: true, signal: controller.signal, onProgress: () => controller.abort() });
      return false;
    } catch (error) { return error.name === 'AbortError'; }
  });
  assert.equal(aborted, true);
  await assert.rejects(readFile(paths.aborted), { code: 'ENOENT' });
  const afterAbort = await save('after-abort');
  assert.equal(await count(), 3); assert.equal(await readFile(paths.first, 'utf8'), afterAbort.text);
  checks.push('Aborting a staged Save As preserves the complete file and previous target.');

  await choose(path.join(runDirectory, 'missing-parent', 'Failed.styk'));
  await assert.rejects(save('failed-save-as', { saveAs: true }), /ENOENT|no such file/i);
  const afterFailure = await save('after-file-error');
  assert.equal(await count(), 4); assert.equal(await readFile(paths.first, 'utf8'), afterFailure.text);
  checks.push('A filesystem failure during Save As retains the previous destination.');

  await choose(paths.second);
  assert.equal((await save('save-as', { saveAs: true })).saved, true);
  const subsequent = await save('after-save-as');
  assert.equal(await count(), 5); assert.equal(await readFile(paths.second, 'utf8'), subsequent.text);
  assert.equal(await readFile(paths.first, 'utf8'), afterFailure.text);
  checks.push('Successful Save As changes the target only after atomic completion.');

  await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, paths.second);
  const reopened = await page.evaluate(async () => {
    const opened = await window.stykDesktop.openFile();
    window.__projectSession = await window.stykDesktop.activateDocument({ openToken: opened.openToken });
    let reusedRejected = false;
    try { await window.stykDesktop.activateDocument({ openToken: opened.openToken }); } catch { reusedRejected = true; }
    return { ...window.__projectSession, reusedRejected };
  });
  assert.equal(reopened.filename, 'Save As.styk'); assert.equal(reopened.hasSaveTarget, true); assert.equal(reopened.reusedRejected, true);
  const reopenSave = await save('reopened-native');
  assert.equal(await count(), 5); assert.equal(await readFile(paths.second, 'utf8'), reopenSave.text);
  checks.push('Opening a native STYK grants a one-use, document-bound Save destination.');

  const stale = await page.evaluate(async () => {
    const previous = window.__projectSession.documentToken;
    const staged = await window.stykDesktop.beginProjectWrite({ documentToken: previous, size: 2 });
    await window.stykDesktop.writeFileChunk(staged.token, new Uint8Array([1]));
    let incompleteRejected = false;
    try { await window.stykDesktop.finishFileWrite(staged.token); } catch { incompleteRejected = true; }
    window.__projectSession = await window.stykDesktop.activateDocument({});
    let staleRejected = false, stagedRejected = false, forgedRejected = false;
    try { await window.stykDesktop.beginProjectWrite({ documentToken: previous, size: 1 }); } catch { staleRejected = true; }
    try { await window.stykDesktop.writeFileChunk(staged.token, new Uint8Array([2])); } catch { stagedRejected = true; }
    try { await window.stykDesktop.activateDocument({ openToken: 'C:/arbitrary-project.styk' }); } catch { forgedRejected = true; }
    return { incompleteRejected, staleRejected, stagedRejected, forgedRejected };
  });
  assert.deepEqual(stale, { incompleteRejected: true, staleRejected: true, stagedRejected: true, forgedRejected: true });
  assert.equal(await readFile(paths.second, 'utf8'), reopenSave.text);
  checks.push('A document switch invalidates old save capabilities and unfinished streams; forged paths reject.');

  await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, paths.piv);
  const pivotOpen = await page.evaluate(async () => {
    const opened = await window.stykDesktop.openFile();
    window.__projectSession = await window.stykDesktop.activateDocument({ openToken: opened.openToken });
    return { kind: opened.kind, openToken: opened.openToken, ...window.__projectSession };
  });
  assert.equal(pivotOpen.kind, 'piv'); assert.equal(pivotOpen.openToken, null); assert.equal(pivotOpen.hasSaveTarget, false);
  await choose(paths.piv);
  await assert.rejects(save('wrong-extension'), /Choose a .styk/);
  await choose(paths.pivotSave);
  assert.equal((await save('converted-pivot')).saved, true);
  assert.equal(hash(await readFile(paths.piv)), pivotHash);
  const dialogCount = await count();
  assert.equal(dialogCount, 7);
  checks.push('Opening PIV requires a new STYK Save destination and rejects overwriting the source extension.');

  const persisted = await page.evaluate(async () => {
    const settings = { version: 1, general: { autosave: true, undoLimit: 160 }, canvas: { showHandles: true, onionCount: 3 } };
    await window.stykDesktop.setWorkspacePreferences({ left: 257 });
    await window.stykDesktop.setEditorSettings(settings);
    let invalidRejected = false, oversizedRejected = false;
    try { await window.stykDesktop.setEditorSettings([]); } catch { invalidRejected = true; }
    try { await window.stykDesktop.setEditorSettings({ huge: 'x'.repeat(17000) }); } catch { oversizedRejected = true; }
    return { settings, origin: location.origin, invalidRejected, oversizedRejected, actual: await window.stykDesktop.getEditorSettings() };
  });
  assert.equal(persisted.invalidRejected, true); assert.equal(persisted.oversizedRejected, true); assert.deepEqual(persisted.actual, persisted.settings);
  assert.deepEqual(rendererErrors, []);
  const closed = app.waitForEvent('close'); await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await closed;
  const restarted = await launch(); applications.push(restarted);
  const next = await restarted.firstWindow(); await next.waitForFunction(() => window.styk?.ready, undefined, { timeout: 30000 });
  const restored = await next.evaluate(async () => ({ origin: location.origin, settings: await window.stykDesktop.getEditorSettings(), workspace: await window.stykDesktop.getWorkspacePreferences() }));
  assert.notEqual(restored.origin, persisted.origin); assert.deepEqual(restored.settings, persisted.settings); assert.deepEqual(restored.workspace, { left: 257 });
  assert.equal((await readdir(runDirectory)).some((name) => name.endsWith('.tmp')), false);
  checks.push('Editor settings persist independently across process/origin restart; malformed and oversized values preserve them.');
  const evidence = { passed: true, checks, dialogCount, firstOrigin: persisted.origin, secondOrigin: restored.origin, settings: restored.settings, pivotSourceUntouched: true, rendererErrors, checkedAt: new Date().toISOString() };
  await writeFile(path.join(output, 'desktop-project-files-smoke.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally { for (const app of applications) await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); }
