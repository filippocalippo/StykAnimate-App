// Playback draws each animation frame once, and only as the prepared (clipped) playback picture.
//
//   node scripts/smoke-playback-draws.mjs
//
// Opens the app on its startup document with a few frames added, plays it for three seconds and counts what the
// stage was asked to draw: the editing view (unclipped, so artwork outside the canvas edge shows) must never be
// drawn while the animation plays, and the prepared frames drawn must not outnumber the animation's frames.
// Without this a frame doubled up as editing view and prepared frame blinks wherever artwork crosses the edge.
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '../tests/support/playwright.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLAY_MS = 3000;
// The last frame being drawn again after a stall, and the first one at the start.
const SLACK = 2;
const profile = await mkdtemp(path.join(os.tmpdir(), 'styk-playback-draws-'));
await writeFile(path.join(profile, 'telemetry-state.json'), JSON.stringify({ decided: true, consent: { analytics: false, diagnostics: false, policyVersion: '2026-09-10', updatedAt: Date.now() } }));
const failures = [];
const expect = (name, condition, detail = '') => { if (!condition) failures.push(`${name}${detail ? ` (${detail})` : ''}`); console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
let app;
try {
  const env = { ...process.env, STYK_USER_DATA_DIR: profile, STYK_STARTUP_VIEW: 'editor', STYK_BACKGROUND_WINDOW: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [appRoot], cwd: appRoot, timeout: 60000, env });
  const page = await app.firstWindow({ timeout: 60000 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForFunction(() => window.styk?.ready === true, undefined, { timeout: 60000 });
  await page.evaluate(async () => {
    document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close());
    for (let i = 0; i < 6; i++) await window.styk.actions['add-frame']();
    window.styk.editor.seek(0);
  });
  await page.waitForTimeout(1500);
  const played = await page.evaluate(async (ms) => {
    const stage = window.styk.state.renderer, counts = { edit: 0, prepared: 0, preparedDrawn: 0 };
    const render = stage.render, renderPrepared = stage.renderPrepared;
    stage.render = (...args) => { counts.edit++; return render.apply(stage, args); };
    stage.renderPrepared = (...args) => { counts.prepared++; const drawn = renderPrepared.apply(stage, args); if (drawn) counts.preparedDrawn++; return drawn; };
    await window.styk.actions.play();
    await new Promise((resolve) => setTimeout(resolve, ms));
    const frames = window.styk.performance().presentation.totalFrames, playing = window.styk.state.playing;
    if (playing) await window.styk.actions.play();
    stage.render = render; stage.renderPrepared = renderPrepared;
    return { ...counts, frames, playing };
  }, PLAY_MS);
  console.log(JSON.stringify(played));
  expect('The animation played', played.playing && played.frames >= 20, `${played.frames} frames`);
  expect('No editing view is drawn while it plays', played.edit === 0, `${played.edit} draws`);
  expect('Each animation frame is drawn once', played.preparedDrawn <= played.frames + SLACK, `${played.preparedDrawn} draws for ${played.frames} frames`);
  expect('No page errors', errors.length === 0, errors.join('; '));
} finally {
  // The frames added above are unsaved work, which holds the quit behind a native prompt: it answers "discard"
  // without showing, and after 15 s this run's own process tree is ended whatever happens.
  const pid = app?.process().pid;
  await app?.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 2, checkboxChecked: false }); }).catch(() => {});
  const closed = app ? await Promise.race([app.close().then(() => true, () => true), new Promise((resolve) => setTimeout(resolve, 15000, false))]) : true;
  if (!closed && pid) {
    try { if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); else process.kill(pid, 'SIGKILL'); } catch { /* it exited */ }
  }
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
if (failures.length) console.error(`\n${failures.length} check(s) failed:\n- ${failures.join('\n- ')}`);
else console.log('\nPlayback draws every frame once.');
process.exit(failures.length ? 1 : 0);
