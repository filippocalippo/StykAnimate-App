/**
 * The stage chrome (experience.md §4, architecture.md §3.11.8 and §3.12): the
 * stage header holds the location, the tool's options, the one message, the
 * view toggles and zoom, and nothing interactive is left inside #viewport.
 *
 *   - at 1440, 1280, 1024, 800 and 500 wide, in Animate, Draw and Build:
 *     nothing interactive inside #viewport, nothing but the renderer's own
 *     layers over the artboard at fit, the header outside #viewport and above
 *     it, and the view cluster clear of the start's content
 *   - one message at a time, never meeting the view cluster (zoom and Fit at
 *     compact width, where the view toggles step aside), never cut, every
 *     button of it the element at its own centre, at 1440, 1180, 1100, 1024,
 *     960, 900, 801, 640 and 500 wide; one that does not fit takes its own line
 *   - the recovery message's Restore is the element at its centre at 800×600,
 *     640×480 and 500×340, and it names the file (authoring.browser restores)
 *   - a pick mode shows its instruction while it lasts (Join) and a Cancel
 *     that ends it
 *   - the Grid split: the button shows or hides the grid, the chevron opens
 *     Grid and guides; the view toggles say their state
 *   - arrow keys on a focused stage-header button leave the pose unchanged,
 *     and a wheel over the header does not zoom
 *   - a tool's option descriptors (ui/tool-options.mjs) replace the crumb in
 *     the start and run their commands; the crumb returns without them
 *
 * Serve the repository (STYK_PYTHON=py node scripts/serve.mjs --port 47913)
 * and run `node tests/stage-chrome.browser.mjs`; STYK_URL overrides the address.
 */
import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';

const base = process.env.STYK_URL || 'http://127.0.0.1:47913';
const out = 'artifacts/stage-chrome';
await mkdir(out, {recursive: true});
const browser = await chromium.launch({channel: 'chrome', headless: true});
const errors = [];
let page;

const step = async (name, run) => {
  try { await run(); console.log(`ok ${name}`); } catch (error) { console.log(`not ok ${name}`); throw error; }
};
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function open(width, height) {
  await page?.context().close();
  const context = await browser.newContext({viewport: {width, height}, deviceScaleFactor: 1});
  await context.addInitScript(() => localStorage.setItem('stykanimate.editor.settings.v1', JSON.stringify({locale: 'en'})));
  page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.waitForFunction(() => window.styk?.ready);
  await page.evaluate(async () => {
    const {createDemo} = await import('/src/demo.mjs');
    styk.editor.load(createDemo(), 'Stage chrome');
    styk.editor.markSaved();
    styk.editor.select(null);
    styk.fit();
  });
  await settle();
}
async function resize(width, height) {
  await page.setViewportSize({width, height});
  await page.waitForFunction(([width, height]) => innerWidth === width && innerHeight === height, [width, height]);
  await settle();
  await page.evaluate(() => styk.fit());
  await settle();
}
async function workspace(mode) {
  await page.click(`[data-workspace-mode="${mode}"]:not(#builder-done)`);
  await page.waitForFunction(mode => document.querySelector('.workspace').dataset.mode === mode, mode);
  await settle();
}
async function leaveBuild() {
  if (await page.evaluate(() => !styk.builder.active)) return;
  await page.click('#builder-done');
  if (await page.locator('#builder-exit-update').count()) await page.click('#builder-exit-update');
  await page.waitForFunction(() => !styk.builder.active);
  await settle();
}

/** Every visible control and box in #viewport except the renderer's own layers, and anything over the artboard. */
const viewportAudit = () => page.evaluate(() => {
  const viewport = document.getElementById('viewport'), artboard = document.getElementById('artboard').getBoundingClientRect();
  const exempt = element => ['scene', 'overlay', 'artboard'].includes(element.id) || element.closest('.canvas-aids')
    || (['renderer-error', 'canvas-empty'].includes(element.id) && !element.hidden);
  const shown = element => element.checkVisibility({visibilityProperty: true}) && element.getClientRects().length;
  const name = element => element.id ? `#${element.id}` : `${element.localName}.${[...element.classList].join('.')}`;
  const interactive = [...viewport.querySelectorAll('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"]), [role="button"], [role="toolbar"]')]
    .filter(element => shown(element) && !exempt(element)).map(name);
  const over = [...viewport.children].filter(element => shown(element) && !exempt(element)).filter(element => {
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && box.left < artboard.right && box.right > artboard.left && box.top < artboard.bottom && box.bottom > artboard.top;
  }).map(name);
  const head = document.querySelector('.stage-head').getBoundingClientRect(), port = viewport.getBoundingClientRect();
  const start = [...document.querySelectorAll('.stage-head-start > * > *, .stage-head-start .draw-quick-row > *')].filter(shown)
    .map(element => element.getBoundingClientRect()).filter(box => box.width > 0);
  const end = document.querySelector('.stage-head-end').getBoundingClientRect();
  const startRight = Math.max(-Infinity, ...start.map(box => Math.min(box.right, document.querySelector('.stage-head-start').getBoundingClientRect().right)));
  return {interactive, over, headInside: viewport.contains(document.querySelector('.stage-head')), headAbove: head.bottom <= port.top + 0.5,
    clusterClear: !(startRight > end.left), zoom: document.querySelector('#zoom-label').checkVisibility()};
});

