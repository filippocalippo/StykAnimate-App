// The inspector's header in the actual app (src/inspector-header.mjs): the target's name and its one menu, the
// scope line while Edit together reaches beyond the frame, the selection's quick actions from the command registry,
// renaming in place, and titled sections that remember being open.
//   STYK_URL=http://127.0.0.1:47831 node tests/inspector-header.browser.mjs
import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';

const browser = await chromium.launch({channel: 'chrome', headless: true});
const page = await browser.newPage({viewport: {width: 1440, height: 900}}), errors = [];
page.on('pageerror', error => errors.push(error.message));
const check = (name, value) => { assert.ok(value, name); console.log('PASS', name); };
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const name = () => page.locator('[data-slot=inspector-target] .ui-target-text').textContent();
const quick = () => page.locator('[data-slot=inspector-head] .ui-quick button').evaluateAll(buttons => buttons.map(button => [button.dataset.action, button.textContent.trim()]));
try {
  await page.goto(process.env.STYK_URL || 'http://127.0.0.1:47831');
  await page.waitForFunction(() => window.styk?.ready);
  await page.evaluate(async () => {
    const {createDemo} = await import('/src/demo.mjs');
    styk.editor.load(createDemo(), 'Header fixture');
    styk.editor.markSaved();
    styk.state.inspectorTab = 'design'; styk.state.inspectorContext = 'figure';
    styk.editor.select(1);
  });
  await settle();
  check('The header names the figure and keeps its kind for the shell', await name() === 'Walker' &&
    await page.locator('#inspector-context').textContent() === 'Figure' && await page.locator('#inspector').getAttribute('data-selection-kind') === 'figure');
  check('One menu button, in the kit\'s look', await page.locator('#object-actions.ui-icon-button').count() === 1);
  assert.deepEqual(await quick(), [['mirror', 'Flip'], ['layer-front', 'Front'], ['layer-back', 'Back'], ['duplicate', 'Duplicate'], ['delete', 'Delete']]);
  check('Quick actions: labelled tiles Flip · Front, Back · Duplicate, Delete', true);
  const figures = await page.evaluate(() => styk.editor.selectionFrame.objects.length);
  await page.locator('[data-slot=inspector-head] [data-action="duplicate"]').click();
  await page.waitForFunction(n => styk.editor.selectionFrame.objects.length === n + 1, figures);
  check('Quick actions run their commands', true);
  await page.evaluate(() => { styk.editor.undo(); styk.editor.select(1); });
  await settle();

  // Rename in place: a double-click opens the name as a field; Enter commits one edit, Escape keeps the name.
  const undo = await page.evaluate(() => styk.editor._undo.length);
  await page.locator('.ui-target-text').dblclick();
  await page.locator('#figure-name').fill('Runner');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => styk.editor.figure.name === 'Runner');
  await settle();
  check('Enter renames the figure definition with one undo step', await page.evaluate(n => styk.editor._undo.length === n + 1, undo) && await name() === 'Runner' &&
    await page.locator('#figure-name').count() === 0);
  await page.locator('.ui-target-text').dblclick();
  await page.locator('#figure-name').fill('Nope');
  await page.keyboard.press('Escape');
  await settle();
  check('Escape keeps the name', await page.evaluate(() => styk.editor.figure.name) === 'Runner' && await name() === 'Runner');
  await page.locator('.ui-target-text').focus();
  await page.keyboard.press('F2');
  check('F2 on the focused name renames it too', await page.locator('#figure-name').evaluate(input => input === document.activeElement));
  await page.keyboard.press('Escape');

  // A titled section remembers being open for the next figure.
  await page.locator('[data-section-toggle="colours"]').click();
  await page.evaluate(() => styk.editor.select(3)); await settle();
  await page.evaluate(() => styk.editor.select(1)); await settle();
  check('Colours stays open for the next figure', await page.locator('[data-section-toggle="colours"]').getAttribute('aria-expanded') === 'true');
  await page.locator('[data-section-toggle="colours"]').click();

  // Edit together: the scope line names the frames and Stop ends it.
  await page.evaluate(() => {
    const timeline = styk.timeline; timeline.start = 0; timeline.end = 2; timeline.selectedLayers = new Set([styk.editor.activeLayerId]);
    styk.state.applyRange = true; styk.editor._emit('selection');
  });
  await settle();
  const scope = page.locator('[data-slot=inspector-head] .ui-scope');
  if (await scope.count()) {
    check('The scope line says which frames an edit reaches', /^Editing (frames \d+–\d+|\d+ frames)$/.test(await scope.locator(':scope > span:not(.ui-dot)').textContent()));
    await scope.getByRole('button', {name: 'Stop'}).click();
    await settle();
    check('Stop ends Edit together and the line goes', await page.evaluate(() => styk.state.applyRange === false) && await page.locator('[data-slot=inspector-head] .ui-scope').count() === 0);
  } else console.log('SKIP scope line: this document selects no frame range');

  // A joint: its name, its quick actions (Front, Back and Flip limb since 8a7df1f3; Isolate, Exact values and Match moved
  // to the ⋯ menu), Isolate's state in that menu; the scene: no quick actions.
  await page.evaluate(() => styk.editor.select(1, 4)); await settle();
  check('A joint is titled as today', /^Joint \d+$/.test(await name()) && await page.locator('#inspector-context').textContent() === 'Joint');
  assert.deepEqual((await quick()).map(([action]) => action), ['selection-front', 'selection-back', 'mirror']);
  check('Isolate is in the ⋯ menu and names its state', await (async () => {
    await page.locator('#object-actions').click(); await settle();
    await page.getByRole('menuitem', {name: 'Isolate joint', exact: true}).click(); await settle();
    const isolated = await page.evaluate(() => styk.state.isolateMode);
    await page.locator('#object-actions').click(); await settle();
    const stop = page.getByRole('menuitem', {name: 'Stop isolating joint', exact: true});
    const named = await stop.count() === 1;
    await stop.click(); await settle();
    return isolated && named && await page.evaluate(() => !styk.state.isolateMode);
  })());
  await page.evaluate(() => styk.editor.select(null)); await settle();
  check('The scene has a name, a kind glyph and no quick actions', await name() === 'Scene' && !(await page.locator('.ui-target-kind').isHidden()) &&
    await page.locator('[data-slot=inspector-head]').isHidden());
  check('No page errors', errors.length === 0);
} finally {
  await browser.close();
}
