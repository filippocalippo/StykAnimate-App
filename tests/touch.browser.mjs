// The touch interface (docs/TOUCH.md) in Chromium with touch emulation: the layouts
// of a phone and a tablet in both orientations, the gestures, the sheets and the
// modifiers, and the desktop interface unchanged at 1440×900.
//
//   node tests/touch.browser.mjs                      serve a fresh build of the site
//   STYK_URL=http://127.0.0.1:47831 node tests/...   test a running app instead
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from './support/playwright.mjs';
import { buildWeb } from '../scripts/build-web.mjs';
import { startWebServer } from '../scripts/serve-web.mjs';

const temp = await mkdtemp(path.join(os.tmpdir(), 'styk-touch-'));
const remote = process.env.STYK_URL;
const site = remote ? { origin: remote, close: async () => {} } : await startWebServer({ root: (await buildWeb({ output: path.join(temp, 'site') })).output });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
const check = (name, condition, detail) => { assert.ok(condition, detail ? `${name}: ${JSON.stringify(detail)}` : name); checks.push(name); console.log('PASS', name); };

/** Opens the editor at `size` with a finger (or a mouse) and the helpers the checks use. */
async function editor(size, { touch = true } = {}) {
  const [width, height] = size.split('x').map(Number);
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: touch, hasTouch: touch });
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (error) => problems.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error' && !/WebGPU/.test(message.text())) problems.push(message.text()); });
  await page.goto(site.origin, { waitUntil: 'load' });
  await page.waitForFunction(() => window.styk?.ready === true, undefined, { timeout: 60000 });
  await page.evaluate(() => { document.querySelector('.styk-privacy [data-decline]')?.click(); for (const d of document.querySelectorAll('dialog[open]')) d.close(); window.styk.toasts?.clear?.(); });
  await page.waitForTimeout(300);
  const cdp = touch ? await context.newCDPSession(page) : null;
  const fingers = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
  const box = (selector) => page.evaluate((selector) => {
    const element = document.querySelector(selector);
    const rect = element?.getBoundingClientRect();
    return rect && rect.width ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height, cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2 } : null;
  }, selector);
  const tap = async (x, y) => {
    if (typeof x === 'string') { const found = await box(x); assert.ok(found, `${x} is on screen`); ({ cx: x, cy: y } = found); }
    await fingers('touchStart', [[x, y]]); await fingers('touchEnd', []); await page.waitForTimeout(150);
  };
  const hold = async (x, y, ms = 750) => { await fingers('touchStart', [[x, y]]); await page.waitForTimeout(ms); await fingers('touchEnd', []); await page.waitForTimeout(200); };
  const drag = async (from, to, { steps = 10, before = 0 } = {}) => {
    await fingers('touchStart', [[from.x, from.y]]);
    if (before) await page.waitForTimeout(before);
    for (let step = 1; step <= steps; step++) { await fingers('touchMove', [[from.x + (to.x - from.x) * step / steps, from.y + (to.y - from.y) * step / steps]]); await page.waitForTimeout(16); }
    await fingers('touchEnd', []); await page.waitForTimeout(200);
  };
  /** Every shown button of the chrome that lies partly outside the window (never allowed). */
  const offscreen = () => page.evaluate(() => [...document.querySelectorAll('.titlebar button, .touch-tabbar button, .stage-head button, .timeline-toolbar button, .shell-rail button, .tl-touch-actions')]
    .filter((b) => b.getClientRects().length && getComputedStyle(b).visibility !== 'hidden')
    // An upright phone's tool bar and the timeline's action bar scroll sideways: buttons past their edge are a swipe
    // away, not cut off (the action bar itself must fit).
    .filter((b) => !b.closest('.workspace[data-rail-orientation="horizontal"] > .shell-rail, .tl-touch-actions > button'))
    .map((b) => ({ name: b.getAttribute('aria-label') || b.textContent.trim(), r: b.getBoundingClientRect() }))
    .filter(({ r, name }) => r.width && (r.left < -1 || r.right > innerWidth + 1 || r.top < -1 || r.bottom > innerHeight + 1) && name)
    .map(({ name }) => name));
  /** The chrome's buttons smaller than `min` on either side. */
  const small = (min, selector) => page.evaluate(({ min, selector }) => [...document.querySelectorAll(selector)]
    .filter((b) => b.getClientRects().length).map((b) => ({ name: b.getAttribute('aria-label') || b.textContent.trim(), r: b.getBoundingClientRect() }))
    .filter(({ r }) => r.width && (r.width < min - 0.5 || r.height < min - 0.5)).map(({ name, r }) => `${name} ${Math.round(r.width)}×${Math.round(r.height)}`), { min, selector });
  const figure = () => page.evaluate(async () => {
    const { worldToScreen } = await import('/src/renderer-geometry.mjs');
    const { editor, state } = window.styk, rect = document.getElementById('overlay').getBoundingClientRect();
    editor.select(editor.frame.objects[0].unique_id, -1);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const g = editor.geometry.objects.get(editor.selectedSlot);
    const at = (p) => { const s = worldToScreen(p, { report: editor.report, frame: editor.frame, view: state.view, cameraEnabled: false }); return { x: rect.left + s.x, y: rect.top + s.y }; };
    return { root: at(g.root), joints: [...g.joints.values()].map(at) };
  });
  return { context, page, problems, box, tap, hold, drag, fingers, offscreen, small, figure, eval: (fn, arg) => page.evaluate(fn, arg) };
}

