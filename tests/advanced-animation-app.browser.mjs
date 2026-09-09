/** Actual application timeline gestures, inspector keys, native save/export and pixels. */
import {chromium} from 'playwright';
import {createRequire} from 'node:module';
import {mkdir, writeFile, readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';
const require = createRequire(import.meta.url), {startBackend} = require('../desktop/backend.cjs');
const appRoot = fileURLToPath(new URL('..', import.meta.url)), out = path.join(appRoot, 'artifacts');
await mkdir(out, {recursive: true});
const report = emptyDocument(); report.canvas_width = 640; report.canvas_height = 400;
report.backgrounds = [{background_id: 1, kind: 2, color: 0xffc8ead8, name: 'Green'}, {background_id: 2, kind: 2, color: 0xffead8c8, name: 'Sand'}];
report.keyframes = [120, 300, 160].map((x, index) => ({...createFrame([
  createObject(report.figure_types[0], 1, x, 230), createObject(report.figure_types[0], 2, 450 - index * 10, 225),
  createObject(report.figure_types[0], 3, x, 152, {scale: .35, join: {target_object_slot: 0, target_unique_id: 1, target_handle_id: 1}}),
], 50), background_id: index, camera: {is_default: false, x: 15 + index * 15, y: 20, scale: 1.2 + index * .2, angle_rad: .1 + index * .1}}));
const fixture = new Editor({demo: false}).load(report), second = fixture.createLayer('Other figure');
fixture.assignFiguresToLayer([2], second.id); fixture.report._styk.name = 'Timeline integration';
const sourcePath = path.join(out, 'advanced-track-source.styk'); await writeFile(sourcePath, JSON.stringify(fixture.serialize()));
const backend = await startBackend({appRoot}); let browser;
const checks = [], errors = [], findings = [], check = (name, value = true) => { assert.ok(value, name); checks.push(name); console.log('PASS', name); };
try {
  browser = await chromium.launch({channel: 'chrome', headless: true});
  const page = await browser.newPage({viewport: {width: 1500, height: 950}, acceptDownloads: true}); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.stack || error.message));
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  async function openProject(file) {
    await page.evaluate(() => { globalThis.__previousOpenDocument = styk.editor.report; });
    await page.locator('#file-input').setInputFiles(file);
    await page.waitForFunction(() => styk.editor.report !== globalThis.__previousOpenDocument);
    await settle();
  }
  const point = (trackId, tick, ruler = false) => page.evaluate(({trackId, tick, ruler}) => {
    const timeline = styk.timeline, rect = timeline.scroll.getBoundingClientRect(), index = timeline.tracks.findIndex(track => track.id === trackId);
    if (!ruler && index < 0) throw new Error(`Track ${trackId} is missing.`);
    return {x: rect.left + 12 + (tick + .5) * timeline.pxPerTick - timeline._offsetX(),
      y: rect.top + (ruler ? 12 : 31 + index * 30 + 15 - timeline._offsetY())};
  }, {trackId, tick, ruler});
  async function seek(tick) { const p = await point(null, tick, true); await page.mouse.click(p.x, p.y); await settle(); assert.equal(await page.evaluate(() => styk.editor.tick), tick); }
  async function exportFile(kind, name) {
    await page.locator('[data-action="export"]').first().click(); const pending = page.waitForEvent('download'); pending.catch(() => {});
    await page.locator(`[data-action="export-${kind}"]`).click(); const download = await pending, target = path.join(out, name); await download.saveAs(target);
    await page.waitForFunction(() => !document.querySelector('#dialog').open); return target;
  }
  async function saveProject(name) {
    const pending = page.waitForEvent('download'); pending.catch(() => {}); await page.locator('[data-action="save"]').first().click();
    const target = path.join(out, name); await (await pending).saveAs(target); return target;
  }
  async function comparePNGs(files) {
    const blobs = await Promise.all(files.map(file => readFile(file).then(bytes => [...bytes])));
    return page.evaluate(async buffers => {
      const images = await Promise.all(buffers.map(bytes => createImageBitmap(new Blob([new Uint8Array(bytes)], {type: 'image/png'}))));
      if (images.some(image => image.width !== images[0].width || image.height !== images[0].height)) throw new Error('Exported image dimensions changed.');
      const data = images.map(image => { const canvas = new OffscreenCanvas(image.width, image.height), ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0); return ctx.getImageData(0, 0, image.width, image.height).data; });
      return data.slice(1).map(next => { let sum = 0, max = 0; for (let i = 0; i < next.length; i++) { const n = Math.abs(next[i] - data[0][i]); sum += n; max = Math.max(max, n); } return {mean: sum / next.length, max}; });
    }, blobs);
  }
  const values = () => page.evaluate(() => Object.fromEntries(styk.editor.evaluatedFrame.objects.map(object => [object.unique_id, {x: object.root_x, y: object.root_y, angles: object.angles}])));
  await page.goto(backend.origin); await page.waitForFunction(() => styk?.ready);
  await openProject(sourcePath); await page.waitForFunction(() => styk.editor.report.keyframes.length === 3 && styk.editor.report.keyframes[0].objects[0].root_x === 120);
  check('Actual app starts a WebGPU scene and an advanced channel timeline', await page.evaluate(() => styk.state.renderer.stats.backend === 'WebGPU' && styk.timeline.channelMode));
  await page.locator('#timeline-zoom').focus(); await page.keyboard.press('Home'); await settle();
  check('The timeline zoom control exposes the full 101-frame sequence', await page.evaluate(() => styk.timeline.pxPerTick === 5));
  const nativeFrames = await page.evaluate(() => JSON.stringify(styk.editor.report.keyframes));
  await seek(25); const initial = await values(); assert.equal(initial[1].x, 210); assert.equal(initial[2].x, 445);
  const from = await point('layer-1', 50), to = await point('layer-1', 70);
  await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, {steps: 16});
  check('Native track key drag previews without modifying native frame storage', await page.evaluate(() => styk.editor.animationChannels.length === 0));
  await page.mouse.up(); await settle(); await seek(25);
  const moved = await values(); check('Moving one layer key changes that figure path while the other layer keeps native timing', Math.abs(moved[1].x - (120 + 180 * 25 / 70)) < .001 && moved[2].x === 445);
  check('The adopted track retains native source poses exactly', await page.evaluate(() => JSON.stringify(styk.editor.report.keyframes)) === nativeFrames);
  await page.keyboard.press('Control+z'); await settle(); await seek(25); check('Track adoption and key move undo together', (await values())[1].x === 210);
  await page.keyboard.press('Control+Shift+z'); await settle(); await seek(25); check('Redo restores the independent timeline movement', Math.abs((await values())[1].x - moved[1].x) < .001);
  const movedKey = await point('layer-1', 70); await page.mouse.click(movedKey.x, movedKey.y); await page.keyboard.press('Delete'); await settle(); await seek(25);
  check('Deleting the layer key removes its pose influence without retiming the other figure', Math.abs((await values())[1].x - 130) < .001 && (await values())[2].x === 445);
  await page.keyboard.press('Control+z'); await settle();
  await seek(0); await page.locator('[data-track-id="camera"] .styk-timeline-label-select').click();
  await page.locator('[data-property-key="camera_x"]').click(); await seek(100);
  await page.locator('[data-property="camera_x"]').fill('30'); await page.locator('[data-property="camera_x"]').press('Enter'); await settle(); await seek(25);
  check('Camera inspector diamond and numeric entry create an independent interpolated property', Math.abs(await page.evaluate(() => styk.editor.evaluatedFrame.camera.x) - 18.75) < .001);
  await seek(0); await page.locator('[data-track-id="scene"] .styk-timeline-label-select').click();
  await page.locator('[data-property-key="scene_color"]').click(); await seek(100);
  await page.locator('#background-color').fill('#dceeff'); await page.locator('#background-color').dispatchEvent('change'); await settle();
  const sceneKeys = await page.evaluate(() => styk.editor.animationChannel({kind: 'scene'}, 'color')?.keys.map(key => ({tick: key.tick, value: key.value})));
  check('Scene inspector color input edits its existing scalar track', sceneKeys?.some(key => key.tick === 100 && key.value === 0xffdceeff));
  await seek(25); await page.screenshot({path: path.join(out, 'advanced-track-app.png')});
  const beforePNG = await exportFile('png', 'advanced-track-before.png');
  const pivPath = await exportFile('piv', 'advanced-track-edited.piv'), stykPath = await saveProject('advanced-track-edited.styk');
  const savedMetadata = await page.evaluate(() => JSON.stringify(styk.editor.report._styk.animation));
  await openProject(stykPath); await page.waitForFunction(() => styk.editor.animationChannels.some(channel => channel.property === 'color'));
  check('Saving and reopening STYK preserves exact sparse channels', await page.evaluate(() => JSON.stringify(styk.editor.report._styk.animation)) === savedMetadata);
  await seek(25); const restoredPNG = await exportFile('png', 'advanced-track-restored.png');
  await openProject(pivPath); await page.waitForFunction(() => styk.editor.report.keyframes.length === 101 && styk.editor.animationChannels.length === 0);
  check('Actual PIV export bakes independent tracks once and reopens without duplicate overlays', await page.evaluate(() => styk.editor.totalTicks === 101));
  await seek(25); const nativePNG = await exportFile('png', 'advanced-track-native.png');
  const pixels = await comparePNGs([beforePNG, restoredPNG, nativePNG]);
  check('Actual exported PNG pixels survive STYK and native PIV reopening', pixels.every(result => result.mean < .01));
  // Reopen authored metadata before checking an advanced-only blank key shortcut.
  await openProject(stykPath); await page.waitForFunction(() => styk.editor.animationChannels.length > 0); await settle();
  const empty = await point('layer-1', 40); await page.mouse.click(empty.x, empty.y); await page.keyboard.press('F7'); await settle();
  const blank = await page.evaluate(() => styk.editor.animationChannel({kind: 'layer', id: 'layer-1'}, 'pose')?.keys.find(key => key.tick === 40 && key.value?.frameId === null));
  check('F7 inserts a blank pose on the selected advanced layer', blank);
  check('A blank layer removes only its assigned figures and attached children', await page.evaluate(() => styk.editor.evaluatedFrame.objects.map(object => object.unique_id).join(',') === '2'));
  await page.keyboard.press('Control+z'); await settle();
  check('Undo restores the blanked layer without changing the other track', (await values())[1] !== undefined && (await values())[3] !== undefined);
  await page.keyboard.press('Control+Shift+z'); await settle();
  for (const trackId of ['camera', 'scene']) {
    const p = await point(trackId, 40); await page.mouse.click(p.x, p.y); await page.keyboard.press('F7'); await settle();
    check(`F7 inserts a blank native pose on the ${trackId} track`, await page.evaluate(kind => styk.editor.animationChannel({kind}, 'pose')?.keys.some(key => key.tick === 40 && key.value?.frameId === null), trackId));
  }
  check('Blank Camera resets unkeyed fields while independent Camera X remains active', await page.evaluate(() => {
    const camera = styk.editor.evaluatedFrame.camera; return camera.y === 0 && camera.scale === 1 && camera.angle_rad === 0 && Math.abs(camera.x - 21) < .001;
  }));
  check('Blank Scene resets its native background while independent Scene color remains active', await page.evaluate(() => styk.editor.evaluatedFrame.background_id === 0 && styk.editor.evaluatedFrame._stykBackgroundColor !== undefined));
  const blankPNG = await exportFile('png', 'advanced-track-blank-before.png');
  const blankPivPath = await exportFile('piv', 'advanced-track-blank.piv'), blankStykPath = await saveProject('advanced-track-blank.styk');
  await openProject(blankStykPath); await page.waitForFunction(() => styk.editor.animationChannels.filter(channel => channel.property === 'pose' && channel.keys.some(key => key.value?.frameId === null)).length === 3);
  await seek(40); const blankRestoredPNG = await exportFile('png', 'advanced-track-blank-restored.png');
  await openProject(blankPivPath); await page.waitForFunction(() => styk.editor.animationChannels.length === 0); await seek(40);
  check('Blank layer presence survives actual PIV export and reopening', await page.evaluate(() => styk.editor.evaluatedFrame.objects.map(object => object.unique_id).join(',') === '2'));
  const blankNativePNG = await exportFile('png', 'advanced-track-blank-native.png');
  const blankPixels = await comparePNGs([blankPNG, blankRestoredPNG, blankNativePNG]);
  check('Blank layer and fixed-track pixels survive STYK and PIV reopening', blankPixels.every(result => result.mean < .01));
  if (errors.length) throw new Error(errors.join('\n'));
  await writeFile(path.join(out, 'advanced-track-app.json'), JSON.stringify({checks, findings, errors, pixels, blankPixels, pivPath, stykPath, blankPivPath, blankStykPath}, null, 2));
  console.log(JSON.stringify({checks, findings, pixels, blankPixels}, null, 2));
} finally { await browser?.close(); backend.stop(); }