/** The shown message: one pill, never cut, clear of what it must not meet, its buttons hit at their centres. */
const messageAudit = () => page.evaluate(() => {
  const pills = [...document.querySelectorAll('#toast .ui-toast')].filter(pill => pill.checkVisibility());
  const head = document.querySelector('.stage-head');
  if (pills.length !== 1) return {count: pills.length};
  const pill = pills[0], box = pill.getBoundingClientRect(), text = pill.querySelector('.ui-toast-text');
  const shown = element => element.checkVisibility({visibilityProperty: true}) && element.getClientRects().length;
  const keep = [...document.querySelectorAll('.stage-head-end button')].filter(shown).map(button => button.getBoundingClientRect());
  const meets = keep.filter(rect => box.left < rect.right && box.right > rect.left && box.top < rect.bottom && box.bottom > rect.top).length;
  const hits = [...pill.querySelectorAll('button')].map(button => {
    const rect = button.getBoundingClientRect(), hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return button === hit || button.contains(hit);
  });
  return {count: 1, meets, hits, cut: text.scrollWidth > text.clientWidth + 1 || box.right > innerWidth || box.left < 0,
    drop: head.hasAttribute('data-msg-drop'), lines: Math.round(text.getBoundingClientRect().height / parseFloat(getComputedStyle(text).lineHeight))};
});

