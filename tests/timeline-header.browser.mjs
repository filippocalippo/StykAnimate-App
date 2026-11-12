/**
 * The shared timeline header (timeline-header.mjs; experience.md §5.6, §5.7):
 * one header in three clusters for Simple and Advanced, the Timeline ⋯ menu's
 * rare rows, Go to frame from the readout, Edit together's states, the
 * minimal tier's folds, the layer list's header (Focus, New layer with rename
 * on create, Find layers) and the view tools (zoom, Fit, Tall) leading the end
 * cluster.
 *
 * Where features/timeline.css is loaded, the layout is checked too: at every
 * tier size the three clusters keep apart, no header control overlaps
 * another or leaves the header, Add frame keeps its word from 900px, and the
 * grid takes the island's whole width.
 *
 *   STYK_URL=http://127.0.0.1:47915 node tests/timeline-header.browser.mjs
 */
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {chromium} from './support/playwright.mjs';

const URL = process.env.STYK_URL || 'http://127.0.0.1:47831';
const out = 'artifacts/timeline-header';
const browser = await chromium.launch({channel: 'chrome', headless: true});
const page = await browser.newPage({viewport: {width: 1440, height: 900}});
const errors = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
const check = (name, value) => { assert.ok(value, name); checks.push(name); console.log('PASS', name); };
const settle = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
const mode = async name => { await page.evaluate(name => styk.settingsUI.commit({timelineMode: name}), name); await settle(); await settle(); };
/** Which cluster (start, transport, end) or place holds each control. */
const where = () => page.evaluate(() => {
  const cluster = selector => document.querySelector(selector)?.closest('[data-slot]')?.dataset.slot ?? (document.querySelector(selector)?.closest('#timeline') ? 'body' : null);
  return Object.fromEntries(['#timeline-workflow', '.sheet-add-frame', '#range-edit', '[data-action="first-frame"]', '#play-button', '#loop-button',
    '#time-display', '#fps', '#onion-button', '#onion-settings-button', '#timeline-audio', '#timeline-menu-button', '#timeline-zoom', '#expand-timeline']
    .map(selector => [selector, cluster(selector)]));
});
const EXPECTED = {'#timeline-workflow': 'start', '.sheet-add-frame': 'start', '#range-edit': 'start', '[data-action="first-frame"]': 'transport',
  '#play-button': 'transport', '#loop-button': 'transport', '#time-display': 'transport', '#fps': 'transport', '#onion-button': 'end',
  '#onion-settings-button': 'end', '#timeline-audio': 'end', '#timeline-menu-button': 'end', '#timeline-zoom': 'ruler-tools', '#expand-timeline': 'ruler-tools'};

