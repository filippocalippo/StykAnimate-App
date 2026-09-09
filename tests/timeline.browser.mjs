import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(appRoot, 'artifacts');
const harness = `<!doctype html><html><head><meta charset="utf-8"><title>Timeline verification</title>
<style>body{margin:0;padding:24px;background:#f5f5f5;font:13px 'Segoe UI',sans-serif;color:#555}h1{font-size:16px;font-weight:500}#timeline{height:240px;width:1120px;border:1px solid #ddd;border-radius:5px;overflow:hidden}</style></head>
<body><h1>StykAnimate · animation timeline</h1><div id="timeline"></div><script type="module">
import {Editor} from '/src/editor.mjs'; import {Timeline} from '/src/timeline.mjs';
window.loopEvents = []; window.editor = new Editor(); window.timeline = new Timeline(document.querySelector('#timeline'), window.editor, {mode: 'frames', onLoopRangeChange: range => loopEvents.push(range)});
window.frameContent = frame => JSON.stringify(frame, (key, value) => key === 'frameId' ? undefined : value);
window.ready = true;
</script></body></html>`;
const server = createServer(async (req, res) => {
  if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end(harness); return; }
  const file = path.resolve(appRoot, `.${new URL(req.url, 'http://localhost').pathname}`);
  if (!file.startsWith(appRoot + path.sep)) { res.writeHead(403); res.end(); return; }
  try { const bytes = await readFile(file); res.setHeader('content-type', 'text/javascript'); res.end(bytes); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(47833, '127.0.0.1', resolve));
const browser = await chromium.launch({
  ...(process.env.STYK_BROWSER_PATH ? {executablePath: process.env.STYK_BROWSER_PATH}
    : process.platform === 'win32' ? {channel: 'chrome'} : {}), headless: true,
});
const page = await browser.newPage({viewport: {width: 1200, height: 370}, deviceScaleFactor: 1});
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto('http://127.0.0.1:47833/');
  await page.waitForFunction(() => window.ready && document.querySelectorAll('.styk-timeline-label').length === 3);
  const scroll = page.locator('.styk-timeline-scroll');
  const box = await scroll.boundingBox();
  await page.mouse.click(box.x + 12 + 20 * 18 + 9, box.y + 31 + 2 * 30 + 15);
  assert.deepEqual(await page.evaluate(() => [editor.tick, editor.selectedUid]), [20, 3]);
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => editor.tick), 21);
  await page.keyboard.press('Home');
  assert.equal(await page.evaluate(() => editor.tick), 0);
  await page.keyboard.press('PageDown');
  assert.equal(await page.evaluate(() => editor.tick), 2);
  await page.keyboard.press('End');
  assert.equal(await page.evaluate(() => editor.tick), 46);
  await page.keyboard.press('Home');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const playback = await page.evaluate(async () => {
    let redraws = 0;
    const draw = timeline._drawGrid.bind(timeline);
    timeline._drawGrid = () => { redraws++; draw(); };
    for (let tick = 1; tick < 20; tick++) {
      editor.seek(tick);
      await new Promise(requestAnimationFrame);
    }
    timeline._drawGrid = draw;
    return {gridRedraws: redraws, labels: document.querySelectorAll('.styk-timeline-label').length};
  });
  assert.equal(playback.gridRedraws, 0, 'Playback should reuse the grid bitmap');
  await mkdir(output, {recursive: true});
  await page.screenshot({path: path.join(output, 'timeline-demo.png')});
  await page.mouse.click(box.x + 12 + 6 * 18 + 9, box.y + 15);
  await page.keyboard.down('Shift');
  await page.mouse.click(box.x + 12 + 14 * 18 + 9, box.y + 15);
  await page.keyboard.up('Shift');
  assert.deepEqual(await page.evaluate(() => timeline.selectedFrameIndices), [3, 4, 5, 6, 7]);
  const originalRange = await page.evaluate(() => editor.report.keyframes.slice(3, 8).map(frame => JSON.stringify(frame)));
  await page.keyboard.press('ControlOrMeta+c');
  assert.equal(await page.evaluate(() => editor.clipboardFrameCount), 5);
  await page.keyboard.press('ControlOrMeta+v');
  assert.equal(await page.evaluate(() => editor.report.keyframes.length), 29);
  assert.deepEqual(await page.evaluate(() => timeline.selectedFrameIndices), [8, 9, 10, 11, 12]);
  await page.evaluate(() => editor.undo());
  assert.equal(await page.evaluate(() => editor.report.keyframes.length), 24);
  await page.mouse.click(box.x + 12 + 6 * 18 + 9, box.y + 15);
  await page.keyboard.down('Shift');
  await page.mouse.click(box.x + 12 + 14 * 18 + 9, box.y + 15);
  await page.keyboard.up('Shift');
  await page.mouse.click(box.x + 12 + 10 * 18 + 9, box.y + 15, {button: 'right'});
  await page.getByRole('menuitem', {name: 'Reverse keyframes', exact: true}).waitFor();
  await page.screenshot({path: path.join(output, 'timeline-range-menu.png')});
  await page.getByRole('menuitem', {name: 'Reverse keyframes', exact: true}).click();
  assert.deepEqual(await page.evaluate(() => editor.report.keyframes.slice(3, 8).map(frame => JSON.stringify(frame))), [...originalRange].reverse());
  await page.evaluate(() => editor.undo());
  await page.keyboard.press('ControlOrMeta+x');
  assert.equal(await page.evaluate(() => editor.report.keyframes.length), 19);
  await page.evaluate(() => editor.undo());
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+ArrowRight');
  assert.deepEqual(await page.evaluate(() => timeline.selectedFrameIndices), [0, 1]);
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  assert.equal(await page.evaluate(() => editor.report.keyframes.length), 1);
  await page.evaluate(() => editor.undo());
  assert.equal(await page.evaluate(() => editor.report.keyframes.length), 24);
  const selectionColor = await page.locator('.styk-timeline-label[aria-selected=true]').evaluate(node => getComputedStyle(node).backgroundColor);
  assert.equal(selectionColor, 'rgb(229, 244, 255)');
  const rangeCommands = {shiftClick: true, shiftArrow: true, copy: true, paste: true, reverse: true, cut: true, deleteAllUndo: true, selectionColor};
  await page.setViewportSize({width: 1200, height: 600});
  await page.locator('.styk-timeline-scroll').focus();
  await page.keyboard.press('Home');
  await page.mouse.click(box.x + 12 + 6 * 18 + 9, box.y + 15);
  await page.keyboard.down('Shift');
  await page.mouse.click(box.x + 12 + 10 * 18 + 9, box.y + 15);
  await page.keyboard.up('Shift');
  assert.deepEqual(await page.evaluate(() => timeline.selectedFrameIndices), [3, 4, 5]);
  const openRangeMenu = async () => {
    await page.mouse.click(box.x + 12 + 8 * 18 + 9, box.y + 15, {button: 'right'});
  };
  await openRangeMenu();
  await page.getByRole('menuitem', {name: 'Loop selected range', exact: true}).click();
  assert.deepEqual(await page.evaluate(() => timeline.loopRange), {startTick: 6, endTick: 12});
  assert.deepEqual(await page.evaluate(() => loopEvents.at(-1)), {startTick: 6, endTick: 12});
  await page.screenshot({path: path.join(output, 'timeline-loop-range.png')});
  await openRangeMenu();
  await page.getByRole('menuitem', {name: 'Keyframe timing…', exact: true}).click();
  const timingDialog = page.getByRole('dialog', {name: 'Keyframe timing', exact: true});
  await timingDialog.waitFor();
  assert.equal(await timingDialog.getByLabel('Exposure frames', {exact: true}).inputValue(), '2');
  await timingDialog.getByRole('button', {name: '8 exposure frames', exact: true}).click();
  assert.equal(await timingDialog.getByLabel('Inbetweens', {exact: true}).inputValue(), '7');
  await timingDialog.getByLabel('Inbetweens', {exact: true}).fill('3');
  assert.equal(await timingDialog.getByLabel('Exposure frames', {exact: true}).inputValue(), '4');
  await page.screenshot({path: path.join(output, 'timeline-timing-dialog.png')});
  await timingDialog.getByRole('button', {name: 'Apply timing', exact: true}).click();
  assert.deepEqual(await page.evaluate(() => editor.report.keyframes.slice(3, 6).map(frame => frame.duration_raw)), [4, 4, 4]);
  assert.deepEqual(await page.evaluate(() => timeline.loopRange), {startTick: 6, endTick: 18});
  assert.deepEqual(await page.evaluate(() => loopEvents.at(-1)), {startTick: 6, endTick: 18});
  await page.evaluate(() => editor.undo());
  assert.deepEqual(await page.evaluate(() => timeline.loopRange), {startTick: 6, endTick: 12});
  await page.evaluate(() => editor.setFramesDuration([4], 5));
  await openRangeMenu();
  await page.getByRole('menuitem', {name: 'Keyframe timing…', exact: true}).click();
  assert.equal(await timingDialog.getByLabel('Exposure frames', {exact: true}).inputValue(), '');
  assert(await timingDialog.getByRole('button', {name: 'Apply timing', exact: true}).isDisabled());
  await timingDialog.getByLabel('Exposure frames', {exact: true}).fill('0');
  await timingDialog.getByRole('button', {name: 'Apply timing', exact: true}).click();
  assert.deepEqual(await page.evaluate(() => editor.report.keyframes.slice(3, 6).map(frame => frame.duration_raw)), [0, 0, 0]);
  assert.equal(await page.evaluate(() => timeline.loopRange), null);
  await page.evaluate(() => { editor.undo(); editor.undo(); });
  assert.deepEqual(await page.evaluate(() => editor.report.keyframes.slice(3, 6).map(frame => frame.duration_raw)), [2, 2, 2]);
  await openRangeMenu();
  await page.getByRole('menuitem', {name: 'Clear playback range', exact: true}).click();
  assert.equal(await page.evaluate(() => timeline.loopRange), null);
  const clipboardBeforeDuplicate = await page.evaluate(() => editor.clipboardFrameCount);
  await page.keyboard.press('ControlOrMeta+d');
  assert.equal(await page.evaluate(() => editor.report.keyframes.length), 27);
  assert.deepEqual(await page.evaluate(() => timeline.selectedFrameIndices), [6, 7, 8]);
  assert.equal(await page.evaluate(() => editor.clipboardFrameCount), clipboardBeforeDuplicate);
  await page.evaluate(() => editor.undo());
  const blankAt = await page.evaluate(() => editor.frameIndex + 1);
  const inheritedCamera = await page.evaluate(() => JSON.stringify(editor.frame.camera));
  await page.keyboard.press('F7');
  assert.equal(await page.evaluate(() => editor.report.keyframes.length), 25);
  assert.equal(await page.evaluate(() => editor.frame.objects.length), 0);
  assert.equal(await page.evaluate(() => JSON.stringify(editor.frame.camera)), inheritedCamera);
  assert.deepEqual(await page.evaluate(() => timeline.selectedFrameIndices), [blankAt]);
  await page.evaluate(() => editor.undo());
  await page.evaluate(() => editor.setFramesDuration([3], 0));
  await page.keyboard.press('ControlOrMeta+a');
  await openRangeMenu();
  await page.getByRole('menuitem', {name: 'Bake inbetweens…', exact: true}).click();
  const bakeDialog = page.getByRole('dialog', {name: 'Bake inbetweens', exact: true});
  await bakeDialog.waitFor();
  await page.screenshot({path: path.join(output, 'timeline-bake-dialog.png')});
  await bakeDialog.getByRole('button', {name: 'Bake keyframes', exact: true}).click();
  await page.waitForFunction(() => editor.report.keyframes.length === 46);
  assert.equal(await page.evaluate(() => editor.totalTicks), 45);
  assert.equal(await page.evaluate(() => editor.timeline.filter(exposure => exposure.count === 0).length), 1);
  assert.equal(await page.evaluate(() => timeline.selectedFrameIndices.length), 46);
  await page.evaluate(() => { editor.undo(); editor.undo(); });
  assert.equal(await page.evaluate(() => editor.report.keyframes.length), 24);
  assert.equal(await page.evaluate(() => editor.totalTicks), 47);
  const timingCommands = {timingFields: true, durationPresets: true, mixedValues: true, hiddenFrames: true,
    loopMarkers: true, loopTimingCallback: true, duplicatePreservesClipboard: true, blankKeyframe: true,
    bakeHiddenRange: true, undo: true};
  const toolbar = page.getByRole('toolbar', {name: 'Keyframe editing', exact: true});
  await toolbar.getByRole('button', {name: 'Add keyframe', exact: true}).click();
  assert.equal(await page.evaluate(() => editor.report.keyframes.length), 25);
  await toolbar.getByRole('button', {name: 'Insert blank keyframe', exact: true}).click();
  assert.equal(await page.evaluate(() => editor.report.keyframes.length), 26);
  assert.equal(await page.evaluate(() => editor.frame.objects.length), 0);
  await toolbar.getByRole('button', {name: 'Delete selected keyframes', exact: true}).click();
  assert.equal(await page.evaluate(() => editor.report.keyframes.length), 25);
  await page.evaluate(() => { editor.undo(); editor.undo(); editor.undo(); });
  await toolbar.getByRole('button', {name: 'Edit selected keyframe timing', exact: true}).click();
  await timingDialog.getByRole('button', {name: 'Cancel', exact: true}).click();
  const selectionBeforeMore = await page.evaluate(() => timeline.selectedFrameIndices);
  await toolbar.getByRole('button', {name: 'More keyframe actions', exact: true}).click();
  assert.deepEqual(await page.evaluate(() => timeline.selectedFrameIndices), selectionBeforeMore);
  assert(await page.getByRole('menuitem', {name: 'Reverse keyframes', exact: true}).isVisible());
  await page.keyboard.press('Escape');
  await page.evaluate(() => editor.seek(19));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const playheadColor = await page.evaluate(() => {
    const x = 12 + (editor.tick + 0.5) * timeline.pxPerTick - timeline._offsetX();
    return [...timeline.headContext.getImageData(Math.round(x * timeline.dpr), Math.round(4 * timeline.dpr), 1, 1).data];
  });
  assert.deepEqual(playheadColor, [13, 153, 255, 255]);
  await page.screenshot({path: path.join(output, 'timeline-ux-toolbar.png')});
  const divider = page.getByRole('separator', {name: 'Layer column width', exact: true});
  await divider.focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => timeline.labelWidth), 184);
  await page.keyboard.press('Home');
  const dividerBox = await divider.boundingBox();
  await page.mouse.move(dividerBox.x + 2, dividerBox.y + 10);
  await page.mouse.down();
  await page.mouse.move(dividerBox.x + 42, dividerBox.y + 10, {steps: 3});
  await page.mouse.up();
  assert.equal(await page.evaluate(() => timeline.labelWidth), 216);
  await divider.dblclick();
  assert.equal(await page.evaluate(() => timeline.labelWidth), 176);
  const ux = {toolbarAdd: true, toolbarBlank: true, toolbarDelete: true, toolbarTiming: true,
    morePreservesRange: true, columnResizePointer: true, columnResizeKeyboard: true, columnResizeReset: true,
    readablePlayheadColor: playheadColor};
  await page.evaluate(() => {
    editor.seek(0);
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor), 'evaluatedFrame');
    const originalSeek = editor.seek;
    window.scrubAudit = {evaluations: 0, seeks: [], lifecycle: [], ranges: 0, navigation: 0};
    window.restoreScrubAudit = () => {
      editor.seek = originalSeek; delete editor.evaluatedFrame;
      timeline.onScrubStart = timeline.onScrub = timeline.onScrubEnd = timeline.onRangeChange = timeline.onSeek = undefined;
    };
    Object.defineProperty(editor, 'evaluatedFrame', {configurable: true, get() {
      scrubAudit.evaluations++; return descriptor.get.call(this);
    }});
    editor.seek = function(tick, options) {
      scrubAudit.seeks.push({tick, evaluate: options?.evaluate !== false});
      scrubAudit.lifecycle.push(`seek:${tick}`);
      return originalSeek.call(this, tick, options);
    };
    timeline.onScrubStart = tick => scrubAudit.lifecycle.push(`start:${tick}`);
    timeline.onScrub = tick => scrubAudit.lifecycle.push(`preview:${tick}`);
    timeline.onScrubEnd = (tick, metadata) => scrubAudit.lifecycle.push(`end:${tick}:${metadata.cancelled}`);
    timeline.onRangeChange = () => { scrubAudit.ranges++; scrubAudit.lifecycle.push('range'); };
    timeline.onSeek = () => scrubAudit.navigation++;
  });
  const scrubBox = await page.locator('.styk-timeline-scroll').boundingBox();
  await page.mouse.move(scrubBox.x + 12 + 2 * 18 + 9, scrubBox.y + 15);
  await page.mouse.down();
  const duringScrub = await page.evaluate(async () => {
    const rect = timeline.scroll.getBoundingClientRect(), pointerId = timeline._scrubPointerId;
    const before = scrubAudit.seeks.length;
    for (let tick = 3; tick <= 20; tick++) for (let repeat = 0; repeat < 8; repeat++) {
      timeline.scroll.dispatchEvent(new PointerEvent('pointermove', {pointerId, clientX: rect.left + 12 + tick * 18 + 9, clientY: rect.top + 15}));
    }
    await new Promise(requestAnimationFrame);
    return {batchedSeeks: scrubAudit.seeks.length - before, tick: editor.tick, evaluations: scrubAudit.evaluations, ranges: scrubAudit.ranges};
  });
  assert.deepEqual(duringScrub, {batchedSeeks: 1, tick: 20, evaluations: 0, ranges: 0});
  await page.evaluate(() => {
    const rect = timeline.scroll.getBoundingClientRect(), pointerId = timeline._scrubPointerId;
    timeline.scroll.dispatchEvent(new PointerEvent('pointermove', {pointerId, clientX: rect.left + 12 + 7 * 18 + 9, clientY: rect.top + 15}));
    timeline.scroll.dispatchEvent(new PointerEvent('pointerup', {pointerId, clientX: rect.left + 12 + 23 * 18 + 9, clientY: rect.top + 15}));
  });
  await page.mouse.up();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const completedScrub = await page.evaluate(() => ({...scrubAudit, tick: editor.tick, dragging: timeline._dragging}));
  assert.equal(completedScrub.tick, 23, 'Release must flush the exact final pointer position');
  assert.equal(completedScrub.dragging, false);
  assert.equal(completedScrub.evaluations, 0, 'Pointer input must not eagerly evaluate a scene');
  assert.equal(completedScrub.ranges, 1, 'Inspector/range notification must be deferred to gesture completion');
  assert.equal(completedScrub.navigation, 2, 'Generic navigation must not run on every pointer move');
  assert.deepEqual(completedScrub.seeks, [{tick: 2, evaluate: false}, {tick: 20, evaluate: false}, {tick: 23, evaluate: false}]);
  assert.equal(completedScrub.lifecycle[0], 'start:2');
  assert.equal(completedScrub.lifecycle.filter(item => item.startsWith('end:')).length, 1);
  await page.locator('.styk-timeline-scroll').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => scrubAudit.evaluations), 1, 'Keyboard navigation retains normal scene evaluation');
  assert.deepEqual(await page.evaluate(() => scrubAudit.seeks.at(-1)), {tick: 24, evaluate: true});
  await page.mouse.move(scrubBox.x + 12 + 3 * 18 + 9, scrubBox.y + 15);
  await page.mouse.down();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert.equal(await page.evaluate(() => scrubAudit.lifecycle.filter(item => item.startsWith('end:')).at(-1)), 'end:3:true');
  assert.equal(await page.evaluate(() => timeline._dragging), false);
  const seeksBeforeUnchangedClick = await page.evaluate(() => scrubAudit.seeks.length);
  await page.mouse.down(); await page.mouse.up();
  assert.equal(await page.evaluate(() => scrubAudit.seeks.length), seeksBeforeUnchangedClick);
  assert.equal(await page.evaluate(() => scrubAudit.lifecycle.filter(item => item.startsWith('end:')).at(-1)), 'end:3:false');
  await page.evaluate(() => restoreScrubAudit());
  const scrub = {burstMoves: 144, seeksPerRaf: duringScrub.batchedSeeks, eagerEvaluations: completedScrub.evaluations,
    exactReleaseTick: completedScrub.tick, deferredRangeNotifications: completedScrub.ranges,
    beginBeforeModelEvent: true, keyboardEvaluationPreserved: true, cancellationSettles: true, unchangedReleaseSettles: true};
  const selectionModifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  const clickKey = async (index, toggle = false) => {
    const point = await page.evaluate(index => {
      const rect = timeline.scroll.getBoundingClientRect();
      return {x: rect.left + 12 + (editor.timeline[index].start + 0.5) * timeline.pxPerTick - timeline._offsetX(), y: rect.top + 15};
    }, index);
    if (toggle) await page.keyboard.down(selectionModifier);
    await page.mouse.click(point.x, point.y);
    if (toggle) await page.keyboard.up(selectionModifier);
  };
  await clickKey(1); await clickKey(3, true);
  assert.deepEqual(await page.evaluate(() => timeline.selectedFrameIndices), [1, 3]);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const sparseColors = await page.evaluate(() => [1, 2, 3].map(index => {
    const x = 12 + (editor.timeline[index].start + 0.5) * timeline.pxPerTick - timeline._offsetX();
    return [...timeline.gridContext.getImageData(Math.round(x * timeline.dpr), Math.round(39 * timeline.dpr), 1, 1).data];
  }));
  assert.deepEqual(sparseColors[0], [184, 223, 255, 255]);
  assert.notDeepEqual(sparseColors[1], sparseColors[0], 'Unselected gaps must not be painted as part of the selection');
  assert.deepEqual(sparseColors[2], sparseColors[0]);
  await page.screenshot({path: path.join(output, 'timeline-toggle-selection.png')});
  await clickKey(1, true); assert.deepEqual(await page.evaluate(() => timeline.selectedFrameIndices), [3]);
  await clickKey(3, true); assert.deepEqual(await page.evaluate(() => timeline.selectedFrameIndices), []);
  assert(await toolbar.getByRole('button', {name: 'Delete selected keyframes', exact: true}).isDisabled());
  assert(await toolbar.getByRole('button', {name: 'Edit selected keyframe timing', exact: true}).isDisabled());
  const clipboardBeforeEmptyCopy = await page.evaluate(() => editor.clipboardFrameCount);
  await page.keyboard.press('ControlOrMeta+c'); await page.keyboard.press('Delete');
  assert.equal(await page.evaluate(() => editor.clipboardFrameCount), clipboardBeforeEmptyCopy);
  assert.equal(await page.evaluate(() => editor.report.keyframes.length), 24);
  await clickKey(1); await clickKey(3, true);
  const sparseBefore = await page.evaluate(() => [1, 2, 3].map(index => frameContent(editor.report.keyframes[index])));
  await page.keyboard.press('ControlOrMeta+c');
  assert.equal(await page.evaluate(() => editor.clipboardFrameCount), 2);
  await page.keyboard.press('ControlOrMeta+v');
  assert.deepEqual(await page.evaluate(() => [4, 5].map(index => frameContent(editor.report.keyframes[index]))), [sparseBefore[0], sparseBefore[2]]);
  assert.notEqual(await page.evaluate(() => editor.report.keyframes[4]._styk.frameId), await page.evaluate(() => editor.report.keyframes[1]._styk.frameId), 'Pasted frames require fresh source identities');
  await page.evaluate(() => editor.undo());
  await clickKey(1); await clickKey(3, true);
  await toolbar.getByRole('button', {name: 'More keyframe actions', exact: true}).click();
  assert(await page.getByRole('menuitem', {name: 'Loop selected range', exact: true}).isDisabled());
  await page.getByRole('menuitem', {name: 'Reverse keyframes', exact: true}).click();
  assert.deepEqual(await page.evaluate(() => [1, 2, 3].map(index => frameContent(editor.report.keyframes[index]))), [sparseBefore[2], sparseBefore[1], sparseBefore[0]]);
  await page.evaluate(() => editor.undo());
  await toolbar.getByRole('button', {name: 'More keyframe actions', exact: true}).click();
  await page.getByRole('menuitem', {name: 'Bake inbetweens…', exact: true}).click();
  await bakeDialog.getByRole('button', {name: 'Bake keyframes', exact: true}).click();
  await page.waitForFunction(() => editor.report.keyframes.length === 26);
  assert.deepEqual(await page.evaluate(() => timeline.selectedFrameIndices), [1, 2, 4, 5]);
  assert.equal(await page.evaluate(() => frameContent(editor.report.keyframes[3])), sparseBefore[1]);
  await page.evaluate(() => editor.undo());
  await page.evaluate(() => editor.setFramesDuration([1, 2], 0));
  await page.locator('.styk-timeline-scroll').focus();
  await page.keyboard.press('Home'); await page.keyboard.press('PageDown');
  assert.deepEqual(await page.evaluate(() => [editor.frameIndex, editor.tick]), [1, 2]);
  assert.match(await page.locator('.styk-timeline-key-position').innerText(), /hidden/);
  await page.keyboard.press('PageDown');
  assert.deepEqual(await page.evaluate(() => [editor.frameIndex, editor.tick]), [2, 2]);
  await page.keyboard.press('Shift+ArrowRight');
  assert.deepEqual(await page.evaluate(() => timeline.selectedFrameIndices), [2, 3]);
  assert.equal(await page.evaluate(() => editor.frameIndex), 3);
  await page.keyboard.press('PageUp'); await page.keyboard.press('Alt+,');
  assert.equal(await page.evaluate(() => editor.frameIndex), 1);
  await page.keyboard.press('Alt+.'); await page.keyboard.press('ControlOrMeta+.');
  assert.deepEqual(await page.evaluate(() => timeline.selectedFrameIndices), [2, 3]);
  await page.keyboard.press('Home'); await page.keyboard.press('PageDown');
  await toolbar.getByRole('button', {name: 'Edit selected keyframe timing', exact: true}).click();
  assert.equal(await timingDialog.getByLabel('Exposure frames', {exact: true}).inputValue(), '0');
  await timingDialog.getByLabel('Exposure frames', {exact: true}).fill('1');
  await timingDialog.getByRole('button', {name: 'Apply timing', exact: true}).click();
  assert.equal(await page.evaluate(() => editor.report.keyframes[1].duration_raw), 1);
  await page.evaluate(() => { editor.undo(); editor.undo(); });
  assert.equal(await page.evaluate(() => editor.totalTicks), 47);
  const parityInteractions = {ctrlToggle: true, deselectAll: true, emptySelectionNonDestructive: true,
    sparseSelectionPaint: true, sparseClipboard: true, sparseReverse: true, sparseBakeSelection: true,
    hiddenKeyNavigation: true, hiddenKeyTimingRestore: true, punctuationNavigation: true, keyboardToggle: true};
  const large = await page.evaluate(async () => {
    timeline.destroy();
    class LargeEditor extends EventTarget {
      constructor() {
        super(); this.frameIndex = this.tick = 0; this.selectedUid = 1;
        this.report = {figure_types: [{figure_type_id: 1, name: 'Sparse figure'}],
          keyframes: Array.from({length: 20_000}, (_, i) => ({objects: [{unique_id: i + 1, figure_type_id: 1}]}))};
        this.timeline = this.report.keyframes.map((_, index) => ({index, start: index * 60_000, count: 60_000}));
        this.totalTicks = 1_200_000_000;
      }
      get frame() { return this.report.keyframes[this.frameIndex]; }
      seek(tick) { this.tick = tick; this.frameIndex = Math.floor(tick / 60_000); this.dispatchEvent(new CustomEvent('change', {detail: {kind: 'seek'}})); }
      select(uid) { this.selectedUid = uid; this.dispatchEvent(new CustomEvent('change', {detail: {kind: 'selection'}})); }
      selectFrame(index) { this.seek(index * 60_000); }
    }
    const {Timeline} = await import('/src/timeline.mjs');
    window.editor = new LargeEditor();
    const before = performance.now();
    window.timeline = new Timeline(document.querySelector('#timeline'), editor);
    const indexMs = performance.now() - before;
    const fixedHeader = timeline.heading.getBoundingClientRect().top;
    const fixedRuler = timeline.gridCanvas.getBoundingClientRect().top;
    timeline.scroll.scrollTop = timeline.scroll.scrollHeight;
    timeline.scroll.scrollLeft = timeline.scroll.scrollWidth;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {indexMs, trackCount: timeline.tracks.length,
      labelCount: document.querySelectorAll('.styk-timeline-label').length,
      lastLabel: [...document.querySelectorAll('.styk-timeline-label:not([hidden])')].at(-1).getAttribute('aria-posinset'),
      scrollWidth: timeline.scroll.scrollWidth, canvasWidth: timeline.gridCanvas.width,
      stickyHeader: timeline.heading.getBoundingClientRect().top === fixedHeader,
      stickyRuler: timeline.gridCanvas.getBoundingClientRect().top === fixedRuler};
  });
  assert.equal(large.trackCount, 20_000);
  assert(large.labelCount <= 9, 'Only visible rows should exist in the DOM');
  assert.equal(large.lastLabel, '20000');
  assert(large.scrollWidth <= 8_000_000);
  assert(large.canvasWidth < 1200, 'Timeline canvas must stay viewport-sized');
  assert(large.stickyHeader && large.stickyRuler, 'Track headers and ruler must remain fixed while scrolling both axes');
  await page.locator('.styk-timeline-scroll').focus();
  await page.keyboard.press('End');
  assert.equal(await page.evaluate(() => editor.tick), 1_199_999_999);
  await page.screenshot({path: path.join(output, 'timeline-large.png')});
  assert.deepEqual(errors, []);
  const report = {passed: true, playback, rangeCommands, timingCommands, ux, scrub, parityInteractions, large, errors};
  await writeFile(path.join(output, 'timeline-verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
