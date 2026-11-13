// What a person sees of the statistics in a page (docs/STATISTICS.md, "On and off"): Home's first-start line and
// Preferences › Privacy with "See the last report". The desktop bridge is faked in the page with the calls of the
// bridge table; the service behind it is tests/stats-service.test.mjs, the rules tests/stats-interface.test.mjs.
import {chromium} from './support/playwright.mjs';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const url = process.env.STYK_URL || 'http://127.0.0.1:47831';
const out = path.resolve('artifacts/privacy-browser');
await mkdir(out, {recursive: true});
const browser = await chromium.launch({channel: 'chrome', headless: true});
const checks = [];
const LINE = 'StykAnimate sends anonymous statistics about speed and crashes. Nothing from your animations.';
const SENT = {lastSent: {v: 1, app: {version: '1.2.6', channel: 'stable'}, reports: [{kind: 'file', op: 'save', format: 'styk'}]}, waiting: [{kind: 'problem', type: 'error', times: 1}]};

/**
 * A page with a desktop bridge holding `state` (null: the browser build, no bridge). `window.fakeStats.calls` records
 * the calls the page makes; a change is pushed back as the main process does (onStatsState).
 */
async function open({state = {}, preview = {lastSent: null, waiting: []}, view = 'home'} = {}) {
  const context = await browser.newContext({viewport: {width: 1440, height: 900}, colorScheme: 'light'});
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {origin: new URL(url).origin});
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({state, preview, view}) => {
    globalThis.stykStartupView = view;
    if (!state) return;
    const fake = window.fakeStats = {calls: [], state: {enabled: true, counting: true, forcedOff: false, noticeSeen: false, uploads: true, ...state}, preview, listeners: []};
    const answer = name => { fake.calls.push(name); return structuredClone(fake.state); };
    const push = () => { for (const listener of fake.listeners) listener(structuredClone(fake.state)); };
    window.stykDesktop = {
      platform: 'win32',
      getStatsState: async () => answer('getStatsState'),
      setStatsEnabled: async on => { fake.state.enabled = on; fake.state.noticeSeen = true; push(); return answer(`setStatsEnabled(${on})`); },
      markStatsNoticeSeen: async () => { fake.state.noticeSeen = true; push(); return answer('markStatsNoticeSeen'); },
      markStatsNoticeShown: async () => answer('markStatsNoticeShown'),
      sendStatsSession: async () => true,
      sendStatsReport: async () => true,
      previewStats: async () => { fake.calls.push('previewStats'); return structuredClone(fake.preview); },
      onStatsState: callback => { fake.listeners.push(callback); return () => {}; },
      openServicePage: async page => { fake.calls.push(`openServicePage(${page})`); },
    };
  }, {state, preview, view});
  await page.goto(url);
  await page.waitForFunction(() => window.styk?.ready, null, {timeout: 120000});
  return {page, errors, context};
}
const calls = page => page.evaluate(() => window.fakeStats.calls);
const line = page => page.locator('.home-notice');

