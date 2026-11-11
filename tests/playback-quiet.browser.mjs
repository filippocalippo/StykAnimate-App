/**
 * Playback stays quiet (architecture.md §3.2): while an animation plays, the
 * chrome writes only what moves with it. Over 2 s of playback of the startup
 * document plus 6 frames, in the Advanced timeline, the Simple timeline and
 * again with the camera selected:
 *
 *   - #time-display is the only text that changes, at most 5 times a second;
 *   - the playhead moves by its transform (the Advanced playhead and its frame
 *     number; in Simple the filmstrip's playhead line, while its cards stay
 *     still until playback stops);
 *   - the onion range markers on the ruler move with the playhead;
 *   - #play-button changes only when playback starts and stops;
 *   - chrome code reads no layout (getBoundingClientRect, offset*, client*,
 *     scroll*, getComputedStyle) while playing;
 *   - the canvas draws once per animation frame, whatever the display's
 *     refresh rate (DRAWS_PER_FRAME leaves room for a frame redrawn after a
 *     stall); the chrome's passes never repaint it.
 *
 * Everything else that still writes or reads during playback is listed in
 * RATCHET with the milestone that removes it. The list only shrinks: a
 * deterministic entry that no longer happens fails the test until it is
 * deleted here, and anything not listed fails as a new offender. Style
 * recalculation, layout and long animation frames are reported against the
 * final budgets (≤ 26 ms of style recalculation, 0 long frames), which M8
 * enforces; M3a enforces that playback mutations stay at least 90% below the
 * measured pre-M3a baseline.
 *
 *   STYK_URL=http://127.0.0.1:47913 node tests/playback-quiet.browser.mjs
 */
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {chromium} from './support/playwright.mjs';

const URL = process.env.STYK_URL || 'http://127.0.0.1:47831';
const PLAY_MS = 2000;
const TIME_DISPLAY_HZ = 5;
// Draws per animation frame: the new frame, and a quarter for one drawn again after the engine could not give it at once.
// A repaint after a chrome pass doubled it (2 per frame), and one on every display frame would draw ~5.5 per animation
// frame at 144 Hz.
const DRAWS_PER_FRAME = 1.25;

// Mutations the contract allows while playing (selector: the element or its ancestor the record's target is in).
const ALLOWED = [
  {id: 'time-display', selector: '#time-display', kinds: ['nodes', 'text'], phases: ['start', 'playing', 'stop'], perSecond: TIME_DISPLAY_HZ},
  {id: 'playhead', selector: '.sheet-playhead', kinds: ['nodes', 'text', 'style'], phases: ['start', 'playing', 'stop']},
  {id: 'play-button', selector: '#play-button', kinds: ['nodes', 'text', 'attributes'], phases: ['start', 'stop']},
  // The onion range markers sit on the ruler beside the playhead and move with it (onion-timeline-range.mjs).
  {id: 'onion-range', selector: '.onion-range-overlay', kinds: ['attributes', 'style'], phases: ['start', 'playing', 'stop']},
];
// Known writers and readers during playback, each until the milestone that removes it. `scenarios` limits an entry to
// where it happens; `always` marks deterministic entries, which fail the test once they stop happening.
const RATCHET = [
  // The status bar and the canvas HUD become the hidden activity log and the quiet "Slow" message (M3b).
  {id: 'render-time', until: 'M3b', selector: '#render-time', kinds: ['nodes', 'text'], always: true},
  {id: 'playback-fps', until: 'M3b', selector: '#playback-fps', kinds: ['nodes', 'text', 'attributes'], always: true},
  {id: 'preview-badge', until: 'M3b', selector: '#preview-badge', kinds: ['nodes', 'text', 'attributes']},
  {id: 'preview-quality', until: 'M3b', selector: '#preview-quality', kinds: ['attributes']},
  {id: 'status', until: 'M3b', selector: '#status, #status-dot', kinds: ['nodes', 'text', 'attributes']},
  // The hidden frame badge is read only by studio-shell's era; it goes with the reader-bound ids (M3b).
  {id: 'frame-badge', until: 'M3b', selector: '#frame-badge', kinds: ['nodes', 'text'], always: true},
  // The audio lane under the filmstrip rewrites its state on every seek (G2's module, M7f).
  {id: 'audio-timeline', until: 'M7f', selector: '#timeline-audio-panel', kinds: ['attributes'], scenarios: ['simple']},
  // The camera's controls and monitor follow every frame from the render loop until the camera surface (M4).
  {id: 'camera-inspector', until: 'M4', selector: '#inspector', kinds: ['nodes', 'text', 'attributes'], scenarios: ['camera'], always: true},
];
const READ_RATCHET = [
  // The timeline's one cached batch (_extent) is allowed for good.
  {id: 'timeline-extent', module: 'layer-timeline.mjs', fn: '_extent', final: true},
  {id: 'audio-paint', until: 'M7f', module: 'audio-timeline.mjs'},
  {id: 'camera-monitor', until: 'M4', module: 'camera-monitor.mjs', scenarios: ['camera'], always: true},
];
// Pre-M3a, the same workload in the Advanced timeline created 885 nodes and wrote 5,338 attributes in 2 s.
const BASELINE = {advanced: {nodes: 885, attributes: 5338}};

