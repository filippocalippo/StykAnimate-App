/**
 * Browser test of the overlay kit (src/ui/): first on
 * tests/fixtures/ui-overlays.html, then wired into the app (app.mjs: the
 * menubar and every #menu menu, messages, the hotkey gate).
 * Serve the repository (node scripts/serve.mjs --port 47832) and run
 * `node tests/overlays.browser.mjs`; STYK_URL overrides the address.
 */
import {chromium} from './support/playwright.mjs';
import {openAppMenu, closeAppMenus} from './support/app-menu.mjs';
import assert from 'node:assert/strict';

const base = process.env.STYK_URL || 'http://127.0.0.1:47832';
const url = `${base}/tests/fixtures/ui-overlays.html`;
const browser = await chromium.launch({channel: 'chrome', headless: true});
const page = await browser.newPage({viewport: {width: 1280, height: 720}});
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
page.setDefaultTimeout(5000);

const log = () => page.evaluate(() => [...fixture.log]);
const clearLog = () => page.evaluate(() => { fixture.log.length = 0; });
const activeId = () => page.evaluate(() => document.activeElement?.id || document.activeElement?.localName);
const settle = (ms = 60) => page.waitForTimeout(ms);
const hotkeysReachEditor = async () => {
  await clearLog();
  await page.evaluate(() => document.getElementById('fixture-stage').focus());
  await page.keyboard.press('h');
  return (await log()).includes('hotkey:tool-hand');
};
const step = async (name, run) => {
  try { await run(); console.log(`ok ${name}`); } catch (error) { console.log(`not ok ${name}`); throw error; }
};

