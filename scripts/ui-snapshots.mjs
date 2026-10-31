/**
 * Deterministic screenshots of the running editor, for reviewing UI changes and
 * proving that a refactor is pixel-neutral.
 *
 *   node scripts/ui-snapshots.mjs --url http://127.0.0.1:47910 --label m0-before
 *   node scripts/ui-snapshots.mjs --url http://127.0.0.1:47910 --label m0-after --compare m0-before
 *   node scripts/ui-snapshots.mjs --label m0-after --compare m0-before --no-capture
 *
 * Options:
 *   --url <origin>       running editor (npm run serve); default http://127.0.0.1:47831
 *   --label <name>       output folder under --out; required
 *   --compare <label>    compare with an earlier label: changed pixel counts and diff PNGs
 *   --no-capture         only compare two existing labels
 *   --allow-diff         exit 0 even when images differ
 *   --sizes <WxH,…>      default 1440x900,1280x720,1024x700,800x600
 *   --themes <a,b>       default light,dark
 *   --only <text,…>      capture only shots whose name contains one of these
 *   --touch              also capture the touch interface: a phone and a tablet, upright and on
 *                        their side (touch emulation at 2× density), in the states marked for it
 *   --chrome-only        with --compare, ignore pixels inside the stage and other pictures the
 *                        engine draws (CHROME_MASKS); the full comparison is still written
 *   --out <dir>          default artifacts/ui-redesign/snapshots
 *
 * The matrix is theme × state × size. States are Animate, Draw and the open
 * Audio panel with the Advanced and Simple timeline, Build (which hides the
 * timeline), and overlays
 * on the Advanced default: figure, joint and polygon inspector, File menu,
 * Insert, onion settings, every Settings tab, Export, the text dialog and the
 * feedback shell (mock desktop bridge).
 *
 * Determinism: every image gets a fresh browser context at its final size with
 * seeded settings (Canvas 2D renderer, English), the fixed demo document, a
 * frozen render-time readout, no pointer movement (so no hover), CSS animations
 * disabled and the caret hidden, and it is retaken until three consecutive
 * captures match. GPU rasterization still anti-aliases an occasional edge
 * differently between runs, so with --compare an image that differs is
 * recaptured up to twice and counts as changed only if every capture differs.
 */
import {chromium} from '../tests/support/playwright.mjs';
import {mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const args = parseArgs(process.argv.slice(2));
const list = (value, fallback) => (value ?? fallback).split(',').map(item => item.trim()).filter(Boolean);
const url = args.url ?? process.env.STYK_URL ?? 'http://127.0.0.1:47831';
const out = path.resolve(root, args.out ?? 'artifacts/ui-redesign/snapshots');
const label = args.label;
const safe = /^[\w.-]+$/;
if (!label || !safe.test(label) || (args.compare && !safe.test(args.compare)))
  fail('Use --label <name> (letters, digits, dot, dash, underscore), optionally with --compare <label>.');
const sizes = list(args.sizes, '1440x900,1280x720,1024x700,800x600').map(size => {
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) fail(`Invalid size ${size}; use WIDTHxHEIGHT.`);
  return {width: Number(match[1]), height: Number(match[2]), name: size};
});
const themes = list(args.themes, 'light,dark');
const only = args.only ? list(args.only) : null;
// The touch layouts of docs/TOUCH.md: a phone and a tablet, upright and on their side.
const TOUCH_SIZES = [['phone-portrait', 390, 780], ['phone-landscape', 780, 390], ['tablet-portrait', 820, 1180], ['tablet-landscape', 1180, 820]]
  .map(([layout, width, height]) => ({width, height, name: `${layout}-${width}x${height}`, touch: true}));
if (args.touch) sizes.push(...TOUCH_SIZES);
// Pictures the engine draws (the stage, thumbnails, previews). --chrome-only ignores their pixels,
// so a comparison can show that the interface around them did not change.
const CHROME_MASKS = ['#viewport', '.sheet-filmstrip canvas', '.sheet-filmstrip img', '.project-tab img', '.project-tab canvas',
  '.home canvas', '.home img', '#camera-monitor', '.library-preview', '#user-library img', '#user-library canvas',
  '#export-dialog canvas', '#export-dialog img', '#insert-dialog canvas', '#insert-dialog img', '.simple-timeline canvas', '.simple-timeline img'];

