// Desktop check of the community library against a stand-in for the website's
// API (the routes of worker/library.js: /api/v1/content, the versioned index,
// the counting download route and the public files). Browses the Community
// library, inserts a figure and a movieclip with one undo step each, saves into
// My library (the WebP poster becomes a PNG preview), opens a
// stykanimate://library link, drags a card onto the canvas, and checks that each
// item is counted as one download however often it is used, including after a
// restart. Nothing leaves the machine.
import {_electron as electron} from '../tests/support/playwright.mjs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {RIG_EXAMPLES, rigExampleDocument} from '../src/rig-examples.mjs';
import {buildContainerV2} from '../tests/support/native-files.mjs';
import {validateScene} from '../src/pivot/model.mjs';

const root = process.cwd();
const run = path.join(root, 'artifacts', `public-library-${Date.now()}`), profile = path.join(run, 'profile'), library = path.join(run, 'library');
await mkdir(profile, {recursive: true});
await writeFile(path.join(profile, 'telemetry-state.json'), JSON.stringify({decided: true, consent: {analytics: false, diagnostics: false, policyVersion: '2026-09-10', updatedAt: Date.now()}}));

// What people upload: real figures from the rig examples (the movieclip is made in the app below), with a WebP poster like the website's.
const WEBP = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64');
const VERSION = 1790000000000;
const uploads = [];
for (const [id, rig, category, author] of [['fanfan1234', 'folding-fan', 'props', 'Kim'], ['boxbox1234', 'solid-box-3d', 'props', 'Ana'], ['cubecube12', 'glass-cube-3d', 'effects', 'Lee']]) {
  const example = RIG_EXAMPLES.find(entry => entry.id === rig), document = rigExampleDocument(rig); validateScene(document);
  uploads.push({id, kind: 'figure', title: example.name, file: `${rig}.stkz`, category, author, bytes: Buffer.from(await buildContainerV2(document, 'stkz'))});
}
const itemOf = upload => ({id: upload.id, k: upload.kind, c: upload.category, t: upload.title, d: `${upload.title} from the community.`, g: [upload.file.split('.')[0]], a: upload.author, s: upload.bytes.length,
  sha256: createHash('sha256').update(upload.bytes).digest('hex'), f: `i/${upload.id}/${upload.file}`, p: null, i: `i/${upload.id}/poster.webp`, w: 500, h: 500, m: '#478480', dl: 0, lk: 0, ft: 0, at: 1});

const requests = [], counted = [];
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://x');
  requests.push(`${url.pathname}${url.search}`);
  const json = value => response.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify(value));
  if (url.pathname === '/api/v1/content') return json({content: {}, library: {v: VERSION, count: uploads.length, downloads: 0, paused: false, base: null}});
  if (url.pathname === `/api/v1/library/index/${VERSION}`) return json({version: VERSION, downloads: 0, items: uploads.map(itemOf)});
  const download = /^\/api\/v1\/library\/get\/([a-z0-9]{10})$/.exec(url.pathname);
  if (download) { counted.push(download[1]); return response.writeHead(302, {location: `/api/v1/library/f/${url.searchParams.get('k')}`}).end(); }
  const object = /^\/api\/v1\/library\/f\/i\/([a-z0-9]{10})\/([\w.-]+)$/.exec(url.pathname), upload = object && uploads.find(entry => entry.id === object[1]);
  if (upload && object[2] === 'poster.webp') return response.writeHead(200, {'content-length': WEBP.length}).end(WEBP);
  if (upload && object[2] === upload.file) return response.writeHead(200, {'content-length': upload.bytes.length}).end(upload.bytes);
  response.writeHead(404).end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const site = `http://127.0.0.1:${server.address().port}`;
