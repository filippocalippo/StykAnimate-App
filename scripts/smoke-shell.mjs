// The desktop shell, live: window controls and their state events, the close prompt with unsaved work (Cancel,
// a stale checkpoint, Save, Discard), a stykanimate:// link from a second launch reaching the first window, a second
// launch with a path opening its own window, and a new window. Scratch profiles only; dialogs are answered by the
// test hooks (engine/crates/styk-desktop/src/shell/test_hooks.rs), so a development or developer build is needed.
//
//   node scripts/smoke-shell.mjs              the development build (or STYK_TAURI_EXECUTABLE)
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tauri, tauriExecutable } from '../tests/support/tauri-app.mjs';

const executable = tauriExecutable();
const work = mkdtempSync(path.join(os.tmpdir(), 'styk-shell-'));
const failures = [];
const expect = (name, condition, detail = '') => { if (!condition) failures.push(name); console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

function profileWithHooks(name, answers) {
  const p = mkdtempSync(path.join(work, `${name}-profile-`)), h = mkdtempSync(path.join(work, `${name}-hooks-`));
  writeFileSync(path.join(p, 'telemetry-state.json'), JSON.stringify({ decided: true, consent: { analytics: false, diagnostics: false, policyVersion: '2026-09-10', updatedAt: Date.now() } }));
  writeFileSync(path.join(h, 'answers.json'), JSON.stringify(answers));
  return { profile: p, hooks: h };
}

try {
  // 1. Window controls and the close prompt.
  {
    const { profile, hooks } = profileWithHooks('controls', { message: ['cancel', 'save', 'discard'] });
    const app = await tauri.launch({ executablePath: executable, env: { ...process.env, STYK_USER_DATA_DIR: profile, STYK_TEST_HOOKS: hooks } });
    const page = await app.firstWindow();
    await page.waitForFunction(() => window.stykDesktop?.pageListening, undefined, { timeout: 60000 });
    await page.evaluate(() => {
      window.__shell = { states: [], actions: [] };
      window.stykDesktop.onWindowState(state => window.__shell.states.push(state));
      window.stykDesktop.onMenuAction(action => window.__shell.actions.push(action));
      return window.stykDesktop.pageListening();
    });
    const before = await page.evaluate(() => window.stykDesktop.getWindowState());
    expect('The window state has its three fields', ['maximized', 'fullscreen', 'focused'].every(key => typeof before[key] === 'boolean'), JSON.stringify(before));
    const maximized = await page.evaluate(() => window.stykDesktop.maximize());
    await sleep(500);
    const restored = await page.evaluate(() => window.stykDesktop.maximize());
    await sleep(500);
    const seen = await page.evaluate(() => window.__shell.states);
    expect('Maximize and restore answer with the new state', maximized.maximized === true && restored.maximized === false, `${maximized.maximized} then ${restored.maximized}`);
    expect('The page hears the window state change', seen.some(state => state.maximized) && seen.at(-1)?.maximized === false, JSON.stringify(seen));
    const unknown = await page.evaluate(() => window.stykDesktop.close === undefined ? null : window.__TAURI__.core.invoke('window', { action: 'shake' }).then(() => 'accepted', error => error.message ?? String(error)));
    expect('An unknown window action is refused', unknown !== 'accepted', unknown);

    await page.evaluate(() => window.stykDesktop.setDocumentState({ name: 'Walk cycle', dirty: true, revision: 'r1', unsaved: 1 }));
    // Cancel: the window stays.
    await page.evaluate(() => window.stykDesktop.close());
    await sleep(1000);
    expect('Cancel keeps the window and its work', alive(app.process().pid) && (await page.evaluate(() => 1).catch(() => 0)) === 1);
    // A close asked at a checkpoint that is no longer current is refused without a question.
    const stale = await page.evaluate(() => window.stykDesktop.close({ revision: 'r0', saved: false }));
    expect('A close at a stale checkpoint is refused', stale === false, String(stale));
    // Save: the page is asked to save and close.
    await page.evaluate(() => window.stykDesktop.close());
    await page.waitForFunction(() => window.__shell.actions.includes('save-and-close'), undefined, { timeout: 10000 }).catch(() => {});
    expect('Save asks the page to save and close', (await page.evaluate(() => window.__shell.actions)).includes('save-and-close'));
    // Discard: the window closes and the process ends.
    await page.evaluate(() => window.stykDesktop.close()).catch(() => {});
    for (let i = 0; i < 100 && alive(app.process().pid); i++) await sleep(100);
    expect('Discard closes the window and ends the process', !alive(app.process().pid));
    expect('The questions were the unsaved-work question, three times', JSON.parse(readFileSync(path.join(hooks, 'answers.json'), 'utf8')).message.length === 0);
    await app.close();
  }

  // 2. A link from a second launch reaches the first window; a second launch with a path opens its own window.
  {
    const { profile, hooks } = profileWithHooks('instance', { message: ['discard', 'discard', 'discard'] });
    const env = { ...process.env, STYK_USER_DATA_DIR: profile, STYK_TEST_HOOKS: hooks };
    const first = await tauri.launch({ executablePath: executable, env });
    const page = await first.firstWindow();
    await page.waitForFunction(() => window.stykDesktop?.pageListening, undefined, { timeout: 60000 });
    await page.evaluate(() => { window.__actions = []; window.stykDesktop.onMenuAction(action => window.__actions.push(action)); return window.stykDesktop.pageListening(); });
    // The link launch: no window of its own, it hands the link over and ends.
    const linkRun = spawnSync(executable, ['stykanimate://privacy'], { env: { ...env, STYK_BACKGROUND_WINDOW: '1' }, timeout: 30000 });
    expect('A launch with only a link ends at once', linkRun.status === 0, `exit ${linkRun.status}`);
    await page.waitForFunction(() => window.__actions.includes('privacy'), undefined, { timeout: 10000 }).catch(() => {});
    expect('The link reaches the first window as its menu action', (await page.evaluate(() => window.__actions)).includes('privacy'));
    const bogus = spawnSync(executable, ['stykanimate://privacy?x=1'], { env: { ...env, STYK_BACKGROUND_WINDOW: '1' }, timeout: 30000 });
    await sleep(500);
    expect('A link with a query is not acted on', bogus.status === 0 && (await page.evaluate(() => window.__actions.filter(a => a === 'privacy').length)) === 1);

    // A second launch with a path: its own process, window and workspace folder.
    const file = path.join(work, 'Second.styk');
    writeFileSync(file, '{}');
    const second = await tauri.launch({ executablePath: executable, args: [file], env: { ...env, STYK_STARTUP_VIEW: '' } });
    const secondPage = await second.firstWindow();
    await secondPage.waitForFunction(() => window.stykDesktop?.isDesktop, undefined, { timeout: 60000 });
    const workspaces = existsSync(path.join(profile, 'workspaces')) ? readdirSync(path.join(profile, 'workspaces')) : [];
    expect('A second launch opens its own window with its own workspace folder', workspaces.includes(String(second.process().pid)), workspaces.join(', '));
    expect('Its window starts on the editor, for the file it was given', (await secondPage.evaluate(() => window.stykDesktop.startupView)) === 'editor');
    await second.close();

    // New window: another process, which takes a workspace folder.
    const beforeNew = new Set(readdirSync(path.join(profile, 'workspaces')));
    expect('New window answers true', (await page.evaluate(() => window.stykDesktop.newWindow())) === true);
    let created = [];
    for (let i = 0; i < 100 && !created.length; i++) { await sleep(200); created = readdirSync(path.join(profile, 'workspaces')).filter(name => !beforeNew.has(name) || alive(Number(name)) && !beforeNew.has(name)); }
    expect('New window starts another process with its own workspace', created.length > 0, created.join(', '));
    for (const pid of created) spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' });
    await first.close();
  }
} finally {
  await sleep(500);
  rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
if (failures.length) { console.error(`\n${failures.length} check(s) failed:\n - ${failures.join('\n - ')}`); process.exitCode = 1; }
else console.log('\nThe shell behaves as the Electron app did.');