const WALKER = 1;          // createDemo(): the walker, the locked ground and the ball are uids 1-3.
const WALKER_JOINT = 4;
const FROZEN_TEXT = {'render-time': '—'};  // Time-based readouts, by element id.
const SETTINGS_TABS = ['interface', 'canvas', 'animation', 'shortcuts'];
const STABLE_CAPTURES = 3;  // Identical captures 250 ms apart before an image counts as settled.
const RECHECKS = 2;         // Fresh recaptures of a differing image before it counts as changed.

const click = selector => page => page.evaluate(selector => {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  element.click();
}, selector);
const waitFor = (selector, state = 'visible') => page => page.locator(selector).first().waitFor({state, timeout: 10000});
const workspace = mode => async page => {
  await click(`[data-workspace-mode="${mode}"]`)(page);
  await page.waitForFunction(mode => document.querySelector('.workspace')?.dataset.mode === mode, mode, {timeout: 10000});
};
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
// Selection updates the inspector on the next frame.
const select = (uid, joint = -1) => async page => {
  await page.evaluate(([uid, joint]) => window.styk.editor.select(uid, joint), [uid, joint]);
  await frames(page);
};
// Runs one of the app's commands without waiting for it: some open a dialog and resolve when it closes.
const action = name => async page => {
  await page.evaluate(name => { void window.styk.actions[name](); }, name);
  await page.waitForTimeout(250);
};
const showPanel = panel => async page => {
  await page.evaluate(panel => window.styk.workspace.show(panel), panel);
  await page.waitForTimeout(250);
  await frames(page);
};
const steps = (...actions) => async page => { for (const action of actions) await action(page); };