const checks = [], errors = [], check = (name, value = true) => { assert.ok(value, name); checks.push(name); console.log('PASS', name); };
let app, page;
async function start() {
  app = await electron.launch({args: [root], cwd: root, timeout: 45000, env: {...process.env, STYK_USER_DATA_DIR: profile, STYK_LIBRARY_DIR: library, STYK_PUBLIC_LIBRARY_URL: site}});
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.styk?.ready);
  const welcome = page.getByRole('button', {name: 'Close welcome screen'}); if (await welcome.isVisible()) await welcome.click();
}
const openCommunity = async () => {
  await page.getByRole('tab', {name: 'Library', exact: true}).click();
  await page.getByRole('button', {name: 'Community library', exact: true}).click();
};
const scene = () => page.evaluate(() => ({count: window.styk.editor.selectionFrame.objects.length, undo: window.styk.editor._undo.length}));
const inserted = async (id, before) => {
  await page.locator(`[data-public-id="${id}"]`).dblclick();
  await page.waitForFunction(count => !window.styk.library.busy && window.styk.editor.selectionFrame.objects.length === count + 1, before.count);
};
// Menus close when the list scrolls, so bring the card into view first.
const rightClick = async id => { await page.locator(`[data-public-id="${id}"]`).scrollIntoViewIfNeeded(); await page.waitForTimeout(250); await page.locator(`[data-public-id="${id}"]`).click({button: 'right'}); };
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
try {
  await start();
  // A movieclip made in the app itself and exported by its own exporter, as a person would share one.
  const clip = await page.evaluate(async () => {
    const editor = window.styk.editor, before = editor.selectionFrame.objects.length;
    const end = Math.min(12, editor.totalTicks);
    if (end < 2) throw new Error('The new project has no animation to capture.');
    editor.select(1); editor.createMovieclip({start: 0, end, name: 'Walk cycle'});
    const {librarySnapshot} = await import('/src/library-files.mjs'), report = librarySnapshot(editor);
    const blob = await window.styk.library.exporter.export(report, {format: 'stykmov', figureUids: report.keyframes[0].objects.map(object => object.unique_id)});
    const bytes = new Uint8Array(await blob.arrayBuffer()); let text = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) text += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    editor.undo();
    return {kind: report._styk.libraryKind, base64: btoa(text), duration: report.figure_types?.[0]?._styk?.movieclip?.duration ?? end, restored: editor.selectionFrame.objects.length === before};
  });
  assert.equal(clip.kind, 'movieclip'); assert.ok(clip.restored);
  uploads.push({id: 'clipclip12', kind: 'movieclip', title: 'Walk cycle', file: 'walk-cycle.stykmov', category: 'effects', author: 'Zed', bytes: Buffer.from(clip.base64, 'base64')});
  assert.equal(uploads.at(-1).bytes.subarray(0, 4).toString('latin1'), 'STMV');

  await openCommunity();
  await page.locator('[data-public-id="fanfan1234"] img').waitFor();
  check('the community library lists every upload, grouped by category', await page.locator('.library-card[data-public-id]').count() === uploads.length
    && (await page.locator('.library-group-label > span:first-child').allTextContents()).join('|') === 'Effects|Props');
  await page.waitForFunction(() => [...document.querySelectorAll('.library-card[data-public-id]')].every(card => card.classList.contains('is-loaded')));
  check('posters arrive from the website as images', await page.locator('[data-public-id="fanfan1234"] img').evaluate(image => image.naturalWidth > 0));
  check('a movieclip is marked as one', await page.locator('[data-public-id="clipclip12"] .library-kind').innerText() === 'Movieclip' && await page.locator('[data-public-id="clipclip12"] .library-clip-badge').count() === 1);
  await page.screenshot({path: path.join(run, 'community-light.png')});
  await page.evaluate(async () => (await import('/src/theme.mjs')).applyEditorTheme('dark'));
  await page.screenshot({path: path.join(run, 'community-dark.png')});
  await page.evaluate(async () => (await import('/src/theme.mjs')).applyEditorTheme('light'));

  const before = await scene();
  await inserted('fanfan1234', before);
  check('double-click inserts the verified community figure in one undo step', await page.evaluate(() => window.styk.editor.figure.name) === 'Folding fan' && (await scene()).undo === before.undo + 1);
  await page.evaluate(() => window.styk.editor.undo());
  check('undo removes the inserted figure', (await scene()).count === before.count);
  await inserted('fanfan1234', before); await page.evaluate(() => window.styk.editor.undo());
  await inserted('fanfan1234', before); await page.evaluate(() => window.styk.editor.undo());

  await inserted('clipclip12', before);
  check('double-click inserts a community movieclip, still animated, in one undo step', await page.evaluate(duration => {
    const figure = window.styk.editor.figure; return figure.name === 'Walk cycle' && figure._styk.movieclip?.duration === duration;
  }, clip.duration) && (await scene()).undo === before.undo + 1);
  await page.evaluate(() => window.styk.editor.undo());
  check('undo removes the inserted movieclip', (await scene()).count === before.count);

  await rightClick('boxbox1234');
  await page.getByRole('menuitem', {name: 'Save to My library', exact: true}).click();
  await page.waitForFunction(() => /saved to My library/.test(document.querySelector('.library-message').textContent));
  const saved = await readFile(path.join(library, 'Box.stkz')), preview = await readFile(path.join(library, 'Box.stkz.png'));
  check('Save to My library writes the verified figure', saved.equals(uploads[1].bytes));
  check('the WebP poster is kept as a real PNG preview', preview.subarray(0, 8).equals(PNG) && preview.length > 50);
  await rightClick('clipclip12');
  await page.getByRole('menuitem', {name: 'Save to My library', exact: true}).click();
  await page.waitForFunction(() => /Walk cycle saved to My library/.test(document.querySelector('.library-message').textContent));
  check('a movieclip saves as a .stykmov file with its preview', (await readFile(path.join(library, 'Walk cycle.stykmov'))).equals(uploads.at(-1).bytes)
    && (await readFile(path.join(library, 'Walk cycle.stykmov.png'))).subarray(0, 8).equals(PNG));
  await page.getByRole('button', {name: 'My library', exact: true}).click();
  await page.locator('[data-library-path="Walk cycle.stykmov"] img').waitFor();
  check('the saved assets appear in My library, the movieclip as a movieclip', await page.locator('[data-library-path="Box.stkz"] img').count() === 1 && await page.locator('.library-card.movieclip[data-library-path="Walk cycle.stykmov"]').count() === 1);

  await page.evaluate(() => { document.querySelector('.library-content').scrollTop = 0; });
  await app.evaluate(({app}) => app.emit('second-instance', {}, ['StykAnimate.exe', 'stykanimate://library/cubecube12']));
  await page.waitForFunction(() => window.styk.library.source === 'public' && document.activeElement?.dataset.publicId === 'cubecube12');
  check('a stykanimate://library link opens the asset selected in the community library', await page.locator('[data-public-id="cubecube12"][aria-selected="true"]').isVisible());
  await app.evaluate(({app}) => app.emit('second-instance', {}, ['StykAnimate.exe', 'stykanimate://library/..%2Fsecret']));
  await page.waitForTimeout(300);
  check('malformed library links are ignored', await page.evaluate(() => window.styk.library.publicSelected) === 'cubecube12');

  const card = await page.locator('[data-public-id="cubecube12"]').boundingBox(), stage = await page.locator('#viewport').boundingBox();
  await page.mouse.move(card.x + card.width / 2, card.y + 30); await page.mouse.down();
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2, {steps: 12});
  await page.waitForSelector('.library-drop-target'); await page.mouse.up();
  await page.waitForFunction(count => !window.styk.library.busy && window.styk.editor.selectionFrame.objects.length === count + 1, before.count);
  check('dragging a community card onto the canvas inserts it', await page.evaluate(() => window.styk.editor.figure.name) === 'Glass cube');
  const everyone = uploads.map(upload => upload.id).sort();
  check('every asset that was taken counted as one download, however often it was used, and browsing counted none', JSON.stringify([...counted].sort()) === JSON.stringify(everyone));

  // A new session has nothing cached: the assets are read again, but never counted a second time.
  await app.evaluate(({app}) => app.exit(0)).catch(() => {}); await new Promise(resolve => setTimeout(resolve, 800));
  const ledger = JSON.parse(await readFile(path.join(profile, 'community-downloads.json'), 'utf8'));
  check('the counted assets are remembered on this device, as public ids only', JSON.stringify([...ledger.ids].sort()) === JSON.stringify(everyone) && Object.keys(ledger).sort().join() === 'ids,version');
  const filesBefore = requests.filter(url => /^\/api\/v1\/library\/f\/i\/fanfan1234\/folding-fan\.stkz$/.test(url)).length;
  await start(); await openCommunity();
  await page.locator('[data-public-id="fanfan1234"] img').waitFor();
  const fresh = await scene();
  await inserted('fanfan1234', fresh);
  await page.evaluate(() => window.styk.editor.undo()); await inserted('clipclip12', fresh);
  check('after a restart the same assets insert again', await page.evaluate(() => window.styk.editor.figure.name) === 'Walk cycle');
  check('and are not counted again', JSON.stringify([...counted].sort()) === JSON.stringify(everyone));
  check('the public file was read directly instead', requests.filter(url => /^\/api\/v1\/library\/f\/i\/fanfan1234\/folding-fan\.stkz$/.test(url)).length === filesBefore + 1);
  check('only the API routes were requested', requests.every(url => /^\/api\/v1\/(content|library\/(index\/\d+|get\/[a-z0-9]{10}\?k=i%2F[a-z0-9]{10}%2F[\w.-]+|f\/i\/[a-z0-9]{10}\/[\w.-]+))$/.test(url)));
  assert.deepEqual(errors, []); check('no browser errors');
  await writeFile(path.join(run, 'evidence.json'), JSON.stringify({checks, requests: requests.length, counted, errors}, null, 2));
  console.log(JSON.stringify({run, checks: checks.length}, null, 2));
} catch (error) { await page?.screenshot({path: path.join(run, 'failure.png')}).catch(() => {}); console.error(await page?.locator('.library-message').innerText().catch(() => '')); throw error; }
finally { if (app) await app.evaluate(({app}) => app.exit(0)).catch(() => {}); server.close(); }
