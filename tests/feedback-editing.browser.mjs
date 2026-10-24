import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {chromium} from './support/playwright.mjs';
import backend from '../desktop/web-host.cjs';

const server = await backend.startDesktopHost({appRoot: fileURLToPath(new URL('..', import.meta.url))});
const browser = await chromium.launch({channel: 'chrome', headless: true});
const output = 'artifacts/feedback-editing';
await mkdir(output, {recursive: true});
const checks = [], errors = [];
try {
  const page = await browser.newPage({viewport: {width: 1440, height: 960}});
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('stykanimate.editor.settings.v1', JSON.stringify({locale: 'en'})));
  await page.goto(server.origin); await page.waitForFunction(() => window.styk?.ready);
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const mode = async name => {
    await page.locator(`.workspace-switch [data-workspace-mode="${name}"]`).click();
    await page.waitForFunction(name => document.querySelector('.workspace').dataset.mode === name, name);
    await settle();
  };
  const fixture = async (timelineMode = 'advanced') => {
    await page.evaluate(async timelineMode => {
      const {emptyDocument, createFrame, createObject} = await import('/src/demo.mjs');
      const report = emptyDocument(), figure = report.figure_types[0];
      report.canvas_width = 800; report.canvas_height = 500;
      figure.segments = [{...figure.segments[0], segment_id: 1, parent_id: 0, length: 180,
        angle_rad: 0, bend_rad: 0, thickness: 12, is_static: false, flags: 0, primitive_code: 0}];
      figure.segment_count = 1;
      report.keyframes = [createFrame([createObject(figure, 1, 220, 230)], 1)];
      styk.settingsUI.commit({timelineMode}); styk.editor.load(report); styk.editor.seek(0); styk.editor.select(1, 0);
      styk.state.onion = false; styk.state.handles = true; styk.fit();
      window.feedbackPoint = async (root = false) => {
        const {worldToScreen} = await import('/src/renderer-geometry.mjs');
        const e = styk.editor, g = e.geometry.objects.get(e.selectedSlot), point = root ? g.root : g.segments[0].end;
        const p = worldToScreen(point, {report: e.report, frame: e.evaluatedFrame, view: styk.state.view, cameraEnabled: false});
        const box = document.querySelector('#viewport').getBoundingClientRect();
        return {x: box.x + p.x, y: box.y + p.y};
      };
    }, timelineMode);
    await settle();
  };
  const run = async (name, fn) => {
    if (process.argv[2] && !name.includes(process.argv[2])) return;
    await fn(); checks.push(name); console.log(`PASS ${name}`);
  };
  await run('Draw recovery restores figure animation', async () => {
    await fixture();
    await page.evaluate(() => {
      const e = styk.editor; window.priorFigureLayer = e.activeLayerId;
      const layer = e.createDrawingLayer(); window.feedbackDrawingLayer = layer.id;
      e.selectSheetLayer(priorFigureLayer); e.select(1, 0);
      window.beforeDrawVisit = JSON.stringify(e.serialize());
    });
    await mode('draw');
    assert.equal(await page.evaluate(() => styk.editor.activeLayerId), await page.evaluate(() => feedbackDrawingLayer));
    await mode('animate');
    assert.equal(await page.evaluate(() => styk.editor.activeLayerId), await page.evaluate(() => priorFigureLayer));
    assert.equal(await page.evaluate(() => styk.editor.selectedUid), 1);
    assert.equal(await page.evaluate(() => JSON.stringify(styk.editor.serialize())), await page.evaluate(() => beforeDrawVisit));
    await page.locator('#viewport').focus(); await page.keyboard.press('a'); await settle();
    assert.equal(await page.evaluate(() => styk.editor.evaluatedFrame.objects.some(o => o.unique_id === 1)), true);
    assert.equal(await page.evaluate(() => styk.editor.layerFrameKeys(priorFigureLayer).length), 2);
    assert.equal(await page.evaluate(() => styk.editor.layerFrameKeys(feedbackDrawingLayer).length), 1);
    await page.screenshot({path: `${output}/draw-recovery.png`});
  });
  for (const timelineMode of ['simple', 'advanced']) for (const kind of ['pose', 'move', 'bend']) await run(`Add frames during ${kind} drag (${timelineMode})`, async () => {
    await fixture(timelineMode); await page.keyboard.press('v');
    const p = await page.evaluate(root => feedbackPoint(root), kind === 'move');
    const button = kind === 'bend' ? 'right' : 'left';
    const pose = () => page.evaluate(kind => {
      const o = styk.editor.evaluatedFrame.objects[0];
      return kind === 'pose' ? o.angles[0] : kind === 'move' ? o.root_x : o.bends[0];
    }, kind);
    await page.mouse.move(p.x, p.y); await page.mouse.down({button});
    await page.mouse.move(p.x - 20, p.y + 40, {steps: 4}); await settle();
    assert.equal(await page.evaluate(() => styk.state.drag?.kind), kind);
    await page.keyboard.press('a'); await settle();
    assert.equal(await page.evaluate(() => styk.state.drag?.kind), kind);
    assert.equal(await page.evaluate(() => styk.editor.dragging), true);
    const first = await pose();
    await page.mouse.move(p.x - 60, p.y + 80, {steps: 4}); await settle();
    await page.keyboard.press('a'); await settle();
    const second = await pose(); assert.notEqual(second, first);
    assert.equal(await page.evaluate(() => styk.state.drag?.kind), kind);
    await page.mouse.move(p.x - 100, p.y + 90, {steps: 4}); await page.mouse.up({button}); await settle();
    assert.equal(await page.evaluate(() => styk.editor.dragging), false);
    assert.equal(await page.evaluate(() => styk.editor.layerFrameKeys().length), 3);
    const third = await pose(); assert.notEqual(third, second);
    const after = await page.evaluate(() => JSON.stringify(styk.editor.serialize()));
    await page.evaluate(() => styk.editor.undo()); await page.evaluate(() => styk.editor.redo());
    assert.equal(await page.evaluate(() => JSON.stringify(styk.editor.serialize())), after);
    for (const [tick, value] of [first, second, third].entries()) {
      await page.evaluate(tick => styk.editor.seek(tick), tick); assert.equal(await pose(), value);
    }
    await page.screenshot({path: `${output}/continuous-${kind}-${timelineMode}.png`});
  });
  await run('Escape cancels only the pose after Add frame', async () => {
    await fixture(); await page.keyboard.press('v');
    const p = await page.evaluate(() => feedbackPoint());
    await page.mouse.move(p.x, p.y); await page.mouse.down();
    await page.mouse.move(p.x - 30, p.y + 50); await page.keyboard.press('a'); await settle();
    const saved = await page.evaluate(() => styk.editor.evaluatedFrame.objects[0].angles[0]);
    await page.mouse.move(p.x - 90, p.y + 90); await page.keyboard.press('Escape'); await page.mouse.up(); await settle();
    assert.equal(await page.evaluate(() => styk.editor.dragging), false);
    assert.equal(await page.evaluate(() => styk.editor.layerFrameKeys().length), 2);
    assert.equal(await page.evaluate(() => styk.editor.evaluatedFrame.objects[0].angles[0]), saved);
  });
  await run('Build right-drag bends reusable figure', async () => {
    await fixture();
    await page.evaluate(() => {const e = styk.editor; e.figure.segments[0].is_static = true; e.figure.segments[0].aux_code = 1; e.touch();});
    await mode('rig');
    const p = await page.evaluate(() => feedbackPoint());
    const before = await page.evaluate(() => JSON.stringify(styk.editor.serialize()));
    await page.mouse.click(p.x, p.y, {button: 'right'});
    assert.equal(await page.evaluate(() => document.querySelector('#menu').hidden), false);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => JSON.stringify(styk.editor.serialize())), before);
    await page.mouse.move(p.x, p.y); await page.mouse.down({button: 'right'});
    await page.mouse.move(p.x - 20, p.y + 70, {steps: 5}); await page.mouse.up({button: 'right'}); await settle();
    assert.ok(Math.abs(await page.evaluate(() => styk.editor.figure.segments[0].bend_rad)) > .1);
    const after = await page.evaluate(() => JSON.stringify(styk.editor.serialize()));
    await page.evaluate(() => styk.editor.undo());
    assert.equal(await page.evaluate(() => JSON.stringify(styk.editor.serialize())), before);
    await page.evaluate(() => styk.editor.redo());
    assert.equal(await page.evaluate(() => JSON.stringify(styk.editor.serialize())), after);
    const next = await page.evaluate(() => feedbackPoint());
    await page.mouse.move(next.x, next.y); await page.mouse.down({button: 'right'});
    await page.mouse.move(next.x - 40, next.y - 70, {steps: 5});
    await page.keyboard.press('Escape'); await page.mouse.up({button: 'right'}); await settle();
    assert.equal(await page.evaluate(() => JSON.stringify(styk.editor.serialize())), after);
    await page.screenshot({path: `${output}/build-bend.png`});
  });
  assert.deepEqual(errors, []);
  await writeFile(`${output}/gestures.json`, JSON.stringify({checks, errors}, null, 2));
} finally { await browser.close(); server.stop(); }