/** `timelines` lists the timeline modes a state is captured in (Advanced is the default). */
const STATES = [
  {name: 'animate', timelines: ['advanced', 'simple'], touch: true, enter: workspace('animate')},
  {name: 'draw', timelines: ['advanced', 'simple'], touch: true, enter: workspace('draw')},
  // The audio panel below the timeline, empty (no clips in the fixture).
  {name: 'audio', timelines: ['advanced', 'simple'], enter: steps(click('#timeline-audio'), waitFor('#timeline-audio-panel'))},
  {name: 'build', touch: true, enter: steps(select(WALKER), workspace('rig'))},
  {name: 'figure-selected', touch: true, enter: select(WALKER)},
  {name: 'joint-selected', touch: true, enter: select(WALKER, WALKER_JOINT)},
  // The Polygons section is a closed disclosure; open it like a user and scroll it into view.
  {name: 'polygon-rows', enter: steps(select(WALKER), click('#inspector details[data-section="Polygons"] > summary'), frames,
    page => page.evaluate(() => document.querySelector('#inspector details[data-section="Polygons"]').scrollIntoView({block: 'start'})), frames)},
  {name: 'file-menu', enter: steps(click('.titlebar .brand'), waitFor('#menu'), page => page.locator('#menu').getByRole('menuitem', {name: 'File', exact: true}).click(), waitFor('.ui-menu[aria-label="File"]'))},
  // The rail's Add menu, and today's Insert dialog (its All in this project…).
  {name: 'add-menu', enter: steps(click('#open-insert'), waitFor('[role=menu][aria-label=Add]'))},
  {name: 'insert-dialog', enter: steps(click('#open-insert'), waitFor('[role=menu][aria-label=Add]'),
    page => page.getByRole('menuitem', {name: /^All .*in this project/}).click(), waitFor('#insert-dialog'))},
  {name: 'onion-popover', enter: steps(click('#onion-settings-button'), waitFor('#onion-popover'))},
  ...SETTINGS_TABS.map(tab => ({name: `settings-${tab}`, enter: steps(
    page => page.evaluate(tab => window.styk.settingsUI.open(tab), tab), waitFor('.styk-settings[open]'))})),
  // Screens and panels reached through the app's own commands, so they open the same way on touch.
  {name: 'home', touch: true, enter: steps(action('home'), frames)},
  {name: 'tutorials', touch: true, enter: steps(action('tutorials'), frames)},
  {name: 'properties-panel', touch: true, enter: steps(select(WALKER), showPanel('properties'))},
  {name: 'vfx-panel', touch: true, enter: steps(select(WALKER), showPanel('vfx'))},
  {name: 'library-panel', touch: true, enter: showPanel('library')},
  {name: 'camera-selected', touch: true, enter: steps(action('toggle-camera'), frames)},
  {name: 'scene-settings', touch: true, enter: steps(action('scene-settings'), frames)},
  {name: 'command-palette', enter: steps(action('command-palette'), frames)},
  {name: 'onion-skins', touch: true, enter: steps(page => page.evaluate(() => { window.styk.editor.seek(Math.min(4, window.styk.editor.totalTicks - 1)); }), action('toggle-onion'), frames)},
  {name: 'motion-paths', enter: steps(select(WALKER, WALKER_JOINT), action('toggle-motion-paths'), frames)},
  {name: 'main-menu', touch: true, enter: steps(action('menu'), frames)},
  {name: 'layout-menu', enter: steps(action('layout-menu'), frames)},
  {name: 'recent-files', enter: steps(action('open-recent'), frames)},
  {name: 'performance', enter: steps(action('performance'), frames)},
  {name: 'about', enter: steps(action('about'), frames)},
  {name: 'export-sheet', touch: true, enter: steps(action('export'), waitFor('#export-dialog[open]'))},
  {name: 'settings', touch: true, enter: steps(page => page.evaluate(() => window.styk.settingsUI.open('interface')), waitFor('.styk-settings[open]'))},
  {name: 'export-dialog', enter: steps(click('.titlebar [data-action="export"]'), waitFor('#export-dialog[open]'))},
  {name: 'text-dialog', enter: steps(page => page.evaluate(() => { void window.styk.actions['add-text'](); }), waitFor('dialog[open]'))},
  // The desktop feedback shell and its lazily loaded support styles, through a
  // mock bridge whose empty private inbox shows the new report form.
  {name: 'feedback', enter: steps(page => page.evaluate(async () => {
    const {FeedbackUI} = await import('/src/feedback-ui.mjs');
    const ok = value => ({ok: true, value});
    await new FeedbackUI({
      getSupportContext: async () => ({inboxId: 'snapshot', source: 'desktop', version: '1.0.0', platform: 'win32', drafts: {}, lastThread: ''}),
      supportRequest: async ({path}) => ok(path === '/config' ? {attachments: true, paused: false} : path.startsWith('/threads?') ? {threads: [], nextCursor: null} : {}),
      saveSupportState: async () => {},
    }).open();
  }), waitFor('.styk-feedback[open] form'))},
];

const report = {label, url, commit: git('rev-parse', 'HEAD'), uncommittedFiles: git('status', '--porcelain', '--', 'index.html', 'src').split('\n').filter(Boolean).length,
  createdAt: new Date().toISOString(), sizes: sizes.map(size => size.name), themes, shots: [], skipped: [], errors: []};
