/**
 * Browser test of the chrome kit on tests/fixtures/ui-chrome.html: the tool
 * options bar (src/ui/tool-options.mjs) measured, folded and keyboard-driven in
 * real layout, its More options popover, and the quick actions rows
 * (src/ui/quick-actions.mjs) over the command registry. Serve the repository
 * (node scripts/serve.mjs --port 47832) and run
 * `node tests/ui-chrome.browser.mjs`; STYK_URL overrides the address.
 */
import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';

const base = `${process.env.STYK_URL || 'http://127.0.0.1:47832'}/tests/fixtures/ui-chrome.html`;
const browser = await chromium.launch({channel: 'chrome', headless: true});
const errors = [];
const step = async (name, run) => {
  try { await run(); console.log(`ok ${name}`); } catch (error) { console.log(`not ok ${name}`); throw error; }
};
const open = async theme => {
  const page = await browser.newPage({viewport: {width: 1280, height: 900}});
  page.on('pageerror', error => errors.push(`${theme}: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') errors.push(`${theme}: ${message.text()}`); });
  page.setDefaultTimeout(5000);
  await page.goto(`${base}?theme=${theme}`);
  await page.waitForFunction(() => window.fixture?.ready);
  // Two frames: the observers measure, then the plan applies.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return page;
};
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
// Every shown control of a bar lies inside the bar: nothing is cut off at any width.
const clipped = (page, name) => page.evaluate(bar => {
  const element = fixture.bars[bar].element, box = element.getBoundingClientRect();
  return [...element.querySelectorAll('button, input, select, .ui-field-label, .ui-optbar-label')]
    .filter(control => control.getClientRects().length && getComputedStyle(control).visibility !== 'hidden' && !control.closest('[data-overflowed]'))
    .filter(control => { const rect = control.getBoundingClientRect(); return rect.width > 1 && (rect.right > box.right + 0.5 || rect.left < box.left - 0.5); })
    .map(control => control.getAttribute('aria-label') || control.textContent.trim());
}, name);
const visible = (page, bar, option) => page.evaluate(([name, id]) => {
  const root = fixture.bars[name].element.querySelector(`[data-option="${id}"]`);
  return Boolean(root?.getClientRects().length) && !root.closest('[data-overflowed]');
}, [bar, option]);

try {
  const page = await open('light');

  await step('Brush folds in its declared order at three widths, and nothing is cut off', async () => {
    const folds = await page.evaluate(() => fixture.folds);
    assert.equal(folds['brush-wide'], undefined, '900px: everything shows, no fold reported');
    assert.deepEqual(folds['brush-medium'].twins, ['mirror-twin-brush'], '560px: Mirror is shown by its twin');
    assert.deepEqual(folds['brush-medium'].more, [], 'no More options while only twins and homes fold');
    assert.deepEqual(folds['brush-narrow'].more, ['flow', 'smooth']);
    assert.deepEqual(folds['brush-narrow'].homes.map(home => home.id), ['pressure', 'recent']);
    for (const bar of Object.keys(await page.evaluate(() => fixture.bars))) assert.deepEqual(await clipped(page, bar), [], `${bar} shows every control whole`);
    assert.equal(await visible(page, 'brush-narrow', 'size'), true);
    assert.equal(await visible(page, 'brush-narrow', 'flow'), false);
    assert.equal(await page.locator('[data-options-for="brush-narrow"] .ui-optbar-more').isVisible(), true);
    assert.equal(await page.locator('[data-options-for="brush-medium"] .ui-optbar-more').isVisible(), false);
  });

  await step('labels drop before anything folds and keep their accessible names', async () => {
    const narrow = await page.evaluate(() => fixture.folds['edit-joints-narrow']);
    assert.deepEqual(narrow.folded, [], 'the words go before Snapping would fold');
    assert.ok(narrow.dropped.includes('branch'), 'Whole branch shows its glyph first');
    if (narrow.dropped.includes('mode')) assert.ok(narrow.dropped.includes('snap'), '"Drag" goes after the toggles\' words');
    const branch = page.locator('[data-options-for="edit-joints-narrow"] #builder-branch');
    assert.equal(await branch.getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('[data-options-for="edit-joints-narrow"]').getByRole('button', {name: 'Whole branch', exact: true}).count(), 1,
      'the dropped word still names the button');
    const box = await branch.evaluate(element => { const {width, height} = element.getBoundingClientRect(); return {width, height}; });
    assert.equal(box.width, box.height, 'a labelled toggle without its word is a square glyph button');
  });

  await step('the bar refolds when its width changes', async () => {
    await page.evaluate(() => { fixture.bars['brush-wide'].element.closest('.stage-head').style.inlineSize = '400px'; });
    await settle(page);
    assert.deepEqual(await page.evaluate(() => fixture.folds['brush-wide'].more), ['flow', 'smooth']);
    await page.evaluate(() => { fixture.bars['brush-wide'].element.closest('.stage-head').style.inlineSize = '900px'; });
    await settle(page);
    assert.deepEqual(await page.evaluate(() => fixture.folds['brush-wide']), {dropped: [], folded: [], more: [], twins: [], homes: [], forced: []});
    assert.deepEqual(await clipped(page, 'brush-wide'), []);
  });

  await step('an item that grows (fonts, a translated label) is measured again without the owner asking', async () => {
    assert.deepEqual(await page.evaluate(() => fixture.folds['brush-medium'].more), []);
    await page.evaluate(() => fixture.bars['brush-medium'].element.querySelector('[data-option="size"]').style.setProperty('--_vch', '14'));
    await settle(page);
    await settle(page);
    assert.ok((await page.evaluate(() => fixture.folds['brush-medium'].more)).length > 0, 'the wider field pushes an option into More options');
    assert.deepEqual(await clipped(page, 'brush-medium'), []);
    await page.evaluate(() => fixture.bars['brush-medium'].element.querySelector('[data-option="size"]').style.setProperty('--_vch', '3'));
    await settle(page);
    await settle(page);
    assert.deepEqual(await page.evaluate(() => fixture.folds['brush-medium'].more), [], 'and back');
  });

  await step('More options shows the folded controls themselves, then puts them back', async () => {
    const more = page.locator('[data-options-for="brush-narrow"] .ui-optbar-more');
    await more.click();
    const popover = page.locator('.ui-optbar-popover');
    await popover.waitFor();
    assert.equal(await more.getAttribute('aria-expanded'), 'true');
    assert.deepEqual(await popover.locator('input[data-property]').evaluateAll(inputs => inputs.map(input => input.dataset.property)),
      ['brushFlow', 'brushSmooth'], 'the same scrub fields, with their PropertyControls hooks');
    assert.equal(await popover.locator('input').first().evaluate(input => document.activeElement === input), true, 'focus moves into the popover');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.property), 'brushSmooth', 'every moved control is a tab stop');
    await page.keyboard.press('Escape');
    await popover.waitFor({state: 'hidden'});
    assert.equal(await more.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('ui-optbar-more')), true, 'focus returns to More options');
    assert.equal(await visible(page, 'brush-narrow', 'flow'), false, 'back in the bar, still folded');
    assert.equal(await page.locator('[data-options-for="brush-narrow"] [data-option="flow"]').count(), 1);
  });

  await step('a scrub field in More options commits through the header\'s PropertyControls', async () => {
    await page.evaluate(() => { fixture.properties.length = 0; fixture.changes.length = 0; });
    const more = page.locator('[data-options-for="brush-narrow"] .ui-optbar-more');
    const popover = page.locator('.ui-optbar-popover');
    await more.click();
    await popover.waitFor();
    assert.equal(await popover.evaluate(element => element.parentElement === fixture.bars['brush-narrow'].element.closest('.stage-head')), true,
      'the popover mounts in the header PropertyControls watches');
    await popover.locator('[data-property="brushFlow"]').fill('50');
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => fixture.properties), ['commit brushFlow 50']);
    assert.deepEqual(await page.evaluate(() => fixture.changes), [], 'a property field reports through PropertyControls only');
    await more.click();
    await popover.waitFor({state: 'hidden'});

    // Escape first rolls back what was typed, then closes More options.
    await more.click();
    await popover.waitFor();
    assert.equal(await page.evaluate(() => document.activeElement.dataset.property), 'brushFlow');
    await page.keyboard.type('7');
    await page.keyboard.press('Escape');
    assert.equal(await popover.isVisible(), true);
    assert.equal(await popover.locator('[data-property="brushFlow"]').inputValue(), '50', 'the typed 7 is rolled back');
    await page.keyboard.press('Escape');
    await popover.waitFor({state: 'hidden'});
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('ui-optbar-more')), true);
    assert.deepEqual(await page.evaluate(() => fixture.properties), ['commit brushFlow 50']);
  });

  await step('the bar is one tab stop; arrows move along it and a field is entered by typing', async () => {
    await page.evaluate(() => { fixture.properties.length = 0; });
    const bar = page.locator('[data-options-for="brush-wide"]');
    assert.equal(await bar.locator('[tabindex="0"]').count(), 1, 'one control is in the tab order');
    await bar.locator('.ui-optbar-pair').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Swap colors');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.property), 'brushSize');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.property), 'brushOpacity', 'an untouched field passes the arrows on');
    await page.keyboard.type('9');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.property), 'brushOpacity',
      'typing enters the field under PropertyControls (which takes its input events): the arrows move the caret');
    await page.keyboard.press('Escape');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.property), 'brushSize', 'Escape hands the arrows back to the bar');
    assert.deepEqual(await page.evaluate(() => fixture.properties), [], 'and the typed 9 was rolled back, never committed');
    await page.keyboard.press('End');
    assert.match(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), /^Color #F5B400$/, 'End reaches the last control');
  });

  await step('focus rings and field halos are drawn whole, and every bar keeps its one-control row', async () => {
    await page.locator('[data-options-for="edit-joints"] #rig-mode').focus();
    await page.keyboard.press('ArrowRight');
    const ring = await page.evaluate(() => {
      const style = getComputedStyle(document.activeElement);
      return document.activeElement.id === 'builder-branch' && style.outlineStyle !== 'none' ? Number.parseFloat(style.outlineWidth) + Number.parseFloat(style.outlineOffset) : 0;
    });
    assert.ok(ring >= 4, `Whole branch, reached by keyboard, draws its ring ${ring}px outside its box`);
    await page.locator('[data-options-for="brush-wide"] [data-property="brushSize"]').focus();
    await page.evaluate(() => { for (const animation of document.activeElement.closest('.ui-field').getAnimations()) animation.finish(); });   // the halo's transition
    const halo = await page.evaluate(() => Math.max(0, ...getComputedStyle(document.activeElement.closest('.ui-field')).boxShadow.split(/,(?![^(]*\))/)
      .filter(shadow => !shadow.includes('inset')).map(shadow => Number.parseFloat([...shadow.matchAll(/(-?[\d.]+)px/g)][3]?.[1]) || 0)));
    assert.ok(halo >= 3, `a focused field draws a ${halo}px halo`);
    const cut = await page.evaluate(([ring, halo]) => {
      // The rectangle an element's overflow clips its content to (its box, plus overflow-clip-margin under `clip`).
      const clipOf = element => {
        const style = getComputedStyle(element), box = element.getBoundingClientRect();
        if (style.overflowX === 'visible' && style.overflowY === 'visible') return null;
        const margin = style.overflowX === 'clip' && style.overflowY === 'clip' ? Number.parseFloat(style.overflowClipMargin) || 0 : 0;
        return {left: box.left - margin, right: box.right + margin, top: box.top - margin, bottom: box.bottom + margin};
      };
      const problems = [];
      for (const [name, bar] of Object.entries(fixture.bars)) {
        const height = bar.element.getBoundingClientRect().height;
        const row = Number.parseFloat(getComputedStyle(bar.element).getPropertyValue('--control-md'));   // the bar's row is one regular control tall
        if (Math.abs(height - row) > 0.5) problems.push(`${name}: the row is ${height}px tall, not ${row}px`);
        const clips = [bar.element, bar.element.closest('.stage-head-start')].map(clipOf).filter(Boolean);
        const drawn = [...[...bar.element.querySelectorAll('.ui-field')].map(field => [field, halo]),
          ...[...bar.element.querySelectorAll('button, select')].map(control => [control, ring])];
        for (const [control, extent] of drawn) {
          if (!control.getClientRects().length || control.closest('[data-overflowed]')) continue;
          const box = control.getBoundingClientRect();
          if (clips.some(clip => box.left - extent < clip.left - 0.5 || box.right + extent > clip.right + 0.5
            || box.top - extent < clip.top - 0.5 || box.bottom + extent > clip.bottom + 0.5))
            problems.push(`${name}: ${control.getAttribute('aria-label') || control.textContent.trim() || control.className}`);
        }
      }
      return problems;
    }, [ring, halo]);
    assert.deepEqual(cut, []);
  });

  await step('a message over the start slot takes its own line while a tool option holds focus', async () => {
    await page.locator('[data-options-for="brush-wide"] [data-property="brushSize"]').focus();
    await page.keyboard.type('1');
    await page.evaluate(() => {
      const head = fixture.bars['brush-wide'].element.closest('.stage-head');
      const message = Object.assign(document.createElement('div'), {className: 'stage-head-msg', id: 'test-message'});
      message.innerHTML = '<div class="ui-toast" role="status"><span class="ui-toast-text">Saved</span></div>';
      head.append(message);
      head.dataset.msgOver = '';
    });
    await settle(page);
    const where = () => page.evaluate(() => {
      const head = fixture.bars['brush-wide'].element.closest('.stage-head'), message = document.getElementById('test-message');
      return {focused: document.activeElement.dataset.property ?? null, start: getComputedStyle(head.querySelector('.stage-head-start')).visibility,
        ownLine: message.getBoundingClientRect().top >= head.getBoundingClientRect().bottom};
    });
    assert.deepEqual(await where(), {focused: 'brushSize', start: 'visible', ownLine: true}, 'the field keeps its focus and what was typed');
    await page.keyboard.press('Escape');
    await page.evaluate(() => document.activeElement.blur());
    await settle(page);
    assert.deepEqual(await where(), {focused: null, start: 'hidden', ownLine: false}, 'without focus there, the message covers the start slot');
    await page.evaluate(() => {
      delete fixture.bars['brush-wide'].element.closest('.stage-head').dataset.msgOver;
      document.getElementById('test-message').remove();
    });
    assert.deepEqual(await page.evaluate(() => fixture.properties), []);
  });

  await step('controls with a command run through the app\'s delegation; the others report their value', async () => {
    await page.evaluate(() => { fixture.log.length = 0; fixture.changes.length = 0; });
    await page.locator('[data-options-for="edit-joints"] #builder-branch').click();
    await page.locator('[data-options-for="brush-wide"] [data-option-id="mirror-y"]').click();
    await page.locator('[data-options-for="brush-wide"] [data-option-id="mirror-x"]').click();
    await page.locator('[data-options-for="tweener"] [data-value="push"]').click();
    await page.locator('[data-options-for="tweener"] [data-option-step="1"]').click();
    await page.locator('[data-options-for="edit-joints"] #rig-mode').selectOption('branch');
    await page.locator('[data-options-for="brush-wide"] [data-value="#0d99ff"]').click();
    assert.deepEqual(await page.evaluate(() => fixture.log), ['toggle-builder-branch', 'drawing-mirror']);
    assert.deepEqual(await page.evaluate(() => fixture.changes.map(({bar, id, value}) => [bar, id, value])), [
      ['brush-wide', 'mirror-y', true], ['tweener', 'blend', 'push'], ['tweener', 'steps', 4], ['edit-joints', 'mode', 'branch'], ['brush-wide', 'recent', '#0d99ff']]);
    assert.equal(await page.locator('[data-options-for="brush-wide"] [data-option-id="mirror-y"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('[data-options-for="tweener"] [data-value="push"]').getAttribute('aria-checked'), 'true');
  });

  await step('update() writes state in place and keeps focus and contract ids', async () => {
    await page.locator('[data-options-for="edit-joints"] #builder-snap').focus();
    const same = await page.evaluate(() => {
      const bar = fixture.bars['edit-joints'], before = bar.element.querySelector('#builder-snap');
      const descriptors = [
        {id: 'mode', kind: 'select', label: 'Drag', description: 'Rig edit mode', showLabel: true, labelFold: 3, elementId: 'rig-mode', value: 'branch',
          options: [{value: 'joint', label: 'Move joint'}, {value: 'branch', label: 'Rotate branch'}]},
        [{id: 'branch', kind: 'toggle', label: 'Whole branch', showLabel: true, accent: true, icon: 'builder-branch', pressed: false, labelFold: 1,
          elementId: 'builder-branch', command: 'toggle-builder-branch'},
        {id: 'snap', kind: 'toggle', label: 'Snapping', showLabel: true, icon: 'builder-snap', pressed: false, labelFold: 2, fold: 2, home: 'View › Build',
          elementId: 'builder-snap'}],
      ];
      bar.update(descriptors);
      return before === bar.element.querySelector('#builder-snap') && document.activeElement === before;
    });
    assert.equal(same, true);
    assert.equal(await page.locator('[data-options-for="edit-joints"] #builder-snap').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('[data-options-for="edit-joints"] #rig-mode').inputValue(), 'branch');
  });

  await step('switching tools reports the new folds, also while the bar is hidden', async () => {
    const reported = () => page.evaluate(() => fixture.folds['brush-medium'].twins);
    assert.deepEqual(await reported(), ['mirror-twin-brush']);
    await page.evaluate(() => fixture.bars['brush-medium'].update(fixture.descriptors.editJoints));
    await settle(page);
    const [last, current] = await page.evaluate(() => [fixture.folds['brush-medium'], fixture.bars['brush-medium'].state]);
    assert.deepEqual(last, current);
    assert.deepEqual(last.twins, [], 'Edit joints fits: Brush\'s Mirror twin is not left in the inspector');
    await page.evaluate(() => fixture.bars['brush-medium'].update(fixture.descriptors.brush()));
    await settle(page);
    assert.deepEqual(await reported(), ['mirror-twin-brush']);
    // Hidden, the bar cannot measure the new tool; the previous tool's twin still goes.
    await page.evaluate(() => {
      const bar = fixture.bars['brush-medium'];
      bar.element.closest('.stage-head').style.display = 'none';
      bar.update(fixture.descriptors.editJoints);
    });
    await settle(page);
    assert.deepEqual(await reported(), []);
    await page.evaluate(() => {
      const bar = fixture.bars['brush-medium'];
      bar.element.closest('.stage-head').style.display = '';
      bar.update(fixture.descriptors.brush());
    });
    await settle(page);
    assert.deepEqual(await reported(), ['mirror-twin-brush']);
  });

  await step('an update that changes only the fold order folds again', async () => {
    const folded = () => page.evaluate(() => fixture.bars.folds.state.folded);
    await page.evaluate(() => {
      const buttons = order => [Array.from({length: 9}, (_, index) => ({id: `b${index}`, kind: 'button', label: `Button ${index}`, icon: 'plus', fold: order(index)}))];
      fixture.foldOrders = {rising: buttons(index => index + 1), falling: buttons(index => 9 - index)};
      fixture.addBar('folds', fixture.foldOrders.rising, '200px', 'Fold orders');
    });
    await settle(page);
    const before = await folded();
    assert.ok(before.includes('b0') && !before.includes('b8'), `the lowest folds go first: ${before}`);
    await page.evaluate(() => fixture.bars.folds.update(fixture.foldOrders.falling));
    await settle(page);
    const after = await folded();
    assert.ok(after.includes('b8') && !after.includes('b0'), `the new order folds the other end: ${after}`);
    assert.deepEqual(await clipped(page, 'folds'), []);
    await page.evaluate(() => {
      fixture.bars.folds.element.closest('.stage-head').remove();
      fixture.bars.folds.destroy();
      delete fixture.bars.folds;
    });
  });

  await step('quick actions: labelled tiles, Shift variants, pins and one tab stop', async () => {
    const row = page.getByRole('toolbar', {name: 'Figure actions'}).first();
    assert.deepEqual(await row.locator('button').evaluateAll(buttons => buttons.map(button => button.dataset.action)),
      ['mirror', 'layer-front', 'layer-back', 'duplicate', 'delete']);
    assert.deepEqual(await row.locator('button').evaluateAll(buttons => buttons.map(button => button.textContent.trim() || button.getAttribute('aria-label'))),
      ['Flip', 'Front', 'Back', 'Duplicate', 'Delete']);
    assert.equal(await row.locator('[data-action="layer-front"]').getAttribute('data-shift-hint'), 'Shift: one step');
    assert.equal(await row.locator('[data-action="mirror"]').getAttribute('aria-keyshortcuts'), 'Shift+H');
    const tips = await page.evaluate(async () => {
      const {tooltipContent} = await import('/src/ui/ui-tooltip.mjs');
      const {withShiftHint} = await import('/src/ui/quick-actions.mjs');
      const {refreshHotkeyHints} = await import('/src/hotkey-hints.mjs');
      const front = fixture.rows.figure.element.querySelector('[data-action="layer-front"]');
      // The app rewrites data-hotkey-hint in the inspector on every render; the Shift hint lives beside it.
      const part = fixture.rows.part.element;
      refreshHotkeyHints({label: id => ({delete: 'Delete'})[id] ?? ''}, part);
      return [tooltipContent(front, {shortcut: withShiftHint}), tooltipContent(part.querySelector('[data-action="delete-single-segment"]'), {shortcut: withShiftHint})];
    });
    assert.deepEqual(tips, [{label: 'Bring to front', shortcut: 'Shift: one step'}, {label: 'Delete part', shortcut: 'Delete · Shift: the branch'}]);
    await page.evaluate(() => { fixture.log.length = 0; });
    await row.locator('[data-action="layer-front"]').click({modifiers: ['Shift']});
    await row.locator('[data-action="layer-back"]').click();
    assert.deepEqual(await page.evaluate(() => fixture.log), ['layer-up', 'layer-back']);
    await row.locator('[data-action="mirror"]').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.action), 'layer-front');
    assert.equal(await row.locator('[tabindex="0"]').count(), 1);

    const pinned = page.getByRole('toolbar', {name: 'Figure actions'}).nth(1);
    const buttons = await pinned.locator('button').evaluateAll(list => list.map(button => [button.dataset.action, button.classList.contains('ui-quick-word')]));
    assert.deepEqual(buttons.slice(-2), [['reset-pose', true], ['rotate', true]], 'pins last; every quick action is a labelled tile');
    assert.deepEqual(buttons.slice(0, -2).map(([action]) => action), ['mirror', 'layer-front', 'layer-back', 'duplicate', 'delete'].slice(0, buttons.length - 2),
      'the last defaults give up their places (they stay in the menu)');
    const displaced = await page.evaluate(() => fixture.rows.pinned.resolved.displaced);
    assert.ok(displaced.includes('delete') && displaced.length === 7 - buttons.length, `displaced ${displaced}`);
    const joint = page.getByRole('toolbar', {name: 'Joint actions'});
    assert.deepEqual(await joint.locator('button').evaluateAll(buttons => buttons.map(button => button.dataset.action)),
      ['selection-front', 'selection-back', 'mirror']);
    await joint.getByRole('button', {name: 'Front', exact: true}).click();
    await joint.getByRole('button', {name: 'Back', exact: true}).click();
    await joint.getByRole('button', {name: 'Front', exact: true}).click({modifiers: ['Shift']});
    await joint.getByRole('button', {name: 'Back', exact: true}).click({modifiers: ['Shift']});
    assert.deepEqual(await page.evaluate(() => fixture.log.slice(-4)), ['selection-front', 'selection-back', 'selection-up', 'selection-down']);
  });

  await step('the rows never wrap, scroll or cut a button, and refit when the inspector widens', async () => {
    // A labelled tile is a glyph over its word: 52px (quick.css).
    const rows = () => page.locator('.ui-quick').evaluateAll(list => list.map(row => [Math.round(row.getBoundingClientRect().height), row.scrollWidth <= row.clientWidth]));
    for (const row of await rows()) assert.deepEqual(row, [52, true]);
    await page.evaluate(() => { document.getElementById('quick-rows').style.inlineSize = '400px'; });
    await settle(page);
    assert.deepEqual(await page.evaluate(() => fixture.rows.pinned.resolved.displaced), ['delete'], 'with room, only the second pin takes a default\'s place');
    for (const row of await rows()) assert.deepEqual(row, [52, true]);
  });

  await step('quick actions: the frame range row, pins per context and a disabled button\'s reason', async () => {
    const range = page.getByRole('toolbar', {name: 'Frame actions'});
    assert.deepEqual(await range.locator('button').evaluateAll(buttons => buttons.map(button => button.textContent.trim() || button.getAttribute('aria-label'))),
      ['Copy', 'Paste', 'Remove keys', 'Delete']);
    const moved = await page.evaluate(() => {
      const row = fixture.rows.pinned;
      row.update({context: 'joint'});
      const ids = row.resolved.items.map(item => item.id);
      row.update({context: 'figure', pins: ['reset-pose', 'rotate']});
      return ids;
    });
    assert.deepEqual(moved, ['selection-front', 'selection-back', 'mirror'], 'the figure\'s pins stay with the figure');
    const disabled = await page.evaluate(async () => {
      const {createQuickActions} = await import('/src/ui/quick-actions.mjs');
      const registry = {has: () => true, get: id => ({label: id === 'delete' ? 'Delete' : id, enabled: id !== 'delete', reason: id === 'delete' ? 'Nothing is selected' : ''})};
      const row = createQuickActions({context: 'figure', registry});
      document.body.append(row.element);
      const button = row.element.querySelector('[data-action="delete"]');
      const result = [button.disabled, button.dataset.tooltip];
      row.destroy();
      return result;
    });
    assert.deepEqual(disabled, [true, 'Delete (Nothing is selected)']);
  });

  await page.close();
  const dark = await open('dark');
  await step('the dark theme renders the same components without errors', async () => {
    assert.equal(await dark.evaluate(() => document.documentElement.dataset.theme), 'dark');
    for (const bar of Object.keys(await dark.evaluate(() => fixture.bars))) assert.deepEqual(await clipped(dark, bar), [], `${bar} in dark`);
    const pressed = await dark.locator('[data-options-for="brush-wide"] [data-option="pressure"]').evaluate(button => getComputedStyle(button).backgroundColor);
    const quietOff = await dark.locator('[data-options-for="brush-wide"] [data-option-id="mirror-x"]').evaluate(button => getComputedStyle(button).backgroundColor);
    assert.notEqual(pressed, quietOff, 'a quiet toggle that is on is a soft tile');
  });
  await dark.close();

  assert.deepEqual(errors, []);
  console.log('ui-chrome browser test passed');
} finally {
  await browser.close();
}
