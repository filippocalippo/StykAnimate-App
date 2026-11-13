// A held frame step in a scene whose editing frame is dear: from the press on the steps show prepared frames and read no frame, and
// the key up draws the exact editing frame of the tick the run reached; an ordinary scene steps exactly at every step
// (docs/TIMELINE.md, "Stepping through a dense scene"). Real key events through the page. Needs the development server (npm run serve).
import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
const browser = await chromium.launch({channel: 'chrome', headless: true});
const page = await browser.newPage({viewport: {width: 1560, height: 1000}});
const errors = []; page.on('pageerror', error => errors.push(error.message));
const sleep = ms => page.waitForTimeout(ms);
/** The scene taken as dear (as the paints of a dense scene would have it) or not, the playhead at `tick`, the log emptied. */
const dense = (tick, dear = true) => page.evaluate(({tick, dear}) => {
  window.stepDear = dear;
  styk.editor.seek(tick);
  stepLog.draws.length = 0; stepLog.reads = 0;
}, {tick, dear});
const settled = tick => page.waitForFunction(tick => styk.state.lastEditingPresentation?.tick === tick && !styk.state.dirtyRender, tick, {timeout: 15000})
  .catch(async error => { throw new Error(`the exact frame of tick ${tick} was not drawn: ${JSON.stringify(await page.evaluate(() => ({tick: styk.editor.tick, shown: styk.state.lastEditingPresentation, dirty: styk.state.dirtyRender, focus: document.activeElement?.id, draws: stepLog.draws.slice(-5)})))}`, {cause: error}); });
/** The playhead at `tick`, moved there by a step of a run (the stage shows prepared frames until the run ends). */
const landed = tick => page.waitForFunction(tick => styk.editor.tick === tick && styk.scrub.preview.active, tick, {timeout: 15000});
/**
 * `key` pressed, then (after the first step landed: drawn exactly in an ordinary scene, `exact`) auto-repeated `repeats` times about 30 a
 * second, and released. Returns the draws of the first step, of the repeats and after the key up, and the reads of the frame on show while
 * the run steered the playhead.
 */
