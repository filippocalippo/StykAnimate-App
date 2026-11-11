// A playhead drag in a scene whose editing frame is dear shows prepared frames and reads no frame until the release; an ordinary
// scene scrubs as editing (docs/TIMELINE.md, "Scrubbing a dense scene"). Needs the development server (npm run serve).
import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
const browser = await chromium.launch({channel: 'chrome', headless: true});
const page = await browser.newPage({viewport: {width: 1560, height: 1000}});
const errors = []; page.on('pageerror', error => errors.push(error.message));
/** The transport's readout against the playhead it should show. */
const readout = () => page.evaluate(() => { const {tick, report: {fps}} = styk.editor, two = value => String(value).padStart(2, '0');
  return {shown: document.getElementById('time-display').textContent, playhead: `${two(Math.floor(tick / fps / 60))}:${two(Math.floor(tick / fps) % 60)}:${two(tick % fps)}`}; });
const drag = async (from, to) => {
  const box = await page.locator('.sheet-scroll').boundingBox();
  await page.mouse.move(box.x + from, box.y + 15); await page.mouse.down();
  for (let step = 1; step <= 24; step++) { await page.mouse.move(box.x + from + (to - from) * step / 24, box.y + 15); await page.waitForTimeout(16); }
};
try {
  await page.goto(process.env.STYK_URL || 'http://127.0.0.1:47831'); await page.waitForFunction(() => window.styk?.ready);
  await page.evaluate(async () => {
    const {editor, state} = styk, {createDemo} = await import('/src/demo.mjs');
    styk.settingsUI.commit({timelineMode: 'advanced'}); editor.load(createDemo()); editor.selectMany([1]); state.onion = true;
    const log = window.scrubLog = {draws: [], reads: 0};
    const renderer = state.renderer, render = renderer.render.bind(renderer), prepared = renderer.renderPrepared.bind(renderer);
    renderer.render = request => { const drawn = render(request); log.draws.push({kind: 'edit', tick: editor.tick, scrubbing: state.scrubbing, onions: Boolean(request.onions), drawn}); return drawn; };
    renderer.renderPrepared = (key, frame) => { const drawn = prepared(key, frame); log.draws.push({kind: 'prepared', tick: Number(key.split(':').at(-1)), scrubbing: state.scrubbing, cameraEnabled: frame.cameraEnabled, drawn}); return drawn; };
    // A read of the frame on show or its geometry that is not already cached evaluates the whole frame on this thread.
    for (const name of ['evaluatedFrame', 'geometry']) {
      let owner = editor; while (!Object.getOwnPropertyDescriptor(owner, name)) owner = Object.getPrototypeOf(owner);
      const get = Object.getOwnPropertyDescriptor(owner, name).get;
      Object.defineProperty(editor, name, {configurable: true, get() {
        if (state.scrubbing && !(name === 'evaluatedFrame' ? this._evaluated : this._geometry)) log.reads++;
        return get.call(this);
      }});
    }
  });
  await page.waitForFunction(() => styk.state.lastEditingPresentation?.tick === 0);

  // An ordinary scene: the editing frame, onion skins included, follows the playhead, and nothing is prepared for it.
  assert.equal(await page.evaluate(() => styk.scrub.costs.dear(styk.editor.report)), false, 'the demo paints a new tick in a few milliseconds');
  await drag(700, 960);
  await page.waitForFunction(() => scrubLog.draws.some(draw => draw.scrubbing && draw.kind === 'edit' && draw.onions && draw.tick > 0));
  let time = await readout();
  assert.equal(time.shown, time.playhead, 'the time readout follows the playhead while it is dragged');
  await page.mouse.up();
  let draws = await page.evaluate(() => scrubLog.draws.filter(draw => draw.scrubbing));
  assert.ok(draws.length > 1 && draws.every(draw => draw.kind === 'edit' && draw.onions), 'an ordinary scrub is editing, with onion skins');

  // The same scene, measured as dear: prepared frames while the playhead is dragged, the exact editing frame on release.
  await page.evaluate(() => {
    const {editor} = styk; editor.seek(0);
    for (const tick of [-1, -2, -3]) styk.scrub.costs.record(editor.report, tick, 100);
    scrubLog.draws.length = 0; scrubLog.reads = 0;
  });
  assert.equal(await page.evaluate(() => styk.scrub.costs.dear(styk.editor.report)), true);
  await drag(160, 960);
  await page.waitForFunction(() => scrubLog.draws.filter(draw => draw.kind === 'prepared' && draw.drawn).length >= 2, null, {timeout: 20000});
  const during = await page.evaluate(() => ({active: styk.scrub.preview.active, draws: scrubLog.draws.filter(draw => draw.scrubbing), reads: scrubLog.reads}));
  assert.equal(during.active, true);
  time = await readout();
  assert.equal(time.shown, time.playhead, 'the time readout follows the playhead of a dense scrub too');
  assert.deepEqual(during.draws.filter(draw => draw.kind === 'edit'), [], 'the editing frame waits for the release');
  assert.equal(during.reads, 0, 'nothing reads the frame on show while the playhead is dragged');
  assert.ok(during.draws.every(draw => draw.cameraEnabled === false), 'prepared frames are shown in the editing view, not through the scene camera');
  const shownTicks = during.draws.filter(draw => draw.drawn).map(draw => draw.tick);
  assert.deepEqual(shownTicks, [...shownTicks].sort((a, b) => a - b), `a forward drag never shows an older tick after a newer one (${shownTicks})`);
  await page.evaluate(() => { scrubLog.released = scrubLog.draws.length; });
  await page.mouse.up();
  await page.waitForFunction(() => scrubLog.draws.slice(scrubLog.released).some(draw => !draw.scrubbing && draw.drawn));
  const released = await page.evaluate(() => ({tick: styk.editor.tick, active: styk.scrub.preview.active, after: scrubLog.draws.slice(scrubLog.released).filter(draw => !draw.scrubbing)}));
  assert.equal(released.active, false);
  assert.ok(released.after.every(draw => draw.kind === 'edit'), 'no prepared frame is shown after the release');
  const first = released.after.find(draw => draw.drawn);
  assert.deepEqual({kind: first.kind, tick: first.tick, onions: first.onions}, {kind: 'edit', tick: released.tick, onions: true}, 'the release draws the exact editing frame');
  await page.screenshot({path: 'artifacts/scrub-dense-release.png'});

  // A new document is measured anew: it scrubs as editing until its own paints say otherwise.
  await page.evaluate(async () => { const {createDemo} = await import('/src/demo.mjs'); styk.editor.load(createDemo()); });
  await page.waitForFunction(() => styk.state.lastEditingPresentation?.tick === 0);
  assert.equal(await page.evaluate(() => styk.scrub.costs.dear(styk.editor.report)), false);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({shownTicks, release: first}));
} finally { await browser.close(); }
