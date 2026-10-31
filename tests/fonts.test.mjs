/**
 * The bundled UI fonts: src/styles/base/fonts.css, assets/fonts/ and the
 * preload in index.html. Missing or unserved files fail silently in the app
 * (text falls back to system fonts), so this test is the guard.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {copyFile, mkdir, mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import hostModule from '../desktop/web-host.cjs';
import english from '../src/locales/en.mjs';
import locales from '../src/locales/locale-index.mjs';
import {parseCss} from '../scripts/check-css.mjs';
import {canvasFont, onFontsReady} from '../src/ui/font-loading.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(path.join(root, file), 'utf8');
const FONTS_CSS = 'src/styles/base/fonts.css';
const SUBSETS = ['latin', 'latin-ext', 'vietnamese', 'cyrillic', 'cyrillic-ext', 'greek', 'greek-ext'];
const FILES = {Inter: subset => `inter-${subset}-opsz-normal.woff2`, 'Inter Tight': subset => `inter-tight-${subset}-wght-normal.woff2`};
// Inter has no Arabic, Hebrew or Han glyphs; these languages use the system fonts in the html stack.
const SYSTEM_FONT_LOCALES = ['ar', 'he', 'zh-Hans'];

/** The @font-face rules of fonts.css with their files resolved from the repository root. */
function fontFaces() {
  const faces = [];
  const visit = items => {
    for (const item of items) {
      if (item.type === 'at' && item.name === 'font-face') {
        const value = name => item.block.find(declaration => declaration.property === name)?.value;
        const url = /^url\("([^"]+)"\) format\("woff2"\)$/.exec(value('src'))?.[1];
        faces.push({
          family: value('font-family').replace(/^"|"$/g, ''), style: value('font-style'), weight: value('font-weight'), display: value('font-display'),
          file: url && path.posix.join(path.posix.dirname(FONTS_CSS), url),
          ranges: value('unicode-range').split(',').map(range => range.trim().replace(/^U\+/i, '').split('-').map(hex => parseInt(hex, 16))),
        });
      } else if (item.block) visit(item.block);
    }
  };
  visit(parseCss(read(FONTS_CSS)).items);
  return faces;
}
const faces = fontFaces();
// Only the Inter latin face is preloaded and may block briefly; every other face swaps in.
// Inter Tight is not used yet, so preloading it would fetch a file nothing draws with.
const preloaded = face => face.family === 'Inter' && /-latin-opsz-/.test(face.file);
const covers = (family, character) => faces.some(face => face.family === family &&
  face.ranges.some(([low, high = low]) => character.codePointAt(0) >= low && character.codePointAt(0) <= high));
const preloads = [...read('index.html').matchAll(/<link\s[^>]*rel="preload"[^>]*>/g)].map(([tag]) => ({
  href: /href="([^"]+)"/.exec(tag)?.[1], as: /\bas="([^"]+)"/.exec(tag)?.[1], type: /type="([^"]+)"/.exec(tag)?.[1], crossorigin: /\scrossorigin\b/.test(tag),
}));