const browser = await chromium.launch({channel: 'chrome', headless: true});
const page = await browser.newPage({viewport: {width: 1440, height: 900}});
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const report = {url: URL, measuredAt: new Date().toISOString(), scenarios: {}, checks: []};
try {
  await page.goto(URL);
  await page.waitForFunction(() => window.styk?.ready);
  await page.waitForTimeout(1200);
  await page.evaluate(async () => {
    document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
    for (let i = 0; i < 6; i++) await window.styk.actions['add-frame']();
  });
  await page.evaluate(({allowed, ratchet, readRatchet}) => {
    const entries = [...allowed.map(entry => ({...entry, allowed: true})), ...ratchet];
    const kindOf = record => record.type === 'childList' ? 'nodes' : record.type === 'characterData' ? 'text'
      : record.attributeName === 'style' ? 'style' : 'attributes';
    const describe = node => {
      const element = node.nodeType === 1 ? node : node.parentElement;
      if (!element) return 'detached';
      const owner = element.closest('[id]');
      const own = element.id ? '' : ` ${element.tagName.toLowerCase()}${element.classList.length ? '.' + [...element.classList].slice(0, 2).join('.') : ''}`;
      return `${owner ? '#' + owner.id : 'document'}${own}`;
    };
    const probe = window.__quiet = {phase: 'idle', scenario: '', counts: {}, offenders: {}, reads: {}, readOffenders: {}, recording: false};
    const bump = (map, key, n = 1) => { map[key] = (map[key] ?? 0) + n; };
    const take = records => {
      for (const record of records) {
        if (probe.phase === 'idle') continue;
        const kind = kindOf(record), element = record.target.nodeType === 1 ? record.target : record.target.parentElement;
        const weight = record.type === 'childList' ? record.addedNodes.length + record.removedNodes.length : 1;
        if (!weight) continue;
        const entry = entries.find(entry => element?.closest(entry.selector) && entry.kinds.includes(kind === 'style' && !entry.kinds.includes('style') ? 'attributes' : kind)
          && (!entry.phases || entry.phases.includes(probe.phase)) && (!entry.scenarios || entry.scenarios.includes(probe.scenario)));
        const key = entry ? `${probe.phase} ${entry.id}` : `${probe.phase} ${describe(record.target)} ${kind}${record.attributeName ? ' ' + record.attributeName : ''}`;
        // Listed writers count changes (records); new ones count the nodes and attributes they touch.
        bump(entry ? probe.counts : probe.offenders, key, entry ? 1 : weight);
        if (record.type === 'childList') bump(probe.counts, `${probe.phase} #added`, record.addedNodes.length);
        else if (record.type === 'attributes') bump(probe.counts, `${probe.phase} #attributes`);
      }
    };
    probe.observer = new MutationObserver(take);
    probe.observer.observe(document.documentElement, {subtree: true, childList: true, attributes: true, characterData: true});
    probe.flush = () => take(probe.observer.takeRecords());
    // Layout reads while playing, by the first app module on the stack.
    const note = api => {
      if (!probe.recording) return;
      const frame = new Error().stack.split('\n').slice(2).find(line => /\/src\/.+\.mjs/.test(line)) ?? '';
      const match = /at (?:(?:async )?([\w$.<>]+) )?\(?[^()]*\/src\/(?:[\w-]+\/)*([\w-]+\.mjs):(\d+)/.exec(frame);
      const module = match?.[2] ?? 'unknown', fn = match?.[1] ?? '';
      const entry = readRatchet.find(entry => entry.module === module && (!entry.fn || fn.endsWith(entry.fn)) && (!entry.scenarios || entry.scenarios.includes(probe.scenario)));
      bump(entry ? probe.reads : probe.readOffenders, entry ? entry.id : `${api} in ${fn || '?'} (${module}:${match?.[3] ?? '?'})`);
    };
    const getter = (proto, name) => {
      const descriptor = Object.getOwnPropertyDescriptor(proto, name);
      Object.defineProperty(proto, name, {...descriptor, get() { note(name); return descriptor.get.call(this); }});
    };
    for (const name of ['offsetWidth', 'offsetHeight', 'offsetTop', 'offsetLeft', 'offsetParent']) getter(HTMLElement.prototype, name);
    for (const name of ['clientWidth', 'clientHeight', 'clientTop', 'clientLeft', 'scrollLeft', 'scrollTop', 'scrollWidth', 'scrollHeight']) getter(Element.prototype, name);
    for (const name of ['getBoundingClientRect', 'getClientRects']) {
      const original = Element.prototype[name];
      Element.prototype[name] = function (...args) { note(name); return original.apply(this, args); };
    }
    const computed = window.getComputedStyle;
    window.getComputedStyle = function (...args) { note('getComputedStyle'); return computed.apply(this, args); };
    // Long animation frames (Chromium).
    probe.longFrames = 0;
    try { new PerformanceObserver(list => { if (probe.recording) probe.longFrames += list.getEntries().filter(entry => entry.duration > 50).length; }).observe({type: 'long-animation-frame'}); } catch {}
  }, {allowed: ALLOWED, ratchet: RATCHET, readRatchet: READ_RATCHET});
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(metric => [metric.name, metric.value]));

  async function scenario(name, setup) {
    await setup?.();
    await page.waitForTimeout(800);
    await page.evaluate(name => { const probe = window.__quiet; probe.flush(); probe.scenario = name; probe.counts = {}; probe.offenders = {}; probe.reads = {}; probe.readOffenders = {}; probe.longFrames = 0; }, name);
    await page.evaluate(async () => { const probe = window.__quiet; probe.phase = 'start'; await window.styk.actions.play(); probe.flush(); probe.phase = 'playing'; probe.recording = true; });
    assert.equal(await page.evaluate(() => window.styk.state.playing), true, `${name}: playback started`);
    const before = await metrics(), drawsBefore = await page.evaluate(() => window.styk.state.drawCalls);
    await page.waitForTimeout(PLAY_MS);
    const after = await metrics(), drawsAfter = await page.evaluate(() => window.styk.state.drawCalls);
    await page.evaluate(async () => { const probe = window.__quiet; probe.flush(); probe.recording = false; probe.phase = 'stop'; await window.styk.actions.play(); probe.flush(); });
    await page.waitForTimeout(400);
    const result = await page.evaluate(() => { const probe = window.__quiet; probe.flush(); probe.phase = 'idle';
      return {counts: probe.counts, offenders: probe.offenders, reads: probe.reads, readOffenders: probe.readOffenders, longFrames: probe.longFrames,
        playing: window.styk.state.playing}; });
    assert.equal(result.playing, false, `${name}: playback stopped`);
    result.style = {recalcs: after.RecalcStyleCount - before.RecalcStyleCount, recalcMs: Math.round((after.RecalcStyleDuration - before.RecalcStyleDuration) * 10000) / 10,
      layouts: after.LayoutCount - before.LayoutCount, layoutMs: Math.round((after.LayoutDuration - before.LayoutDuration) * 10000) / 10};
    const fps = await page.evaluate(() => { const report = window.styk.editor.report; return report.frame_delay_ms ? 1000 / report.frame_delay_ms : report.fps; });
    result.draws = {count: drawsAfter - drawsBefore, budget: Math.ceil(PLAY_MS / 1000 * fps * DRAWS_PER_FRAME), fps};
    report.scenarios[name] = result;
    const playing = Object.fromEntries(Object.entries(result.offenders).filter(([key]) => key.startsWith('playing ') || key.startsWith('start ')));
    assert.deepEqual(playing, {}, `${name}: only the time readout, the playhead and the play button change while playing (new writers: ${JSON.stringify(playing)})`);
    assert.deepEqual(result.readOffenders, {}, `${name}: chrome reads no layout while playing (new readers: ${JSON.stringify(result.readOffenders)})`);
    const ticks = result.counts['playing time-display'] ?? 0;
    assert.ok(ticks <= Math.ceil(PLAY_MS / 1000 * TIME_DISPLAY_HZ) + 1, `${name}: #time-display changed ${ticks} times in ${PLAY_MS} ms`);
    assert.ok(ticks > 0, `${name}: #time-display follows playback`);
    assert.ok(result.draws.count <= result.draws.budget,
      `${name}: the canvas drew ${result.draws.count} times in ${PLAY_MS} ms at ${result.draws.fps} fps (budget ${result.draws.budget})`);
    for (const entry of [...RATCHET, ...READ_RATCHET].filter(entry => entry.always && (!entry.scenarios || entry.scenarios.includes(name)))) {
      const seen = entry.module ? result.reads[entry.id] : Object.keys(result.counts).some(key => key.endsWith(` ${entry.id}`));
      assert.ok(seen, `${name}: ${entry.id} no longer happens during playback; remove it from the ratchet (until ${entry.until})`);
    }
    report.checks.push(`${name}: quiet (time readout ${ticks}×, ${result.draws.count} draws of ${result.draws.budget}, style ${result.style.recalcs} recalcs / ${result.style.recalcMs} ms, ${result.longFrames} long frames)`);
    console.log('PASS', report.checks.at(-1));
    return result;
  }

  const advanced = await scenario('advanced', () => page.evaluate(() => window.styk.settingsUI.commit({timelineMode: 'advanced'})));
  const added = advanced.counts['playing #added'] ?? 0, attributes = advanced.counts['playing #attributes'] ?? 0;
  assert.ok(added <= BASELINE.advanced.nodes * 0.1 && attributes <= BASELINE.advanced.attributes * 0.1,
    `Advanced playback mutations are at least 90% below the pre-M3a baseline (${added} nodes, ${attributes} attributes)`);
  report.checks.push(`advanced: ${added} nodes and ${attributes} attribute writes (baseline ${BASELINE.advanced.nodes} and ${BASELINE.advanced.attributes})`);
  console.log('PASS', report.checks.at(-1));
  await scenario('simple', () => page.evaluate(() => window.styk.settingsUI.commit({timelineMode: 'simple'})));
  // The Simple cards stayed still while playing; at the stop they catch up: the card playback stopped in is current,
  // selected and in view, and the playhead line is gone.
  await page.waitForFunction(() => { const t = window.styk.timeline, card = t.cards.get(t.selectedIndex); return card?.dataset.current === 'true'; }, null, {timeout: 5000});
  assert.ok(await page.evaluate(() => {
    const t = window.styk.timeline, card = t.cards.get(t.selectedIndex).getBoundingClientRect(), strip = t.strip.getBoundingClientRect();
    return t.selected.has(t.selectedIndex) && card.left >= strip.left - 1 && card.right <= strip.right + 1 && t.playhead.style.visibility === 'hidden';
  }), 'simple: the cards catch up when playback stops');
  report.checks.push('simple: the cards catch up when playback stops');
  console.log('PASS', report.checks.at(-1));
  await scenario('camera', async () => {
    await page.evaluate(() => window.styk.settingsUI.commit({timelineMode: 'advanced'}));
    await page.waitForTimeout(300);
    await page.evaluate(() => window.styk.actions['toggle-camera']());
    assert.equal(await page.evaluate(() => window.styk.state.inspectorContext), 'camera');
  });
  assert.deepEqual(errors, []);
} finally {
  report.errors = errors;
  await mkdir('artifacts/playback-quiet', {recursive: true});
  await writeFile('artifacts/playback-quiet/report.json', JSON.stringify(report, null, 1) + '\n');
  await browser.close();
}
