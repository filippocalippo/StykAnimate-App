// The references for the recovery screens (docs/native/screens/limits.toml, `recovery-offer`, `recovery-chooser`, `recovery-busy`,
// `recovery-error`, `close-prompt`): today's recovery offer (`showRecovery` in src/app.mjs, the stage message), the chooser
// (`chooseRecovery` in src/app-dialogs.mjs) and the close prompt (`confirmReplace`, with the failure the native build reports under
// it and its Retry), drawn by today's stylesheets and today's own modules (`createToasts`, `createDialog`) in Playwright's bundled
// Chromium (LCD text on, opaque surfaces), the way engine/crates/xtask/fonts-chromium.mjs captures.
//
//   node engine/crates/styk-app/automation/recovery-reference/screens.mjs [--scale 2] [--out dir] [--only recovery-offer,close-prompt-dark]
//
// By default it writes docs/native/screens/recovery/<id>.png at device scale 1 (what the screen guard compares); `--scale 2
// --out artifacts/native-screens/recovery-reference-2` writes the 200 % references the checks of the chunk compare by hand.
// The copies are the ones engine/crates/styk-ui/src/recovery_sheet.rs lists; the times are written by the page's own `Intl`
// (en-US, UTC), as today writes them. The page's dialogs are opened and then blurred: the native screens show no focus ring.
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {mkdir, readFile} from 'node:fs/promises';
import {extname, join, normalize, resolve} from 'node:path';