test('each family declares every subset once, as a bundled variable font', () => {
  for (const [family, file] of Object.entries(FILES))
    assert.deepEqual(faces.filter(face => face.family === family).map(face => face.file).sort(),
      SUBSETS.map(subset => `assets/fonts/${file(subset)}`).sort(), `${family} subsets`);
  assert.equal(faces.length, SUBSETS.length * 2);
  for (const face of faces) {
    assert.ok(existsSync(path.join(root, face.file)), `${face.file} exists`);
    assert.equal(face.style, 'normal');
    assert.equal(face.weight, '100 900', `${face.file} spans the weight axis`);
    assert.equal(face.display, preloaded(face) ? 'block' : 'swap', `${face.file} font-display`);
  }
  const bundled = readdirSync(path.join(root, 'assets/fonts')).filter(name => name.endsWith('.woff2'));
  assert.deepEqual(bundled.map(name => `assets/fonts/${name}`).sort(), faces.map(face => face.file).sort(), 'no unused font files ship');
  assert.match(read('src/styles/base/document.css'), /html\s*\{\s*font-family:\s*var\(--font-ui\);/, 'the document uses the UI font');
  assert.match(read('src/styles/tokens.css'), /--font-ui:\s*"Inter",/, 'the UI font starts with Inter');
  assert.match(read('src/styles/tokens.css'), /--font-display:\s*"Inter Tight",/, 'the display font starts with Inter Tight');
});

test('index.html preloads the Inter latin face and nothing else', () => {
  assert.deepEqual(preloads.map(preload => preload.href), faces.filter(preloaded).map(face => `./${face.file}`));
  assert.equal(preloads.length, 1);
  for (const preload of preloads) assert.deepEqual({...preload, href: undefined}, {href: undefined, as: 'font', type: 'font/woff2', crossorigin: true});
});

test('the fonts cover every shipped language that Inter supports', async () => {
  assert.equal(locales.length, 27);
  for (const locale of locales) {
    const messages = locale.id === 'en' ? english : (await import(`../src/locales/messages/${locale.id}.mjs`)).default;
    const captions = Object.values(messages)
      .flatMap(value => typeof value === 'string' ? [value] : Object.values(value));
    const text = [locale.nativeName, ...captions].join('');
    const letters = [...new Set(text.match(/[\p{L}\p{M}]/gu))];
    for (const family of Object.keys(FILES)) {
      const missing = letters.filter(character => !covers(family, character));
      if (SYSTEM_FONT_LOCALES.includes(locale.id)) assert.ok(missing.length, `${locale.id} still needs the system fonts`);
      else assert.deepEqual(missing, [], `${family} covers ${locale.id} (${locale.name})`);
    }
  }
});

test('the SIL Open Font License texts ship with the fonts', () => {
  for (const [file, project] of [['OFL-Inter.txt', 'rsms/inter)'], ['OFL-InterTight.txt', 'rsms/inter-tight)']]) {
    const license = read(`assets/fonts/${file}`);
    assert.match(license, /SIL OPEN FONT LICENSE Version 1\.1/);
    assert.ok(license.includes(`The Inter Project Authors (https://github.com/${project}`), `${file} names its copyright holder`);
  }
});

test('the packaged desktop app ships and serves the fonts', async t => {
  const {extraResources} = JSON.parse(read('package.json')).build;
  const web = extraResources.find(resource => resource.to === 'web');
  assert.equal(web.from, '.');
  for (const pattern of ['index.html', 'src/**/*', 'assets/**/*']) assert.ok(web.filter.includes(pattern), `the web root includes ${pattern}`);
  // A packaged web root with the files the fonts need, served as in the app.
  const directory = await mkdtemp(path.join(os.tmpdir(), 'styk-fonts-')), webRoot = path.join(directory, 'web');
  const files = ['index.html', FONTS_CSS, ...faces.map(face => face.file)];
  for (const file of files) {
    await mkdir(path.dirname(path.join(webRoot, file)), {recursive: true});
    await copyFile(path.join(root, file), path.join(webRoot, file));
  }
  const host = await hostModule.startDesktopHost({appRoot: root, resourcesPath: directory, packaged: true});
  t.after(async () => { await host.stop(); await rm(directory, {recursive: true, force: true}); });
  const get = pathname => new Promise((resolve, reject) => http.get(`${host.origin}${pathname}`, {agent: false}, response => {
    response.resume(); response.on('end', () => resolve(response)); response.on('error', reject);
  }).on('error', reject));
  for (const file of files.slice(1)) {
    const response = await get(`/${file}`);
    assert.equal(response.statusCode, 200, `/${file}`);
    assert.equal(response.headers['content-type'], file.endsWith('.css') ? 'text/css; charset=utf-8' : 'font/woff2', `/${file} type`);
  }
});

test('canvas painters repaint once per frame when fonts finish loading', async () => {
  assert.equal(typeof onFontsReady(() => assert.fail('no document, no fonts')), 'function');
  const fonts = new EventTarget(), frames = [], errors = [];
  Object.assign(globalThis, {document: {fonts}, requestAnimationFrame: callback => frames.push(callback), reportError: error => errors.push(error)});
  const flush = () => { for (const callback of frames.splice(0)) callback(); };
  const calls = {timeline: 0, audio: 0, closed: 0};
  const painters = new AbortController();
  onFontsReady(() => calls.timeline++, {signal: painters.signal});
  onFontsReady(() => { calls.audio++; throw new Error('paint failed'); });
  const stop = onFontsReady(() => calls.closed++);
  fonts.dispatchEvent(new Event('loadingdone'));
  fonts.dispatchEvent(new Event('loadingdone'));
  assert.equal(frames.length, 1, 'coalesced to one frame');
  flush();
  assert.deepEqual(calls, {timeline: 1, audio: 1, closed: 1});
  assert.deepEqual(errors.map(error => error.message), ['paint failed'], 'a failing painter does not stop the others');
  stop();
  painters.abort();
  fonts.dispatchEvent(new Event('loadingdone'));
  flush();
  assert.deepEqual(calls, {timeline: 1, audio: 2, closed: 1}, 'removed and aborted painters stop repainting');
  assert.equal(frames.length, 0);
});

test('canvas text uses the document UI font once the stylesheets apply', () => {
  const saved = {document: globalThis.document, getComputedStyle: globalThis.getComputedStyle};
  let token = '', reads = 0;
  Object.assign(globalThis, {document: {documentElement: {}}, getComputedStyle: () => {
    reads++;
    return {getPropertyValue: () => token, fontFamily: token ? 'Inter, "Segoe UI", sans-serif' : '"Times New Roman"'};
  }});
  try {
    assert.equal(canvasFont('11px'), '11px sans-serif', 'no UI font before the stylesheets apply');
    token = ' "Inter", "Segoe UI", sans-serif';
    assert.equal(canvasFont('11px'), '11px Inter, "Segoe UI", sans-serif');
    assert.equal(canvasFont('600 10px'), '600 10px Inter, "Segoe UI", sans-serif');
    assert.equal(reads, 2, 'the family is read once after the stylesheets apply');
  } finally {
    Object.assign(globalThis, saved);
  }
});
