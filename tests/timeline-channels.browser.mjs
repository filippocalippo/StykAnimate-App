import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(appRoot, 'artifacts');
const harness = `<!doctype html><html><head><meta charset="utf-8"><title>Layer timeline verification</title>
<style>body{margin:0;padding:24px;background:#f2f3f5;font:13px 'Segoe UI',sans-serif;color:#555}h1{font-size:16px;font-weight:500}#timeline{height:420px;width:1120px;border:1px solid #d9dfe6;border-radius:6px;overflow:hidden}</style></head>
<body><h1>StykAnimate · layers and property animation</h1><div id="timeline"></div><script type="module">
import {Editor} from '/src/editor.mjs'; import {Timeline} from '/src/timeline.mjs';
window.editor = new Editor(); window.failures = []; window.changes = [];
window.bubbledF7 = 0; document.addEventListener('keydown', event => { if (event.key === 'F7') bubbledF7++; });
const second = editor.createLayer('Character'); editor.assignFiguresToLayer([3], second.id ?? second);
window.timeline = new Timeline(document.querySelector('#timeline'), editor, {mode:'tracks', onError: error => failures.push(error.message), onKeysChange: selection => changes.push(selection)});
window.ready = true;
</script></body></html>`;
const server = createServer(async (req, res) => {
  if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end(harness); return; }
  const file = path.resolve(appRoot, `.${new URL(req.url, 'http://localhost').pathname}`);
  if (!file.startsWith(appRoot + path.sep)) { res.writeHead(403); res.end(); return; }
  try { res.setHeader('content-type', 'text/javascript'); res.end(await readFile(file)); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(47838, '127.0.0.1', resolve));
const browser = await chromium.launch({...(process.env.STYK_BROWSER_PATH ? {executablePath: process.env.STYK_BROWSER_PATH} : process.platform === 'win32' ? {channel: 'chrome'} : {}), headless: true});
const page = await browser.newPage({viewport: {width: 1200, height: 560}, deviceScaleFactor: 1});
const errors = [];
page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const cell = async (trackId, tick) => page.evaluate(({trackId, tick}) => {
  const rect = timeline.scroll.getBoundingClientRect(), row = timeline.tracks.findIndex(track => track.id === trackId);
  return {x: rect.left + 12 + (tick + .5) * timeline.pxPerTick - timeline._offsetX(), y: rect.top + 31 + row * 30 + 15 - timeline._offsetY()};
}, {trackId, tick});
try {
  await page.goto('http://127.0.0.1:47838/');
  await page.waitForFunction(() => window.ready);
  assert.equal(await page.evaluate(() => timeline.channelMode), true, 'The actual Editor must provide installed channel methods');
  await settle();
  assert.deepEqual(await page.evaluate(() => timeline.tracks.map(track => track.id)), ['scene', 'camera', 'layer-2', 'layer-1']);
  assert.equal(await page.evaluate(() => editor.animationChannels.length), 0, 'Showing native keys must not author channels');
  const source = await page.evaluate(() => JSON.stringify(editor.report.keyframes));
  const start = await cell('layer-2', 6), finish = await cell('layer-2', 7);
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(finish.x, finish.y, {steps: 16});
  assert.equal(await page.evaluate(() => editor.animationChannels.length), 0, 'Dragging must preview without mutating engine');
  await page.mouse.up(); await settle();
  const afterDrag = await page.evaluate(() => editor.animationChannels.map(channel => ({id: channel.id, target: channel.target, ticks: channel.keys.map(key => key.tick)})));
  assert.equal(afterDrag.length, 1); assert.deepEqual(afterDrag[0].target, {kind: 'layer', id: 'layer-2'});
  assert(afterDrag[0].ticks.includes(7) && !afterDrag[0].ticks.includes(6));
  assert.equal(await page.evaluate(() => JSON.stringify(editor.report.keyframes)), source, 'Layer dragging must never move or edit document frames');
  await page.evaluate(() => editor.undo());
  assert.equal(await page.evaluate(() => editor.animationChannels.length), 0, 'Adopt plus move is one undo command');
  await page.evaluate(() => editor.redo());
  assert.equal(await page.evaluate(() => editor.animationChannels[0].keys[3].tick), 7);
  await page.evaluate(() => editor.undo());
  const nativeIsolation = {singleLayerOnly: true, nativeFramesUntouched: true, noMutationDuringDrag: true, adoptionUndoRedo: true};

  const earlierPoses = await page.evaluate(() => {
    const poses = [0, 2, 4].map(tick => { editor.seek(tick); return JSON.stringify(editor.evaluatedFrame.objects); });
    editor.seek(5); timeline.selectTrack('layer-2'); timeline.scroll.focus(); return poses;
  });
  await page.keyboard.press('F7'); await settle();
  assert.deepEqual(await page.evaluate(() => editor.evaluatedFrame.objects.map(object => object.unique_id)), [1, 2], 'Blanking Character must remove its figure while preserving the other layer');
  assert.equal(await page.evaluate(() => editor.animationChannels.length), 1);
  assert.deepEqual(await page.evaluate(() => editor.animationChannels[0].keys.find(key => key.tick === 5).value), {frameId: null});
  assert.equal(await page.evaluate(() => timeline.selectedAnimationKeys[0].keyIds.length), 1, 'Blank insertion selects only its actual pose key');
  assert.equal(await page.evaluate(() => bubbledF7), 0, 'F7 must not bubble into a second host command');
  assert.equal(await page.evaluate(() => JSON.stringify(editor.report.keyframes)), source);
  assert.deepEqual(await page.evaluate(() => [0, 2, 4].map(tick => { editor.seek(tick); return JSON.stringify(editor.evaluatedFrame.objects); })), earlierPoses, 'Native source poses before the blank must stay intact');
  await page.evaluate(() => { editor.seek(5); timeline.expandedTracks.add('layer-2'); timeline._reindex(); timeline.resize(); timeline.update(); });
  await settle(); await page.screenshot({path: path.join(output, 'timeline-blank-pose.png')});
  await page.evaluate(() => editor.undo());
  assert.equal(await page.evaluate(() => editor.animationChannels.length), 0, 'Native adoption and blank insertion must undo together');
  assert.deepEqual(await page.evaluate(() => editor.evaluatedFrame.objects.map(object => object.unique_id)), [1, 2, 3]);
  await page.evaluate(() => { editor.seek(5); timeline.selectTrack('channel:layer:layer-2:pose'); });
  await page.getByRole('button', {name: 'Insert blank pose key', exact: true}).click();
  assert.deepEqual(await page.evaluate(() => editor.evaluatedFrame.objects.map(object => object.unique_id)), [1, 2]);
  await page.evaluate(() => { editor.undo(); timeline.selectTrack('camera'); });
  await page.getByRole('button', {name: 'More track actions', exact: true}).click();
  await page.getByRole('menuitem', {name: 'Insert blank pose key', exact: true}).click();
  assert.deepEqual(await page.evaluate(() => editor.animationChannels[0].target), {kind: 'camera'});
  assert.deepEqual(await page.evaluate(() => editor.evaluatedFrame.camera), {is_default: true, x: 0, y: 0, scale: 1, angle_rad: 0});
  assert.deepEqual(await page.evaluate(() => editor.evaluatedFrame.objects.map(object => object.unique_id)), [1, 2, 3]);
  await page.evaluate(() => { editor.undo(); timeline.selectTrack('scene'); });
  await page.getByRole('button', {name: 'Insert blank pose key', exact: true}).click();
  assert.deepEqual(await page.evaluate(() => editor.animationChannels[0].target), {kind: 'scene'});
  assert.deepEqual(await page.evaluate(() => [editor.evaluatedFrame.background_id, editor.evaluatedFrame.background_id_b, editor.evaluatedFrame.background_mix]), [0, 0, 0]);
  await page.evaluate(() => { editor.undo(); timeline.expandedTracks.clear(); timeline._reindex(); timeline.resize(); timeline.update(); });
  const blankPoses = {f7: true, noHostBubbling: true, layerPresence: true, priorPosesPreserved: true, nativeFramesUntouched: true,
    adoptionOneUndo: true, exactKeySelection: true, poseLeafToolbar: true, cameraContextMenu: true, sceneToolbar: true};

  await page.evaluate(() => {
    editor.addAnimationKeys([{target: {kind: 'figure', uid: 3}, property: 'x', tick: 2, value: 50}, {target: {kind: 'figure', uid: 3}, property: 'x', tick: 8, value: 110}]);
    timeline.expandedTracks.add('layer-2'); timeline.expandedTracks.add('figure:3'); timeline._reindex(); timeline.resize(); timeline.update();
  });
  await settle();
  const channelId = await page.evaluate(() => editor.animationChannel({kind: 'figure', uid: 3}, 'x').id);
  const rowId = `channel:${channelId}`;
  await page.evaluate(rowId => { timeline.selectTrack(rowId); timeline.scroll.focus(); }, rowId);
  assert(await page.getByRole('button', {name: 'Insert blank pose key', exact: true}).isDisabled(), 'Scalar channels have no blank-pose operation');
  const scalarBeforeF7 = await page.evaluate(() => JSON.stringify(editor.animationChannels));
  await page.keyboard.press('F7');
  assert.equal(await page.evaluate(() => JSON.stringify(editor.animationChannels)), scalarBeforeF7);
  assert.match(await page.evaluate(() => timeline.live.textContent), /Pose track/);
  assert.equal(await page.evaluate(() => bubbledF7), 0);
  blankPoses.scalarExplicitlyDisabled = true;
  let a = await cell(rowId, 2), b = await cell(rowId, 4);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, {steps: 12}); await page.mouse.up();
  assert.deepEqual(await page.evaluate(() => editor.animationChannel({kind: 'figure', uid: 3}, 'x').keys.map(key => key.tick)), [4, 8]);
  await page.evaluate(() => editor.undo()); await settle();
  a = await cell(rowId, 2); b = await cell(rowId, 8);
  await page.mouse.click(a.x, a.y); await page.keyboard.down('Shift'); await page.mouse.click(b.x, b.y); await page.keyboard.up('Shift');
  assert.equal(await page.evaluate(() => timeline.selectedAnimationKeys[0].keyIds.length), 2);
  const destination = await cell(rowId, 10);
  await page.mouse.move(b.x, b.y); await page.mouse.down(); await page.mouse.move(destination.x, destination.y, {steps: 12}); await page.mouse.up();
  assert.deepEqual(await page.evaluate(() => editor.animationChannel({kind: 'figure', uid: 3}, 'x').keys.map(key => key.tick)), [4, 10]);
  await page.evaluate(() => editor.undo()); await settle();
  a = await cell(rowId, 2); b = await cell(rowId, 8);
  await page.mouse.click(a.x, a.y); // clicking a selected group preserves range: explicitly clear then select one
  await page.keyboard.press('Escape'); await page.mouse.click(a.x, a.y);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, {steps: 8}); await page.mouse.up();
  assert.deepEqual(await page.evaluate(() => editor.animationChannel({kind: 'figure', uid: 3}, 'x').keys.map(key => key.tick)), [2, 8]);
  assert.match(await page.evaluate(() => failures.at(-1)), /occupies/);
  await page.evaluate(() => failures.length = 0);
  await page.keyboard.press('Alt+ArrowRight');
  assert.deepEqual(await page.evaluate(() => editor.animationChannel({kind: 'figure', uid: 3}, 'x').keys.map(key => key.tick)), [3, 8]);
  await page.evaluate(() => editor.undo());
  const propertyEditing = {drag: true, rangeDrag: true, collisionAtomic: true, keyboardNudge: true};

  await page.evaluate(() => timeline.selectTrack('channel:figure:3:opacity'));
  await page.getByRole('button', {name: 'Insert key at playhead', exact: true}).click();
  assert.equal(await page.evaluate(() => editor.animationChannel({kind: 'figure', uid: 3}, 'opacity').keys.length), 1);
  await page.getByRole('button', {name: 'Delete selected keys', exact: true}).click();
  assert.equal(await page.evaluate(() => editor.animationChannel({kind: 'figure', uid: 3}, 'opacity').keys.length), 0);
  await page.evaluate(rowId => { editor.undo(); timeline.selectTrack(rowId); }, rowId);
  await settle();
  await page.screenshot({path: path.join(output, 'timeline-channels.png')});
  const controls = {propertyInsert: true, propertyDelete: true};
  await page.getByRole('button', {name: 'Lock Character', exact: true}).click();
  assert.equal(await page.evaluate(() => editor.getLayer('layer-2').locked), true);
  assert(await page.getByRole('button', {name: 'Insert key at playhead', exact: true}).isDisabled());
  await page.getByRole('button', {name: 'Unlock Character', exact: true}).click();
  await page.getByRole('button', {name: 'Hide Character', exact: true}).click();
  assert.equal(await page.evaluate(() => editor.getLayer('layer-2').visible), false);
  await page.getByRole('button', {name: 'Show Character', exact: true}).click();
  await page.getByRole('button', {name: 'Frames', exact: true}).click(); await settle();
  assert.equal(await page.evaluate(() => timeline.channelMode), false);
  await page.getByRole('button', {name: 'Layers', exact: true}).click(); await settle();
  assert.equal(await page.evaluate(() => timeline.channelMode), true);
  Object.assign(controls, {layerLock: true, layerVisibility: true, frameViewRoundtrip: true});
  const externalSelection = await page.evaluate(() => {
    const before = {active: editor.activeLayerId, uid: editor.selectedUid, keys: JSON.stringify(timeline.selectedAnimationKeys)};
    timeline.selectTrack('camera');
    return {before, after: {active: editor.activeLayerId, uid: editor.selectedUid, keys: JSON.stringify(timeline.selectedAnimationKeys)}};
  });
  assert.deepEqual(externalSelection.after, externalSelection.before, 'External highlight synchronization must not mutate model selection');
  await page.evaluate(rowId => timeline.selectTrack(rowId), rowId);
  const marqueeStart = await cell(rowId, 1), marqueeEnd = await cell(rowId, 9);
  await page.mouse.move(marqueeStart.x, marqueeStart.y - 10); await page.mouse.down();
  await page.mouse.move(marqueeEnd.x, marqueeEnd.y + 10, {steps: 8}); await page.mouse.up();
  assert.equal(await page.evaluate(() => timeline.selectedAnimationKeys.find(group => group.channelId === 'figure:3:x').keyIds.length), 2);
  const beforeDestroy = await page.evaluate(() => JSON.stringify(editor.animationChannels));
  const dragStart = await cell(rowId, 2), dragEnd = await cell(rowId, 3);
  await page.mouse.move(dragStart.x, dragStart.y); await page.mouse.down(); await page.mouse.move(dragEnd.x, dragEnd.y);
  await page.evaluate(() => timeline.destroy()); await page.mouse.up(); await settle();
  assert.equal(await page.evaluate(() => JSON.stringify(editor.animationChannels)), beforeDestroy, 'Destroying the timeline must cancel its pending drag');
  assert.equal(await page.locator('.styk-timeline').count(), 0);
  Object.assign(controls, {externalSelectionNoSideEffects: true, marquee: true, destroyCancelsGesture: true});
  assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => failures), []);
  const report = {passed: true, nativeIsolation, blankPoses, propertyEditing, controls, errors};
  await mkdir(output, {recursive: true});
  await writeFile(path.join(output, 'timeline-channels-verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
