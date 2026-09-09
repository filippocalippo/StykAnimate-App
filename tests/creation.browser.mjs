import {readNativeDocument} from '../scripts/read-native-document.mjs';
/** Real editor UI regression for multi-selection, portable text, and persistence. */
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(appRoot, 'artifacts'), url = process.env.STYK_URL || 'http://127.0.0.1:47831';
await mkdir(out, {recursive: true});
const browser = await chromium.launch({channel: 'chrome', headless: true});
const context = await browser.newContext({viewport: {width: 1500, height: 940}, acceptDownloads: true});
const page = await context.newPage(), checks = [], errors = [], findings = [];
page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.stack));
const check = (name, result = true) => { assert.ok(result, name); checks.push({name, passed: true}); console.log('PASS', name); };
const value = fn => page.evaluate(fn);
const blur = () => page.locator('[data-tool="select"]').click();
const selection = () => value(() => [...styk.editor.selectedUids]);
const poses = () => value(() => styk.editor.frame.objects.map(o => ({uid: o.unique_id, x: o.root_x, y: o.root_y, scale: o.scale, join: o.join})));
async function layer(uid, shift = false) {
  await page.locator(`.styk-tree-row[data-key="figure:${uid}"] .styk-tree-name`).click({modifiers: shift ? ['Shift'] : []});
}
async function point(x, y) {
  return page.evaluate(({x, y}) => {
    const r = document.querySelector('#viewport').getBoundingClientRect(), v = styk.state.view;
    return {x: r.left + v.x + x * v.scale, y: r.top + v.y + y * v.scale};
  }, {x, y});
}
async function dragWorld(a, b) {
  const from = await point(...a), to = await point(...b);
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  await page.mouse.move(to.x, to.y, {steps: 8}); await page.mouse.up();
}
async function saveDownload(action, filename) {
  const pending = page.waitForEvent('download'); pending.catch(() => {}); await action();
  const download = await pending, target = path.join(out, filename);
  await download.saveAs(target); return target;
}
async function addText(text, {style = false} = {}) {
  await blur(); await page.keyboard.press('t');
  if (!await page.locator('#text-content').isVisible()) {
    findings.push('Plain T shortcut did not open the advertised text dialog.');
    await page.locator('[data-action="add-text"]').first().click();
  }
  await page.locator('#text-content').fill(text);
  await page.locator('#text-size').fill('38');
  if (style) {
    await page.locator('#text-bold').check(); await page.locator('#text-italic').check();
    await page.locator('#text-alignment').selectOption('center');
    await page.locator('#text-line-height').fill('1.4');
    await page.locator('#text-gradient-enabled').check(); await page.locator('#text-outline-width').fill('1');
  }
  await page.locator('#create-text').click(); await page.waitForFunction(() => !document.querySelector('#dialog').open);
}
try {
  await page.goto(url); await page.waitForFunction(() => window.styk?.ready);
  check('Creation UI initializes actual WebGPU renderer', await value(() => styk.state.renderer.stats.backend === 'WebGPU'));
  const uids = await value(() => {
    const e = styk.editor; e.newDocument(); e.updateProject({canvas_width: 800, canvas_height: 450});
    e.updateObject({root_x: 130, root_y: 200, scale: .5}); const ids = [e.selectedUid];
    e.addFigure(); e.updateObject({root_x: 290, root_y: 230, scale: .5}); ids.push(e.selectedUid);
    e.addFigure(); e.updateObject({root_x: 590, root_y: 210, scale: .5}); ids.push(e.selectedUid);
    styk.fit(); return ids;
  });
  await layer(uids[0]); await layer(uids[1], true);
  check('Shift-clicking layers selects two figures with a stable active figure', (await selection()).join(',') === uids.slice(0, 2).join(',') && await value(() => styk.editor.selectedUid) === uids[1]);
  check('Multi-selection exposes group bounds and alignment controls', await page.locator('[data-field="group_width"]').isVisible() && await page.locator('[data-action="align-left"]').isVisible());
  const beforeMove = await poses();
  await dragWorld([130, 200], [175, 225]);
  const moved = await poses();
  check('Dragging a selected origin translates both figures by the same amount', moved.slice(0, 2).every((o, i) => Math.abs(o.x - beforeMove[i].x - 45) < .01 && Math.abs(o.y - beforeMove[i].y - 25) < .01));
  check('Group drag leaves the unselected figure unchanged', moved[2].x === beforeMove[2].x && moved[2].y === beforeMove[2].y);
  await blur(); await page.keyboard.press('Control+z');
  check('One undo restores the complete group drag', JSON.stringify(await poses()) === JSON.stringify(beforeMove));
  await page.keyboard.press('Control+Shift+z');
  check('Group drag redo restores the entire movement', JSON.stringify(await poses()) === JSON.stringify(moved));
  await page.keyboard.press('Control+z');
  await dragWorld([70, 60], [390, 330]);
  check('Canvas marquee selects the two intersected figures and excludes the distant figure', [...await selection()].sort().join(',') === [...uids.slice(0, 2)].sort().join(','));
  await layer(uids[1], true);
  check('Shift-click toggles an already selected figure off', (await selection()).join(',') === String(uids[0]));
  await layer(uids[1], true);
  const beforeAlign = await poses();
  await page.locator('[data-action="align-left"]').click();
  check('Align left moves equal-size selected figures to the same left edge', await value(() => Math.abs(styk.editor.selectedObjects[0].root_x - styk.editor.selectedObjects[1].root_x) < .001));
  await blur(); await page.keyboard.press('Control+z');
  check('Selection alignment is one undo transaction', JSON.stringify(await poses()) === JSON.stringify(beforeAlign));
  const x = Number(await page.locator('[data-field="group_x"]').inputValue());
  await page.locator('[data-field="group_x"]').fill(String(x + 20)); await page.locator('[data-field="group_x"]').press('Tab');
  check('Numeric group X moves selected figures together', (await poses()).slice(0, 2).every((o, i) => Math.abs(o.x - beforeAlign[i].x - 20) < .02));
  await blur(); await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+c'); await page.keyboard.press('Control+v');
  const copied = await poses(), pastedIds = await selection();
  check('Keyboard copy/paste adds the whole group with distinct stable identities', copied.length === 5 && pastedIds.length === 2 && pastedIds.every(id => !uids.includes(id)));
  check('Pasted group retains relative spacing and one shared definition', Math.abs(copied[4].x - copied[3].x - 160) < .01 && await value(() => new Set(styk.editor.selectedObjects.map(o => o.figure_type_id)).size) === 1);
  await page.keyboard.press('Control+z');
  check('Group paste undo removes only the inserted instances', (await poses()).length === 3);
  await layer(uids[0]); await layer(uids[1], true); await blur();
  await page.keyboard.press('Control+x');
  check('Keyboard cut removes all selected figures', (await poses()).length === 1);
  await page.keyboard.press('Control+z');
  check('Cut undo restores both identities and their original poses', JSON.stringify(await poses()) === JSON.stringify(beforeAlign));
  await page.keyboard.press('Control+a');
  check('Select all chooses every editable visible figure', (await selection()).length === 3);
  await layer(uids[2]);
  await page.screenshot({path: path.join(out, 'creation-selection-ui.png')});

  await addText('Styk in motion\nΚαλημέρα • Привет', {style: true});
  const textUid = await value(() => styk.editor.selectedUid), textType = await value(() => styk.editor.figure.figure_type_id);
  const textBefore = await value(() => structuredClone(styk.editor.figure));
  check('T shortcut creates styled multilingual text through the actual dialog', textBefore.text_assets[0].text === 'Styk in motion\nΚαλημέρα • Привет' && textBefore.text_assets[0].font_style === 3 && !!textBefore.text_assets[0].normalized_svg_path);
  check('Text dialog applies multiline layout, gradient and outline', textBefore._styk.textAuthoring.alignment === 'center' && textBefore._styk.textAuthoring.lineHeight === 1.4 && !!textBefore.segments[0].secondary && textBefore.segment_decode.global_style.outline_thickness === 1);
  await value(() => {styk.editor.updateObject({root_x: 170, root_y: 375}); styk.editor.addFrame();});
  await page.locator('[data-action="edit-text"]').click();
  check('Editing text reopens the authored content and styles', await page.locator('#text-content').inputValue() === textBefore.text_assets[0].text && await page.locator('#text-bold').isChecked() && await page.locator('#text-italic').isChecked());
  await page.locator('#text-content').fill('Move together\nCafé • Привет');
  await page.locator('#text-size').fill('44'); await page.locator('#create-text').click();
  await page.waitForFunction(() => !document.querySelector('#dialog').open);
  check('Edit text rebuilds actual glyph outlines', await value(() => styk.editor.figure.text_assets[0].text) === 'Move together\nCafé • Привет' && await value(() => styk.editor.figure.text_assets[0].bounds.width) !== textBefore.text_assets[0].bounds.width);
  check('Global text update preserves both frames and existing figure identity', await page.evaluate(({textUid, textType}) => styk.editor.report.keyframes.every(f => f.objects.some(o => o.unique_id === textUid && o.figure_type_id === textType)), {textUid, textType}));
  await blur(); await page.keyboard.press('Control+z');
  check('Text editing undo restores the previous embedded glyphs', await value(() => styk.editor.figure.text_assets[0].text) === textBefore.text_assets[0].text);
  await page.keyboard.press('Control+Shift+z');
  await page.locator('[data-action="edit-text"]').click(); await page.locator('#text-content').fill('😀');
  await page.locator('#text-error').waitFor({state: 'visible'});
  check('Unsupported text reports an inline error without losing the existing definition', await value(() => styk.editor.figure.text_assets[0].text) === 'Move together\nCafé • Привет');
  check('Invalid text cannot be applied', await page.locator('#create-text').isDisabled());
  await page.locator('#dialog [data-text-close]').first().click();
  // Create an actual joined group for persistence; then exercise its clipboard through UI.
  await page.evaluate(uids => {const e = styk.editor; e.selectFrame(0); e.select(uids[1]); e.joinTo(uids[0], 0); e.selectMany(uids.slice(0, 2));}, uids);
  await blur(); await page.keyboard.press('Control+c'); await page.keyboard.press('Control+v');
  check('Copy/paste remaps internal joined-group references to the new parent', await value(() => {const selected = styk.editor.selectedObjects; const child = selected.find(o => o.join); return !!child && selected.some(o => o.unique_id === styk.editor.frame.objects[child.join.target_object_slot]?.unique_id);}));
  await page.evaluate(textUid => styk.editor.select(textUid), textUid);
  await page.screenshot({path: path.join(out, 'creation-text-ui.png')});
  const nativePath = await saveDownload(() => page.locator('[data-action="save"]').first().click(), 'creation-authored.styk');
  const native = await readNativeDocument(nativePath), doc = native.document || native;
  check('Actual native save contains editable text options and embedded glyphs', doc.figure_types.some(f => f._styk?.textAuthoring?.text === 'Move together\nCafé • Привет' && f.text_assets[0].glyphs.length > 0));
  check('Native save contains joined groups and both animation frames', doc.keyframes.length === 2 && doc.keyframes[0].objects.filter(o => o.join).length === 2);
  await page.locator('#file-input').setInputFiles(nativePath); await page.waitForFunction(() => styk.editor.name === 'creation-authored');
  check('Reopening the saved native file retains text editing metadata and group joins', await value(() => styk.editor.report.figure_types.some(f => f._styk?.textAuthoring?.text === 'Move together\nCafé • Привет') && styk.editor.report.keyframes[0].objects.filter(o => o.join).length === 2));

  const sourcePath = path.resolve(appRoot, '../Pivot Animator v5/Animations/tween_pendulum.piv');
  await page.locator('#file-input').setInputFiles(sourcePath); await page.waitForFunction(() => styk.editor.name === 'tween_pendulum');
  const sourceKeys = await value(() => styk.editor.report.keyframes.length);
  const objectCount = await value(() => styk.editor.frame.objects.length);
  await page.locator('#file-input').setInputFiles(path.resolve(appRoot, '../Pivot Animator v5/Figures/sheep.stk'));
  await page.waitForFunction(n => styk.editor.frame.objects.length === n + 1, objectCount);
  const importedUid = await value(() => styk.editor.selectedUid), initialX = await value(() => styk.editor.object.root_x);
  await page.locator('[data-field="root_x"]').fill('123'); await page.locator('[data-field="root_x"]').press('Tab');
  await blur(); await page.keyboard.press('F6');
  check('Imported PIV plus real STK can be posed and extended with a new keyframe', await value(() => styk.editor.object.root_x === 123) && await value(() => styk.editor.report.keyframes.length) === sourceKeys + 1);
  await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z');
  check('Source scene pose and frame edits undo without losing its imported STK', await value(() => styk.editor.report.keyframes.length) === sourceKeys && await value(() => styk.editor.object.root_x) === initialX && await value(() => styk.editor.frame.objects.length) === objectCount + 1);
  await page.keyboard.press('Control+Shift+z'); await page.keyboard.press('Control+Shift+z');
  const initialTick = await value(() => styk.editor.tick);
  await page.locator('#play-button').click(); await page.waitForFunction(tick => styk.editor.tick !== tick, initialTick);
  await page.locator('#play-button').click();
  check('The same imported and edited scene plays and pauses', await value(() => !styk.state.playing));
  const timelineBox = await page.locator('.styk-timeline-scroll').boundingBox();
  await page.mouse.click(timelineBox.x + 15, timelineBox.y + 14);
  check('The same scene scrubs to its first key through the visible timeline', await value(() => styk.editor.tick) === 0);
  await addText('A new Pivot title');
  const sourceNative = await saveDownload(() => page.locator('[data-action="save"]').first().click(), 'creation-source-chain.styk');
  await page.locator('#file-input').setInputFiles(sourceNative); await page.waitForFunction(() => styk.editor.name === 'creation-source-chain');
  check('The complete import, pose, frame, history and playback workflow survives native save/reopen', await page.evaluate(({importedUid, sourceKeys}) => styk.editor.report.keyframes.length === sourceKeys + 1 && styk.editor.report.keyframes[0].objects.some(o => o.unique_id === importedUid && o.root_x === 123) && !!styk.editor.report._stykSource?.source_base64, {importedUid, sourceKeys}));
  await page.locator('[data-action="export"]').first().click();
  const pivPath = await saveDownload(() => page.locator('[data-action="export-piv"]').click(), 'creation-source-edited.piv');
  const reopened = await page.evaluate(async bytes => {
    const response = await fetch('/api/import?filename=creation-source-edited.piv', {method: 'POST', headers: {'Content-Type': 'application/octet-stream'}, body: Uint8Array.from(bytes)});
    if (!response.ok) throw new Error(await response.text()); return (await response.json()).document;
  }, [...await readFile(pivPath)]);
  check('Source-bearing PIV export preserves edited timeline and includes the newly authored text', reopened.keyframes.length === sourceKeys + 1 && reopened.figure_types.some(f => f.text_assets?.some(a => a.text === 'A new Pivot title')));
  check('Source-bearing PIV export retains the added text instance in its edited frame', reopened.keyframes[0].objects.some(o => reopened.figure_types.some(f => f.figure_type_id === o.figure_type_id && f.text_assets?.some(a => a.text === 'A new Pivot title'))));
  assert.deepEqual(errors, []); check('Creation workflow has no uncaught browser exceptions');
  assert.deepEqual(findings, []);
  await writeFile(path.join(out, 'creation-verification.json'), JSON.stringify({checks, errors, findings, timestamp: new Date().toISOString()}, null, 2));
} catch (error) {
  await page.screenshot({path: path.join(out, 'creation-failure.png')});
  await writeFile(path.join(out, 'creation-verification.json'), JSON.stringify({checks, errors, findings, failure: error.stack}, null, 2));
  throw error;
} finally { await browser.close(); }