const shots = new Map();
const dir = path.join(out, label);
let exitCode = 0;
const browser = await chromium.launch({channel: 'chrome', headless: true, args: ['--force-color-profile=srgb']});
try {
  if (!args['no-capture']) {
    await rm(dir, {recursive: true, force: true});
    await mkdir(dir, {recursive: true});
    await capture(plan());
    const unstable = [...shots.values()].filter(shot => !shot.stable).length;
    console.log(`Captured ${shots.size} images in ${path.relative(root, dir)}${unstable ? `, ${unstable} never settled (see manifest.json)` : ''}.`);
    if (report.errors.length) { console.warn(`${report.errors.length} page errors:\n  ${report.errors.join('\n  ')}`); exitCode = 1; }
  }
  if (args.compare) {
    const before = path.join(out, args.compare);
    let summary = await compare(before, dir);
    for (let attempt = 1; attempt <= RECHECKS && summary.changed && !args['no-capture']; attempt++) {
      const differing = new Set(summary.results.filter(result => result.status === 'changed').map(result => result.file));
      const retry = plan().filter(shot => differing.has(`${shot.name}.png`));
      if (!retry.length) break;
      console.log(`Recapturing ${retry.length} differing images (${attempt}/${RECHECKS})`);
      await capture(retry);
      summary = await compare(before, dir);
    }
    for (const result of summary.results.filter(result => result.status !== 'same'))
      console.log(`  ${result.status.padEnd(7)} ${result.file}${result.changedPixels ? `  ${result.changedPixels} px in ${describe(result)}` : ''}`);
    console.log(`Compared ${summary.compared} images with ${summary.before}: ${summary.changed} differ${summary.changed ? `; diffs in ${path.relative(root, path.join(dir, `diff-${summary.before}`))}` : ''}.`);
    if (summary.changed && !args['allow-diff']) exitCode = 1;
  }
  if (!args['no-capture']) {
    report.shots = [...shots.values()];
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(report, null, 2));
  }
} finally {
  await browser.close();
}
process.exitCode = exitCode;

/** Every image of the matrix, in capture order, filtered by --only. */
function plan() {
  return themes.flatMap(theme => ['advanced', 'simple'].flatMap(timeline => STATES
    .filter(state => (state.timelines ?? ['advanced']).includes(timeline))
    .flatMap(state => sizes.filter(size => !size.touch || state.touch).map(size => ({theme, timeline, state, size, name: shotName(theme, state, timeline, size)})))))
    .filter(shot => !only || only.some(text => shot.name.includes(text)));
}

/** Every image starts from a fresh context at its own size (clean storage, no
 * resize history), so an image does not depend on which others were captured. */
async function capture(planned) {
  for (const {theme, timeline, state, size, name} of planned) {
    const context = await browser.newContext({viewport: {width: size.width, height: size.height}, deviceScaleFactor: size.touch ? 2 : 1,
      isMobile: !!size.touch, hasTouch: !!size.touch, locale: 'en-US', timezoneId: 'UTC', colorScheme: theme});
    await context.addInitScript(settings => {
      localStorage.setItem('stykanimate.editor.settings.v1', JSON.stringify(settings));
      localStorage.setItem('stykanimate.theme.v1', settings.theme);
    }, {theme, timelineMode: timeline, locale: 'en', uiScale: 100});
    const page = await context.newPage();
    page.on('pageerror', error => report.errors.push(`${name}: ${error.message}`));
    try {
      await page.goto(url);
      await page.waitForFunction(() => window.styk?.ready === true, null, {timeout: 60000});
      await loadFixture(page);
      // A state the current interface no longer has is skipped and reported, not fatal:
      // the matrix must finish, and a comparison then lists it as missing on both sides.
      try { await state.enter(page); }
      catch (error) { report.skipped.push({name, reason: String(error.message).split('\n')[0]}); console.log(`  ${name} skipped: ${String(error.message).split('\n')[0]}`); continue; }
      const shot = await settledScreenshot(page, path.join(dir, `${name}.png`));
      const recaptures = shots.has(name) ? shots.get(name).recaptures + 1 : 0;
      const masks = await page.evaluate(selectors => selectors.flatMap(selector => [...document.querySelectorAll(selector)].map(element => {
        const rect = element.getBoundingClientRect();
        return rect.width && rect.height ? {selector, x: Math.floor(rect.left), y: Math.floor(rect.top), width: Math.ceil(rect.right) - Math.floor(rect.left), height: Math.ceil(rect.bottom) - Math.floor(rect.top)} : null;
      }).filter(Boolean)), CHROME_MASKS);
      shots.set(name, {name, theme, timeline, state: state.name, size: size.name, ...shot, recaptures, masks});
      console.log(`  ${name}${shot.stable ? '' : ' did not settle'}`);
    } finally {
      await context.close();
    }
  }
}

function shotName(theme, state, timeline, size) {
  return [theme, state.name, ...(state.timelines ? [timeline] : []), size.name].join('-');
}