try {
  await page.goto(URL);
  await page.waitForFunction(() => window.styk?.ready);
  await page.evaluate(async () => {
    document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
    const {createDemo} = await import('/src/demo.mjs');
    styk.editor.load(createDemo(), 'Header fixture');
  });
  await mode('advanced');
  const styled = await page.evaluate(() => getComputedStyle(document.getElementById('animation-timeline')).getPropertyValue('--timeline-kit').trim() !== '');

  // One header, three clusters, the same controls in both modes; the ruler's tools go with the body.
  for (const name of ['advanced', 'simple']) {
    await mode(name);
    assert.deepEqual(await where(), EXPECTED, `${name}: every control in its cluster`);
    check(`${name}: one Add frame, named "Add Frame", with its word`, await page.evaluate(() => {
      const buttons = document.querySelectorAll('.sheet-add-frame'), button = buttons[0];
      return buttons.length === 1 && button.getAttribute('aria-label') === 'Add Frame' && button.textContent.trim() === 'Add frame';
    }));
  }
  const simpleBefore = await page.evaluate(() => styk.timeline.frameCount);
  await page.getByRole('button', {name: 'Add Frame', exact: true}).click();
  check('Simple: the header Add frame adds a frame', await page.evaluate(n => styk.timeline.frameCount === n + 1, simpleBefore));
  await page.keyboard.press('Control+z');
  await mode('advanced');
  const advancedBefore = await page.evaluate(() => styk.editor.layerFrameKeys(styk.editor.activeLayerId).length);
  await page.evaluate(() => styk.timeline.seek(2));
  await page.getByRole('button', {name: 'Add Frame', exact: true}).click();
  check('Advanced: the header Add frame keys the selected cell and the grid keeps the keyboard',
    await page.evaluate(n => styk.editor.layerFrameKeys(styk.editor.activeLayerId).length === n + 1 && document.activeElement === styk.timeline.scroll, advancedBefore));
  await page.keyboard.press('Control+z');

  // Loop says its state; Edit together shows only once two frames are selected, with its word.
  check('Loop is a pressed toggle, on by default', await page.evaluate(() => document.getElementById('loop-button').getAttribute('aria-pressed') === String(styk.state.loop)));
  check('Edit together waits for a range', await page.evaluate(() => { const b = document.getElementById('range-edit'); return b.disabled && !b.hidden && b.getAttribute('aria-label') === 'Edit together' && b.getBoundingClientRect().width === 0; }));
  await page.evaluate(() => { const t = styk.timeline, row = t.tracks.findIndex(r => r.kind === 'layer'); t._selectCell({row, tick: 1}); t._selectCell({row, tick: 6}, {extend: true}); });
  await settle(); await settle();
  check('Edit together applies to a selected range, with its word', await page.evaluate(() => { const b = document.getElementById('range-edit'); return !b.disabled && b.getBoundingClientRect().width > 40; }));
  await page.locator('#range-edit').click(); await settle();
  check('Edit together toggles on', await page.evaluate(() => document.getElementById('range-edit').getAttribute('aria-pressed') === 'true' && styk.state.applyRange));
  await page.locator('#range-edit').click(); await settle();
  await page.evaluate(() => styk.timeline.seek(0)); await settle();

  // Timeline ⋯ holds the rare rows.
  await page.locator('#timeline-menu-button').click();
  const rows = await page.evaluate(() => [...document.querySelectorAll('.ui-menu [role^="menuitem"]')].map(item => item.querySelector('span')?.textContent.trim()));
  assert.deepEqual(rows, ['Last frame', 'Previous key', 'Next key', 'Default height'], 'Timeline ⋯ rows at rest: Playback range stays beside Loop');
  await page.getByRole('menuitem', {name: 'Last frame'}).click(); await settle();
  check('Timeline ⋯ › Last frame goes to the last frame', await page.evaluate(() => styk.editor.tick === styk.editor.totalTicks - 1));

  // The readout opens Go to frame; Enter goes there (frames of the ruler in Advanced, cards in Simple).
  await page.locator('.tl-readout').click();
  await page.getByRole('spinbutton', {name: 'Go to frame'}).fill('5');
  await page.keyboard.press('Enter'); await settle();
  check('Go to frame goes to frame 5 of the ruler', await page.evaluate(() => styk.editor.tick === 4 && !document.querySelector('.tl-goto-popover:popover-open')));
  await mode('simple');
  await page.locator('.tl-readout').click();
  await page.getByRole('spinbutton', {name: 'Go to frame'}).fill('3');
  await page.keyboard.press('Enter'); await settle();
  check('Go to frame goes to the third card in Simple', await page.evaluate(() => styk.timeline.selectedIndex === 2));
  await mode('advanced');

  // The layer list's header: Show all while a focus is on, New layer opens its name, Find layers takes the title's place.
  check('Show all waits for a focus', await page.evaluate(() => styk.timeline.focusLayersButton.hidden));
  await page.getByRole('button', {name: 'New layer', exact: true}).click();
  await page.locator('.sheet-layer-rename').waitFor();
  check('New layer opens its name for typing', await page.evaluate(() => document.activeElement?.classList.contains('sheet-layer-rename')));
  await page.keyboard.type('Rival'); await page.keyboard.press('Enter'); await settle();
  check('The new layer takes the typed name', await page.evaluate(() => styk.editor.getLayer(styk.editor.activeLayerId).name === 'Rival'));
  await page.evaluate(() => styk.timeline.focusSelectedLayers()); await settle(); await settle();
  check('A focus shows Show all, with its word', await page.evaluate(() => { const b = styk.timeline.focusLayersButton; return !b.hidden && b.textContent.trim() === 'Show all' && b.getAttribute('aria-label') === 'Show all layers'; }));
  await page.getByRole('button', {name: 'Show all layers', exact: true}).click(); await settle(); await settle();
  check('Show all ends the focus and leaves', await page.evaluate(() => !styk.timeline.focusedLayerIds && styk.timeline.focusLayersButton.hidden));
  await page.getByRole('button', {name: 'More layer types', exact: true}).click();
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.ui-menu [role^="menuitem"]')].map(item => item.querySelector('span')?.textContent.trim())),
    ['New layer', 'New drawing layer', 'New folder', 'Group selected layers in folder'], 'New layer ▾ lists everything the layer list can add');
  await page.getByRole('menuitem', {name: 'New drawing layer'}).click();
  await page.locator('.sheet-layer-rename').waitFor();
  await page.keyboard.press('Escape'); await settle();
  check('New layer ▾ makes a drawing layer', await page.evaluate(() => Boolean(styk.editor.getLayer(styk.editor.activeLayerId)?.drawing)));
  check('A drawing layer shows Next copy and Blank frame', await page.evaluate(() => !document.querySelector('.tl-cel').hidden && document.querySelector('.sheet-add-frame').textContent.trim() === 'Blank frame'));
  await page.getByRole('button', {name: 'Find layers', exact: true}).click();
  check('Find layers opens its field in the title\'s place', await page.evaluate(() => document.activeElement === styk.timeline.layerSearch && styk.timeline.labelTitle.hidden));
  await page.keyboard.press('Escape'); await settle();
  check('An empty find field closes', await page.evaluate(() => styk.timeline.searchField.hidden && !styk.timeline.labelTitle.hidden));
  await page.getByRole('button', {name: 'Fit timeline', exact: true}).click(); await settle();
  check('Fit timeline fits the animation', await page.evaluate(() => styk.timeline.pxPerTick * styk.editor.totalTicks <= styk.timeline.width + 1));

  // A one-frame file never shows Edit together.
  await page.evaluate(async () => { const {emptyDocument} = await import('/src/demo.mjs'); styk.editor.load(emptyDocument(), 'One frame'); });
  await settle(); await settle();
  check('A one-frame file hides Edit together', await page.evaluate(() => styk.editor.totalTicks < 2 && document.getElementById('range-edit').hidden));
  await page.evaluate(async () => { const {createDemo} = await import('/src/demo.mjs'); styk.editor.load(createDemo(), 'Header fixture'); });
  await settle();

  // Layout: the clusters keep apart and nothing overlaps (with features/timeline.css).
  const layout = () => page.evaluate(() => {
    const head = document.querySelector('.timeline-toolbar'), box = element => element.getBoundingClientRect();
    const shown = element => element.offsetParent !== null && box(element).width > 0;
    const controls = [...head.querySelectorAll('button, input, [role="group"] > button')].filter(shown).filter((element, index, all) => all.indexOf(element) === index);
    const rects = controls.map(element => ({name: element.getAttribute('aria-label') || element.id || element.textContent.trim(), r: box(element)}));
    const overlaps = [];
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i].r, b = rects[j].r;
      if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5 && !controls[i].contains(controls[j]) && !controls[j].contains(controls[i])) overlaps.push(`${rects[i].name} × ${rects[j].name}`);
    }
    const outside = rects.filter(({r}) => r.left < box(head).left - 0.5 || r.right > box(head).right + 0.5).map(({name}) => name);
    const slot = name => [...head.querySelector(`[data-slot="${name}"]`).querySelectorAll('button, input')].filter(shown).map(box);
    const edge = (list, side) => side === 'right' ? Math.max(...list.map(r => r.right)) : Math.min(...list.map(r => r.left));
    const start = slot('start'), transport = slot('transport'), end = slot('end');
    const add = head.querySelector('.sheet-add-frame .ui-label');
    const scroll = box(styk.timeline.scroll), island = box(document.getElementById('animation-timeline'));
    return {overlaps, outside, overflow: head.scrollWidth > head.clientWidth + 0.5,
      gaps: [edge(transport, 'left') - edge(start, 'right'), edge(end, 'left') - edge(transport, 'right')],
      addWord: add && box(add).width > 1, gridEnds: !scroll.width || scroll.right >= island.right - 1.5, fold: head.dataset.fold ?? ''};
  });
  // At rest, and with every word the start cluster can hold (Blank frame, Next copy and Edit together's on a drawing layer's range).
  const busy = () => page.evaluate(() => {
    const layer = styk.editor.createDrawingLayer('Ink'), t = styk.timeline;
    t._selectLayer(layer.id);
    const row = t.tracks.findIndex(r => r.id === layer.id);
    t._selectCell({row, tick: 1}); t._selectCell({row, tick: 6}, {extend: true});
  });
  if (styled) for (const state of ['rest', 'busy']) {
    if (state === 'busy') { await page.setViewportSize({width: 1440, height: 900}); await busy(); await settle(); await settle(); }
    for (const [width, height] of [[1440, 900], [1280, 720], [1152, 720], [1024, 700], [960, 600], [900, 700], [820, 600], [520, 400]]) {
      await page.setViewportSize({width, height}); await settle(); await settle(); await settle();
      const result = await layout();
      assert.deepEqual(result.overlaps, [], `${width}×${height}: header controls overlap`);
      assert.deepEqual(result.outside, [], `${width}×${height}: controls outside the header`);
      assert.equal(result.overflow, false, `${width}×${height}: the header overflows`);
      // The minimal tier's clusters sit 4px apart (tighter gaps there), never touching.
      assert.ok(result.gaps.every(gap => gap >= (width <= 660 ? 4 : 8)), `${width}×${height}: clusters keep apart (${result.gaps})`);
      if (width >= 900) assert.ok(result.addWord, `${width}×${height}: Add frame keeps its word (folds: ${result.fold})`);
      assert.ok(result.gridEnds, `${width}×${height}: the grid takes the island's whole width`);
      checks.push(`${state} ${width}×${height}: three clusters apart, nothing overlaps${result.fold ? ` (folded: ${result.fold})` : ''}`);
      console.log('PASS', checks.at(-1));
    }
  } else console.log('SKIP layout checks: features/timeline.css is not loaded yet');

  // The minimal tier folds First frame, Loop, Audio and Edit together into Timeline ⋯.
  await page.setViewportSize({width: 500, height: 340}); await settle(); await settle(); await settle();
  check('Minimal: First frame, Loop, Audio and Edit together fold', await page.evaluate(() =>
    ['[data-action="first-frame"]', '#loop-button', '#timeline-audio', '#range-edit'].every(selector => document.querySelector(selector).hidden)));
  if (styled) {
    await page.locator('#timeline-menu-button').click();
    const minimalRows = await page.evaluate(() => [...document.querySelectorAll('.ui-menu [role^="menuitem"]')].map(item => item.querySelector('span')?.textContent.trim()));
    for (const row of ['First frame', 'Loop playback', 'Audio', 'Last frame']) assert.ok(minimalRows.includes(row), `Minimal: Timeline ⋯ lists ${row} (${minimalRows})`);
    check('Minimal: Timeline ⋯ lists the folded controls first', minimalRows.indexOf('First frame') < minimalRows.indexOf('Last frame'));
    if (await page.evaluate(() => (document.querySelector('.timeline-toolbar').dataset.fold ?? '').includes('celmenu')))
      check('Minimal: where Next copy folds, Timeline ⋯ lists its commands', ['Next copied drawing', 'Next blank drawing', 'Blank drawing here', 'Copy drawing here', 'Extend'].every(row => minimalRows.includes(row)));
    await page.keyboard.press('Escape');
  }
  await page.setViewportSize({width: 1440, height: 900}); await settle(); await settle();
  check('Wide again: the folded controls are back', await page.evaluate(() => !document.getElementById('loop-button').hidden && !document.querySelector('[data-action="first-frame"]').hidden));

  // A new language refolds the header for its own words: folded for Chinese, Croatian's longer words still fit.
  if (styled) {
    const language = async id => { await page.evaluate(async id => { await styk.loadLocale(id); styk.settingsUI.commit({locale: id}); }, id); await settle(); await settle(); };
    await page.setViewportSize({width: 760, height: 740}); await language('zh-Hans');
    await page.setViewportSize({width: 761, height: 740}); await settle(); await settle(); await settle();
    await language('hr');
    const result = await layout();
    check(`A language change refolds the header: nothing overflows or leaves it (folded: ${result.fold})`, !result.overflow && result.outside.length === 0 && result.overlaps.length === 0);
    await language('en');
    await page.setViewportSize({width: 1440, height: 900}); await settle(); await settle();
  }

  await mkdir(out, {recursive: true});
  await page.screenshot({path: `${out}/advanced.png`});
  assert.deepEqual(errors, []);
  check('No uncaught browser errors', true);
  await writeFile(`${out}/report.json`, JSON.stringify({styled, checks, errors}, null, 2));
} finally {
  await browser.close();
}
