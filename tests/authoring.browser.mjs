/** Bounded application authoring flows. Requires the local app at STYK_URL. */
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(appRoot, 'artifacts'), url = process.env.STYK_URL || 'http://127.0.0.1:47831';
await mkdir(out, {recursive: true});
const browser = await chromium.launch({channel: 'chrome', headless: true});
const context = await browser.newContext({viewport: {width: 1500, height: 940}, acceptDownloads: true});
const page = await context.newPage(), checks = [], errors = [], consoleErrors = [], findings = [];
page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.stack));
page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
const check = (name, value = true) => { assert.ok(value, name); checks.push({name, passed: true}); console.log('PASS', name); };
const value = fn => page.evaluate(fn);
const blur = () => page.locator('[data-tool="select"]').click();
async function saveDownload(action, filename) {
  const promise = page.waitForEvent('download'); promise.catch(() => {}); await action();
  const download = await promise, target = path.join(out, filename);
  await download.saveAs(target); return target;
}
let mediaProbe, recoveryProbe;
try {
  await page.goto(url); await page.waitForFunction(() => window.styk?.ready);
  check('Authoring application initializes WebGPU', await value(() => styk.state.renderer.stats.backend === 'WebGPU'));
  const initial = await value(() => ({count: styk.editor.frame.objects.length, uid: styk.editor.selectedUid, x: styk.editor.object.root_x}));
  await blur(); await page.keyboard.press('Control+c'); await page.keyboard.press('Control+v');
  check('Figure keyboard copy/paste adds a distinct identity', await value(() => styk.editor.frame.objects.length) === initial.count + 1 && await value(() => styk.editor.selectedUid) !== initial.uid);
  const pasted = await value(() => styk.editor.selectedUid);
  await page.keyboard.press('Control+x');
  check('Figure keyboard cut removes the selected pasted figure', await value(() => styk.editor.frame.objects.length) === initial.count && !await page.evaluate(uid => styk.editor.frame.objects.some(o => o.unique_id === uid), pasted));
  await page.keyboard.press('Control+v');
  check('Cut figure can be pasted again', await value(() => styk.editor.frame.objects.length) === initial.count + 1);
  await page.keyboard.press('Control+z');
  check('Pasted figure is one undo transaction', await value(() => styk.editor.frame.objects.length) === initial.count);

  const png = await value(() => {
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 24;
    const c = canvas.getContext('2d'); c.fillStyle = '#128ac7'; c.fillRect(0, 0, 32, 24);
    c.fillStyle = '#ffb443'; c.fillRect(5, 4, 13, 13); return canvas.toDataURL('image/png').split(',')[1];
  });
  const imagePath = path.join(out, 'authoring-input.png'); await writeFile(imagePath, Buffer.from(png, 'base64'));
  await page.locator('.brand').click();
  const spriteChooser = page.waitForEvent('filechooser'); await page.locator('[data-action="import-sprite"]').click();
  await (await spriteChooser).setFiles(imagePath);
  await page.waitForFunction(n => styk.editor.frame.objects.length === n + 1, initial.count);
  check('Sprite menu and image input create an embedded editable figure', await value(() => styk.editor.figure.image_assets[0].data_url.startsWith('data:image/png;base64,')));
  const beforeBackground = await value(() => ({backgrounds: styk.editor.report.backgrounds.length, id: styk.editor.frame.background_id}));
  await page.locator('.brand').click();
  const backgroundChooser = page.waitForEvent('filechooser'); await page.locator('[data-action="import-background"]').click();
  await (await backgroundChooser).setFiles(imagePath);
  await page.waitForFunction(n => styk.editor.report.backgrounds.length === n + 1, beforeBackground.backgrounds);
  check('Background menu and image input assign an embedded image background', await value(() => styk.editor.frame.background_id > 0));
  await blur(); await page.keyboard.press('Control+z');
  check('Background import undo restores table and frame reference', await value(() => styk.editor.report.backgrounds.length) === beforeBackground.backgrounds && await value(() => styk.editor.frame.background_id) === beforeBackground.id);
  await page.keyboard.press('Control+Shift+z');
  check('Background import redo restores embedded image', await value(() => styk.editor.report.backgrounds.length) === beforeBackground.backgrounds + 1);

  await page.locator('[data-inspector="animation"]').click();
  check('Animation inspector tab exposes timing controls', await page.locator('[data-field="duration"]').isVisible() && await page.locator('#easing').count() === 0);
  await page.locator('[data-field="duration"]').fill('4'); await page.locator('[data-field="duration"]').press('Tab');
  check('Animation inspector edits keyframe duration', await value(() => styk.editor.frame.duration_raw) === 4);
  await page.locator('[data-inspector="design"]').click();
  check('Design inspector returns to figure properties', await page.locator('[data-field="root_x"]').isVisible());
  await page.screenshot({path: path.join(out, 'authoring-media-ui.png')});

  // Use deterministic three-key fixtures for timeline range operations and video.
  await value(() => { const e = styk.editor; e.newDocument(); e.updateProject({canvas_width: 160, canvas_height: 100, fps: 10}); e.updateObject({root_x: 30, root_y: 60, scale: .15}); e.addFrame(); e.updateObject({root_x: 70}); e.addFrame(); e.updateObject({root_x: 110}); e.selectFrame(0); styk.fit(); });
  await page.locator('#timeline-zoom').fill('18'); await page.locator('#timeline-zoom').dispatchEvent('input');
  const scroll = page.locator('.styk-timeline-scroll'), box = await scroll.boundingBox();
  await page.mouse.click(box.x + 12 + 9, box.y + 14);
  await page.keyboard.down('Shift'); await page.mouse.click(box.x + 12 + 2 * 18 + 9, box.y + 14); await page.keyboard.up('Shift');
  await page.mouse.click(box.x + 12 + 18 + 9, box.y + 14, {button: 'right'});
  check('Integrated timeline Shift-click selects a three-key range', (await page.locator('.styk-timeline-menu-label').textContent()).includes('3 KEYFRAMES'));
  await page.locator('[data-command="reverseSelection"]').click();
  check('Timeline context reverse changes the selected keyframe sequence', await value(() => styk.editor.report.keyframes.map(f => f.objects[0].root_x).join(',')) === '110,70,30');
  await page.keyboard.press('Control+z');
  if (await value(() => styk.editor.report.keyframes.map(f => f.objects[0].root_x).join(',')) !== '30,70,110') {
    findings.push('Ctrl+Z while the timeline is focused does not undo timeline Reverse.');
    await blur(); await page.keyboard.press('Control+z');
  }
  check('Timeline reverse undo restores all keys', await value(() => styk.editor.report.keyframes.map(f => f.objects[0].root_x).join(',')) === '30,70,110');
  await blur();
  check('Tiny video fixture has exactly three output ticks', await value(() => styk.editor.totalTicks) === 3);
  if (process.env.STYK_SKIP_VIDEO !== '1') {
  await page.locator('[data-action="export"]').first().click();
  const videoPath = await saveDownload(() => page.locator('[data-action="export-video"]').click(), 'authoring-three-frames.webm');
  check('WebM export downloads a nonempty file', (await readFile(videoPath)).byteLength > 100);
  try { mediaProbe = await page.evaluate(async bytes => {
    const video = document.createElement('video'); video.muted = true;
    const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes)], {type: 'video/webm'}));
    Object.assign(video.style, {position: 'fixed', left: '0', top: '0', zIndex: '99999'}); document.body.append(video);
    try {
      const complete = new Promise((resolve, reject) => { video.onended = resolve; video.onerror = () => reject(new Error('Downloaded WebM cannot be decoded.')); });
      video.src = url; await Promise.all([video.play(), complete]);
      const quality = video.getVideoPlaybackQuality();
      return {width: video.videoWidth, height: video.videoHeight, decodedFrames: quality.totalVideoFrames,
        droppedFrames: quality.droppedVideoFrames, duration: Number.isFinite(video.duration) ? video.duration : null};
    } finally { video.remove(); URL.revokeObjectURL(url); }
  }, [...await readFile(videoPath)]);
  check('Downloaded WebM decodes at project dimensions', mediaProbe.width === 160 && mediaProbe.height === 100);
  check('Downloaded WebM contains all three requested frames', mediaProbe.decodedFrames === 3);
  } catch (error) { findings.push(`WebM decode/frame verification failed: ${error.message}`); mediaProbe = {error: error.message, bytes: (await readFile(videoPath)).byteLength}; }
  } else findings.push('WebM flow explicitly skipped by STYK_SKIP_VIDEO.');

  await value(() => styk.editor.markSaved());
  const sourcePath = path.resolve(appRoot, '../Pivot Animator v5/Animations/tween_pendulum.piv');
  await page.locator('#file-input').setInputFiles(sourcePath);
  await page.waitForFunction(() => styk.editor.name === 'tween_pendulum');
  await value(() => styk.editor.select(styk.editor.frame.objects[0].unique_id));
  await page.locator('[data-field="root_x"]').fill('77'); await page.locator('[data-field="root_x"]').press('Tab');
  const stykPath = await saveDownload(() => page.locator('[data-action="save"]').first().click(), 'authoring-source.styk');
  const native = JSON.parse(await readFile(stykPath, 'utf8'));
  const savedDocument = native.document || native, source = await readFile(sourcePath);
  check('Native save retains edited pose and inline original PIV source', savedDocument.keyframes[0].objects.some(o => o.root_x === 77) && Buffer.from(savedDocument._stykSource.source_base64, 'base64').equals(source));
  check('Native source fingerprint matches the supplied original', savedDocument._stykSource.sha256 === createHash('sha256').update(source).digest('hex'));
  await page.locator('#file-input').setInputFiles(stykPath); await page.waitForFunction(() => styk.editor.name === 'authoring-source');
  check('Actual native save reload preserves edited pose', await value(() => styk.editor.frame.objects.some(o => o.root_x === 77)));

  const beforeCorrupt = await value(() => JSON.stringify(styk.editor.serialize()));
  await page.locator('#file-input').setInputFiles({name: 'corrupted.piv', mimeType: 'application/octet-stream', buffer: Buffer.from('This is not a Pivot animation.')});
  await page.waitForFunction(() => !styk.state.importing && document.querySelector('#status-dot').classList.contains('error'));
  check('Corrupt PIV import reports an error and preserves current scene', await value(() => JSON.stringify(styk.editor.serialize())) === beforeCorrupt);

  await value(() => { styk.editor.name = 'Authoring recovery'; styk.editor.select(styk.editor.frame.objects[0].unique_id); styk.editor.updateObject({root_x: 93}); });
  // waitForFunction does not repoll a Promise that resolves false in this runtime.
  // Read using evaluate, then poll in Node until the real IndexedDB transaction ends.
  let stored, deadline = Date.now() + 15000;
  do {
    stored = await value(() => new Promise(resolve => {
      const req = indexedDB.open('stykanimate-recovery', 1); req.onsuccess = () => {
        const db = req.result, tx = db.transaction('documents'), get = tx.objectStore('documents').get('latest');
        let result = null;
        get.onsuccess = () => { result = {name: get.result?.name, blobSize: get.result?.blob?.size, isBlob: get.result?.blob instanceof Blob}; };
        tx.oncomplete = () => { db.close(); resolve(result); }; tx.onerror = () => { db.close(); resolve(null); };
      }; req.onerror = () => resolve(null);
    }));
    if (stored?.name === 'Authoring recovery' && stored?.isBlob) break;
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);
  check('Autosave writes a persistent source-bearing native Blob', stored?.name === 'Authoring recovery' && stored?.isBlob && stored.blobSize > 0);
  await value(() => styk.editor.markSaved()); await page.reload(); await page.waitForFunction(() => styk?.ready);
  recoveryProbe = await value(() => new Promise(resolve => {
    const req = indexedDB.open('stykanimate-recovery', 1); req.onsuccess = () => {
      const db = req.result, tx = db.transaction('documents'), get = tx.objectStore('documents').get('latest');
      get.onsuccess = () => resolve({url: location.href, name: get.result?.name, blobSize: get.result?.blob?.size, banner: !!document.getElementById('restore-recovery')});
      get.onerror = () => resolve({error: get.error?.message}); tx.oncomplete = () => db.close();
    }; req.onerror = () => resolve({error: req.error?.message});
  }));
  console.log('Recovery after reload', JSON.stringify(recoveryProbe));
  await page.locator('#restore-recovery').click();
  await page.waitForFunction(() => styk.editor.name === 'Authoring recovery' && styk.editor.frame.objects.some(o => o.root_x === 93));
  check('Recovery restores actual edits after page reload in the same context', await value(() => styk.editor.dirty));
  check('Recovery retains embedded original source for future interchange', await value(() => !!styk.editor.report._stykSource?.source_base64));
  await page.screenshot({path: path.join(out, 'authoring-recovery-ui.png')});
  assert.deepEqual(errors, []); check('No uncaught browser exceptions');
  assert.deepEqual(findings, []);
  await writeFile(path.join(out, 'authoring-verification.json'), JSON.stringify({checks, errors, consoleErrors, findings, mediaProbe, recoveryProbe, timestamp: new Date().toISOString()}, null, 2));
} catch (error) {
  await page.screenshot({path: path.join(out, 'authoring-failure.png')});
  await writeFile(path.join(out, 'authoring-verification.json'), JSON.stringify({checks, errors, consoleErrors, findings, mediaProbe, recoveryProbe, failure: error.stack}, null, 2));
  throw error;
} finally { await browser.close(); }