try {
  // ---- The first-start line ------------------------------------------------------------------------------------------
  let {page, errors, context} = await open();
  await line(page).waitFor({state: 'visible'});
  assert.equal(await page.locator('.home-notice-text').textContent(), LINE);
  assert.deepEqual(await line(page).locator('button').allTextContents(), ['What is sent', 'Turn off', 'OK']);
  assert.ok(await page.evaluate(() => document.querySelector('.home-main').firstElementChild.classList.contains('home-notice')), 'the line leads Home\'s page, in its flow');
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.home-notice')).position), 'static', 'nothing floats');
  await page.waitForFunction(() => window.fakeStats.calls.includes('markStatsNoticeShown'));
  await page.screenshot({path: path.join(out, 'home-line.png')});
  await line(page).getByRole('button', {name: 'What is sent'}).click();
  let report = page.locator('#privacy-report');
  await report.waitFor({state: 'visible'});
  assert.equal(await report.locator('.privacy-report-empty').textContent(), 'Nothing has been sent yet.');
  assert.equal(await report.locator('.privacy-report-json').count(), 0);
  assert.equal(await report.locator('#privacy-report-copy').count(), 0, 'nothing to copy');
  await page.keyboard.press('Escape');
  await report.waitFor({state: 'detached'});
  assert.ok(await line(page).isVisible(), 'What is sent leaves the line in place');
  await page.evaluate(() => window.styk.actions.home());
  await page.evaluate(() => window.styk.actions.home());
  assert.ok(await line(page).isVisible(), 'the line stays on every visit to Home until it is answered');
  await line(page).getByRole('button', {name: 'OK'}).click();
  await line(page).waitFor({state: 'hidden'});
  assert.deepEqual((await calls(page)).filter(name => name.startsWith('mark')), ['markStatsNoticeShown', 'markStatsNoticeSeen'], 'shown once, then answered');
  assert.deepEqual(errors, []);
  await context.close();
  checks.push('Home shows the line in its page, What is sent opens the last report and leaves it, OK answers it.');

  // A dialog over Home (What's new at a first start): the line is not seen yet, so the desktop is not told until it closes.
  ({page, errors, context} = await open({view: 'editor'}));
  await page.evaluate(() => window.styk.actions.help());
  await page.waitForFunction(() => document.querySelector('dialog[open]'));
  await page.evaluate(() => window.styk.actions.home());
  await line(page).waitFor({state: 'attached'});
  await page.waitForTimeout(1500);
  assert.ok(!(await calls(page)).includes('markStatsNoticeShown'), 'not marked shown under a dialog');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.fakeStats.calls.includes('markStatsNoticeShown'), null, {timeout: 5000});
  assert.deepEqual(errors, []);
  await context.close();
  checks.push('The line counts as shown only once no dialog covers Home.');

  ({page, errors, context} = await open());
  await line(page).getByRole('button', {name: 'Turn off'}).click();
  await line(page).waitFor({state: 'hidden'});
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Statistics are off.'));
  assert.match(await page.locator('#toast').textContent(), /turn them back on in Preferences, under Privacy/);
  assert.deepEqual((await calls(page)).filter(name => !name.startsWith('get') && name !== 'markStatsNoticeShown'), ['markStatsNoticeSeen', 'setStatsEnabled(false)']);
  assert.deepEqual(errors, []);
  await context.close();
  checks.push('Turn off answers the line, turns statistics off and says where to turn them on again.');

  for (const [state, why] of [[{noticeSeen: true}, 'answered'], [{enabled: false, noticeSeen: true}, 'off'], [{enabled: false, forcedOff: true, uploads: false}, 'forced off'], [null, 'the browser build']]) {
    ({page, errors, context} = await open({state}));
    await page.waitForTimeout(300);
    assert.equal(await line(page).isVisible(), false, `no line: ${why}`);
    if (state) assert.ok(!(await calls(page)).includes('markStatsNoticeShown'), `nothing marked shown: ${why}`);
    if (!state) {
      await page.evaluate(() => window.styk.actions.settings());
      assert.equal(await page.locator('.styk-settings [data-tab="privacy"]').count(), 0, 'the browser build has no Privacy section');
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  checks.push('No line once answered, with statistics off or forced off, or in the browser build (which has no Privacy section).');

  // ---- Preferences › Privacy -----------------------------------------------------------------------------------------
  ({page, errors, context} = await open({state: {noticeSeen: true}, preview: SENT, view: 'editor'}));
  await page.evaluate(() => window.styk.actions.privacy());
  const section = page.locator('.styk-settings[open]');
  await section.locator('[data-tab="privacy"][aria-selected="true"]').waitFor();
  const toggle = section.locator('[data-privacy-enabled]');
  assert.equal(await section.locator('.styk-settings-page h3').textContent(), 'Privacy');
  assert.equal(await toggle.isChecked(), true);
  assert.equal(await toggle.isDisabled(), false);
  assert.equal(await section.locator('[data-privacy-state]').count(), 0, 'no extra line while statistics upload');
  assert.match(await section.locator('.styk-settings-card').first().textContent(), /Send anonymous statistics.*Speed, crashes and which features are used\. Nothing from your animations\./s);
  await page.screenshot({path: path.join(out, 'preferences-privacy.png')});
  await toggle.click();
  await page.waitForFunction(() => !document.querySelector('[data-privacy-enabled]').checked);
  assert.ok((await calls(page)).includes('setStatsEnabled(false)'));
  await toggle.click();
  await page.waitForFunction(() => document.querySelector('[data-privacy-enabled]').checked);
  await section.getByRole('button', {name: 'Privacy note'}).click();
  await page.waitForFunction(() => window.fakeStats.calls.includes('openServicePage(privacy)'));
  await section.getByRole('button', {name: 'See the last report'}).click();
  report = page.locator('#privacy-report');
  await report.waitFor({state: 'visible'});
  assert.equal(await report.locator('.ui-dialog-title').textContent(), 'The last report');
  assert.equal(await report.locator('.ui-dialog-desc').first().textContent(), 'This is exactly what StykAnimate last sent, and what is waiting to be sent.');
  assert.equal(await report.locator('.privacy-report-empty').count(), 0);
  assert.deepEqual(JSON.parse(await report.locator('.privacy-report-json').textContent()), SENT, 'exactly what previewStats() returned');
  await report.locator('#privacy-report-copy').click();
  await page.waitForFunction(() => document.querySelector('#privacy-report .ui-dialog-meta')?.textContent === 'Copied');
  assert.deepEqual(JSON.parse(await page.evaluate(() => navigator.clipboard.readText())), SENT);
  await page.screenshot({path: path.join(out, 'last-report.png')});
  await page.keyboard.press('Escape');
  await report.waitFor({state: 'detached'});
  assert.ok(await section.isVisible(), 'Preferences stays open under the report');
  assert.deepEqual(errors, []);
  await context.close();
  checks.push('Preferences › Privacy: the switch turns statistics off and on, the privacy note opens the site\'s page, the last report shows and copies exactly what was sent.');

  for (const [state, note, disabled] of [[{enabled: false, forcedOff: true, uploads: false}, 'Statistics are turned off for this computer.', true],
    [{uploads: false}, 'This is a development run: reports are collected but not uploaded.', false]]) {
    ({page, errors, context} = await open({state: {noticeSeen: true, ...state}, view: 'editor'}));
    await page.evaluate(() => window.styk.actions.privacy());
    const toggle = page.locator('.styk-settings[open] [data-privacy-enabled]');
    await page.locator('.styk-settings[open] [data-privacy-state]').waitFor();
    assert.equal(await page.locator('.styk-settings[open] [data-privacy-state]').textContent(), note);
    assert.equal(await toggle.isDisabled(), disabled);
    assert.equal(await toggle.isChecked(), !disabled);
    assert.deepEqual(errors, []);
    await context.close();
  }
  checks.push('Forced off: the switch is off and disabled with one line; a development run says reports are not uploaded.');
  console.log(checks.map(check => `✓ ${check}`).join('\n'));
} finally {
  await browser.close();
}
