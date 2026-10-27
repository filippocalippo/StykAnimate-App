/** Camera follow from a figure's context menu through the redesigned Motion tab. */
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {chromium} from './support/playwright.mjs';

const out = 'artifacts/camera-follow'; await mkdir(out, {recursive: true});
const browser = await chromium.launch({channel: 'chrome', headless: true});
const page = await browser.newPage({viewport: {width: 1440, height: 1100}}), errors = [];
page.on('pageerror', error => errors.push(error.message));
const check = (name, value) => {assert.ok(value, name); console.log('PASS', name);};
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const clip = () => page.evaluate(() => styk.editor.getCameraMotions().find(c => c.type === 'follow'));
const undo = () => page.evaluate(() => styk.editor._undo.length);
try {
  await page.goto(process.env.STYK_URL || 'http://127.0.0.1:47831'); await page.waitForFunction(() => window.styk?.ready);
  await page.evaluate(async () => {
    const {createDemo} = await import('/src/demo.mjs');
    styk.state.settings.autosaveSeconds = 0; styk.settingsUI.commit({timelineMode: 'advanced'}); styk.editor.load(createDemo());
    styk.state.tool = 'select'; styk.editor.select(1); styk.fit();
  });
  await settle();
  const root = await page.evaluate(() => {
    const {editor, state} = styk, g = [...editor.geometry.objects.values()].find(g => g.obj.unique_id === 1), p = g.segments[0].end;
    const r = document.getElementById('overlay').getBoundingClientRect();
    return {x: r.x + state.view.x + p.x * state.view.scale, y: r.y + state.view.y + p.y * state.view.scale};
  });
  await page.mouse.click(root.x, root.y, {button: 'right'}); await settle();
  await page.locator('#menu [data-action="camera-follow"]').click(); await settle();
  let follow = await clip();
  check('Follow with camera adds a follow for the selected figure', follow?.targets.length === 1 && follow.targets[0].uid === 1 && follow.start === 0);
  check('It opens Camera → Motion on the new move', await page.evaluate(() => styk.state.inspectorContext === 'camera') && await page.locator('.motion-card[data-kind="follow"]').isVisible());
  check('The card names the followed figure', /Walker/.test(await page.locator('.motion-target-name').first().textContent()));
  await page.screenshot({path: `${out}/follow-card.png`});

  let before = await undo();
  const smoothness = page.locator('input[type="range"][data-motion-field="lag"]');
  await smoothness.focus(); await page.keyboard.press('ArrowRight'); await settle();
  follow = await clip();
  check('Smoothness slider commits one step', follow.params.lag === 9 && await undo() === before + 1);
  check('The typed value mirrors the slider', await page.locator('input[type="number"][data-motion-field="lag"]').inputValue() === '9');
  await page.locator('input[type="number"][data-motion-field="deadZone"]').fill('25'); await page.locator('input[type="number"][data-motion-field="deadZone"]').press('Enter'); await settle();
  check('Typing a percentage stores a fraction', (await clip()).params.deadZone === .25);
  await page.locator('[data-motion-axes="x"]').click(); await settle();
  follow = await clip();
  check('Direction Across follows horizontally only', follow.params.followX === 1 && follow.params.followY === 0);

  // A second figure: select it, come back to the camera, and add it.
  await page.evaluate(() => { styk.editor.select(1); styk.editor.select(2, -1, {add: true}); }); await settle();
  await page.getByRole('button', {name: 'Select layer Camera', exact: true}).click(); await settle();
  await page.locator('[data-motion-action="follow-selected"]').click(); await settle();
  follow = await clip();
  check('Follow selected figures adds the new figure once', follow.targets.map(t => t.uid).sort().join() === '1,2');
  const weight = page.locator('[data-follow-weight="2"]');
  check('Two figures show a weight each', await page.locator('[data-follow-weight]').count() === 2);
  before = await undo();
  await weight.focus(); for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowLeft'); await settle();
  check('Weights are editable', Math.abs((await clip()).targets.find(t => t.uid === 2).weight - .9) < 1e-9 && await undo() > before);
  await page.locator('[data-follow-remove="2"]').click(); await settle();
  check('A figure can be removed from the follow', (await clip()).targets.length === 1);

  await page.locator('[data-motion-action="keep-framing"]').click(); await settle();
  follow = await clip();
  check('Keep current framing sets an offset from the shot', follow.params.offsetX !== 0 || follow.params.offsetY !== 0);
  check('The live camera follows the figure', await page.evaluate(async () => {
    const e = styk.editor, c = e.getCameraMotions().find(c => c.type === 'follow');
    e.setCameraMotion(c.id, {params: {deadZone: 0, offsetX: 0, offsetY: 0, fadeIn: 0}});
    const moved = [0, 10, 20, 30, 40].map(tick => { e.seek(tick); return (e._shown.shot()?.x ?? 0) - (e.evaluatedFrame.camera?.x ?? 0); });
    e.undo(); return moved.some(dx => Math.abs(dx) > 1);
  }));
  await page.evaluate(() => styk.editor.undo()); await settle();
  check('Undo restores the previous framing', (await clip()).params.offsetX === 0 && (await clip()).params.offsetY === 0);

  // Adding from the gallery once moves exist.
  await page.locator('[data-motion-action="toggle-add"]').click(); await settle();
  check('Add opens the gallery with descriptions', await page.locator('.motion-gallery .motion-tile').count() === 6 && /rattle/.test(await page.locator('[data-motion-add="shake"]').textContent()));
  await page.locator('[data-motion-add="shake"]').click(); await settle();
  check('A gallery tile adds that move and selects it', await page.locator('.motion-card[data-kind="shake"]').isVisible() && await page.locator('.motion-gallery').count() === 0);
  await page.screenshot({path: `${out}/shake-card.png`});
  check('No uncaught browser errors', errors.length === 0);
} finally { await browser.close(); }