try {
  // ---- A phone held upright ----
  {
    const t = await editor('390x780');
    const root = await t.eval(() => ({ ...document.documentElement.dataset }));
    check('A coarse pointer turns the touch interface on by itself', root.input === 'touch' && root.touchLayout === 'phone-portrait', root);
    check('Upright, the workspaces and Properties sit in a tab bar under the thumb',
      await t.eval(() => Boolean(document.querySelector('.touch-tabbar > .workspace-switch') && document.querySelector('.touch-tabbar > .shell-sheet-button'))));
    check('Upright, nothing in the chrome is cut off by the window', (await t.offscreen()).length === 0, await t.offscreen());
    check('Upright, the band, the tab bar and the timeline header have finger-sized targets',
      (await t.small(40, '.titlebar button:not(.ui-menubar-item), .touch-tabbar button, .timeline-toolbar > [data-slot] button')).length === 0,
      await t.small(40, '.titlebar button:not(.ui-menubar-item), .touch-tabbar button, .timeline-toolbar > [data-slot] button'));
    check('Upright, the tools lie along the stage’s bottom edge', await t.eval(() => document.querySelector('.workspace').dataset.railOrientation === 'horizontal'));
    const stage = await t.box('#viewport'), timeline = await t.box('#animation-timeline');
    check('Upright, the timeline’s frames stay docked under the stage', timeline && timeline.y >= stage.y + stage.height - 1 && timeline.height > 150);
    check('Upright, the timeline’s actions sit in a finger-sized row of its header',
      await t.eval(() => [...document.querySelectorAll('.tl-touch-action')].some((b) => !b.hidden && b.getClientRects().length)) && (await t.small(44, '.tl-touch-action')).length === 0,
      await t.small(44, '.tl-touch-action'));
    check('Upright, the stage header folds its view toggles into one View menu', Boolean(await t.box('.stage-view-menu')) && !(await t.box('#handles-button')));

    await t.tap('.shell-sheet-button');
    const sheet = await t.box('.shell-sheet:popover-open');
    const tabbar = await t.box('.touch-tabbar');
    check('Properties rises as a bottom sheet above the tab bar', sheet && Math.round(sheet.x) === 0 && Math.abs(sheet.y + sheet.height - tabbar.y) <= 1, { sheet, tabbar });
    const pocket = '.shell-sheet:popover-open :is(.ui-tab, .ui-icon-button, .ui-button), .sheet-label-head button, .sheet-layer button';
    check('Upright, the sheet’s tabs and buttons and the timeline’s layer buttons are finger-sized', (await t.small(44, pocket)).length === 0, await t.small(44, pocket));
    await t.drag({ x: 195, y: sheet.y + 12 }, { x: 195, y: sheet.y - 200 });
    const taller = await t.box('.shell-sheet:popover-open');
    check('Its grip drags it taller, to a resting height', taller && taller.height > sheet.height + 100, { taller, sheet });
    await t.drag({ x: 195, y: taller.y + 12 }, { x: 195, y: taller.y + taller.height - 30 });
    check('A swipe down closes it', !(await t.box('.shell-sheet:popover-open')));

    await t.tap('.shell-mark');
    check('A menu opens as a sheet from the bottom edge', await t.eval(() => document.querySelector('.ui-menu:popover-open')?.dataset.present === 'sheet'));
    const file = await t.eval(() => { const b = [...document.querySelectorAll('.ui-menu:popover-open .ui-menu-item')].find((item) => item.textContent.trim().startsWith('File'))?.getBoundingClientRect(); return b && { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
    await t.tap(file.x, file.y);
    check('A submenu leads back with a Back row', await t.eval(() => Boolean(document.querySelector('.ui-menu:popover-open .ui-menu-back'))));
    await t.page.keyboard.press('Escape');
    await t.page.keyboard.press('Escape');
    check('No console or page errors upright', t.problems.length === 0, t.problems);
    await t.context.close();
  }

  // ---- A phone on its side: gestures, modifiers, the timeline ----
  {
    const t = await editor('844x390');
    check('On its side, the band is a wing down the right edge', await t.eval(() => { const b = document.querySelector('.titlebar').getBoundingClientRect(); return b.height > b.width && b.right >= innerWidth - 1; }));
    check('On its side, nothing in the chrome is cut off by the window', (await t.offscreen()).length === 0, await t.offscreen());
    await t.tap('.shell-mark');
    const menu = await t.box('.ui-menu:popover-open'), mark = await t.box('.shell-mark');
    check('Menus from the wing open beside it, toward the stage', menu && menu.x + menu.width <= mark.x && menu.y < 120, { menu, mark });
    await t.page.keyboard.press('Escape');

    const undo = await t.box('[data-action="undo"]');
    await t.fingers('touchStart', [[undo.cx, undo.cy]]);
    await t.page.waitForTimeout(750);
    const tip = await t.eval(() => document.querySelector('#ui-tooltip:popover-open .ui-tooltip-label')?.textContent);
    await t.fingers('touchEnd', []);
    await t.page.waitForTimeout(200);
    check('Holding a button shows its name, and lifting the finger does not press it', tip === 'Undo' && !(await t.eval(() => window.styk.editor.canRedo)), tip);

    let { joints } = await t.figure();
    const hand = joints.at(-1);
    await t.drag(hand, { x: hand.x + 30, y: hand.y - 20 }, { steps: 8 });
    check('One finger poses a joint', await t.eval(() => window.styk.editor.canUndo));
    const spare = { x: hand.x - 160, y: hand.y };
    await t.fingers('touchStart', [[spare.x, spare.y], [spare.x + 60, spare.y]]); await t.page.waitForTimeout(60); await t.fingers('touchEnd', []); await t.page.waitForTimeout(300);
    check('A two-finger tap undoes', await t.eval(() => !window.styk.editor.canUndo && window.styk.editor.canRedo));
    await t.fingers('touchStart', [[spare.x, spare.y], [spare.x + 60, spare.y], [spare.x + 30, spare.y + 50]]); await t.page.waitForTimeout(60); await t.fingers('touchEnd', []); await t.page.waitForTimeout(300);
    check('A three-finger tap redoes', await t.eval(() => window.styk.editor.canUndo));

    await t.tap('.touch-modifiers-toggle');
    await t.tap('.touch-modifier[data-modifier="bend"]');
    check('The modifiers offer Bend, and a tap latches it', (await t.eval(() => window.styk.touchModifiers.active)).includes('bend'));
    ({ joints } = await t.figure());
    const elbow = joints[Math.floor(joints.length / 2)];
    await t.fingers('touchStart', [[elbow.x, elbow.y]]);
    for (let step = 1; step <= 8; step++) { await t.fingers('touchMove', [[elbow.x + step * 5, elbow.y + step * 2]]); await t.page.waitForTimeout(16); }
    const kind = await t.eval(() => window.styk.state.drag?.kind);
    await t.fingers('touchEnd', []);
    await t.page.waitForTimeout(200);
    check('With Bend on, a finger bends the joint (the right button’s drag)', kind === 'bend', kind);
    await t.tap('.touch-modifier[data-modifier="bend"]');

    ({ joints } = await t.figure());
    await t.hold(joints[0].x, joints[0].y, 800);
    check('Holding still on a figure opens its menu', await t.eval(() => [...document.querySelectorAll('.ui-menu:popover-open .ui-menu-item')].some((item) => /Copy/.test(item.textContent))));
    await t.page.keyboard.press('Escape');

    // The timeline on its side: docked under the stage, a finger-tall row under a playhead fixed at its middle.
    const docked = await t.eval(() => window.styk.shell.presentation('timeline'));
    const strip = await t.box('#animation-timeline'), view = await t.box('#viewport');
    check('On its side, the timeline stays docked under the stage', docked === 'docked' && strip.y >= view.y + view.height - 1 && strip.height >= 120, { docked, strip });
    await t.eval(async () => { for (let i = 0; i < 6; i++) await window.styk.timeline.addFrameFromHeader(); });
    await t.page.waitForTimeout(500);
    const state = () => t.eval(() => {
      const x = window.styk.timeline, e = window.styk.editor;
      return { tick: Math.round(e.tick), center: x.tickAtCenter(), start: x.start, end: x.end, range: Boolean(x.touchRange), px: x.pxPerTick,
        keys: e.layerFrameKeys(x.selectedTrackId).map((k) => k.tick).join() };
    });
    const row = await t.eval(() => { const x = window.styk.timeline, b = x.scroll.getBoundingClientRect(), i = x.tracks.findIndex((r) => r.id === x.selectedTrackId);
      return { x: b.left + b.width / 2, y: b.top + x.rowY(i) + x.rowSize(i) / 2, size: x.rowSize(i) }; });
    const action = (id) => t.eval((id) => { const b = document.querySelector(`.tl-touch-action[data-touch-action="${id}"]`); const r = b?.getBoundingClientRect();
      return r && !b.hidden && r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height } : null; }, id);
    const press = async (id) => { const b = await action(id); assert.ok(b, `${id} is shown`); await t.tap(b.x, b.y); await t.page.waitForTimeout(250); };
    let now = await state();
    check('Its rows are finger-tall and the current frame sits under the playhead', row.size >= 44 && now.center === now.tick, { row, now });
    const shown = await t.eval(() => [...document.querySelectorAll('.tl-touch-action')].filter((b) => !b.hidden && b.getClientRects().length).map((b) => b.dataset.touchAction));
    check('The action bar offers Key, Shorter, Longer and Select', ['key', 'shorter', 'longer', 'select'].every((id) => shown.includes(id)), shown);
    const reach = await t.eval(() => { const bar = document.querySelector('.tl-touch-actions').getBoundingClientRect(), select = document.querySelector('.tl-touch-action[data-touch-action="select"]').getBoundingClientRect();
      return { bar: [Math.round(bar.left), Math.round(bar.right)], select: [Math.round(select.left), Math.round(select.right)], playbackRange: document.querySelector('#playback-range-button')?.getClientRects().length ?? 0 }; });
    check('Playback range leaves the header to the action bar, so Select can be tapped without a swipe', reach.playbackRange === 0 && reach.select[0] >= reach.bar[0] && (reach.select[0] + reach.select[1]) / 2 < reach.bar[1] - 12, reach);
    check('The action bar’s buttons are finger-sized', (await t.small(44, '.tl-touch-action')).length === 0, await t.small(44, '.tl-touch-action'));
    // A slow swipe right slides time back under the playhead: 3 frames' width, 3 frames earlier.
    const from = now.tick;
    await t.drag({ x: row.x, y: row.y }, { x: row.x + now.px * 3, y: row.y }, { steps: 15 });
    await t.page.waitForTimeout(400);
    now = await state();
    check('A sideways swipe scrubs: the frame under the playhead becomes the current one', now.tick === from - 3 && now.center === now.tick && now.start === now.tick && now.end === now.tick, { from, now });
    const keys = now.keys, keyed = (list) => list.split(',').includes(String(now.tick));
    await press('longer');
    const longer = await state();
    check('Longer holds the frame one frame more', longer.keys !== keys && keyed(longer.keys) === keyed(keys), { keys, longer });
    await press('shorter');
    check('Shorter takes it back', (await state()).keys === keys);
    await press('key');
    const toggled = await state();
    check('Key adds or removes the key at the playhead', keyed(toggled.keys) !== keyed(keys) && toggled.tick === now.tick, { keys, toggled });
    await press('key');
    check('Key again puts it back', (await state()).keys === keys);
    // Select: the playhead's frame is one end of a range, and scrubbing moves the other.
    await press('select');
    await t.drag({ x: row.x, y: row.y }, { x: row.x + now.px * 2, y: row.y }, { steps: 12 });
    await t.page.waitForTimeout(400);
    const range = await state();
    check('Select, then a swipe, stretches a range of frames', range.range && range.end - range.start === 2, range);
    check('A range shows Earlier, Later and Done', Boolean(await action('left') && await action('right') && await action('done')));
    await press('done');
    check('Done leaves the range', !(await state()).range);
    // Two fingers zoom around the playhead.
    const zoom = (await state()).px;
    await t.fingers('touchStart', [[row.x - 30, row.y], [row.x + 30, row.y]]);
    for (let i = 1; i <= 8; i++) { await t.fingers('touchMove', [[row.x - 30 - i * 6, row.y], [row.x + 30 + i * 6, row.y]]); await t.page.waitForTimeout(16); }
    await t.fingers('touchEnd', []); await t.page.waitForTimeout(400);
    check('A pinch zooms the timeline', (await state()).px > zoom * 1.3, { zoom, after: await state() });
    await t.hold(row.x, row.y, 800);
    check('Holding a frame opens its menu', await t.eval(() => Boolean(document.querySelector('.ui-menu:popover-open'))));
    await t.page.keyboard.press('Escape');
    check('No console or page errors on its side', t.problems.length === 0, t.problems);
    await t.context.close();
  }

  // ---- Draw with a finger ----
  {
    const t = await editor('844x390');
    await t.tap('.workspace-switch [data-workspace-mode="draw"]');
    await t.page.waitForTimeout(1200);
    const stage = await t.box('#viewport');
    const view = await t.eval(() => ({ ...window.styk.state.view }));
    await t.drag({ x: stage.x + stage.width * 0.55, y: stage.y + stage.height * 0.4 }, { x: stage.x + stage.width * 0.7, y: stage.y + stage.height * 0.6 }, { steps: 12 });
    await t.page.waitForTimeout(800);
    check('In Draw a finger draws a stroke (until a pen is used)', await t.eval((view) => window.styk.editor.canUndo && window.styk.state.view.x === view.x, view));
    check('Draw offers its own modifiers', (await t.eval(() => [...document.querySelectorAll('.touch-modifier')].map((b) => b.dataset.modifier))).join() === 'line,pick,size');
    await t.context.close();
  }

  // ---- Every workspace in every layout keeps its chrome on screen ----
  for (const size of ['390x780', '844x390', '360x640', '820x1180']) {
    const t = await editor(size);
    for (const mode of ['draw', 'rig', 'animate']) {
      await t.tap(`.workspace-switch [data-workspace-mode="${mode}"]`);
      await t.page.waitForTimeout(900);
      check(`${size} in ${mode}: nothing in the chrome is cut off`, (await t.offscreen()).length === 0, await t.offscreen());
    }
    check(`${size}: no console or page errors across the workspaces`, t.problems.length === 0, t.problems);
    await t.context.close();
  }

  // ---- Tablets ----
  for (const size of ['1180x820', '820x1180']) {
    const t = await editor(size);
    const root = await t.eval(() => ({ ...document.documentElement.dataset }));
    check(`A ${size} tablet is laid out as a tablet`, root.form === 'tablet', root);
    check(`On a ${size} tablet nothing in the chrome is cut off`, (await t.offscreen()).length === 0, await t.offscreen());
    const docked = await t.eval(() => window.styk.shell.presentation('properties'));
    check(`On a ${size} tablet the inspector ${size === '1180x820' ? 'stays docked' : 'opens as a sheet'}`, docked === (size === '1180x820' ? 'docked' : 'sheet'), docked);
    check(`On a ${size} tablet targets are at least 40px`, (await t.small(40, '.titlebar button:not(.ui-menubar-item), .shell-rail .tool')).length === 0,
      await t.small(40, '.titlebar button:not(.ui-menubar-item), .shell-rail .tool'));
    await t.context.close();
  }

  // ---- The desktop interface is unchanged ----
  {
    const t = await editor('1440x900', { touch: false });
    const root = await t.eval(() => ({ ...document.documentElement.dataset }));
    check('A mouse keeps the desktop interface', root.input === 'pointer' && !root.touchLayout, root);
    check('The desktop has no tab bar, no modifier buttons and its project tabs', await t.eval(() => !document.querySelector('.touch-tabbar')
      && document.querySelector('.touch-modifiers').hidden && document.querySelector('.project-tab[aria-selected="true"]').getClientRects().length > 0));
    check('The desktop band keeps its words and its height', await t.eval(() => document.querySelector('.titlebar').getBoundingClientRect().height <= 53
      && document.querySelector('.band-export .band-label').getClientRects().length > 0));
    check('The desktop inspector is docked', await t.eval(() => window.styk.shell.presentation('properties') === 'docked'));
    await t.context.close();
  }

  // ---- ?ui= overrides the setting for one page load ----
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto(`${site.origin}/?ui=touch`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.styk?.ready === true, undefined, { timeout: 60000 });
    check('?ui=touch turns the touch interface on with a mouse', await page.evaluate(() => document.documentElement.dataset.input === 'touch'));
    await context.close();
  }

  console.log(`\n${checks.length} checks passed`);
} finally {
  await browser.close();
  await site.close();
  await rm(temp, { recursive: true, force: true });
}
