// Drives today's app (Chrome, through the DevTools Input domain and synthetic pointer events) with pen events and
// records what the JavaScript drawing controller makes of them: the brush it posted, how it maps window pixels to cel
// pixels, and a hash of every tile of the cel after the stroke, after undo, after redo and after a save and reopen.
// `engine/crates/styk-core/tests/pen_parity.rs` replays the same events through the native input path and compares.
//
//   node scripts/serve.mjs --port 47839 &        (the app from source)
//   STYK_URL=http://127.0.0.1:47839 node scripts/pen-parity-capture.mjs <out.json> [--runs 2]
//
// With --runs 2 the capture is made twice and the differences between the two runs (the old-versus-old baseline) are
// listed in the file: only fields that differ there may differ natively.
import {chromium} from '../tests/support/playwright.mjs';
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';

const out = process.argv[2];
if (!out) throw new Error('usage: node scripts/pen-parity-capture.mjs <out.json> [--runs N]');
const runsAt = process.argv.indexOf('--runs');
const runs = runsAt >= 0 ? Number(process.argv[runsAt + 1]) : 1;
const url = process.env.STYK_URL || 'http://127.0.0.1:47839';

/** The pen path: a sine across the stage with a pressure ramp and a tilt sweep, as pointer events. */
function sineStroke(x0, x1, y, {samples = 120, amplitude = 40, hover = 4} = {}) {
  const events = [];
  let t = 0;
  const point = u => ({x: x0 + (x1 - x0) * u, y: y + amplitude * Math.sin(2 * Math.PI * 2.5 * u)});
  for (let i = 0; i < hover; i++) events.push({t: t += 4, type: 'move', ...point(0), pressure: 0, tiltX: -50, tiltY: 20, buttons: 0});
  for (let i = 0; i < samples; i++) {
    const u = i / (samples - 1);
    events.push({t: t += 4, type: i === 0 ? 'down' : 'move', ...point(u), pressure: Math.fround(0.1 + 0.9 * u), tiltX: Math.round(-50 + 100 * u), tiltY: Math.round(20 - 40 * u), buttons: 1});
  }
  events.push({t: t += 4, type: 'up', ...point(1), pressure: 0, tiltX: 0, tiltY: 0, buttons: 0});
  return events;
}

/** A scenario: how the stage is set up, the events, and how the stroke ends. */
const scenarios = [
  {name: 'plain', view: null, mirror: false, end: 'up'},
  {name: 'zoomed-and-panned', view: {scale: 2.5, dx: 37, dy: -21}, mirror: false, end: 'up'},
  {name: 'mirrored', view: null, mirror: true, end: 'up'},
  {name: 'interrupted', view: null, mirror: false, end: 'lostcapture'},
  // A flat tip that turns with the pen's tilt: the lean reaches the pixels.
  {name: 'tilt-angle', view: {scale: 1.7, dx: -11, dy: 9}, mirror: false, end: 'up', settings: {angleMode: 'tilt', roundness: 0.35}},
  {name: 'discarded', view: null, mirror: false, end: 'escape'},
];