async function hold(key, repeats, {focus = '#viewport', first, exact = false} = {}) {
  await page.evaluate(selector => document.querySelector(selector).focus({preventScroll: true}), focus);
  // A step within a quarter of a second of the last one would join its run: the press is a first step.
  await sleep(400);
  await page.evaluate(() => { stepLog.draws.length = 0; stepLog.reads = 0; });
  const keys = key.split('+'), main = keys.at(-1);
  for (const modifier of keys.slice(0, -1)) await page.keyboard.down(modifier);
  await page.keyboard.down(main);
  if (first !== undefined) await (exact ? settled(first) : landed(first));
  const firstDraws = await page.evaluate(() => stepLog.draws.splice(0));
  // Playwright sends a key pressed again before its release as the keyboard's auto-repeat.
  for (let i = 0; i < repeats; i++) { await page.keyboard.down(main); await sleep(33); }
  const during = await page.evaluate(() => ({draws: stepLog.draws.splice(0), reads: stepLog.reads, steering: styk.scrub.preview.active, tick: styk.editor.tick}));
  await page.keyboard.up(main);
  for (const modifier of keys.slice(0, -1).reverse()) await page.keyboard.up(modifier);
  await settled(during.tick);
  const after = await page.evaluate(() => ({draws: stepLog.draws.splice(0), steering: styk.scrub.preview.active, tick: styk.editor.tick}));
  return {first: firstDraws, during, after};
}
try {
  await page.goto(process.env.STYK_URL || 'http://127.0.0.1:47831'); await page.waitForFunction(() => window.styk?.ready);
  await page.evaluate(async () => {
    const {editor, state} = styk, {createDemo} = await import('/src/demo.mjs');
    styk.settingsUI.commit({timelineMode: 'advanced'}); editor.load(createDemo()); state.onion = true;
    const log = window.stepLog = {draws: [], reads: 0};
    const renderer = state.renderer, render = renderer.render.bind(renderer), prepared = renderer.renderPrepared.bind(renderer);
    renderer.render = request => { const drawn = render(request); log.draws.push({kind: 'edit', tick: editor.tick, onions: Boolean(request.onions), drawn}); return drawn; };
    renderer.renderPrepared = (key, frame) => { const drawn = prepared(key, frame); log.draws.push({kind: 'prepared', tick: Number(key.split(':').at(-1)), drawn}); return drawn; };
    // A read of the frame on show or its geometry that is not already cached evaluates the whole frame on this thread.
    for (const name of ['evaluatedFrame', 'geometry']) {
      let owner = editor; while (!Object.getOwnPropertyDescriptor(owner, name)) owner = Object.getPrototypeOf(owner);
      const get = Object.getOwnPropertyDescriptor(owner, name).get;
      Object.defineProperty(editor, name, {configurable: true, get() {
        if (styk.scrub.preview.active && !(name === 'evaluatedFrame' ? this._evaluated : this._geometry)) log.reads++;
        return get.call(this);
      }});
    }
  });
  await settled(0);
  const total = await page.evaluate(() => styk.editor.totalTicks);
  assert.ok(total > 40, `the demo has room for a run (${total} ticks)`);
  assert.equal(await page.evaluate(() => styk.scrub.costs.dear(styk.editor.report)), false, 'the demo paints a new tick in a few milliseconds');
  // The rule is asked at a step outside a run, and the demo's paints are cheap: the test answers for it.
  await page.evaluate(() => { styk.scrub.costs.dear = report => report === styk.editor.report && window.stepDear; });

  // An ordinary scene: every step of a held key draws the exact editing frame, onion skins included; nothing is prepared for it.
  await dense(0, false);
  let run = await hold('Period', 12, {first: 1, exact: true});
  assert.equal(run.during.steering, false);
  assert.equal(run.after.tick, 13, 'every step lands');
  const ordinary = [...run.first, ...run.during.draws, ...run.after.draws].filter(draw => draw.drawn);
  assert.ok(ordinary.every(draw => draw.kind === 'edit' && draw.onions), 'an ordinary scene steps as editing');
  assert.ok(new Set(ordinary.map(draw => draw.tick)).size > 6, 'the editing frame follows the steps');

  // A dense scene: the press and its repeats show prepared frames and read nothing, the key up draws the exact frame.
  await dense(0);
  await settled(0);
  await page.evaluate(() => { stepLog.draws.length = 0; });
  run = await hold('Period', 24, {first: 1});
  assert.deepEqual(run.first.filter(draw => draw.kind === 'edit'), [], 'the press draws no editing frame: its picture is a prepared frame');
  assert.equal(run.during.steering, true, 'the press and the repeats steer the playhead');
  assert.deepEqual(run.during.draws.filter(draw => draw.kind === 'edit'), [], 'no editing frame is drawn until the run ends');
  assert.equal(run.during.reads, 0, 'nothing reads the frame on show during the run');
  const shown = [...run.first, ...run.during.draws].filter(draw => draw.drawn).map(draw => draw.tick);
  assert.ok(shown.length >= 1, 'prepared frames are shown during the run');
  assert.deepEqual(shown, [...shown].sort((a, b) => a - b), `a forward run never shows an older tick after a newer one (${shown})`);
  assert.equal(run.after.steering, false);
  assert.equal(run.after.tick, 25, 'every step lands');
  const firstAfter = run.after.draws.find(draw => draw.drawn);
  assert.deepEqual(firstAfter, {kind: 'edit', tick: 25, onions: true, drawn: true}, 'the key up draws the exact editing frame of the last tick');
  assert.ok(run.after.draws.every(draw => draw.kind === 'edit'), 'no prepared frame is shown after the run');
  await page.screenshot({path: 'artifacts/step-dense-release.png'});

  // Backward, into the start of the timeline: the steps stop on the first tick, as they do one at a time.
  await dense(10);
  await settled(10);
  run = await hold('Comma', 20, {first: 9});
  assert.equal(run.during.reads, 0);
  assert.equal(run.after.tick, 0);
  const back = run.during.draws.filter(draw => draw.drawn).map(draw => draw.tick);
  assert.deepEqual(back, [...back].sort((a, b) => b - a), `a backward run never shows a later tick after an earlier one (${back})`);
  // Forward past the end, a loop range set: the steps stop on the last tick, as they do one at a time; the range is playback's only.
  await page.evaluate(total => { styk.state.loopRange = {startTick: 5, endTick: 20}; }, total);
  await dense(total - 8);
  await settled(total - 8);
  run = await hold('Period', 16, {first: total - 7});
  assert.equal(run.during.reads, 0);
  assert.equal(run.after.tick, total - 1);
  assert.deepEqual(run.after.draws.find(draw => draw.drawn), {kind: 'edit', tick: total - 1, onions: true, drawn: true});
  await page.evaluate(() => { styk.state.loopRange = null; });

  // The keyframe steps land on the keyframes, held as pressed one at a time.
  const keyTicks = await page.evaluate(() => styk.editor.timeline.map(row => row.start));
  await dense(0);
  await settled(0);
  run = await hold('Shift+Period', 6, {first: keyTicks[1]});
  assert.equal(run.during.reads, 0);
  assert.equal(run.after.tick, keyTicks[7], 'seven keyframe steps');
  assert.ok(run.during.draws.every(draw => draw.kind === 'prepared' && keyTicks.includes(draw.tick)), 'only keyframes are passed');

  // A tap is a run that ends a quarter of a second after it, with the exact frame of its tick; taps closer than that are one run; another
  // command's key ends it first, so the command acts on the exact frame.
  await dense(0);
  await settled(0);
  await page.evaluate(() => document.querySelector('#viewport').focus({preventScroll: true}));
  await sleep(400);
  await page.evaluate(() => { stepLog.draws.length = 0; });
  await page.keyboard.press('Period'); await settled(1);
  const tapped = (await page.evaluate(() => stepLog.draws)).filter(draw => draw.kind === 'edit' && draw.drawn).map(draw => draw.tick);
  assert.ok(tapped.length > 0 && tapped.every(tick => tick === 1), `a lone tap draws the exact frame of its tick when its run ends (${tapped})`);
  await page.keyboard.press('Period'); await page.keyboard.press('Period');
  assert.equal(await page.evaluate(() => styk.scrub.preview.active), true, 'quick taps steer the playhead');
  await page.evaluate(() => { stepLog.draws.length = 0; });
  await page.keyboard.press('End');
  assert.deepEqual(await page.evaluate(() => ({steering: styk.scrub.preview.active, scrubbing: styk.state.scrubbing})), {steering: false, scrubbing: false},
    'another key ends the run before its command');
  await settled(total - 1);
  assert.ok((await page.evaluate(() => stepLog.draws)).every(draw => draw.kind === 'edit'));

  // On the timeline, a layer's cell selected: the steps select the cell of each tick; the layer's figures are found once, at the end.
  await dense(0);
  await settled(0);
  const layer = await page.evaluate(() => { const timeline = styk.timeline, row = timeline.tracks.findIndex(track => track.kind === 'layer');
    timeline._selectCell({row, tick: 0}); return {row, id: timeline.tracks[row].id, sheet: Boolean(styk.editor.report._styk.layerSheet)}; });
  await page.evaluate(() => { stepLog.draws.length = 0; stepLog.reads = 0; });
  run = await hold('Period', 12, {focus: '.sheet-scroll', first: 1});
  assert.equal(run.during.steering, true);
  assert.equal(run.during.reads, 0, 'the selected layer\'s figures are not looked up at each step');
  assert.equal(run.after.tick, 13);
  const selection = await page.evaluate(id => { const {editor, timeline} = styk;
    return {cell: [timeline.start, timeline.end, timeline.selectedTrackId], selected: [...editor.selectedUids].sort(),
      expected: editor.evaluatedFrame.objects.filter(object => editor.layerForUid(object.unique_id) === id).map(object => object.unique_id).sort()}; }, layer.id);
  assert.deepEqual(selection.cell, [13, 13, layer.id], 'the cell of the last tick is selected');
  if (layer.sheet) assert.deepEqual(selection.selected, selection.expected, 'the selection is the layer\'s figures at the last tick');

  // The Simple timeline steps from card to card the same way.
  await page.evaluate(() => styk.settingsUI.commit({timelineMode: 'simple'}));
  await page.waitForFunction(() => Boolean(styk.timeline?.strip));
  await dense(0);
  await settled(0);
  const cards = await page.evaluate(() => styk.timeline.times.slice());
  run = await hold('Period', 8, {first: cards[1]});
  assert.equal(run.during.steering, true);
  assert.equal(run.during.reads, 0);
  assert.equal(run.after.tick, cards[9]);
  assert.equal(await page.evaluate(() => styk.timeline.selectedIndex), 9);
  assert.deepEqual(run.after.draws.find(draw => draw.drawn)?.kind, 'edit');

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({shown, back}));
} finally { await browser.close(); }