try {
  await open(1440, 900);

  await step('nothing interactive inside #viewport and nothing over the artboard, in every workspace and at every width', async () => {
    for (const [width, height] of [[1440, 900], [1280, 720], [1024, 700], [800, 600], [500, 340]]) {
      await resize(width, height);
      for (const mode of ['animate', 'draw', 'rig']) {
        if (mode === 'rig') await page.evaluate(() => styk.editor.select(1, -1));
        await workspace(mode);
        const audit = await viewportAudit();
        const label = `${mode} ${width}x${height}: ${JSON.stringify(audit)}`;
        assert.deepEqual(audit.interactive, [], label);
        assert.deepEqual(audit.over, [], label);
        assert.equal(audit.headInside, false, label);
        assert.equal(audit.headAbove, true, label);
        assert.equal(audit.clusterClear, true, label);
        assert.equal(audit.zoom, true, label);
        if (mode === 'rig') await leaveBuild();
      }
      await workspace('animate');
      await page.screenshot({path: `${out}/animate-${width}x${height}.png`});
    }
  });

  await step('one message at a time, never cut and never meeting the view cluster; a long one takes its own line', async () => {
    const kinds = {
      toast: () => styk.ui.toasts.show({message: 'Frames 22–28 eased', tone: 'success', action: {label: 'Undo'}, timeout: 60000}),
      error: () => styk.ui.toasts.fail(new Error('Could not open whoosh.wav, it is in use')),
      recovery: () => styk.ui.toasts.show({title: 'Restore unsaved work', message: 'in Kick combo from 12:04?', slot: 'recovery', timeout: 0, dismissible: false,
        actions: [{label: 'Not now'}, {label: 'Restore', variant: 'outline'}]}),
    };
    for (const [width, height] of [[1440, 900], [1180, 800], [1100, 700], [1024, 700], [960, 600], [900, 700], [801, 700], [640, 480], [500, 340]]) {
      await resize(width, height);
      for (const [kind, show] of Object.entries(kinds)) {
        await page.evaluate(show);
        await page.evaluate(() => styk.ui.toasts.show({message: 'A second message waits its turn', timeout: 60000}));
        await settle();
        const audit = await messageAudit();
        const label = `${kind} ${width}x${height}: ${JSON.stringify(audit)}`;
        assert.equal(audit.count, 1, label);
        assert.equal(audit.meets, 0, label);
        assert.equal(audit.cut, false, label);
        assert.ok(audit.hits.every(Boolean), label);
        if (!audit.drop) assert.equal(audit.lines, 1, `${label}: one line in the header`);
        await page.evaluate(() => { styk.ui.toasts.clear(); });
        await settle();
        assert.equal(await page.evaluate(() => ['data-msg-over', 'data-msg-over-view', 'data-msg-drop'].some(name => document.querySelector('.stage-head').hasAttribute(name))), false,
          `${label}: the header's start and view toggles return when it closes`);
      }
    }
    await resize(1440, 900);
  });

  await step('a message that would cover a focused tool option takes its own line, and covers the options once focus leaves', async () => {
    await workspace('draw');
    await page.focus('.stage-head .drawing-quickbar [data-draw-slider="size"]');
    await page.evaluate(() => styk.ui.toasts.show({message: 'Frames 22–28 eased', tone: 'success', action: {label: 'Undo'}, timeout: 60000}));
    await settle();
    const where = () => page.evaluate(() => {
      const head = document.querySelector('.stage-head'), pill = document.querySelector('#toast .ui-toast').getBoundingClientRect();
      return {drop: head.hasAttribute('data-msg-drop'), over: head.hasAttribute('data-msg-over'), below: pill.top >= head.getBoundingClientRect().bottom,
        focused: Boolean(document.activeElement?.closest('.stage-head-start')), start: getComputedStyle(head.querySelector('.stage-head-start')).visibility};
    });
    assert.deepEqual(await where(), {drop: true, over: false, below: true, focused: true, start: 'visible'}, 'the focused option keeps its focus and stays in view');
    await page.evaluate(() => document.activeElement.blur());
    await page.waitForTimeout(50);
    await settle();
    assert.deepEqual(await where(), {drop: false, over: true, below: false, focused: false, start: 'hidden'}, 'without focus there, the message covers the options');
    await page.evaluate(() => styk.ui.toasts.clear());
    await workspace('animate');
  });

  await step('the recovery offer is a message naming the file, its Restore hit at its centre at 800×600, 640×480 and 500×340', async () => {
    for (const [width, height] of [[800, 600], [640, 480], [500, 340]]) {
      await open(width, height);
      await page.evaluate(async () => {
        const {writeBrowserRecovery} = await import('/src/browser-recovery.mjs');
        const blob = await styk.editor.exportNative?.() ?? new Blob([JSON.stringify(styk.editor.report)]);
        await writeBrowserRecovery(blob, 'Recovered walk', new AbortController().signal);
      });
      await page.reload();
      await page.waitForFunction(() => window.styk?.ready);
      await page.locator('#restore-recovery').waitFor();
      await settle();
      const hit = await page.evaluate(() => {
        const button = document.getElementById('restore-recovery'), rect = button.getBoundingClientRect();
        const found = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return {hit: button === found || button.contains(found), inViewport: Boolean(button.closest('#viewport')), text: button.closest('.ui-toast').textContent};
      });
      assert.equal(hit.hit, true, `${width}x${height}: ${JSON.stringify(hit)}`);
      assert.equal(hit.inViewport, false, 'the recovery offer is a message, not a banner over the canvas');
      assert.match(hit.text, /Restore unsaved work in Recovered walk/, 'the message names the file');
      await page.locator('#dismiss-recovery').click();
      await page.locator('#restore-recovery').waitFor({state: 'detached'});
    }
    await open(1440, 900);
  });

  await step('a pick mode shows its instruction while it lasts, and its Cancel ends it', async () => {
    await page.evaluate(() => styk.editor.select(1, -1));
    await settle();
    await page.evaluate(() => styk.actions['join-figure']());
    await page.locator('#toast .ui-toast[data-variant="mode"]').waitFor();
    assert.match(await page.locator('#toast .ui-toast-text').textContent(), /Click the joint to join to/);
    await page.locator('#toast .ui-toast-action', {hasText: 'Cancel'}).click();
    await settle();
    assert.equal(await page.evaluate(() => styk.state.tool), 'select');
    assert.equal(await page.locator('#toast .ui-toast').count(), 0, 'the mode message goes with the mode');
    await page.evaluate(() => styk.actions['join-figure']());
    await page.locator('#toast .ui-toast[data-variant="mode"]').waitFor();
    await page.locator('#viewport').focus();
    await page.keyboard.press('Escape');
    await settle();
    assert.equal(await page.locator('#toast .ui-toast').count(), 0, 'Esc ends the mode and its message');
    await page.evaluate(() => styk.editor.select(null));
  });

  await step('the Grid split toggles the grid and opens its settings; view toggles say their state', async () => {
    const grid = () => page.evaluate(() => styk.state.settings.canvasGrid);
    const before = await grid();
    await page.click('#canvas-guides-button');
    assert.equal(await grid(), !before);
    assert.equal(await page.getAttribute('#canvas-guides-button', 'aria-pressed'), String(!before));
    await page.click('#canvas-guides-button');
    assert.equal(await grid(), before);
    await page.click('#guides-options-button');
    assert.equal(await page.evaluate(() => document.getElementById('canvas-guides-panel').matches(':popover-open')), true);
    const panel = await page.locator('#canvas-guides-panel').boundingBox(), head = await page.locator('.stage-head').boundingBox();
    assert.ok(panel.y >= head.y + head.height - 1, 'Grid and guides opens under the stage header');
    await page.keyboard.press('Escape');
    for (const [selector, pressed] of [['#handles-button', 'showHandles'], ['#paths-button', 'motionPaths']]) {
      const state = await page.evaluate(key => styk.state.settings[key], pressed);
      assert.equal(await page.getAttribute(selector, 'aria-pressed'), String(state), selector);
      await page.click(selector);
      assert.equal(await page.getAttribute(selector, 'aria-pressed'), String(!state), `${selector} after a click`);
      await page.click(selector);
    }
    await page.click('#vfx-preview');
    assert.equal(await page.getAttribute('#vfx-preview', 'aria-pressed'), 'false');
    await page.click('#vfx-preview');
    assert.equal(await page.getAttribute('#vfx-preview', 'aria-pressed'), 'true');
    // Build: Static handles, Highlight part and the construction background (Isolate joint left the header in 4b12926d and the rail in 8200cf0f; it is a menu row now); Animate's Joints and Motion paths step aside.
    await page.evaluate(() => styk.editor.select(1, -1));
    await workspace('rig');
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.stage-head [data-view] button')].filter(button => button.checkVisibility()).map(button => button.getAttribute('aria-label'))),
      ['Grid', 'Grid and guides settings', 'Static handles', 'Highlight part', 'Construction background']);
    const highlight = await page.evaluate(() => styk.state.settings.builderHighlightSegment);
    await page.click('.stage-head [data-action="builder-highlight"]');
    assert.equal(await page.evaluate(() => styk.state.settings.builderHighlightSegment), !highlight);
    assert.equal(await page.getAttribute('.stage-head [data-action="builder-highlight"]', 'aria-pressed'), String(!highlight));
    await page.click('.stage-head [data-action="builder-highlight"]');
    await leaveBuild();
    await workspace('animate');
  });

  await step('arrow keys on a stage-header button leave the pose alone, and a wheel over the header does not zoom', async () => {
    await page.evaluate(() => styk.editor.select(1, 2));
    await settle();
    const pose = () => page.evaluate(() => JSON.stringify(styk.editor.evaluatedFrame));
    const before = await pose(), view = await page.evaluate(() => ({...styk.state.view}));
    await page.focus('#handles-button');
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) await page.keyboard.press(key);
    assert.equal(await pose(), before, 'the pose is unchanged');
    assert.ok(await page.evaluate(() => document.activeElement.closest('.stage-head-end') !== null), 'focus moves inside the view cluster');
    const head = await page.locator('.stage-head').boundingBox();
    await page.mouse.move(head.x + head.width / 2, head.y + head.height / 2);
    await page.mouse.wheel(0, -400);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -400);
    await page.keyboard.up('Control');
    await settle();
    assert.deepEqual(await page.evaluate(() => ({...styk.state.view})), view, 'the view is unchanged');
    await page.evaluate(() => styk.editor.select(null));
  });

  await step('a tool\'s option descriptors replace the crumb, run their commands and give the crumb back', async () => {
    assert.equal(await page.locator('.stage-head .ui-crumb').isVisible(), true);
    await page.evaluate(() => styk.ui.stageHead.setToolOptions([{id: 'grid', kind: 'toggle', command: 'toggle-grid', label: 'Grid', icon: 'grid', showLabel: true}], {tool: 'test', label: 'Test options'}));
    await settle();
    assert.equal(await page.locator('.stage-head .ui-crumb').isVisible(), false, 'the crumb gives way to the options');
    const before = await page.evaluate(() => styk.state.settings.canvasGrid);
    await page.click('.stage-head .ui-optbar [data-option-id="grid"]');
    assert.equal(await page.evaluate(() => styk.state.settings.canvasGrid), !before, 'the option runs its command');
    await page.click('.stage-head .ui-optbar [data-option-id="grid"]');
    await page.evaluate(() => styk.ui.stageHead.setToolOptions([]));
    await settle();
    assert.equal(await page.locator('.stage-head .ui-crumb').isVisible(), true, 'the crumb returns');
    // The crumb: the Scene with its size selects the Scene; the background chip is the scene's colour.
    await page.click('.stage-head [data-crumb="scene"]');
    await settle();
    assert.equal(await page.evaluate(() => styk.state.inspectorContext), 'scene');
    assert.match(await page.locator('#stage-size').textContent(), /^\d+ × \d+$/);
    assert.match(await page.getAttribute('#crumb-background', 'aria-label'), /Background colour #[0-9A-F]{6}/);
  });

  assert.deepEqual(errors, [], 'no page errors');
} finally {
  await browser.close();
}
