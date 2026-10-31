import assert from 'node:assert/strict';
import {chromium} from './support/playwright.mjs';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {pcmWave} from '../src/audio-pcm.mjs';

const out = 'artifacts/audio-ux'; await mkdir(out, {recursive:true});
const samples = Float32Array.from({length:48000 * 4}, (_, i) => Math.sin(i * Math.PI * 440 / 24000) * (.25 + .2 * Math.sin(i / 3000) ** 2));
await writeFile(`${out}/Dialogue.wav`, new Uint8Array(await pcmWave([samples]).arrayBuffer()));
const browser = await chromium.launch({channel:'chrome', headless:true, ignoreDefaultArgs:['--hide-scrollbars']}), page = await browser.newPage({viewport:{width:1440, height:1000}}), errors = [];
page.on('pageerror', error => errors.push(error.stack ?? error.message));
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const state = () => page.evaluate(() => structuredClone(styk.editor.report._styk.audio));
const gesture = async (from, to, key) => {
  if (key) await page.keyboard.down(key);
  await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, {steps:8}); await settle();
};
const release = async key => { await page.mouse.up(); if (key) await page.keyboard.up(key); await settle(); };
const position = (id, offset = 55) => page.locator(`[data-clip="${id}"]`).evaluate((node, offset) => {const box = node.getBoundingClientRect();return {x:box.x + offset, y:box.y + 40};}, offset);
const trackCenter = id => page.locator(`.audio-track[data-track="${id}"]`).evaluate(node => {const box = node.getBoundingClientRect();return box.y + box.height / 2;});
try {
  await page.goto(process.env.STYK_URL ?? 'http://127.0.0.1:47831'); await page.waitForFunction(() => window.styk?.ready);
  await page.evaluate(async () => {
    const {emptyDocument, createFrame, createObject} = await import('/src/demo.mjs'), report = emptyDocument(); report.fps = 12;
    report.keyframes = Array.from({length:8}, (_, i) => createFrame([createObject(report.figure_types[0], 1, 220 + i * 20, 250)], 24));
    styk.settingsUI.commit({timelineMode:'advanced'}); styk.editor.load(report); styk.fit();
  });
  await page.getByLabel('Choose audio recording').setInputFiles(`${out}/Dialogue.wav`);
  await page.waitForFunction(() => styk.editor.report._styk.audio?.tracks.length === 1); await settle();
  const initial = await state(), id = initial.tracks[0].clips[0].id, source = initial.tracks[0].id;
  await page.getByRole('button', {name:'New audio track', exact:true}).click(); await settle();
  const destination = (await state()).tracks[1].id;
  const before = await state(), undo = await page.evaluate(() => styk.editor._undo.length), p = await position(id);
  await gesture(p, {x:p.x + 35, y:await trackCenter(destination)}, 'Shift');
  assert.deepEqual(await state(), before, 'Dragging previews without changing document/history');
  assert.equal(await page.locator(`[data-track="${destination}"]`).getAttribute('data-drop'), 'true');
  await page.screenshot({path:`${out}/drag-between-tracks.png`}); await release('Shift');
  assert.equal((await state()).tracks[1].clips[0].id, id);
  assert.equal((await state()).tracks[1].clips[0].start, 0, 'Shift drag preserves timing');
  assert.equal(await page.evaluate(() => styk.editor._undo.length), undo + 1);
  await page.locator('.audio-body').press('Control+z'); await settle(); assert.deepEqual(await state(), before);
  await page.locator('.audio-body').press('Control+y'); await settle();

  // Pointer cancellation and keyboard transfers preserve recording bytes and undo.
  const moved = await state(), cancelPoint = await position(id);
  await gesture(cancelPoint, {x:cancelPoint.x + 80, y:await trackCenter(source)}); await page.keyboard.press('Escape'); await release();
  assert.deepEqual(await state(), moved);
  await page.locator(`[data-clip="${id}"]`).press('ArrowUp'); await settle(); assert.equal((await state()).tracks[0].clips[0].id, id);
  await page.locator(`[data-clip="${id}"]`).press('ArrowDown'); await settle(); assert.equal((await state()).tracks[1].clips[0].id, id);
  const sizeBefore = await page.locator('.sheet-main').evaluate(node => node.clientHeight);
  const separator = page.getByRole('separator', {name:'Resize timeline', exact:true}), box = await separator.boundingBox();
  await gesture({x:box.x + box.width / 2, y:box.y + 3}, {x:box.x + box.width / 2, y:box.y - 90}); await release();
  const resized = await page.locator('.sheet-main').evaluate(node => node.clientHeight); assert.ok(resized > sizeBefore + 65, `${sizeBefore} -> ${resized}`);
  await separator.press('ArrowDown'); await settle(); assert.ok(await page.locator('.sheet-main').evaluate(node => node.clientHeight) < resized);
  await separator.press('ArrowUp'); await settle();

  // Drop onto the new-track row creates and moves in one undo command.
  const newBefore = await state(), newUndo = await page.evaluate(() => styk.editor._undo.length), from = await position(id), drop = await page.locator('.audio-new-lane').boundingBox();
  await gesture(from, {x:from.x, y:drop.y + 15}, 'Shift'); await release('Shift');
  assert.equal((await state()).tracks.length, 3); assert.equal((await state()).tracks[2].clips[0].id, id);
  assert.equal(await page.evaluate(() => styk.editor._undo.length), newUndo + 1);
  await page.locator('.audio-body').press('Control+z'); await settle(); assert.deepEqual(await state(), newBefore);
  await page.locator('.audio-body').press('Control+y'); await settle();

  // Direct fade handles and visible volume controls are undoable, no dialogs needed.
  await page.locator(`[data-clip="${id}"]`).click({position:{x:55, y:28}}); await settle();
  const fade = await page.locator(`[data-clip="${id}"] .audio-fadeIn`).boundingBox();
  await gesture({x:fade.x + 5, y:fade.y + 5}, {x:fade.x + 47, y:fade.y + 5}); await release();
  assert.equal((await state()).tracks[2].clips[0].fadeIn, .25);
  await page.getByRole('button',{name:'Audio clip controls',exact:true}).click();
  const volume = page.getByRole('slider', {name:'Selected clip volume'}); await volume.fill('75'); await volume.dispatchEvent('change'); await settle();
  assert.equal((await state()).tracks[2].clips[0].gain, .75);
  await page.keyboard.press('Escape');
  await page.getByRole('slider', {name:'Volume for Audio 3', exact:true}).fill('80'); await page.getByRole('slider', {name:'Volume for Audio 3', exact:true}).dispatchEvent('change'); await settle();
  assert.equal((await state()).tracks[2].gain, .8);
  await page.getByRole('button',{name:'Audio clip controls',exact:true}).click();
  await volume.focus(); await volume.press('Control+z'); await settle(); assert.equal((await state()).tracks[2].gain, 1);
  await volume.press('Control+z'); await settle(); assert.equal(await volume.inputValue(), '100');
  await volume.press('Control+y'); await volume.press('Control+y'); await settle();
  await page.keyboard.press('Escape');
  await page.getByRole('button', {name:'Mute Audio 3', exact:true}).press('Space'); await settle(); assert.equal((await state()).tracks[2].mute, true);
  await page.getByRole('button', {name:'Mute Audio 3', exact:true}).press('Enter'); await settle(); assert.equal((await state()).tracks[2].mute, false);

  // Selection, preferences, and editing survive both timeline modes.
  await page.evaluate(() => styk.settingsUI.commit({timelineMode:'simple'})); await settle();
  assert.equal(await page.evaluate(() => styk.timeline.audio.selected), id);
  assert.equal(await page.evaluate(() => styk.editor.audioPanelOpen), true);
  const simplePoint = await position(id, 35);
  await gesture(simplePoint, {x:simplePoint.x, y:await trackCenter(source)}, 'Shift'); await release('Shift');
  assert.equal((await state()).tracks[0].clips[0].id, id);
  await page.locator(`[data-clip="${id}"]`).hover();
  assert.equal(await page.locator(`[data-clip="${id}"]`).evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)', 'Hover must not cover the waveform');
  await page.screenshot({path:`${out}/simple.png`});

  // The main timeline expansion works with the Audio tab on a small screen.
  await page.setViewportSize({width:960, height:720}); await settle();
  const compact = await page.locator('.audio-body').evaluate(node => node.clientHeight);
  const wheelBox = await page.locator('.audio-body').boundingBox(); await page.mouse.move(wheelBox.x + 400, wheelBox.y + 40); await page.mouse.wheel(70, 0); await settle();
  const offsetBeforeExpand = await page.evaluate(() => styk.timeline.strip.scrollLeft); assert.ok(offsetBeforeExpand > 0);
  await page.locator('#expand-timeline').click(); await settle();
  const expanded = await page.locator('.audio-body').evaluate(node => node.clientHeight); assert.ok(expanded >= compact, `${compact} -> ${expanded}`);
  assert.equal(await page.evaluate(() => styk.timeline.strip.scrollLeft), offsetBeforeExpand, 'Expand preserves the timeline position');
  const focusPoint = await position(id, 35);
  await gesture(focusPoint, {x:focusPoint.x, y:await trackCenter(destination)}, 'Shift'); await release('Shift');
  assert.equal((await state()).tracks[1].clips[0].id, id);
  await page.locator('.audio-body').press('Control+z'); await settle();
  // Native file drops land on the chosen track and time, rather than the playhead.
  const dropCount = (await state()).tracks[1].clips.length, bytes = [...await readFile(`${out}/Dialogue.wav`)];
  await page.evaluate(({bytes, destination}) => {
    const audio = styk.timeline.audio, rect = audio.lanes.getBoundingClientRect(), row = document.querySelector(`[data-track="${destination}"]`).getBoundingClientRect(), dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([new Uint8Array(bytes)], 'Drop.wav', {type:'audio/wav'}));
    audio.lanes.dispatchEvent(new DragEvent('drop', {bubbles:true, cancelable:true, dataTransfer, clientX:rect.left + audio.tickX(24), clientY:row.y + 32}));
  }, {bytes, destination});
  await page.waitForFunction(count => styk.editor.report._styk.audio.tracks[1].clips.length === count + 1, dropCount);
  assert.equal((await state()).tracks[1].clips.at(-1).start, 2);
  assert.equal(await page.getByText(/Choose a .*project/).count(), 0, 'Audio drops must not also invoke project import');
  await page.locator('.audio-body').press('Control+z'); await settle();
  await page.screenshot({path:`${out}/expanded-compact.png`});
  await page.getByRole('button', {name:'Restore timeline height', exact:true}).click(); await settle();
  await page.getByRole('button', {name:'Audio', exact:true}).click(); await settle();
  assert.equal(await page.locator('.sheet-filmstrip-controls').evaluate(node => node.scrollHeight <= node.clientHeight + 1), true);
  await page.screenshot({path:`${out}/compact.png`});
  await page.getByRole('button', {name:'Audio', exact:true}).click(); await settle();

  // Many tracks remain virtualized; dragging scrolls to a destination below the viewport.
  await page.setViewportSize({width:1440, height:1000}); await page.evaluate(() => styk.settingsUI.commit({timelineMode:'advanced'})); await settle();
  const focusedHeight = await page.locator('.sheet-main').evaluate(node => node.clientHeight);
  await page.getByRole('separator', {name:'Resize timeline', exact:true}).press('ArrowDown'); await settle();
  assert.ok(await page.locator('.sheet-main').evaluate(node => node.clientHeight) < focusedHeight, 'Timeline resizing also resizes the shared audio viewport');
  // Snapping shows a guide; the preview leaves the document unchanged until release.
  await page.evaluate(() => {styk.timeline.audio.selected = styk.editor.report._styk.audio.tracks[0].clips[0].id;styk.editor.seek(24);}); await settle();
  const snapFrom = await position(id), snapBefore = await state();
  await gesture(snapFrom, {x:snapFrom.x + 335, y:snapFrom.y});
  assert.equal(await page.locator('.audio-snap-line').isVisible(), true); assert.deepEqual(await state(), snapBefore);
  await release(); assert.equal((await state()).tracks[0].clips[0].start, 2);
  await page.locator('.audio-body').press('Control+z'); await settle();
  await page.evaluate(() => {for(let i=4;i<=18;i++)styk.editor.addAudioTrack(`Audio ${i}`); styk.timeline.audio.verticalScroll.scrollTop=styk.timeline.audioTop-styk.timeline.bodyTop;}); await settle();
  assert.ok(await page.locator('.audio-track').count() < 10);
  const scrollPoint = await position(id), body = await page.locator('.sheet-scroll').boundingBox();
  await gesture(scrollPoint, {x:scrollPoint.x, y:body.y + body.height - 4}, 'Shift');
  await page.waitForFunction(() => styk.timeline.audio.verticalScroll.scrollTop > 650); await release('Shift');
  assert.ok((await state()).tracks.findIndex(track => track.clips.some(clip => clip.id === id)) >= 7);
  assert.ok(await page.locator('.audio-track').count() < 10);
  await page.evaluate(() => styk.settingsUI.commit({theme:'dark'})); await settle(); await page.screenshot({path:`${out}/dark-scrolled.png`});
  assert.equal(await page.locator('.sheet-label-head').evaluate(node => Math.abs(node.getBoundingClientRect().top - node.parentElement.getBoundingClientRect().top) <= 2), true);
  assert.equal(await page.locator('.audio-timeline').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
  // Dense documents keep drag work coalesced and tiny sound effects movable.
  await page.evaluate(() => {
    const report = styk.editor.serialize(), audio = report._styk.audio, assetId = Object.keys(audio.assets)[0];
    audio.tracks = Array.from({length:32}, (_, row) => ({id:`dense-track-${row}`, name:`Track ${row + 1}`, gain:1, mute:false, solo:false,
      clips:Array.from({length:128}, (_, i) => ({id:`dense-${row}-${i}`, assetId, start:i / 10, offset:0, duration:.05, fadeIn:0, fadeOut:0, gain:1}))}));
    styk.editor.load(report); styk.timeline.audio.setOpen(true); styk.timeline.audio.verticalScroll.scrollTop = styk.timeline.audioTop - styk.timeline.bodyTop;
  }); await settle();
  const tiny = await page.locator('[data-clip="dense-0-0"]').boundingBox();
  await page.keyboard.down('Shift'); await page.mouse.move(tiny.x + tiny.width / 2, tiny.y + 34); await page.mouse.down();
  assert.equal(await page.evaluate(() => styk.timeline.audio.gesture?.kind), 'move');
  const dense = await page.evaluate(async () => {
    const audio = styk.timeline.audio, original = audio.paint, before = styk.editor._undo.length, pointer = audio.gesture.pointer, rect = audio.lanes.getBoundingClientRect(); let paints = 0;
    audio.paint = function() {paints++; return original.call(this);}; const started = performance.now();
    for(let i=0;i<240;i++)audio.lanes.dispatchEvent(new PointerEvent('pointermove', {bubbles:true, pointerId:pointer, clientX:rect.x + 10, clientY:rect.y + 118, shiftKey:true}));
    const eventMs = performance.now() - started;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); audio.paint = original;
    return {eventMs, paints, unchanged:styk.editor._undo.length === before, rows:audio.labels.size, clips:audio.nodes.size};
  });
  assert.ok(dense.paints <= 2, JSON.stringify(dense)); assert.equal(dense.unchanged, true); assert.ok(dense.rows < 10); assert.ok(dense.clips < 1000);
  await page.mouse.up(); await page.keyboard.up('Shift'); await settle();
  assert.equal((await state()).tracks[1].clips.some(clip => clip.id === 'dense-0-0'), true);
  assert.deepEqual(errors, []);
  await writeFile(`${out}/results.json`, JSON.stringify({resized, compact, expanded, dense, errors}, null, 2));
  console.log('PASS audio UX: resize, expand/restore, two-dimensional drag, cancel, new-track drop, one-step undo, fades, volume, both timelines, virtualized autoscroll', {resized, compact, expanded, dense});
} catch (error) {await page.screenshot({path:`${out}/failure.png`});throw error;}
finally {await browser.close();}
