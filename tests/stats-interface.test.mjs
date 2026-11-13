// What a person sees of the statistics (src/privacy-settings.mjs, docs/STATISTICS.md "On and off"): when Home shows the
// first-start line and what its buttons do, the Privacy section's states, and what "See the last report" shows. The
// line and the section in a page are tests/privacy.browser.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { statsNoticeWanted, privacySwitch, lastReport, openPrivacy, createPrivacy } from '../src/privacy-settings.mjs';

const state = (extra = {}) => ({ enabled: true, counting: true, forcedOff: false, noticeSeen: false, uploads: true, ...extra });

/** A desktop bridge holding a state, recording the calls the page makes. */
function bridge(initial = state()) {
  const calls = [];
  let current = { ...initial }, listener = null;
  const answer = name => { calls.push(name); return { ...current }; };
  return {
    calls,
    push(next) { current = { ...current, ...next }; listener?.({ ...current }); },
    getStatsState: async () => answer('getStatsState'),
    setStatsEnabled: async on => { current.enabled = on; current.noticeSeen = true; return answer(`setStatsEnabled(${on})`); },
    markStatsNoticeSeen: async () => { current.noticeSeen = true; return answer('markStatsNoticeSeen'); },
    markStatsNoticeShown: async () => answer('markStatsNoticeShown'),
    previewStats: async () => ({ lastSent: null, waiting: [] }),
    openServicePage: async page => { calls.push(`openServicePage(${page})`); },
    onStatsState: callback => { listener = callback; return () => { listener = null; }; },
  };
}

test('Home shows the line while statistics are on and the line was not answered; never when off or forced off', () => {
  assert.equal(statsNoticeWanted(state()), true);
  assert.equal(statsNoticeWanted(state({ noticeSeen: true })), false, 'answered');
  assert.equal(statsNoticeWanted(state({ enabled: false })), false, 'off');
  assert.equal(statsNoticeWanted(state({ enabled: false, forcedOff: true })), false, 'forced off');
  assert.equal(statsNoticeWanted(state({ counting: false })), true, 'a session that is not counted still shows it');
  assert.equal(statsNoticeWanted(null), false, 'no state yet, or the browser build');
});

test('OK answers the line; Turn off answers it, turns statistics off and says once where to turn them on', async () => {
  const desktop = bridge(), privacy = createPrivacy({ desktop }), seen = [];
  privacy.subscribe(next => seen.push(statsNoticeWanted(next)));
  await privacy.refresh();
  assert.equal(await privacy.answer('ok'), null);
  assert.deepEqual(desktop.calls, ['getStatsState', 'markStatsNoticeSeen']);
  assert.deepEqual(seen, [true, false], 'the line goes as soon as it is answered');

  const other = bridge(), off = createPrivacy({ desktop: other });
  assert.equal(await off.answer('off'), 'privacy.notice.turnedOff');
  assert.deepEqual(other.calls, ['markStatsNoticeSeen', 'setStatsEnabled(false)']);
  assert.deepEqual([off.state.enabled, statsNoticeWanted(off.state)], [false, false]);
  await assert.rejects(off.answer('later'), TypeError);
});

test('the state follows the desktop process: a change pushed from there reaches every listener', async () => {
  const desktop = bridge(), privacy = createPrivacy({ desktop });
  let last = null;
  const stop = privacy.subscribe(next => { last = next; });
  desktop.push({ noticeSeen: true });
  assert.equal(last.noticeSeen, true);
  stop();
  desktop.push({ enabled: false });
  assert.equal(last.enabled, true, 'an unsubscribed listener hears nothing more');
  assert.equal(privacy.state.enabled, false);
  assert.equal(createPrivacy({ desktop: {} }).available, false, 'the browser build has no bridge');
  assert.equal(await createPrivacy({}).refresh(), null);
});

test('the Privacy switch: on, off, forced off (off and disabled), and a development run that uploads nothing', () => {
  assert.deepEqual(privacySwitch(state()), { on: true, disabled: false, note: null });
  assert.deepEqual(privacySwitch(state({ enabled: false, uploads: false })), { on: false, disabled: false, note: null });
  assert.deepEqual(privacySwitch(state({ enabled: false, forcedOff: true, uploads: false })), { on: false, disabled: true, note: 'privacy.forcedOff' });
  assert.deepEqual(privacySwitch(state({ uploads: false })), { on: true, disabled: false, note: 'privacy.notUploaded' });
  assert.deepEqual(privacySwitch(null), { on: false, disabled: true, note: null }, 'until the state is known');
});

test('the section is drawn from the state, and its controls do what they say', async () => {
  const desktop = bridge(state({ uploads: false })), privacy = createPrivacy({ desktop });
  const settings = { t: key => `«${key}»`, group: (title, rows) => `<section><h4>${title}</h4>${rows}</section>` };
  await privacy.refresh();
  const html = privacy.sectionHTML(settings);
  assert.match(html, /<h4>«privacy.statistics»<\/h4>/);
  assert.match(html, /data-privacy-enabled[^>]*checked/);
  assert.doesNotMatch(html, /data-privacy-enabled[^>]*disabled/);
  assert.match(html, /«privacy.notUploaded»/, 'a development run says so in one line');
  assert.match(html, /data-privacy-report/);
  assert.match(html, /data-privacy-note/);
  desktop.push({ enabled: false, forcedOff: true });
  const forced = privacy.sectionHTML(settings);
  assert.match(forced, /data-privacy-enabled[^>]*disabled/);
  assert.doesNotMatch(forced, /data-privacy-enabled[^>]*checked/);
  assert.match(forced, /«privacy.forcedOff»/);

  const failures = [];
  const toggle = { type: 'change', target: { checked: false, matches: selector => selector === '[data-privacy-enabled]', closest: () => null } };
  assert.equal(privacy.handle(toggle, error => failures.push(error)), true);
  const note = { type: 'click', target: { matches: () => false, closest: selector => (selector === '[data-privacy-note]' ? {} : null) } };
  assert.equal(privacy.handle(note, error => failures.push(error)), true);
  assert.equal(privacy.handle({ type: 'click', target: { matches: () => false, closest: () => null } }, () => {}), false, 'another control is not the section\'s');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(desktop.calls.slice(-2), ['setStatsEnabled(false)', 'openServicePage(privacy)'], 'the switch and the privacy note, the site\'s own page');
  assert.deepEqual(failures, []);
});

test('the last report is exactly what the desktop process answered, or nothing at all', () => {
  assert.deepEqual(lastReport({ lastSent: null, waiting: [] }), { sent: false, json: null });
  const waiting = { lastSent: null, waiting: [{ kind: 'file', op: 'save' }] };
  assert.deepEqual(lastReport(waiting), { sent: false, json: JSON.stringify(waiting, null, 2) });
  const both = { lastSent: { v: 1, reports: [{ kind: 'session' }] }, waiting: [] };
  const { sent, json } = lastReport(both);
  assert.equal(sent, true);
  assert.deepEqual(JSON.parse(json), both);
  assert.match(json, /\n {2}"lastSent": \{/, 'readable: indented');
});

test('openPrivacy opens Preferences at Privacy where that section exists', () => {
  const opened = [];
  openPrivacy({ open: tab => opened.push(tab), hasTab: tab => tab === 'privacy' });
  openPrivacy({ open: tab => opened.push(tab), hasTab: () => false });
  assert.deepEqual(opened, ['privacy', undefined]);
  assert.equal(openPrivacy(null), undefined);
});