async function capture(browser, scenario) {
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => window.styk?.ready);
  await page.evaluate(() => { styk.state.settings.autosaveSeconds = 0; });
  await page.locator('[data-workspace-mode="draw"]').click();
  await page.locator('[data-draw-action="new"]').first().click();
  await page.locator('[data-tool="drawing-brush"]').click();
  await page.evaluate(({view, mirror, settings}) => {
    Object.assign(styk.drawing.settings, {preset: 'ink', size: 24, color: '#202020', opacity: 1, flow: 1, hardness: 1, pressureSize: true, pressureOpacity: false, stabilization: 0, texture: 0, scatter: 0, roundness: 1, blend: 'normal', alphaLock: false, mirrorX: mirror, mirrorY: false, ...settings});
    if (view) { styk.state.view.scale = view.scale; styk.state.view.x += view.dx; styk.state.view.y += view.dy; }
    // What the controller hands its stroke worker: the brush, exactly.
    const worker = styk.drawing.owner.strokeWorker, post = worker.post.bind(worker);
    window.__begin = null;
    worker.post = message => { if (message.kind === 'begin') window.__begin = structuredClone(message.settings); return post(message); };
    const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
    window.__tiles = async () => {
      const target = styk.editor.drawingTarget();
      if (!target.figure) return [];
      const store = (await styk.drawing.owner.surface(target.figure)).store, rows = [];
      for (const tile of store) rows.push([tile.tx, tile.ty, await hash(tile.pixels)]);
      return rows.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    };
    window.__settle = () => new Promise(resolve => { const wait = () => styk.drawing.gesture || styk.drawing.operation || styk.drawing.loading ? setTimeout(wait, 10) : resolve(); wait(); });
  }, scenario);
  // The events as the app received them: the browser rounds positions to single precision and stamps its own times.
  await page.evaluate(() => {
    window.__seen = [];
    for (const type of ['pointerdown', 'pointermove', 'pointerup']) window.addEventListener(type, e => { if (e.target.id === 'overlay') window.__seen.push({type: e.type.slice(7), x: e.clientX, y: e.clientY, pressure: e.pressure, tiltX: e.tiltX, tiltY: e.tiltY, buttons: e.buttons, t: e.timeStamp}); }, {capture: true});
  });
  const cdp = await page.context().newCDPSession(page);
  const box = await page.locator('#viewport').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const events = sineStroke(cx - 300, cx + 300, cy);
  const send = (type, e) => cdp.send('Input.dispatchMouseEvent', {type, x: e.x, y: e.y, button: type === 'mouseMoved' && !e.buttons ? 'none' : 'left', buttons: e.buttons, clickCount: type === 'mouseMoved' ? 0 : 1, pointerType: 'pen', force: e.pressure, tiltX: e.tiltX, tiltY: e.tiltY});
  const dispatched = [];
  let mapping = null;
  const readMapping = () => page.evaluate(async () => {
    const {cameraMatrix} = await import('/src/renderer-geometry.mjs'), d = styk.drawing, r = d.viewRect();
    const target = d.gesture?.session ? null : styk.editor.drawingTarget(), report = styk.editor.report;
    const camera = cameraMatrix({report, frame: styk.editor.evaluatedFrame, view: styk.state.view, cameraEnabled: false});
    // The stage's offset in the window and the ratio of its client size to its rectangle, then the camera.
    return {rect: [r.left, r.top, r.clientWidth / r.width, r.clientHeight / r.height], camera: [...camera], pixel_matrix: d.gesture?.session?.matrix ?? d.pixelMatrix(target), canvas: [report.canvas_width, report.canvas_height]};
  });
  if (scenario.end === 'lostcapture') {
    // A synthetic pointer: capture is stubbed, and losing it is a lostpointercapture event.
    await page.evaluate(async ({events}) => {
      const overlay = document.getElementById('overlay'), real = {set: overlay.setPointerCapture, has: overlay.hasPointerCapture, release: overlay.releasePointerCapture};
      let held = false;
      overlay.setPointerCapture = function (id) { if (id === 77) { held = true; return; } return real.set.call(this, id); };
      overlay.hasPointerCapture = function (id) { return id === 77 ? held : real.has.call(this, id); };
      overlay.releasePointerCapture = function (id) { if (id === 77) { held = false; return; } return real.release.call(this, id); };
      const fire = (type, e) => overlay.dispatchEvent(new PointerEvent(type, {pointerId: 77, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true, clientX: e.x, clientY: e.y, button: type === 'pointermove' ? -1 : 0, buttons: e.buttons, pressure: e.pressure, tiltX: e.tiltX, tiltY: e.tiltY}));
      const half = events.findIndex(e => e.type === 'down') + 60;
      for (const [i, e] of events.entries()) {
        if (i > half) break;
        fire(e.type === 'down' ? 'pointerdown' : 'pointermove', e);
        await new Promise(r => setTimeout(r, 2));
      }
      fire('lostpointercapture', events[half]);
      await window.__settle();
      Object.assign(overlay, {setPointerCapture: real.set, hasPointerCapture: real.has, releasePointerCapture: real.release});
    }, {events});
    dispatched.push(...events.slice(0, events.findIndex(e => e.type === 'down') + 61));
  } else {
    const half = scenario.end === 'escape' ? events.findIndex(e => e.type === 'down') + 60 : events.length;
    for (const [i, e] of events.entries()) {
      if (i >= half) break;
      await send(e.type === 'down' ? 'mousePressed' : e.type === 'up' ? 'mouseReleased' : 'mouseMoved', e);
      dispatched.push(e);
    }
    if (scenario.end === 'escape') {
      // The cel's pose is read while the stroke still holds its target.
      mapping = await readMapping();
      await page.keyboard.press('Escape');
    }
  }
  await page.evaluate(() => window.__settle());
  mapping ??= await readMapping();
  const brush = await page.evaluate(() => window.__begin);
  const received = await page.evaluate(() => window.__seen);
  const expect = {};
  expect.commit = await page.evaluate(() => window.__tiles());
  expect.undoLabel = await page.evaluate(() => styk.editor.undoLabel);
  if (scenario.end !== 'escape') {
    await page.evaluate(() => styk.drawing.history('undo'));
    expect.undo = await page.evaluate(() => window.__tiles());
    await page.evaluate(() => styk.drawing.history('redo'));
    expect.redo = await page.evaluate(() => window.__tiles());
    expect.reopen = await page.evaluate(async () => {
      const {DocumentExporter} = await import('/src/document-export.mjs'), {ImportClient} = await import('/src/import-client.mjs'), exporter = new DocumentExporter();
      try {
        const e = styk.editor, blob = await exporter.export(e.report, {format: 'styk', getRevision: () => e.revision});
        const read = await new ImportClient().importFile(new File([blob], 'pen-parity.styk'));
        e.load(read.document);
      } finally { exporter.dispose(); }
      return window.__tiles();
    });
  }
  await page.close();
  return {name: scenario.name, view: scenario.view, mirror: scenario.mirror, end: scenario.end, brush_json: JSON.stringify(brush), mapping, events: received, expect, errors};
}

const diff = (a, b, path = '') => {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a)) return Object.keys({...a, ...b}).flatMap(k => diff(a[k], b[k], `${path}/${k}`));
  return [path || '/'];
};

const browser = await chromium.launch({channel: 'chrome', headless: true});
try {
  const results = [];
  for (const scenario of scenarios) {
    const captures = [];
    for (let run = 0; run < runs; run++) captures.push(await capture(browser, scenario));
    const baseline = runs > 1 ? diff(captures[0], captures[1]) : [];
    results.push({...captures[0], oldVersusOld: baseline});
    console.log(scenario.name, 'tiles', captures[0].expect.commit.length, 'old-versus-old differences', baseline.length ? baseline.join(' ') : 'none');
  }
  writeFileSync(out, JSON.stringify({sha: createHash('sha256').update(JSON.stringify(results)).digest('hex'), scenarios: results}));
} finally {
  await browser.close();
}
