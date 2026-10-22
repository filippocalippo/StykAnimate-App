import {_electron as electron, closeStartupPrompts} from '../tests/support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd(), run = path.join(root, 'artifacts', `library-drag-${Date.now()}`);
const profile = path.join(run, 'profile'), checks = [], errors = [];
await mkdir(profile, {recursive: true});
await writeFile(path.join(profile, 'telemetry-state.json'), JSON.stringify({decided: true, consent: {analytics: false, diagnostics: false, policyVersion: '2026-09-10', updatedAt: Date.now()}}));
const check = (name, value = true) => { assert.ok(value, name); checks.push(name); console.log('PASS', name); };
let app, page;
try {
  app = await electron.launch({args: [root], cwd: root, timeout: 45000, env: {...process.env, STYK_USER_DATA_DIR: profile, STYK_LIBRARY_DIR: path.join(run, 'library')}});
  app.process().stderr.on('data', data => process.stderr.write(data));
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.styk?.ready);
  await closeStartupPrompts(page);
  await page.evaluate(() => window.styk.editor.select(1));
  await page.getByRole('tab', {name: 'Library', exact: true}).click();
  await page.locator('#user-library [data-library-action="save"]').click();
  await page.waitForFunction(() => !window.styk.library.busy && window.styk.library.entries.length === 1);
  const card = page.locator('.library-card:not(.folder)').first();
  await card.locator('img').waitFor();
  await page.waitForFunction(() => document.querySelector('.library-thumbnail img')?.complete);
  const count = await page.evaluate(() => window.styk.editor.selectionFrame.objects.length);
  await page.evaluate(() => {
    const library = window.styk.library, importer = library.importer.importFile.bind(library.importer);
    window.dragEvidence = {nativeStarts: 0, imports: 0, pointerId: null, hoverMoves: 0};
    document.addEventListener('dragstart', () => window.dragEvidence.nativeStarts++);
    library.grid.addEventListener('pointerdown', event => { window.dragEvidence.pointerId = event.pointerId; });
    document.getElementById('overlay').addEventListener('pointermove', () => window.dragEvidence.hoverMoves++);
    library.importer.importFile = (...args) => { window.dragEvidence.imports++; return importer(...args); };
  });
  const start = async () => {
    const box = await card.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 35); await page.mouse.down();
    return {x: box.x + box.width / 2, y: box.y + 35};
  };
  const point = async (x = 260, y = 220) => {
    const box = await page.locator('#viewport').boundingBox();
    return {x: box.x + x, y: box.y + y};
  };
  const moveTo = async (p, steps = 1) => page.mouse.move(p.x, p.y, {steps});
  const clean = async () => {
    assert.equal(await page.locator('.library-drag-ghost, .library-dragging, .library-drop-target, .library-pointer-dragging').count(), 0);
  };
  const unchanged = async () => {
    await page.waitForFunction(() => !window.styk.library.busy);
    assert.equal(await page.evaluate(() => window.styk.editor.selectionFrame.objects.length), count);
    await clean();
  };

  const initial = await start(); await moveTo({x: initial.x + 2, y: initial.y + 1}); await page.mouse.up();
  await unchanged(); check('Small movements select the card without inserting or starting a drag');
  await start(); const destination = await point();
  await moveTo(destination, 25);
  await page.waitForSelector('.library-drop-target');
  const held = await page.evaluate(() => ({...window.dragEvidence, count: window.styk.editor.selectionFrame.objects.length}));
  check('Holding uses pointer capture without native drag, imports, scene edits, or canvas hover work', held.nativeStarts === 0 && held.imports === 0 && held.hoverMoves === 0 && held.count === count);
  const burst = await page.evaluate(async ({x, y}) => {
    const ghost = document.querySelector('.library-drag-ghost'), card = document.querySelector('.library-card');
    let writes = 0;
    const observer = new MutationObserver(records => { writes += records.length; });
    observer.observe(ghost, {attributes: true, attributeFilter: ['style']});
    for (let i = 0; i < 200; i++) card.dispatchEvent(new PointerEvent('pointermove', {bubbles: true, pointerId: window.dragEvidence.pointerId, buttons: 1, clientX: x + i / 10, clientY: y + i / 10}));
    await new Promise(requestAnimationFrame);
    await Promise.resolve(); observer.disconnect();
    const matrix = new DOMMatrixReadOnly(getComputedStyle(ghost).transform);
    return {writes, x: matrix.m41, y: matrix.m42, expectedX: x + 19.9 + 14, expectedY: y + 19.9 + 14};
  }, destination);
  check('200 queued pointer moves paint once at the latest position', burst.writes === 1 && Math.abs(burst.x - burst.expectedX) < .01 && Math.abs(burst.y - burst.expectedY) < .01);
  await moveTo(destination);
  await page.screenshot({path: path.join(run, 'held-drag.png')});
  await page.mouse.up();
  await page.waitForFunction(n => !window.styk.library.busy && window.styk.editor.selectionFrame.objects.length === n + 1, count);
  const inserted = await page.evaluate(() => {
    const {editor, state} = window.styk;
    return {x: editor.object.root_x, y: editor.object.root_y, expectedX: (260 - state.view.x) / state.view.scale, expectedY: (220 - state.view.y) / state.view.scale, imports: window.dragEvidence.imports};
  });
  check('Release imports exactly once at the final canvas coordinates', inserted.imports === 1 && Math.abs(inserted.x - inserted.expectedX) < .001 && Math.abs(inserted.y - inserted.expectedY) < .001);
  await clean(); await page.evaluate(() => window.styk.editor.undo()); await unchanged();
  check('One undo removes the dropped asset');

  for (const cancellation of ['outside', 'Escape', 'pointercancel', 'lostpointercapture', 'blur']) {
    await start(); await moveTo(await point()); await page.waitForSelector('.library-drag-ghost');
    if (cancellation === 'outside') await moveTo({x: 1450, y: 350});
    else if (cancellation === 'Escape') await page.keyboard.press('Escape');
    else if (cancellation === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    else await page.evaluate(type => {
      const card = document.querySelector('.library-card'), pointerId = window.dragEvidence.pointerId;
      if (type === 'lostpointercapture') card.releasePointerCapture(pointerId);
      else card.dispatchEvent(new PointerEvent(type, {bubbles: true, pointerId}));
    }, cancellation);
    // Deliver a move so the browser processes an explicitly released capture.
    if (cancellation === 'lostpointercapture') await moveTo(await point(270, 230));
    await page.mouse.up(); await unchanged(); check(`${cancellation} cancels cleanly without inserting`);
  }
  await page.getByRole('tab', {name: 'Properties', exact: true}).click();
  check('The first click after cancellation still works', await page.locator('#inspector').isVisible());
  await page.getByRole('tab', {name: 'Library', exact: true}).click();
  await card.waitFor();
  await card.dblclick();
  await page.waitForFunction(n => !window.styk.library.busy && window.styk.editor.selectionFrame.objects.length === n + 1, count);
  check('Double-click insertion still works');
  await page.evaluate(() => window.styk.editor.undo());
  await card.click(); await page.keyboard.press('F2');
  const input = page.getByRole('textbox', {name: 'Asset name', exact: true});
  await input.fill('Drag check'); await input.press('Escape');
  await unchanged(); check('Inline rename retains normal input handling');
  await page.getByRole('button', {name: 'New library folder', exact: true}).click();
  await page.getByRole('textbox', {name: 'Folder name', exact: true}).fill('Folder');
  await page.getByRole('button', {name: 'Create folder', exact: true}).click();
  const folder = page.locator('.library-card.folder'); await folder.waitFor();
  await folder.dragTo(page.locator('#viewport'));
  await unchanged(); check('Folders cannot be dragged into the scene');
  assert.deepEqual(errors, []);
  await writeFile(path.join(run, 'evidence.json'), JSON.stringify({checks, errors, held, burst, inserted}, null, 2));
  console.log(JSON.stringify({run, checks: checks.length, errors}, null, 2));
} catch (error) {
  await page?.screenshot({path: path.join(run, 'failure.png')}).catch(() => {});
  throw error;
} finally {
  if (app) await app.evaluate(({app}) => app.exit(0)).catch(() => {});
}