/** Loads the fixed document at frame 1 with nothing selected, and freezes time-based text. */
async function loadFixture(page) {
  await page.evaluate(async frozen => {
    for (const [id, text] of Object.entries(frozen)) {
      const element = document.getElementById(id);
      if (!element) continue;
      element.textContent = text;
      Object.defineProperty(element, 'textContent', {configurable: true, get: () => text, set: () => {}});
    }
    const {createDemo} = await import('/src/demo.mjs');
    const report = createDemo();
    // A polygon on the walker gives the inspector its polygon rows.
    report.figure_types[0].polyfills = [{segment_ids: [0, 7, 9], color_rgb: [240, 165, 71]}];
    window.styk.editor.load(report, 'Snapshot fixture');
    window.styk.editor.markSaved();
    window.styk.editor.select(null);
    window.styk.fit();
  }, FROZEN_TEXT);
  await frames(page);
}

/** Waits for fonts, toasts and thumbnails, then retakes the screenshot until
 * STABLE_CAPTURES consecutive captures are identical. */
async function settledScreenshot(page, file) {
  await page.evaluate(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    await document.fonts.ready;
    const toast = document.getElementById('toast');
    for (let waited = 0; waited < 6000 && (!toast?.hidden || window.styk.thumbnails?.stats?.pending); waited += 100) await wait(100);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const options = {animations: 'disabled', caret: 'hide', scale: 'css'};
  let previous = await page.screenshot(options), attempts = 1, same = 1;
  const deadline = Date.now() + 10000;
  while (same < STABLE_CAPTURES && Date.now() < deadline) {
    await page.waitForTimeout(250);
    const next = await page.screenshot(options);
    attempts++;
    same = next.equals(previous) ? same + 1 : 1;
    previous = next;
  }
  await writeFile(file, previous);
  return {stable: same >= STABLE_CAPTURES, attempts};
}

/** Pixel comparison in the browser (no image dependencies). Writes compare-<before>.json and diff PNGs. */
async function compare(beforeDir, afterDir) {
  if (!existsSync(beforeDir)) fail(`Nothing to compare with: ${path.relative(root, beforeDir)} does not exist.`);
  if (!existsSync(afterDir)) fail(`Nothing to compare: ${path.relative(root, afterDir)} does not exist.`);
  const names = async folder => new Set((await readdir(folder)).filter(file => file.endsWith('.png')));
  const before = await names(beforeDir), after = await names(afterDir);
  const other = path.basename(beforeDir);
  const maskTable = async folder => {
    const manifest = JSON.parse(await readFile(path.join(folder, 'manifest.json'), 'utf8').catch(() => '{"shots":[]}'));
    return new Map(manifest.shots.map(shot => [`${shot.name}.png`, shot.masks ?? []]));
  };
  // The live capture's manifest is written after comparing, so its masks come from memory.
  const beforeMasks = await maskTable(beforeDir);
  const afterMasks = shots.size ? new Map([...shots.values()].map(shot => [`${shot.name}.png`, shot.masks ?? []])) : await maskTable(afterDir);
  const diffDir = path.join(afterDir, `diff-${other}${args['chrome-only'] ? '-chrome' : ''}`);
  await rm(diffDir, {recursive: true, force: true});
  const page = await browser.newPage();
  await page.setContent('<!doctype html><title>compare</title>');
  const results = [];
  const files = [...new Set([...before, ...after])].filter(file => !only || only.some(text => file.includes(text))).sort();
  for (const file of files) {
    if (!before.has(file) || !after.has(file)) {
      results.push({file, status: before.has(file) ? 'missing' : 'added'});
      continue;
    }
    const [a, b] = await Promise.all([readFile(path.join(beforeDir, file)), readFile(path.join(afterDir, file))]);
    if (a.equals(b)) { results.push({file, status: 'same', changedPixels: 0}); continue; }
    const masks = args['chrome-only'] ? [...(beforeMasks.get(file) ?? []), ...(afterMasks.get(file) ?? [])] : [];
    const result = await page.evaluate(diffImages, [a.toString('base64'), b.toString('base64'), masks]);
    if (args['chrome-only']) result.maskedRegions = masks.length;
    if (result.diff) {
      await mkdir(diffDir, {recursive: true});
      await writeFile(path.join(diffDir, file), Buffer.from(result.diff, 'base64'));
    }
    results.push({file, status: result.changedPixels ? 'changed' : 'same', changedPixels: result.changedPixels,
      totalPixels: result.totalPixels, bounds: result.bounds, ...(result.sizeChanged ? {sizeChanged: result.sizeChanged} : {})});
  }
  await page.close();
  const changed = results.filter(result => result.status !== 'same');
  const summary = {before: other, after: path.basename(afterDir), compared: results.length, changed: changed.length,
    changedPixels: changed.reduce((sum, result) => sum + (result.changedPixels ?? 0), 0), results};
  await writeFile(path.join(afterDir, `compare-${other}${args['chrome-only'] ? '-chrome' : ''}.json`), JSON.stringify(summary, null, 2));
  return summary;
}

function describe({bounds, sizeChanged}) {
  return `${bounds.width}x${bounds.height} at ${bounds.x},${bounds.y}${sizeChanged ? ` (size ${sizeChanged})` : ''}`;
}

/** Runs in the page: decodes both PNGs and paints changed pixels red over a faded copy of the new image. */
async function diffImages([beforeBase64, afterBase64, masks = []]) {
  const decode = async base64 => {
    const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], {type: 'image/png'}), {colorSpaceConversion: 'none', premultiplyAlpha: 'none'});
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', {willReadFrequently: true});
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, bitmap.width, bitmap.height);
  };
  const [before, after] = await Promise.all([decode(beforeBase64), decode(afterBase64)]);
  const width = Math.max(before.width, after.width), height = Math.max(before.height, after.height);
  const output = new ImageData(width, height);
  const scale = 1;  // Screenshots are taken at CSS scale, the masks' unit.
  let changedPixels = 0, left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const inBefore = x < before.width && y < before.height, inAfter = x < after.width && y < after.height;
      const a = (y * before.width + x) * 4, b = (y * after.width + x) * 4;
      const masked = masks.some(mask => x >= mask.x * scale && x < (mask.x + mask.width) * scale && y >= mask.y * scale && y < (mask.y + mask.height) * scale);
      const same = masked || inBefore && inAfter && before.data[a] === after.data[b] && before.data[a + 1] === after.data[b + 1]
        && before.data[a + 2] === after.data[b + 2] && before.data[a + 3] === after.data[b + 3];
      if (same) {
        const gray = (after.data[b] * 0.3 + after.data[b + 1] * 0.59 + after.data[b + 2] * 0.11) * 0.25 + 191;
        output.data.set([gray, gray, gray, 255], o);
      } else {
        changedPixels++;
        left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
        output.data.set([255, 0, 0, 255], o);
      }
    }
  }
  const sizeChanged = before.width !== after.width || before.height !== after.height
    ? `${before.width}x${before.height} → ${after.width}x${after.height}` : null;
  if (!changedPixels) return {changedPixels, totalPixels: width * height};
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d').putImageData(output, 0, 0);
  const blob = await canvas.convertToBlob({type: 'image/png'});
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const bounds = {x: left, y: top, width: right - left + 1, height: bottom - top + 1};
  return {changedPixels, totalPixels: width * height, bounds, sizeChanged, diff: btoa(binary)};
}

function parseArgs(argv) {
  const flags = new Set(['no-capture', 'allow-diff', 'touch', 'chrome-only']), result = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--')) fail(`Unexpected argument ${argv[i]}`);
    if (flags.has(name)) result[name] = true;
    else if (i + 1 < argv.length) result[name] = argv[++i];
    else fail(`Missing value for --${name}`);
  }
  return result;
}

function git(...command) {
  const result = spawnSync('git', command, {cwd: root, encoding: 'utf8'});
  return result.status === 0 ? result.stdout.trim() : '';
}

function fail(message) {
  console.error(message);
  process.exit(2);
}