try {
  await page.goto(url);
  await page.waitForFunction(() => window.fixture?.ready);

  await step('an open menu takes every key; Escape returns focus to its button', async () => {
    await page.click('[data-app-menu=file]');
    assert.equal(await page.evaluate(() => fixture.overlays.blocksHotkeys()), true);
    await clearLog();
    await page.keyboard.press('h');
    assert.ok(!(await log()).some(entry => entry.startsWith('hotkey')), 'H does not pick the Pan tool behind the File menu');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.appMenu), 'file');
    assert.equal(await page.locator('[data-app-menu=file]').getAttribute('aria-expanded'), 'false');
    assert.equal(await hotkeysReachEditor(), true);
  });

  await step('menu items are named by their label; shortcuts are aria-keyshortcuts; group labels name a group', async () => {
    await page.click('[data-app-menu=file]');
    const save = page.getByRole('menuitem', {name: 'Save', exact: true});
    assert.equal(await save.getAttribute('aria-keyshortcuts'), 'Control+S');
    assert.equal(await save.locator('kbd').textContent(), 'Ctrl+S');
    await page.keyboard.press('Escape');
    await page.click('[data-app-menu=view]');
    const canvas = page.getByRole('group', {name: 'Canvas'});
    assert.equal(await canvas.getByRole('menuitemcheckbox', {name: 'Joints', exact: true}).getAttribute('aria-checked'), 'true');
    await page.keyboard.press('Escape');
  });

  await step('typeahead finds a row; Right opens a submenu on its first row; Left and Escape close only the submenu', async () => {
    const focused = () => page.evaluate(() => {
      const row = document.activeElement;
      return {label: row.querySelector(':scope > span')?.textContent ?? null, menu: row.closest('.ui-menu')?.getAttribute('aria-label') ?? null,
        expanded: row.getAttribute('aria-expanded')};
    });
    await page.click('[data-app-menu=edit]');
    await page.keyboard.press('p');
    assert.equal((await focused()).label, 'Paste');
    await page.keyboard.press('p');   // the same letter again cycles to the next row it starts
    assert.deepEqual(await focused(), {label: 'Paste special', menu: 'Edit', expanded: 'false'});
    await page.keyboard.press('ArrowRight');
    const inside = await focused();
    assert.equal(inside.menu, 'Paste special', 'focus moves to the submenu');
    assert.ok(inside.label, 'on its first row');
    await page.keyboard.press('ArrowLeft');
    assert.deepEqual(await focused(), {label: 'Paste special', menu: 'Edit', expanded: 'false'});
    await page.keyboard.press('Enter');
    assert.equal((await focused()).menu, 'Paste special', 'Enter on a submenu row opens it');
    await page.keyboard.press('Escape');
    assert.deepEqual(await focused(), {label: 'Paste special', menu: 'Edit', expanded: 'false'}, 'Escape closes only the submenu');
    assert.equal(await page.locator('[data-app-menu=edit]').getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.appMenu), 'edit');
  });

  await step('the #menu host gets back its own class and name after each menu', async () => {
    const state = await page.evaluate(async () => {
      const {openMenu} = await import('/src/ui/ui-menu.mjs');
      const host = document.getElementById('menu'), anchor = document.getElementById('open-menu-host');
      const timeline = openMenu({host, anchor, className: 'sheet-menu', label: 'Timeline', items: [{label: 'Insert key', run() {}}], overlays: fixture.overlays});
      const during = [host.className, host.getAttribute('aria-label'), anchor.getAttribute('aria-expanded'), anchor.getAttribute('aria-controls')];
      const plain = openMenu({host, anchor, items: [{label: 'Paste', run() {}}], overlays: fixture.overlays});
      const next = [host.className, host.getAttribute('aria-label'), timeline.isOpen];
      plain.close();
      return {during, next, after: [host.className, host.getAttribute('aria-label'), host.hidden, host.hasAttribute('data-side'), anchor.getAttribute('aria-expanded')]};
    });
    assert.deepEqual(state.during, ['menu ui-menu sheet-menu', 'Timeline', 'true', 'menu']);
    assert.deepEqual(state.next, ['menu ui-menu', null, false], 'no timeline class or name leaks into the next menu');
    assert.deepEqual(state.after, ['menu', null, true, false, 'false']);
  });

  await step('a context menu stays inside a 500 × 340 window, below the band', async () => {
    await page.setViewportSize({width: 500, height: 340});
    const box = await page.locator('#context-area').boundingBox();
    await page.mouse.click(Math.min(490, box.x + box.width - 12), Math.min(330, box.y + box.height - 12), {button: 'right'});
    const rect = await page.evaluate(() => ({...document.getElementById('menu').getBoundingClientRect().toJSON(),
      band: document.querySelector('.fixture-band').getBoundingClientRect().bottom}));
    assert.ok(rect.top >= rect.band + 6 - 0.5 && rect.bottom <= 340 && rect.left >= 0 && rect.right <= 500, JSON.stringify(rect));
    await page.keyboard.press('Escape');
    await page.setViewportSize({width: 1280, height: 720});
  });

  await step('closing a dialog closes the menu and manual popover inside it, and the hotkeys come back', async () => {
    for (const close of ['code', 'close-button']) {
      await page.click('#open-modal');
      await page.click('#modal-popover-button');
      await page.click('#modal-menu-button');
      const open = await page.evaluate(() => fixture.overlays.list().map(handle => handle.kind));
      assert.deepEqual(open, ['dialog', 'popover', 'menu'], `${close}: a dialog with a popover and a menu inside`);
      if (close === 'code') await page.evaluate(() => fixture.modal.close('done'));
      else {
        await page.keyboard.press('Escape');   // the menu first
        await page.click('dialog .ui-dialog-close');
      }
      await settle();
      assert.deepEqual(await page.evaluate(() => [fixture.overlays.list().length, fixture.overlays.blocksHotkeys()]), [0, false], close);
      assert.equal(await hotkeysReachEditor(), true, `${close}: H reaches the hotkeys`);
    }
  });

  await step('focus returns to the popover anchor after a dialog opened from inside the popover', async () => {
    await clearLog();
    await page.click('#open-popover');
    await page.click('#popover-rename');
    assert.equal(await page.evaluate(() => document.activeElement.closest('dialog')?.open), true);
    await page.keyboard.press('Escape');
    await settle();
    assert.equal(await activeId(), 'open-popover', 'not the hidden Rename button, and not the body');
    assert.deepEqual(await log(), ['popover-prompt:null']);
  });

  await step('a tooltip after one at the right edge is centred 6px above its button', async () => {
    await page.hover('#edge-tip');
    await page.waitForTimeout(700);
    assert.equal(await page.evaluate(() => document.getElementById('ui-tooltip').matches(':popover-open')), true);
    await page.hover('[data-command=undo]');
    await settle(120);
    const tip = await page.evaluate(() => {
      const element = document.getElementById('ui-tooltip'), button = document.querySelector('[data-command=undo]');
      const box = element.getBoundingClientRect(), anchor = button.getBoundingClientRect();
      const [label, dot, key] = [...element.children].map(child => child.getBoundingClientRect());
      return {text: element.textContent, dx: box.left + box.width / 2 - (anchor.left + anchor.width / 2), gap: anchor.top - box.bottom,
        spaced: dot.left - label.right > 2 && key.left - dot.right > 2, described: button.getAttribute('aria-describedby')};
    });
    assert.ok(Math.abs(tip.dx) <= 1, `centred (${tip.dx})`);
    assert.ok(Math.abs(tip.gap - 6) <= 1, `6px above (${tip.gap})`);
    assert.equal(tip.text, 'Undo·Ctrl+Z');
    assert.equal(tip.spaced, true, '"Undo · Ctrl+Z": the dot is spaced on both sides');
    assert.equal(tip.described, 'ui-tooltip');
    const restored = await page.evaluate(() => {
      const button = document.querySelector('[data-command=redo]');
      button.setAttribute('aria-describedby', 'redo-help');
      fixture.tooltips.show(button);
      fixture.tooltips.show(button);   // hovered, then focused
      const shown = button.getAttribute('aria-describedby');
      fixture.tooltips.hide();
      return [shown, button.getAttribute('aria-describedby')];
    });
    assert.deepEqual(restored, ['redo-help ui-tooltip', 'redo-help']);
    await page.mouse.move(5, 700);
  });

  await step('the palette is a modal dialog: Escape and a press outside close it', async () => {
    await page.evaluate(() => document.getElementById('fixture-stage').focus());
    await page.keyboard.press('Control+p');
    assert.deepEqual(await page.evaluate(() => [fixture.palette.element.matches(':modal'), document.activeElement.getAttribute('role')]), [true, 'combobox']);
    await clearLog();
    await page.keyboard.type('12');
    await page.keyboard.press('Enter');
    assert.deepEqual(await log(), ['frame:12']);
    await page.keyboard.press('Control+p');
    await page.keyboard.press('Escape');
    assert.deepEqual(await page.evaluate(() => [fixture.palette.isOpen, document.activeElement.id]), [false, 'fixture-stage']);
    await page.keyboard.press('Control+p');
    await page.mouse.click(20, 700);
    await settle();
    assert.equal(await page.evaluate(() => fixture.palette.isOpen), false);
  });

  await step('messages are announced once from a live region, inside the modal when one is open', async () => {
    await page.click('#toast-error');
    await settle(150);
    const outside = await page.evaluate(() => ({
      roles: [...document.querySelectorAll('#toast .ui-toast')].map(node => node.getAttribute('role')),
      live: document.getElementById('toast').getAttribute('aria-live'),
      said: [...document.querySelectorAll('body > .ui-toast-live')].map(region => region.textContent),
    }));
    assert.deepEqual(outside, {roles: [null], live: null, said: ['', 'Could not open whoosh.wav, it is in use']});
    await page.evaluate(() => fixture.toasts.clear());
    await page.click('#toast-over-modal');
    await settle(150);
    assert.equal(await page.evaluate(() => document.querySelector('dialog.ui-dialog[open] > .ui-toast-live[aria-live=assertive]')?.textContent),
      'The encoder stopped', 'under a modal the rest of the page is inert: the dialog announces it');
    await page.keyboard.press('Escape');
    await page.evaluate(() => fixture.toasts.clear());
  });

  await step('clear({tones}) keeps other messages; task text survives being displaced; aborted signals end tasks', async () => {
    const state = await page.evaluate(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const {toasts} = fixture;
      toasts.show({message: 'Motion paths on'});
      toasts.clear({tones: ['info']});
      const cleared = document.getElementById('toast').hidden;
      const task = toasts.task({title: 'Copying 3 figures', delay: 0});
      await wait(30);
      const error = toasts.show({message: 'Disk full', tone: 'error'});
      task.update({title: 'Copying 2 figures'});
      error.dismiss();
      const text = document.querySelector('#toast .ui-toast-text')?.textContent;
      task.done();
      const aborted = new AbortController();
      aborted.abort();
      toasts.task({title: 'Never shown', delay: 0, signal: aborted.signal});
      await wait(30);
      return {cleared, text, never: document.getElementById('toast').textContent.includes('Never shown')};
    });
    assert.deepEqual(state, {cleared: true, text: 'Copying 2 figures', never: false});
  });

  await step('the #dialog compatibility instance: form, focus rule, Enter runs the primary, joins the stack', async () => {
    const state = await page.evaluate(async () => {
      const {showLegacyDialog} = await import('/src/ui/ui-dialog.mjs');
      const dialog = document.createElement('dialog'), content = document.createElement('div');
      dialog.id = 'dialog';
      content.id = 'dialog-content';
      dialog.append(content);
      document.body.append(dialog);
      showLegacyDialog('Rename', '<label>Name <input id="legacy-name" value="Bubble"></label><button class="primary">Rename</button><button data-action="undo">Undo</button>',
        {dialog, overlays: fixture.overlays, pointer: false});
      content.querySelector('.primary').addEventListener('click', () => fixture.log.push('legacy-primary'));
      return {focused: document.activeElement.id, close: content.querySelector('[data-action=close-dialog]').getAttribute('aria-label'),
        types: [...content.querySelectorAll('.dialog-body button')].map(button => button.type), stack: fixture.overlays.list().map(handle => handle.kind)};
    });
    assert.deepEqual(state, {focused: 'legacy-name', close: 'Close dialog', types: ['button', 'button'], stack: ['dialog']});
    await clearLog();
    await page.keyboard.press('Enter');
    await page.click('#dialog [data-action=undo]');
    assert.deepEqual(await log(), ['legacy-primary', 'undo'], 'Enter runs the primary; body buttons keep their data-action and never submit');
    assert.equal(await page.evaluate(() => document.getElementById('dialog').open), true);
    await page.evaluate(() => document.getElementById('dialog').close());
    await settle();
    assert.deepEqual(await page.evaluate(() => [fixture.overlays.list().length, fixture.overlays.blocksHotkeys()]), [0, false]);
    await page.evaluate(() => document.getElementById('dialog').remove());
  });

  await step('toolbar overflow leaves `hidden` to the owners and places controls they show or add', async () => {
    await page.setViewportSize({width: 700, height: 600});
    await settle(200);
    const overflowed = await page.evaluate(() => [...document.querySelectorAll('#toolbar [data-overflowed]')].map(button => button.dataset.action));
    assert.ok(overflowed.length > 0 && !overflowed.includes('undo'), JSON.stringify(overflowed));
    const owned = overflowed[0];
    await page.evaluate(action => { document.querySelector(`#toolbar [data-action="${action}"]`).hidden = true; }, owned);
    await page.setViewportSize({width: 1280, height: 720});
    await settle(200);
    const wide = await page.evaluate(action => ({hidden: document.querySelector(`#toolbar [data-action="${action}"]`).hidden,
      overflowed: document.querySelectorAll('#toolbar [data-overflowed]').length, more: document.getElementById('toolbar-more').hidden}), owned);
    assert.deepEqual(wide, {hidden: true, overflowed: 0, more: true}, 'a control its owner hid stays hidden when the toolbar widens');
    await page.evaluate(action => {
      const toolbar = document.getElementById('toolbar');
      toolbar.querySelector(`[data-action="${action}"]`).hidden = false;
      for (const label of ['Insert blank key', 'Insert copied key', 'Extend key', 'Delete frames']) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.action = 'copy';
        button.className = 'added';
        button.textContent = label;
        toolbar.insertBefore(button, document.getElementById('toolbar-more'));
      }
    }, owned);
    await settle(200);
    const added = await page.evaluate(() => {
      const toolbar = document.getElementById('toolbar');
      return {fits: toolbar.scrollWidth <= toolbar.clientWidth + 1, more: !document.getElementById('toolbar-more').hidden};
    });
    assert.deepEqual(added, {fits: true, more: true}, 'controls added at the same width go to More instead of being clipped');
    await page.evaluate(() => { for (const button of document.querySelectorAll('#toolbar .added')) button.remove(); });
  });

  // ---------------------------------------------------------------------------
  // The app: the same kit wired into app.mjs.
  await page.setViewportSize({width: 1440, height: 900});
  await page.goto(`${base}/`);
  await page.waitForFunction(() => window.styk?.ready, null, {timeout: 60000});
  const menuOpen = () => page.evaluate(() => !document.getElementById('menu').hidden && document.getElementById('menu').matches(':popover-open'));
  const focusedLabel = () => page.evaluate(() => document.activeElement?.querySelector?.(':scope > span')?.textContent ?? null);
  const tool = () => page.evaluate(() => styk.state.tool);

  // The application menus are submenus of the mark's menu (the band keeps its room for the open projects).
  await step('app: letters typed into the open File menu never reach the tool hotkeys; typeahead, Left and Right, Escape', async () => {
    const before = await tool();
    await page.click('.titlebar .brand');
    await page.locator('#menu').getByRole('menuitem', {name: 'File', exact: true}).focus();
    await page.keyboard.press('ArrowRight');   // opens File on its first row
    assert.equal(await menuOpen(), true, 'the mark\'s menu renders into #menu');
    assert.equal(await page.evaluate(() => styk.ui.overlays.blocksHotkeys()), true);
    await page.keyboard.press('h');
    assert.equal(await tool(), before, 'H does not pick the Pan tool behind the File menu');
    await page.waitForTimeout(750);   // a new typeahead query
    await page.keyboard.press('s');
    assert.equal(await focusedLabel(), 'Save');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await focusedLabel(), 'File', 'Left closes the File menu and returns to its row');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement.closest('.ui-menu')?.getAttribute('aria-label')), 'Edit', 'Right opens the next row\'s menu');
    assert.equal(await focusedLabel(), 'Undo');
    await closeAppMenus(page);
    assert.deepEqual(await page.evaluate(() => [document.getElementById('menu').hidden, document.activeElement.dataset.action ?? null,
      styk.ui.overlays.blocksHotkeys()]), [true, 'menu', false], 'Escape closes the menus and returns focus to the mark');
    await page.locator('#viewport').focus();
    await page.keyboard.press('h');
    assert.equal(await tool(), 'hand', 'with the menu closed, H picks the Pan tool again');
    await page.keyboard.press('v');
    assert.equal(await tool(), before);
  });

  await step('app: Space in an open menu runs the focused row and never arms the pan chord', async () => {
    await page.click('.titlebar .brand');
    await page.locator('#menu').getByRole('menuitem', {name: 'Help', exact: true}).focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await focusedLabel(), 'Keyboard shortcuts');
    await page.keyboard.down('Space');
    const held = await page.evaluate(() => [Boolean(styk.state.spaceHeld), Boolean(styk.state.space), document.querySelectorAll('dialog[open]').length]);
    await page.keyboard.up('Space');
    assert.deepEqual(held, [false, false, 1]);
    await page.keyboard.press('Escape');
    await settle();
    assert.equal(await page.evaluate(() => document.querySelectorAll('dialog[open]').length), 0);
  });

  await step('app: a message stays above a dialog that opens after it, and failures show as alerts that stay', async () => {
    await page.evaluate(() => styk.ui.toasts.show({message: 'Motion paths on', timeout: 30000}));
    // The pill's middle band: in the stage header it is 28px tall and over a dialog 32px, with the same words and colours.
    const pill = async () => {
      const box = await page.locator('#toast .ui-toast').boundingBox();
      return page.screenshot({clip: {x: box.x + 6, y: Math.round(box.y + box.height / 2) - 8, width: box.width - 12, height: 16}});
    };
    const before = await pill();
    await page.evaluate(() => styk.actions.performance());
    await page.waitForFunction(() => document.getElementById('performance-dialog')?.open);
    await settle(150);
    assert.ok(before.equals(await pill()), 'the dialog backdrop does not cover or dim the message');
    const placed = await page.evaluate(() => {
      const toast = document.querySelector('#toast .ui-toast').getBoundingClientRect(), dialog = document.getElementById('performance-dialog').getBoundingClientRect();
      return {inside: Boolean(document.getElementById('toast').closest('#performance-dialog')),
        clear: toast.bottom <= dialog.top || toast.top >= dialog.bottom || toast.right <= dialog.left || toast.left >= dialog.right};
    });
    assert.deepEqual(placed, {inside: true, clear: true}, 'the host lives in the modal (so it can be clicked) and sits outside its box');
    await page.evaluate(() => styk.ui.toasts.fail(new Error('The encoder stopped')));
    await settle(150);
    assert.deepEqual(await page.evaluate(() => ({
      text: document.querySelector('#toast .ui-toast-text')?.textContent, tone: document.querySelector('#toast .ui-toast')?.dataset.tone,
      icon: Boolean(document.querySelector('#toast .ui-toast-icon')),
      said: document.querySelector('#performance-dialog > .ui-toast-live[aria-live=assertive]')?.textContent,
    })), {text: 'The encoder stopped', tone: 'danger', icon: true, said: 'The encoder stopped'}, 'an error takes the slot, shows its glyph and is announced from inside the dialog');
    await page.keyboard.press('Escape');
    await settle();
    assert.equal(await page.evaluate(() => document.getElementById('toast').parentElement === document.body), true, 'the host goes back when the dialog closes');
    assert.equal(await page.locator('#toast .ui-toast-text').textContent(), 'The encoder stopped', 'the failure stays until dismissed');
    await page.evaluate(() => styk.ui.toasts.clear());
    // The app's own messages go through the same slot.
    await page.click('[data-workspace-mode=rig]');
    await page.evaluate(() => styk.actions.import());
    assert.equal(await page.locator('#toast .ui-toast-text').textContent(), 'Finish the figure or return to Animate to import figures.');
    await page.click('[data-workspace-mode=animate]');
    await page.waitForFunction(() => document.querySelector('.workspace').dataset.mode === 'animate');
    await page.evaluate(() => styk.ui.toasts.clear());
  });

  await step('app: a routine failure is a dismissible alert that goes after 8 seconds; a failed import stays', async () => {
    const clickAction = action => page.evaluate(action => {
      const button = document.createElement('button');
      button.dataset.action = action;
      document.body.append(button);
      button.click();
      button.remove();
    }, action);
    await page.evaluate(() => { styk.actions['test-routine-failure'] = () => { throw new Error('Choose a line or circle segment.'); }; });
    await clickAction('test-routine-failure');
    await settle(100);
    assert.deepEqual(await page.evaluate(() => ({
      text: document.querySelector('#toast .ui-toast-text')?.textContent, tone: document.querySelector('#toast .ui-toast')?.dataset.tone,
      icon: Boolean(document.querySelector('#toast .ui-toast-icon')), dismiss: Boolean(document.querySelector('#toast .ui-toast-close')),
    })), {text: 'Choose a line or circle segment.', tone: 'danger', icon: true, dismiss: true});
    await page.waitForTimeout(8300);
    assert.equal(await page.evaluate(() => document.querySelector('#toast .ui-toast') === null), true, 'gone after 8 seconds');
    await page.evaluate(() => { delete styk.actions['test-routine-failure']; });
    // A failed import is an I/O failure: it stays until dismissed.
    await page.evaluate(() => {
      const files = new DataTransfer();
      files.items.add(new File(['not a pivot file'], 'broken.piv'));
      const input = document.getElementById('file-input');
      input.files = files.files;
      input.dispatchEvent(new Event('change', {bubbles: true}));
    });
    await page.waitForFunction(() => document.querySelector('#toast .ui-toast[data-tone="danger"]'), null, {timeout: 20000});
    await page.waitForTimeout(8300);
    assert.equal(await page.evaluate(() => Boolean(document.querySelector('#toast .ui-toast[data-tone="danger"] .ui-toast-close'))), true, 'the failed import stays');
    await page.click('#toast .ui-toast-close');
    assert.equal(await page.evaluate(() => document.querySelector('#toast .ui-toast') === null), true);
    // fail() logs both to the console; they are this step's own errors.
    const expected = /Choose a line or circle segment|Invalid zlib project/;
    errors.splice(0, errors.length, ...errors.filter(message => !expected.test(message)));
  });

  await step('app: a message over Settings can be dismissed and leaves Settings as it was', async () => {
    await page.evaluate(() => styk.actions.settings());
    await page.locator('.styk-settings[open]').waitFor();
    await settle(150);
    const values = () => page.evaluate(() => [...document.querySelectorAll('.styk-settings input, .styk-settings select')]
      .map(field => `${field.name || field.id || field.getAttribute('aria-label')}=${field.type === 'checkbox' || field.type === 'radio' ? field.checked : field.value}`).join('|'));
    const before = await values();
    await page.evaluate(() => styk.ui.toasts.fail(new Error('The encoder stopped')));
    await settle(150);
    const close = await page.evaluate(() => {
      const button = document.querySelector('#toast .ui-toast-close'), box = button.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return {hit: button === hit || button.contains(hit), inside: Boolean(button.closest('.styk-settings'))};
    });
    assert.deepEqual(close, {hit: true, inside: true}, 'Dismiss is the element at its own centre, inside the open dialog');
    await page.click('#toast .ui-toast-close');
    await settle();
    assert.equal(await page.evaluate(() => document.querySelector('#toast .ui-toast') === null), true, 'the message is gone');
    assert.equal(await values(), before, 'nothing in Settings changed');
    assert.equal(await page.evaluate(() => document.querySelector('.styk-settings').open), true);
    await page.keyboard.press('Escape');
    await page.locator('.styk-settings[open]').waitFor({state: 'detached'}).catch(() => {});
    await settle();
    assert.equal(await page.evaluate(() => document.querySelectorAll('dialog[open]').length), 0);
  });

  await step('app: an error never covers the view controls or a dialog\'s buttons (1024 × 700 and 500 × 340)', async () => {
    // Controls that step aside for the message are visibility: hidden, so they count as not shown.
    const centreHits = selector => page.evaluate(selector => [...document.querySelectorAll(selector)]
      .filter(element => element.checkVisibility({visibilityProperty: true}))
      .map(element => {
        const box = element.getBoundingClientRect(), hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return element === hit || element.contains(hit) ? true : `${element.getAttribute('aria-label') || element.id || element.textContent.trim()}: ${hit?.closest('#toast') ? 'under the message' : hit?.outerHTML.slice(0, 60)}`;
      }), selector);
    for (const [width, height] of [[1024, 700], [500, 340]]) {
      await page.setViewportSize({width, height});
      await settle(200);
      await page.evaluate(() => styk.ui.toasts.fail(new Error('The encoder stopped while writing frame 12')));
      await settle(150);
      // The stage header's end: at compact width the view toggles may step aside for the message; zoom and Fit never do.
      const cluster = await centreHits('.stage-head [data-slot="stage-end"] button');
      assert.ok(cluster.length >= 2 && cluster.every(item => item === true), `${width}x${height}: ${cluster}`);
      assert.equal((await centreHits('.stage-head [data-zoom] button')).length, 2, `${width}x${height}: zoom and Fit stay`);
      await page.evaluate(() => { styk.editor.dirty = true; });
      await page.evaluate(() => { void styk.actions['close-project'](); });
      await page.locator('#save-changes').waitFor();
      await settle(150);
      const buttons = await centreHits('.ui-dialog[open] .ui-dialog-foot button');
      assert.ok(buttons.length >= 3 && buttons.every(item => item === true), `${width}x${height}: ${buttons}`);
      assert.equal((await centreHits('#toast .ui-toast-close')).every(item => item === true), true, `${width}x${height}: the message can be dismissed`);
      await page.keyboard.press('Escape');
      await settle();
      await page.evaluate(() => styk.ui.toasts.clear());
    }
    await page.setViewportSize({width: 1440, height: 900});
    await settle(200);
  });

  await step('app: a context menu opens above the pointer when there is more room there, and never under the band', async () => {
    // Bring the figure's feet 24px above the bottom of the stage, wherever the fit put them.
    await page.evaluate(() => {
      const g = [...styk.editor.geometry.objects.values()][0], r = document.getElementById('viewport').getBoundingClientRect(), v = styk.state.view;
      const lowest = Math.max(...[...g.joints.values()].map(p => r.y + v.y + p.y * v.scale));
      styk.state.view.y += r.bottom - 24 - lowest;
    });
    await settle();
    const joint = await page.evaluate(() => {
      const g = [...styk.editor.geometry.objects.values()][0], r = document.getElementById('viewport').getBoundingClientRect(), v = styk.state.view;
      return [...g.joints.values()].map(p => ({x: r.x + v.x + p.x * v.scale, y: r.y + v.y + p.y * v.scale})).sort((a, b) => b.y - a.y)[0];
    });
    const before = await tool();
    await page.mouse.click(joint.x, joint.y, {button: 'right'});
    const placed = await page.evaluate(() => ({menu: document.getElementById('menu').getBoundingClientRect().toJSON(), natural: document.getElementById('menu').scrollHeight,
      band: document.querySelector('.titlebar').getBoundingClientRect().bottom, height: innerHeight}));
    assert.ok(placed.height - 8 - joint.y < placed.natural, 'the menu does not fit below the pointer');
    assert.ok(placed.menu.bottom <= joint.y + 3 && placed.menu.top >= placed.band + 6 - 0.5, JSON.stringify({joint, ...placed}));
    await page.keyboard.press('h');
    assert.equal(await tool(), before, 'letters typed into a context menu never reach the tool hotkeys');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'viewport', 'Escape returns focus to the stage');
    await page.evaluate(() => styk.fit());

    await page.setViewportSize({width: 500, height: 340});
    await settle(200);
    // A point of the (tiny) stage that no floating control covers.
    const free = await page.evaluate(() => {
      const r = document.getElementById('viewport').getBoundingClientRect();
      for (let y = r.bottom - 4; y > r.top; y -= 4) for (let x = r.right - 4; x > r.left; x -= 8)
        if (document.elementFromPoint(x, y)?.id === 'overlay') return {x, y};
      return null;
    });
    assert.ok(free, 'part of the stage is free');
    await page.mouse.click(free.x, free.y, {button: 'right'});
    const small = await page.evaluate(() => ({...document.getElementById('menu').getBoundingClientRect().toJSON(),
      band: document.querySelector('.titlebar').getBoundingClientRect().bottom}));
    assert.ok(small.top >= small.band + 6 - 0.5 && small.bottom <= 340 && small.left >= 0 && small.right <= 500, JSON.stringify(small));
    await page.keyboard.press('Escape');
    await page.setViewportSize({width: 1440, height: 900});
    await settle(200);
  });

  await step('app: at 500 × 340 a long menu says more is below, and a submenu overlaps its parent rather than cut its labels', async () => {
    await page.setViewportSize({width: 500, height: 340});
    await settle(200);
    await page.click('.brand');
    await settle();
    await page.getByRole('menuitem', {name: 'View', exact: true}).click();
    await settle();
    const view = await page.evaluate(() => {
      const menu = document.querySelector('.ui-menu[aria-label="View"]'), box = menu.getBoundingClientRect();
      return {inside: box.left >= 0 && box.right <= innerWidth, cut: [...menu.querySelectorAll('.ui-menu-item > span')].filter(span => span.scrollWidth > span.clientWidth + 1).map(span => span.textContent),
        more: menu.hasAttribute('data-more-below')};
    });
    assert.deepEqual(view, {inside: true, cut: [], more: true}, 'the View menu fades while rows wait below');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.setViewportSize({width: 1440, height: 900});
    await settle(200);
  });

  await step('app: a menu opened from inside a dialog lives in it, and its rows can be clicked', async () => {
    await page.evaluate(() => styk.actions.performance());
    await page.evaluate(async () => {
      const {openMenu} = await import('/src/ui/ui-menu.mjs');
      const button = document.createElement('button');
      button.type = 'button';
      button.id = 'probe-menu-button';
      button.textContent = 'Options';
      document.querySelector('#performance-dialog .ui-dialog-body').append(button);
      button.addEventListener('click', () => openMenu({anchor: button, overlays: styk.ui.overlays, label: 'Options',
        items: [{label: 'Copy report', run: () => { window.probeMenuRan = true; }}]}));
    });
    await page.click('#probe-menu-button');
    assert.equal(await page.evaluate(() => document.querySelector('[role=menu][aria-label=Options]')?.closest('dialog')?.id), 'performance-dialog');
    await page.getByRole('menuitem', {name: 'Copy report', exact: true}).click();
    assert.deepEqual(await page.evaluate(() => [window.probeMenuRan === true, document.getElementById('performance-dialog').open, document.activeElement.id]),
      [true, true, 'probe-menu-button']);
    await page.keyboard.press('Escape');
    await settle();
    assert.equal(await page.evaluate(() => styk.ui.overlays.blocksHotkeys()), false);
  });

  await step('app: the Properties ⋯ button opens the selection menu; a second press closes it; Escape returns focus to it', async () => {
    await page.click('#object-actions');
    assert.equal(await menuOpen(), true, 'the click that opens the menu no longer closes it');
    assert.equal(await page.locator('#object-actions').getAttribute('aria-expanded'), 'true');
    const placed = await page.evaluate(() => ({menu: document.getElementById('menu').getBoundingClientRect().toJSON(),
      button: document.getElementById('object-actions').getBoundingClientRect().toJSON(), width: innerWidth}));
    assert.ok(placed.menu.top >= placed.button.bottom && placed.menu.right <= placed.width - 8 + 0.5, JSON.stringify(placed));
    await page.click('#object-actions');
    assert.equal(await menuOpen(), false, 'a second press closes it');
    assert.equal(await page.locator('#object-actions').getAttribute('aria-expanded'), 'false');
    await page.locator('#object-actions').focus();
    await page.keyboard.press('Enter');
    assert.equal(await menuOpen(), true);
    assert.equal(await focusedLabel(), 'Duplicate', 'the keyboard lands on the first row');
    await page.keyboard.press('Escape');
    assert.deepEqual(await page.evaluate(() => [document.getElementById('menu').hidden, document.activeElement.id]), [true, 'object-actions']);
    const selected = () => page.evaluate(() => styk.editor.selectedUid);
    const before = await selected();
    await page.click('#object-actions');
    await page.click('#menu [data-action=duplicate]');
    const copy = await selected();
    assert.ok(copy !== null && copy !== before, 'its rows run their commands: the duplicate is selected');
    await page.locator('#viewport').focus();
    await page.keyboard.press('Control+z');
    await page.waitForFunction(uid => !styk.editor.geometry.objects.has(uid) || styk.editor.selectedUid !== uid, copy, {timeout: 5000});
  });

  await step('app: the project name dialog starts in its field, Enter saves the name and Escape cancels', async () => {
    // A double-click on the project's tab renames it; the tab shows the new name and gets focus back.
    await page.dblclick('.project-tab[aria-selected="true"] .project-tab-name');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'rename-input', 'focus starts in the field, not on Close');
    await page.keyboard.type('Kick combo');   // the name is selected, so typing replaces it
    await page.keyboard.press('Enter');
    await settle();
    assert.deepEqual(await page.evaluate(() => [styk.editor.name, document.querySelector('.project-tab[aria-selected="true"] .project-tab-name').textContent,
      document.querySelectorAll('dialog[open]').length, document.activeElement.getAttribute('role')]), ['Kick combo', 'Kick combo', 0, 'tab']);
    await page.dblclick('.project-tab[aria-selected="true"] .project-tab-name');
    await page.keyboard.type('Something else');
    await page.keyboard.press('Escape');
    await settle();
    assert.deepEqual(await page.evaluate(() => [styk.editor.name, document.querySelectorAll('dialog[open]').length]), ['Kick combo', 0]);
  });

  await step('app: "Save changes?" starts on Save, without a ring after a pointer and with one after a key; Escape keeps editing', async () => {
    await page.evaluate(() => { styk.editor.dirty = true; });
    const focus = () => page.evaluate(() => [document.activeElement.id, document.activeElement.matches(':focus-visible')]);
    // A new animation opens beside the project; closing the project is what asks about its changes.
    await (await openAppMenu(page, 'file')).locator('[data-action="close-project"]').click();
    await page.locator('#save-changes').waitFor();
    assert.deepEqual(await focus(), ['save-changes', false], 'opened by a pointer: focused without the ring');
    await page.keyboard.press('Escape');
    await settle();
    assert.deepEqual(await page.evaluate(() => [document.querySelectorAll('dialog[open]').length, styk.editor.dirty, styk.editor.name]), [0, true, 'Kick combo']);
    await page.locator('.project-tab[aria-selected="true"]').focus();
    await page.keyboard.press('Delete');
    await page.locator('#save-changes').waitFor();
    assert.deepEqual(await focus(), ['save-changes', true], 'opened from the keyboard: the ring shows');
    await page.keyboard.press('Escape');
    await settle();
    assert.deepEqual(await page.evaluate(() => [document.querySelectorAll('dialog[open]').length, styk.editor.name, styk.ui.overlays.blocksHotkeys()]),
      [0, 'Kick combo', false]);
  });

  await step('app: Enter in an export field runs the chosen format once, and only that format', async () => {
    await page.click('.titlebar [data-action="export"]');
    await page.locator('#export-dialog[open] #export-start').waitFor();
    await settle(300);   // the capability refresh settles the formats
    const chosen = await page.evaluate(() => {
      // Record the export commands the dialog runs instead of exporting.
      window.exportRuns = [];
      window.exportActions = Object.entries(styk.actions).filter(([name]) => name.startsWith('export-'));
      for (const [name] of window.exportActions) styk.actions[name] = () => { window.exportRuns.push(name); };
      return document.getElementById('output-format').value;
    });
    assert.ok(chosen, `a format is chosen (${chosen})`);
    await page.locator('#export-start').focus();
    await page.keyboard.press('Enter');
    await settle(150);
    assert.deepEqual(await page.evaluate(() => window.exportRuns), [chosen], 'one export, of the chosen format');
    await page.evaluate(() => { for (const [name, action] of window.exportActions) styk.actions[name] = action; });
    await page.keyboard.press('Escape');
    await settle();
    assert.equal(await page.evaluate(() => document.querySelectorAll('dialog[open]').length), 0);
  });

  await step('app: a tooltip names the control and shows its shortcut from the registry, with no native title beside it', async () => {
    const tip = () => page.evaluate(() => {
      const element = document.getElementById('ui-tooltip');
      return element.matches(':popover-open') ? element.textContent : null;
    });
    const undo = page.locator('[data-action=undo]:visible').first();
    assert.deepEqual(await undo.evaluate(button => [button.getAttribute('title'), button.dataset.hotkeyTitle, button.dataset.hotkeyHint,
      button.getAttribute('aria-keyshortcuts')]), [null, 'Undo', 'Ctrl+Z', 'Control+Z']);
    assert.ok(await page.getByRole('button', {name: 'Undo', exact: true}).count() >= 1, 'the accessible name has no shortcut');
    await undo.hover();
    await page.waitForFunction(() => document.getElementById('ui-tooltip').matches(':popover-open'));
    assert.equal(await tip(), 'Undo·Ctrl+Z');
    assert.equal(await undo.getAttribute('aria-describedby'), 'ui-tooltip');
    // A control that took its name from its old title keeps that name, without the shortcut.
    assert.equal(await page.locator('[data-action=previous-frame]:visible').first().getAttribute('aria-label'), 'Previous frame');
    await page.mouse.move(700, 450);
    await settle(100);
    assert.equal(await tip(), null, 'it hides when the pointer leaves');

    // A rebinding shows at once; the tooltip reads the user's bindings, not text.
    await page.evaluate(() => styk.settingsUI.commit({hotkeys: {...styk.hotkeys.bindings, undo: ['Mod+KeyU']}}));
    assert.equal(await undo.getAttribute('data-hotkey-hint'), 'Ctrl+U');
    await page.evaluate(() => styk.ui.tooltips.show(document.querySelector('[data-action=undo]')));
    assert.equal(await tip(), 'Undo·Ctrl+U');
    await page.evaluate(() => { styk.ui.tooltips.hide(); styk.settingsUI.commit({hotkeys: undefined}); });
    assert.equal(await undo.getAttribute('data-hotkey-hint'), 'Ctrl+Z');

    // A workspace that claims a key takes it off the general command: M flips the view in Draw.
    await page.evaluate(() => styk.ui.tooltips.show(document.getElementById('paths-button')));
    assert.equal(await tip(), 'Motion paths·M');
    await page.click('[data-workspace-mode=draw]');
    await page.waitForFunction(() => document.querySelector('.workspace').dataset.mode === 'draw');
    await page.evaluate(() => styk.ui.tooltips.show(document.getElementById('paths-button')));
    assert.equal(await tip(), 'Motion paths');
    await page.evaluate(() => styk.ui.tooltips.show(document.querySelector('[data-tool=drawing-brush]')));
    assert.equal(await tip(), 'Brush·B', 'drawing tools show their shortcut from the bindings, not from their markup');
    await page.evaluate(() => styk.ui.tooltips.hide());
    await page.click('[data-workspace-mode=animate]');
    await page.waitForFunction(() => document.querySelector('.workspace').dataset.mode === 'animate');

    // Markup that still carries a native title keeps it, and gets no second tooltip.
    assert.equal(await page.evaluate(() => {
      const legacy = document.querySelector('#zoom-label[title]');
      styk.ui.tooltips.show(legacy);
      return [legacy.title, document.getElementById('ui-tooltip').matches(':popover-open')].join('|');
    }), 'Zoom options|false');
    // In the chrome that native title becomes the ink tooltip the first time it is pointed at: one style for neighbours.
    await page.hover('#zoom-label');
    await page.waitForFunction(() => document.getElementById('ui-tooltip').matches(':popover-open'));
    assert.deepEqual(await page.evaluate(() => {
      const button = document.getElementById('zoom-label');
      return [button.hasAttribute('title'), button.dataset.tooltip, document.querySelector('#ui-tooltip .ui-tooltip-label').textContent];
    }), [false, 'Zoom options', 'Zoom options']);
    // Beside the rail the tooltip opens on the stage's side, never over the neighbouring tools.
    await page.mouse.move(700, 500);
    await page.evaluate(() => styk.ui.tooltips.hide());
    await page.hover('[data-tool=select]');
    await page.waitForFunction(() => document.getElementById('ui-tooltip').matches(':popover-open'));
    const beside = await page.evaluate(() => {
      const tool = document.querySelector('[data-tool=select]').getBoundingClientRect(), tip = document.getElementById('ui-tooltip').getBoundingClientRect();
      return {right: tip.left >= tool.right, clear: tip.bottom <= tool.top || tip.top >= tool.bottom || tip.left >= tool.right, add: (() => {
        const add = document.getElementById('open-insert').getBoundingClientRect();
        return tip.right <= add.left || tip.left >= add.right || tip.bottom <= add.top || tip.top >= add.bottom;
      })()};
    });
    assert.deepEqual(beside, {right: true, clear: true, add: true});
    await page.mouse.move(700, 500);
    await page.evaluate(() => styk.ui.tooltips.hide());
  });

  const paletteRows = () => page.evaluate(() => [...document.querySelectorAll('.ui-palette [role=group]')].map(group => [
    group.querySelector('.ui-palette-group').textContent,
    [...group.querySelectorAll('[role=option]')].map(option => [option.querySelector('.ui-palette-label').textContent,
      option.querySelector('.ui-palette-meta')?.textContent ?? '', option.getAttribute('aria-disabled') === 'true']),
  ]));
  const paletteQuery = async text => { await page.fill('.ui-palette input', text); await settle(80); return paletteRows(); };

  await step('app: Ctrl+P, Ctrl+Shift+P, F1 and Search commands… open the command palette; the browser never prints', async () => {
    await page.evaluate(() => {
      window.paletteKeys = [];
      window.addEventListener('keydown', event => { if (['KeyP', 'F1'].includes(event.code)) paletteKeys.push(event.defaultPrevented); });
    });
    for (const key of ['Control+p', 'Control+Shift+P', 'F1']) {
      await page.locator('#viewport').focus();
      await page.keyboard.press(key);
      assert.deepEqual(await page.evaluate(() => [styk.ui.palette.isOpen, styk.ui.palette.element.matches(':modal'), document.activeElement.getAttribute('role'),
        styk.ui.overlays.blocksHotkeys()]), [true, true, 'combobox', true], `${key} opens the palette`);
      assert.equal(await page.evaluate(() => {
        const again = new KeyboardEvent('keydown', {code: 'KeyP', key: 'p', ctrlKey: true, bubbles: true, cancelable: true});
        styk.ui.palette.input.dispatchEvent(again);
        return again.defaultPrevented && styk.ui.palette.isOpen;
      }), true, 'Ctrl+P inside the palette keeps it open and never prints');
      await page.keyboard.press('Escape');
      assert.deepEqual(await page.evaluate(() => [styk.ui.palette.isOpen, document.activeElement.id, styk.ui.overlays.blocksHotkeys()]),
        [false, 'viewport', false], 'Escape closes it and returns focus');
    }
    await page.locator('#fps').focus();
    await page.keyboard.press('Control+p');
    assert.equal(await page.evaluate(() => styk.ui.palette.isOpen), false, 'typing in a field never opens it');
    assert.deepEqual(await page.evaluate(() => paletteKeys), [true, true, true, true], 'the browser never sees the keys (print, help)');

    await page.click('.brand[data-action=menu]');
    const row = page.locator('#menu [data-action=command-palette]');
    assert.deepEqual(await row.evaluate(item => [item.querySelector(':scope > span').textContent, item.querySelector('kbd').textContent,
      item.getAttribute('aria-keyshortcuts'), item === item.parentElement.querySelector('[data-action]')]),
    ['Search commands…', 'Ctrl+P', 'Control+P Control+Shift+P F1', true], 'the first row of the StykAnimate menu');
    assert.deepEqual(await page.locator('#menu').evaluate(menu => [...menu.querySelectorAll('.ui-menu-item')].map(item => item.dataset.action ?? item.textContent.trim())),
      ['command-palette', 'File', 'Edit', 'View', 'Joint', 'Animation', 'Help', 'settings'],
      'the StykAnimate menu holds Search commands, the application menus and Settings, and repeats none of their commands');
    await row.click();
    assert.deepEqual(await page.evaluate(() => [styk.ui.palette.isOpen, document.getElementById('menu').hidden]), [true, true]);
    await page.keyboard.press('Escape');
  });

  await step('app: the palette runs a command, explains one it cannot run, remembers recent ones and goes to a frame', async () => {
    await page.evaluate(async () => {
      const {emptyDocument, createFrame, createObject} = await import('/src/demo.mjs');
      const report = emptyDocument();
      report.keyframes = [0, 40].map(x => createFrame([createObject(report.figure_types[0], 1, 200 + x, 250)], 12));
      styk.editor.load(report);
      styk.editor.select(1);
      styk.fit();
    });
    const before = await page.evaluate(() => ({undo: styk.editor._undo.length, revision: styk.editor.revision}));
    await page.locator('#viewport').focus();
    await page.keyboard.press('Control+p');
    const flips = await paletteQuery('flip hor');
    assert.deepEqual(flips[0][1][0], ['Flip horizontally', 'Shift+H', false], JSON.stringify(flips));
    await page.keyboard.press('Enter');
    await page.waitForFunction(undo => styk.editor._undo.length === undo + 1, before.undo);
    assert.deepEqual(await page.evaluate(() => [styk.ui.palette.isOpen, document.activeElement.id]), [false, 'viewport'], 'it closes, then runs');
    await page.keyboard.press('Control+z');
    await page.waitForFunction(undo => styk.editor._undo.length === undo, before.undo);

    await page.keyboard.press('Control+p');
    const recent = await paletteRows();
    assert.deepEqual(recent[0], ['Recent', [['Flip horizontally', 'Shift+H', false]]], 'recent commands lead the empty query');
    const split = (await paletteQuery('split'))[0][1].find(([label]) => label === 'Split');
    assert.deepEqual(split, ['Split', 'In Build', true], 'a Build command stays findable, with the reason it cannot run here');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => styk.ui.palette.isOpen), true, 'Enter on an unavailable row does nothing');
    const web = (await paletteQuery('new window'))[0][1][0];
    assert.deepEqual(web, ['New window', 'In the desktop app', true]);

    // The active row is the first one Enter can run, and a short query matches no letters scattered over a label.
    await paletteQuery('flip');
    assert.deepEqual(await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.ui-palette [role=option]')];
      const active = document.querySelector('.ui-palette [role=option][aria-selected=true]');
      return {activeEnabled: active?.getAttribute('aria-disabled') !== 'true', anyEnabled: rows.some(row => row.getAttribute('aria-disabled') !== 'true'),
        scattered: rows.map(row => row.querySelector('.ui-palette-label').textContent).filter(label => /movieclip|Save figure|Timeline panel/.test(label))};
    }), {activeEnabled: true, anyEnabled: true, scattered: []});
    assert.deepEqual(await paletteQuery('12'), [['Go to', [['Go to frame 12', '', false]]]]);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => styk.editor.tick === 11);
    await page.keyboard.press('Control+p');
    await paletteQuery('100000');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => styk.editor.tick === styk.editor.totalTicks - 1);
  });

  await step('app: the palette finds layers, figures and settings by name', async () => {
    await page.locator('#viewport').focus();
    await page.evaluate(() => styk.editor.select(null));
    await page.keyboard.press('Control+p');
    const figure = await paletteQuery('walker');
    const project = figure.find(([group]) => group === 'In this project');
    assert.ok(project && project[1][0][1] === 'Figure · Layer 1', JSON.stringify(figure));
    await page.evaluate(() => { const options = [...document.querySelectorAll('.ui-palette [role=option]')];
      options.find(option => option.querySelector('.ui-palette-meta')?.textContent === 'Figure · Layer 1').click(); });
    await page.waitForFunction(() => styk.editor.selectedUid === 1);

    await page.keyboard.press('Control+p');
    const layers = await paletteQuery('layer 1');
    assert.deepEqual(layers.find(([group]) => group === 'In this project')?.[1][0], ['Layer 1', 'Layer', false]);
    await page.evaluate(() => [...document.querySelectorAll('.ui-palette [role=option]')].find(option => option.querySelector('.ui-palette-meta')?.textContent === 'Layer').click());
    await page.waitForFunction(() => styk.state.selectedTrackId === 'layer-1' && styk.state.inspectorContext === 'layer' && styk.timeline.selectedTrackId === 'layer-1');

    await page.keyboard.press('Control+p');
    const theme = await paletteQuery('theme');
    assert.deepEqual(theme.find(([group]) => group === 'Settings')?.[1][0], ['Theme', 'Settings › Interface', false]);
    await page.evaluate(() => [...document.querySelectorAll('.ui-palette [role=option]')].find(option => option.querySelector('.ui-palette-meta')?.textContent === 'Settings › Interface').click());
    await page.waitForFunction(() => document.querySelector('.styk-settings')?.open);
    assert.deepEqual(await page.evaluate(() => [document.activeElement.dataset.setting, document.activeElement.checked, styk.settingsUI.tab]), ['theme', true, 'interface'],
      'Settings opens on the tab with the field focused');
    await page.getByRole('button', {name: 'Close settings', exact: true}).click();
  });

  await step('app: every action the app registers has catalog metadata and every catalog requirement an answer', async () => {
    const coverage = await page.evaluate(async () => {
      const {COMMAND_BY_ID, CATALOG_REQUIREMENTS} = await import('/src/ui/command-catalog.mjs');
      return {unlabelled: Object.keys(styk.actions).filter(id => !COMMAND_BY_ID.has(id)),
        unanswered: CATALOG_REQUIREMENTS.filter(name => typeof styk.ui.commands.requirements[name] !== 'function'),
        listed: styk.ui.commands.list().length};
    });
    assert.deepEqual([coverage.unlabelled, coverage.unanswered], [[], []]);
    assert.ok(coverage.listed > 150, `${coverage.listed} palette rows`);
  });

  await step('app: startup prompts open one at a time, release notes first, never over a menu', async () => {
    // A desktop bridge with just the release notes and a first-run privacy state.
    const desktopPage = await browser.newPage({viewport: {width: 1280, height: 720}});
    desktopPage.on('pageerror', error => errors.push(`desktop: ${error.message}`));
    await desktopPage.addInitScript(() => {
      let resolveNotes;
      const notes = new Promise(resolve => { resolveNotes = resolve; });
      const state = decided => ({epoch: decided ? 2 : 1, decided, consent: {analytics: false, diagnostics: false}, status: decided ? 'Saved' : 'Not decided'});
      window.fakeDesktop = {decided: false, notes: () => resolveNotes({version: '9.9.9', title: 'A test release', groups: [{name: 'Added', notes: ['A new thing.']}]})};
      window.stykDesktop = {
        platform: 'linux',
        getReleaseInfo: startup => (startup ? notes : Promise.resolve({version: '9.9.9', groups: []})),
        getTelemetryState: async () => state(fakeDesktop.decided),
        onTelemetryState: () => () => {},
        setTelemetryConsent: async () => { fakeDesktop.decided = true; return state(true); },
      };
    });
    await desktopPage.goto(`${base}/`);
    await desktopPage.waitForFunction(() => window.styk?.ready, null, {timeout: 60000});
    const open = () => desktopPage.evaluate(() => [...document.querySelectorAll('dialog[open]')].map(dialog => dialog.className));
    await desktopPage.waitForTimeout(300);
    assert.deepEqual(await open(), [], 'the privacy choice waits for the release notes to be known');
    assert.deepEqual(await desktopPage.evaluate(() => styk.ui.overlays.pendingPrompts()), ['release-notes', 'privacy-first-run']);

    await desktopPage.click('.titlebar .brand');
    await desktopPage.evaluate(() => fakeDesktop.notes());
    await desktopPage.waitForTimeout(300);
    assert.deepEqual(await open(), [], 'nothing opens over an open menu');
    await desktopPage.keyboard.press('Escape');
    await desktopPage.locator('.release-splash[open]').waitFor();
    await desktopPage.waitForTimeout(200);
    assert.deepEqual(await open(), ['release-splash'], 'one prompt at a time: the release notes first');
    await desktopPage.getByRole('button', {name: 'Close welcome screen'}).click();
    await desktopPage.locator('.styk-privacy[open]').waitFor();
    assert.deepEqual(await open(), ['styk-privacy'], 'then the privacy choice');
    await desktopPage.locator('[data-decline]').click();
    await desktopPage.locator('.styk-privacy').waitFor({state: 'hidden'});
    assert.deepEqual(await desktopPage.evaluate(() => [styk.ui.overlays.pendingPrompts(), styk.ui.overlays.activePrompt, fakeDesktop.decided]), [[], null, true]);
    await desktopPage.close();
  });

  assert.deepEqual(errors, [], 'no page errors');
  console.log('overlays browser test passed');
} finally {
  await browser.close();
}
