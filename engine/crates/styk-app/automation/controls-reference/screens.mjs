// The references for the design system's controls page (docs/native/screens/limits.toml, `controls` and `controls-dark`): today's
// components, in every state, drawn by today's stylesheets in Playwright's bundled Chromium (LCD text on, opaque surfaces),
// the way engine/crates/xtask/fonts-chromium.mjs captures. The page is one table: a label column of 150 px, then five state
// columns of 148 px, each cell 52 px high with its control starting 8 px in and centred vertically. The native page
// (`styk_ui::controls_sheet`) lays out the same table with the same controls.
//
//   node engine/crates/styk-app/automation/controls-reference/screens.mjs [--scale 1.5] [--out dir] [--only controls|controls-dark]
//
// By default it writes docs/native/screens/controls/controls.png and controls-dark.png at device scale 1 (what the
// screen guard compares); `--scale 1.5 --out artifacts/native-screens/controls-reference-1.5` writes the 150 % references
// the checks of the chunk compare by hand. Hover, pressed and focus are forced on their elements through the DevTools
// protocol (`CSS.forcePseudoState`), so every state shows at once; nothing is faked with a stylesheet.
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {mkdir, readFile} from 'node:fs/promises';
import {extname, join, normalize, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const root = resolve(import.meta.dirname, '../../../../..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1]; };
const scale = Number(option('--scale', '1'));
const out = resolve(root, option('--out', 'docs/native/screens/controls'));
const only = option('--only', '');

const LABEL = 150, CELL = 148, ROW = 52, HEAD = 28, PAD = 24;
export const STATES = ['rest', 'hover', 'pressed', 'focus', 'disabled'];
const esc = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;');

const {icon} = await import(pathToFileURL(join(root, 'src/icons.mjs')).href);
const glyph = (name, cls = 'ui-icon') => icon(name, cls);

const forced = state => (state === 'rest' || state === 'disabled' ? '' : `data-force="${state}"`);
const off = state => state === 'disabled';

const button = (variant, state, {text = 'Button', size, tone, pressed, icon: lead} = {}) =>
  `<button type="button" class="ui-button"${variant ? ` data-variant="${variant}"` : ''}${size ? ` data-size="${size}"` : ''}${tone ? ' data-tone="danger"' : ''}${pressed ? ' aria-pressed="true"' : ''}${off(state) ? ' disabled' : ''} ${forced(state)}>${lead ? glyph(lead) : ''}<span class="ui-label">${text}</span></button>`;
const iconButton = (state, {name = 'plus', variant, tone, size, round, pressed, expanded} = {}) =>
  `<button type="button" class="ui-icon-button"${variant ? ` data-variant="${variant}"` : ''}${size ? ` data-size="${size}"` : ''}${tone ? ' data-tone="danger"' : ''}${round ? ' data-shape="round"' : ''}${pressed ? ' aria-pressed="true"' : ''}${expanded ? ' aria-expanded="true"' : ''}${off(state) ? ' disabled' : ''} aria-label="${name}" ${forced(state)}>${glyph(name, '')}</button>`;
const toggle = (cls, state, checked, extra = '') => `<input type="${cls === 'ui-radio' ? 'radio' : 'checkbox'}" class="${cls}"${cls === 'ui-switch' ? ' role="switch"' : ''}${checked ? ' checked' : ''}${extra}${off(state) ? ' disabled' : ''} ${forced(state)}>`;
const segmented = (state, {size, items, chosen = 0}) => {
  const parts = items.map((item, index) => {
    const mine = state === 'disabled' ? index === 1 : state === 'focus' ? index === 0 : index === 1;
    const attrs = `${index === chosen ? ' aria-checked="true"' : ' aria-checked="false"'}${off(state) && mine ? ' disabled' : ''}${mine && state !== 'rest' && state !== 'disabled' ? ` ${forced(state)}` : ''}`;
    return `<button type="button" class="ui-segmented-item" role="radio"${attrs}>${item.icon ? glyph(item.icon) : ''}${item.text ? esc(item.text) : ''}</button>`;
  }).join('');
  return `<div class="ui-segmented"${size ? ` data-size="${size}"` : ''} role="radiogroup">${parts}</div>`;
};
const slider = (state, value, {quiet} = {}) =>
  `<input type="range" class="ui-slider"${quiet ? ' data-quiet' : ''} min="0" max="100" value="${value}" style="--_p:${value}%; width:132px"${off(state) ? ' disabled' : ''} ${forced(state)}>`;
const numberField = (state, {invalid} = {}) =>
  `<label class="ui-field" style="width:132px" ${state === 'hover' ? 'data-force="hover"' : state === 'focus' ? 'data-force="focus-within"' : ''}><span class="ui-field-label" data-property-scrub tabindex="0" role="button">X</span><input class="ui-field-input" type="number" value="128.5" step="any"${invalid ? ' aria-invalid="true"' : ''}${off(state) ? ' disabled' : ''}><span class="ui-field-suffix" aria-hidden="true">px</span></label>`;
const selectField = (state) =>
  `<label class="ui-field" data-select style="width:132px" ${state === 'hover' ? 'data-force="hover"' : state === 'focus' ? 'data-force="focus-within"' : ''}><span class="ui-field-label">Easing</span><select class="ui-field-input"${off(state) ? ' disabled' : ''}><option>Linear</option><option>Hold</option></select>${glyph('chevron-down', 'ui-icon ui-field-chev')}</label>`;
const colorField = (state) =>
  `<button type="button" class="ui-field" data-color style="width:132px" ${off(state) ? 'disabled' : ''} ${state === 'hover' ? 'data-force="hover"' : state === 'focus' ? 'data-force="focus-within"' : ''}><span class="ui-swatch" data-size="sm" style="--swatch:#c85028"></span><span class="ui-field-hex">C85028</span></button>`;
const switchField = (state) =>
  `<label class="ui-field" data-switch-field style="width:132px" ${state === 'hover' ? 'data-force="hover"' : ''}><span class="ui-field-label">Pin joint</span><input type="checkbox" class="ui-switch" role="switch"${off(state) ? ' disabled' : ''} ${state === 'focus' ? 'data-force="focus"' : ''}></label>`;
const chip = (state, {pressed, text = 'Figures'} = {}) =>
  `<button type="button" class="ui-chip"${pressed ? ' aria-pressed="true"' : ''}${off(state) ? ' disabled' : ''} ${forced(state)}>${text}</button>`;
const badge = tint => `<span class="badge" data-tint="${tint}">${glyph('layers', '')}</span>`;

/** The page's sections: [heading, [label, cells...]]. A cell is the HTML of one control; five unless the row says fewer. */
export function sections() {
  const states = make => STATES.map(make);
  return [
    ['Buttons', [
      ['Soft', states(s => button(undefined, s))],
      ['Primary', states(s => button('primary', s))],
      ['Accent', states(s => button('accent', s))],
      ['Ghost', states(s => button('ghost', s))],
      ['Outline', states(s => button('outline', s))],
      ['Danger', states(s => button('danger', s))],
      ['Ghost, danger tone', states(s => button('ghost', s, {text: 'Delete', tone: true}))],
      ['Toggled on', states(s => button('ghost', s, {text: 'Guides', pressed: true}))],
      ['With a glyph', states(s => button(undefined, s, {text: 'Export', icon: 'image'}))],
      ['Sizes', ['sm', 'md', 'lg'].map(size => button(undefined, 'rest', {size}))],
    ]],
    ['Icon buttons', [
      ['Ghost', states(s => iconButton(s))],
      ['Soft', states(s => iconButton(s, {variant: 'soft'}))],
      ['Danger tone', states(s => iconButton(s, {name: 'trash', tone: true}))],
      ['Toggled on', states(s => iconButton(s, {name: 'grid', pressed: true}))],
      ['Expanded', states(s => iconButton(s, {name: 'settings', expanded: true}))],
      ['Sizes, round', [iconButton('rest', {size: 'xs'}), iconButton('rest', {size: 'sm'}), iconButton('rest'), iconButton('rest', {size: 'lg'}), iconButton('rest', {round: true})]],
    ]],
    ['Switch, checkbox and radio', [
      ['Switch off', states(s => toggle('ui-switch', s, false))],
      ['Switch on', states(s => toggle('ui-switch', s, true))],
      ['Checkbox', states(s => toggle('ui-checkbox', s, false))],
      ['Checkbox checked', states(s => toggle('ui-checkbox', s, true))],
      ['Checkbox mixed', states(s => toggle('ui-checkbox', s, false, ' aria-checked="mixed" data-indeterminate'))],
      ['Radio', states(s => toggle('ui-radio', s, false))],
      ['Radio chosen', states(s => toggle('ui-radio', s, true))],
    ]],
    ['Segmented', [
      ['Words', states(s => segmented(s, {items: [{text: 'Transform'}, {text: 'Motion'}]}))],
      ['Small', states(s => segmented(s, {size: 'sm', items: [{text: 'Transform'}, {text: 'Motion'}]}))],
      ['Glyphs', states(s => segmented(s, {items: [{icon: 'grid'}, {icon: 'layers'}, {icon: 'image'}]}))],
      ['Large', states(s => segmented(s, {size: 'lg', items: [{text: 'One'}, {text: 'Two'}]}))],
    ]],
    ['Slider', [
      ['Value 0, 50, 100', [slider('rest', 0), slider('rest', 50), slider('rest', 100)]],
      ['Focus, off, quiet', [slider('focus', 50), slider('disabled', 50), slider('rest', 50, {quiet: true})]],
    ]],
    ['Fields', [
      ['Number', ['rest', 'hover', 'focus', 'invalid', 'disabled'].map(s => numberField(s === 'invalid' ? 'rest' : s, {invalid: s === 'invalid'}))],
      ['Select', ['rest', 'hover', 'focus', 'disabled'].map(selectField)],
      ['Colour', ['rest', 'hover', 'focus', 'disabled'].map(colorField)],
      ['Switch', ['rest', 'hover', 'focus', 'disabled'].map(switchField)],
    ]],
    ['Chips and badges', [
      ['Chip', ['rest', 'hover', 'focus', 'pressed-on', 'disabled'].map(s => chip(s === 'pressed-on' ? 'rest' : s, {pressed: s === 'pressed-on'}))],
      ['Badges', ['select', 'draw', 'time', 'library', 'camera', 'fx'].slice(0, 5).map(badge)],
    ]],
  ];
}

const MIME = {'.css': 'text/css', '.mjs': 'text/javascript', '.js': 'text/javascript', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.html': 'text/html'};

function page(theme) {
  const body = sections().map(([heading, rows]) => `<h2 class="head">${esc(heading)}</h2>${rows.map(([label, cells]) => `<div class="row"><div class="lab">${esc(label)}</div>${cells.map(html => `<div class="cell">${html}</div>`).join('')}</div>`).join('')}`).join('');
  return `<!doctype html><html lang="en" data-theme="${theme}"><head><meta charset="utf-8"><link rel="stylesheet" href="/src/styles/app.css"><style>
    html, body { margin: 0; background: var(--surface); }
    #page { box-sizing: border-box; width: ${PAD * 2 + LABEL + CELL * 5}px; padding: ${PAD}px; background: var(--surface); color: var(--text-1); font: var(--type-ui); }
    .head { box-sizing: border-box; margin: 0; height: ${HEAD + 8}px; display: flex; align-items: flex-end; padding-block-end: 4px; font: var(--type-emphasis); color: var(--text-1); }
    .row { display: flex; height: ${ROW}px; }
    .lab { flex: none; width: ${LABEL}px; display: flex; align-items: center; font: var(--type-small); color: var(--text-3); }
    .cell { flex: none; width: ${CELL}px; box-sizing: border-box; padding-inline-start: 8px; display: flex; align-items: center; }
    .badge { display: inline-grid; place-items: center; inline-size: 22px; block-size: 22px; border-radius: var(--radius-xs); }
    .badge svg { inline-size: 14px; block-size: 14px; }
    .badge[data-tint="select"] { background: var(--tint-select-soft); color: var(--tint-select-ink); }
    .badge[data-tint="draw"] { background: var(--tint-draw-soft); color: var(--tint-draw-ink); }
    .badge[data-tint="time"] { background: var(--tint-time-soft); color: var(--tint-time-ink); }
    .badge[data-tint="library"] { background: var(--tint-library-soft); color: var(--tint-library-ink); }
    .badge[data-tint="camera"] { background: var(--tint-camera-soft); color: var(--tint-camera-ink); }
  </style></head><body><div id="page">${body}</div></body></html>`;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const match = /^\/page-(light|dark)$/.exec(url.pathname);
  if (match) { response.writeHead(200, {'content-type': 'text/html'}); response.end(page(match[1])); return; }
  const file = normalize(join(root, decodeURIComponent(url.pathname)));
  if (!file.startsWith(root)) { response.writeHead(403); response.end(); return; }
  try { const data = await readFile(file); response.writeHead(200, {'content-type': MIME[extname(file)] ?? 'application/octet-stream'}); response.end(data); }
  catch { response.writeHead(404); response.end(); }
}).listen(0);
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

await mkdir(out, {recursive: true});
const browser = await chromium.launch();
const FORCE = {hover: ['hover'], pressed: ['hover', 'active'], focus: ['focus', 'focus-visible', 'focus-within'], 'focus-within': ['focus-within']};
for (const theme of ['light', 'dark']) {
  const id = theme === 'light' ? 'controls' : 'controls-dark';
  if (only && only !== id) continue;
  const context = await browser.newContext({viewport: {width: PAD * 2 + LABEL + CELL * 5, height: 2200}, deviceScaleFactor: scale, locale: 'en-US', timezoneId: 'UTC', colorScheme: theme});
  const tab = await context.newPage();
  await tab.goto(`${base}/page-${theme}`, {waitUntil: 'load'});
  await tab.evaluate(async () => { await document.fonts.ready; for (const element of document.querySelectorAll('*')) element.style.caretColor = 'transparent'; });
  const session = await context.newCDPSession(tab);
  await session.send('DOM.enable'); await session.send('CSS.enable');
  const {root: documentNode} = await session.send('DOM.getDocument', {depth: 0});
  const {nodeIds} = await session.send('DOM.querySelectorAll', {nodeId: documentNode.nodeId, selector: '[data-force]'});
  for (const nodeId of nodeIds) {
    const {attributes} = await session.send('DOM.getAttributes', {nodeId});
    const state = attributes[attributes.indexOf('data-force') + 1];
    if (FORCE[state]) await session.send('CSS.forcePseudoState', {nodeId, forcedPseudoClasses: FORCE[state]});
  }
  await tab.waitForTimeout(400);
  const box = await tab.locator('#page').boundingBox();
  const path = join(out, `${id}.png`);
  await tab.screenshot({path, clip: {x: 0, y: 0, width: Math.ceil(box.width), height: Math.ceil(box.height)}, animations: 'disabled', caret: 'hide'});
  console.log(id, Math.ceil(box.width), Math.ceil(box.height), path);
  await context.close();
}
await browser.close();
server.close();