const root = resolve(import.meta.dirname, '../../../../..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1]; };
const scale = Number(option('--scale', '1'));
const out = resolve(root, option('--out', 'docs/native/screens/recovery'));
const only = option('--only', '').split(',').filter(Boolean);

export const SCENES = {
  'recovery-offer': [640, 140], 'recovery-chooser': [520, 360], 'recovery-busy': [520, 360], 'recovery-error': [520, 360], 'close-prompt': [520, 300],
};

const MIME = {'.css': 'text/css', '.mjs': 'text/javascript', '.js': 'text/javascript', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.html': 'text/html'};

function shell(theme, [width, height]) {
  return `<!doctype html><html lang="en" data-theme="${theme}"><head><meta charset="utf-8"><link rel="stylesheet" href="/src/styles/app.css"><style>
    html, body { margin: 0; background: var(--surface); }
    body { position: relative; width: ${width}px; height: ${height}px; overflow: hidden; color: var(--text-1); font: var(--type-ui); }
    /* Animations stand still at their first frame and transitions are over: a loop at time zero, a popover already shown. */
    *, *::before, *::after { animation-play-state: paused !important; transition: none !important; }
  </style></head><body><div id="page"></div></body></html>`;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const match = /^\/scene\/([a-z-]+)\/(light|dark)$/.exec(url.pathname);
  if (match) { response.writeHead(200, {'content-type': 'text/html'}); response.end(shell(match[2], SCENES[match[1]])); return; }
  const file = normalize(join(root, decodeURIComponent(url.pathname)));
  if (!file.startsWith(root)) { response.writeHead(403); response.end(); return; }
  try { const data = await readFile(file); response.writeHead(200, {'content-type': MIME[extname(file)] ?? 'application/octet-stream'}); response.end(data); }
  catch { response.writeHead(404); response.end(); }
}).listen(0);
await new Promise(resolvePromise => server.once('listening', resolvePromise));
const base = `http://127.0.0.1:${server.address().port}`;

// The copies of recovery_sheet.rs: name, ISO time.
const COPIES = [['Rooftop fight', '2026-11-08T14:03:00.000Z'], ['Chase', '2026-11-08T13:41:00.000Z'], ['', '2026-11-07T22:15:00.000Z']];

/** Runs in the page: today's chooser dialog (`chooseRecovery`), with the copies above. */
async function chooser(page, {busy = false, error = ''} = {}) {
  await page.evaluate(async ({copies, busy, error}) => {
    const {icon} = await import('/src/icons.mjs');
    const {createDialog} = await import('/src/ui/ui-dialog.mjs');
    const body = document.createDocumentFragment(), label = document.createElement('label'), select = document.createElement('select'), wrap = document.createElement('span');
    label.className = 'ui-form-row'; label.append('Recovery copy'); wrap.className = 'ui-select'; wrap.insertAdjacentHTML('beforeend', icon('chevron-down', 'ui-icon'));
    select.setAttribute('aria-label', 'Recovery copy');
    for (const [name, at] of copies) {
      const option = document.createElement('option');
      option.append(`${name || 'Untitled'} · ${new Intl.DateTimeFormat('en-US', {dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC'}).format(Date.parse(at))}`);
      select.append(option);
    }
    wrap.prepend(select);
    const note = document.createElement('p'); note.className = 'ui-dialog-desc'; note.textContent = 'Restore opens this copy as an edited project. Discard permanently removes this recovery copy.';
    label.append(wrap); body.append(label, note);
    const dialog = createDialog({title: 'Restore unsaved work', size: 'sm', body, icon: name => icon(name, 'ui-icon'), pointer: true, mount: document.body,
      actions: [{label: 'Cancel', cancel: true}, {label: 'Discard copy', value: 'discard', tone: 'danger'}, {label: 'Restore', value: 'restore', variant: 'primary'}]});
    dialog.showModal();
    if (busy) dialog.setBusy(true);
    if (error) dialog.setError(error);
  }, {copies: COPIES, busy, error});
}

const scenes = {
  async 'recovery-offer'(page) {
    await page.evaluate(async () => {
      const {icon} = await import('/src/icons.mjs');
      const {createToasts} = await import('/src/ui/ui-toast.mjs');
      const time = new Intl.DateTimeFormat('en-US', {hour: '2-digit', minute: '2-digit', timeZone: 'UTC'}).format(Date.parse('2026-11-08T14:03:00.000Z'));
      const toasts = createToasts({icon: name => icon(name, 'ui-icon'), slot: {place: ({width}) => ({x: 24 + width / 2, top: 24, place: 'head'}), release() {}}});
      toasts.show({slot: 'recovery', icon: 'clock', title: 'Restore unsaved work', key: 'recovery', message: `in Rooftop fight from ${time}?`, timeout: 0, dismissible: false,
        actions: [{label: 'Not now', id: 'dismiss-recovery'}, {label: 'Restore', id: 'restore-recovery', variant: 'outline', dismiss: false}]});
    });
    await page.waitForTimeout(500);
  },
  async 'recovery-chooser'(page) { await chooser(page); await settle(page); },
  async 'recovery-busy'(page) { await chooser(page, {busy: true}); await settle(page); },
  async 'recovery-error'(page) { await chooser(page, {error: 'This recovery copy is open in another tab.'}); await settle(page); },
  async 'close-prompt'(page) {
    await page.evaluate(async () => {
      const {icon} = await import('/src/icons.mjs');
      const {createDialog} = await import('/src/ui/ui-dialog.mjs');
      const dialog = createDialog({size: 'sm', title: 'Save changes to Chase?', body: 'Your changes will be lost if you don\'t save them.', icon: name => icon(name, 'ui-icon'), pointer: true, mount: document.body,
        actions: [
          {label: 'Don\'t save', value: 'discard', variant: 'ghost', tone: 'danger'},
          {label: 'Cancel', cancel: true, variant: 'ghost'},
          {label: 'Retry', value: 'retry', variant: 'ghost'},
          {label: 'Save', value: 'save', variant: 'primary', autofocus: true},
        ]});
      dialog.showModal();
      dialog.setError('Recovery copy could not be written: The disk is full.');
    });
    await settle(page);
  },
};

/** The dialog is up and has finished entering; nothing holds focus, as in the native screens. */
async function settle(page) {
  await page.waitForTimeout(500);
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.waitForTimeout(300);
}

await mkdir(out, {recursive: true});
const browser = await chromium.launch();
for (const [id, size] of Object.entries(SCENES)) {
  for (const theme of ['light', 'dark']) {
    const name = theme === 'light' ? id : `${id}-dark`;
    if (only.length && !only.includes(name)) continue;
    const context = await browser.newContext({viewport: {width: size[0], height: size[1]}, deviceScaleFactor: scale, locale: 'en-US', timezoneId: 'UTC', colorScheme: theme});
    const page = await context.newPage();
    await page.goto(`${base}/scene/${id}/${theme}`, {waitUntil: 'load'});
    await page.evaluate(async () => { await document.fonts.ready; });
    await scenes[id](page, context);
    await page.evaluate(() => { for (const element of document.querySelectorAll('*')) element.style.caretColor = 'transparent'; });
    const path = join(out, `${name}.png`);
    await page.screenshot({path, clip: {x: 0, y: 0, width: size[0], height: size[1]}, animations: 'allow', caret: 'hide'});
    console.log(name, size.join('x'), path);
    await context.close();
  }
}
await browser.close();
server.close();
