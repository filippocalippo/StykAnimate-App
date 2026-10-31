/** Portable text authoring and binary round trips. Requires STYK_URL (default :47831). */
import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(appRoot, 'artifacts');
const origin = process.env.STYK_URL || 'http://127.0.0.1:47831';
await mkdir(output, {recursive: true});
const browser = await chromium.launch({channel: 'chrome', headless: true});
const context = await browser.newContext({viewport: {width: 1400, height: 1040}});
const page = await context.newPage();
const errors = [], fontRequests = [];
page.on('pageerror', error => errors.push(error.stack));
page.on('request', request => { if (/\/vendor\/text\/.*\.ttf/.test(request.url())) fontRequests.push(request.url()); });
let result;
try {
  const health = await page.goto(`${origin}/tests/fixtures/blank.html`);
  assert.ok(health.ok(), 'The development server must be running.');
  result = await page.evaluate(async () => {
    const {createTextFigure} = await import('/src/text-authoring.mjs');
    const {emptyDocument, createFrame, createObject} = await import('/src/demo.mjs');
    const checks = window.textChecks = [];
    const check = (name, condition) => { if (!condition) throw new Error(name); checks.push({name, passed: true}); };
    const near = (a, b) => typeof a === 'number' && typeof b === 'number'
      && Math.abs(a - b) <= Math.max(0.00002, Math.abs(a) * 0.0000002);
    const sameNumbers = (a, b) => a.length === b.length && a.every((n, i) => near(n, b[i]));
    const text = 'Café ÀÉÖ — Ελληνικά\nПривет мир · 0123';
    const styles = [
      {name: 'Regular', bold: false, italic: false, alignment: 'left', color: [43, 43, 43]},
      {name: 'Bold', bold: true, italic: false, alignment: 'center', color: [104, 63, 204]},
      {name: 'Italic', bold: false, italic: true, alignment: 'right', color: [14, 131, 112]},
      {name: 'Bold italic outlined', bold: true, italic: true, alignment: 'left',
        color: [112, 89, 240], gradientColor: [244, 98, 116], outlineWidth: 1.5, outlineColor: [40, 31, 74]},
    ];
    const scene = emptyDocument(), placed = [];
    scene.canvas_width = 1300; scene.canvas_height = 620; scene.figure_types = [];
    const creationMs = [], figures = [];
    for (const [index, style] of styles.entries()) {
      const start = performance.now();
      const figure = await createTextFigure({...style, text, fontSize: 32, lineHeight: 1.3});
      creationMs.push(performance.now() - start); figures.push(figure);
      const asset = figure.text_assets?.[0];
      check(`${style.name}: authors portable Latin, accented, Greek and Cyrillic outlines`,
        asset && asset.text.replace(/\r\n/g, '\n') === text && asset.glyphs.some(g => g.commands.length)
        && asset.normalized_svg_path.length > 100 && asset.bounds.width > 100 && asset.bounds.height > 30);
      check(`${style.name}: persists style and one placement for every UTF-16 code unit`,
        Boolean(asset.font_style & 1) === style.bold && Boolean(asset.font_style & 2) === style.italic
        && asset.placements.length === asset.text.length);
      const visible = asset.placements.filter(p => p.visible);
      check(`${style.name}: multiline has at least two baselines and every visible glyph has a path`,
        new Set(visible.map(p => p.y)).size >= 2
        && visible.every(p => asset.glyphs[p.glyph_index]?.svg_path.length > 0));
      figure.figure_type_id = index + 1; scene.figure_types.push(figure);
      placed.push(createObject(figure, index + 1, index % 2 ? 680 : 50, index < 2 ? 210 : 490));
    }
    scene.keyframes = [createFrame(placed, 1)];
    check('All four font styles produce distinct glyph outlines', new Set(figures.map(f =>
      JSON.stringify(f.text_assets[0].glyphs.map(g => g.commands)))).size === 4);

    const alignmentOffsets = [];
    for (const alignment of ['left', 'center', 'right']) {
      const f = await createTextFigure({text: 'A\nAAAA', fontSize: 32, alignment});
      const a = f.text_assets[0], first = a.placements.find(p => p.visible);
      const second = a.placements.find(p => p.visible && p.y !== first.y);
      alignmentOffsets.push(first.x - second.x);
    }
    check('Left, center and right alignment change shorter-line placement consistently',
      near(alignmentOffsets[0], 0) && alignmentOffsets[1] > 0
      && near(alignmentOffsets[2], 2 * alignmentOffsets[1]));

    const document = scene;
    const assertAsset = (before, after, label) => {
      check(`${label}: text, font-style metadata, glyph count and placement count survive`,
        after?.text === before.text && after.font_name === before.font_name
        && after.font_style === before.font_style && after.alignment === before.alignment
        && after.glyphs.length === before.glyphs.length && after.placements.length === before.placements.length);
      check(`${label}: vector glyph opcodes and coordinates survive`, before.glyphs.every((glyph, i) => {
        const other = after.glyphs[i];
        return glyph.utf16_code_unit === other.utf16_code_unit
          && glyph.commands.length === other.commands.length
          && glyph.commands.every((command, j) => command.op === other.commands[j].op
            && sameNumbers(command.values, other.commands[j].values));
      }));
      check(`${label}: visible character positions survive`, before.placements.every((placement, i) => {
        const other = after.placements[i];
        return placement.glyph_index === other.glyph_index && placement.visible === other.visible
          && (!placement.visible || (near(placement.x, other.x) && near(placement.y, other.y)));
      }));
      check(`${label}: decoded portable text paths and bounds are present`,
        after.normalized_svg_path.length > 100 && ['left', 'top', 'right', 'bottom', 'width', 'height']
          .every(key => near(before.bounds[key], after.bounds[key])));
    };
    const exportFile = async (format, figureTypeId) => {
      const response = await (await import('/tests/support/page-codec.mjs')).codecFetch('/api/export', {method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({document, format, sourceId: null, figureTypeId})});
      if (!response.ok) throw new Error(`${format} export failed: ${await response.text()}`);
      const bytes = await response.arrayBuffer();
      const imported = await (await import('/tests/support/page-codec.mjs')).codecFetch(`/api/import?filename=text-authoring.${format}`, {method: 'POST',
        headers: {'Content-Type': 'application/octet-stream'}, body: bytes});
      if (!imported.ok) throw new Error(`${format} decoder failed: ${await imported.text()}`);
      return {bytes: [...new Uint8Array(bytes)], document: (await imported.json()).document};
    };
    const piv = await exportFile('piv'), stks = [];
    const sourceText = document.figure_types.filter(f => f.text_assets?.length);
    const importedText = piv.document.figure_types.filter(f => f.text_assets?.length);
    check('PIV preserves all four authored text definitions and scene poses', importedText.length === 4
      && piv.document.keyframes[0].objects.length === 4 && document.keyframes[0].objects.every((o, i) => {
        const other = piv.document.keyframes[0].objects[i];
        return near(o.root_x, other.root_x) && near(o.root_y, other.root_y) && near(o.scale, other.scale);
      }));
    for (const [i, figure] of sourceText.entries()) {
      assertAsset(figure.text_assets[0], importedText[i].text_assets[0], `PIV ${styles[i].name}`);
      const stk = await exportFile('stk', figure.figure_type_id);
      assertAsset(figure.text_assets[0], stk.document.figure_types.find(f => f.text_assets?.length)?.text_assets[0],
        `STK ${styles[i].name}`);
      stks.push(stk);
    }
    const rejected = [];
    for (const [label, options, expected] of [
      ['empty text', {text: ''}, /text|empty|character|visible/i],
      ['whitespace-only text', {text: ' \t\n '}, /text|empty|character|visible|whitespace/i],
      ['zero font size', {text: 'A', fontSize: 0}, /size/i],
      ['negative font size', {text: 'A', fontSize: -2}, /size/i],
      ['nonfinite font size', {text: 'A', fontSize: Number.NaN}, /size/i],
      ['infinite font size', {text: 'A', fontSize: Infinity}, /size/i],
      ['unsupported CJK glyph', {text: '漢'}, /glyph|support|font|character|U\+/i],
      ['unsupported emoji', {text: '😀'}, /glyph|support|font|character|UTF|BMP|U\+/i],
      ['missing glyph', {text: '\u0378'}, /glyph|support|font|character|U\+/i],
    ]) {
      let message = null;
      try { await createTextFigure(options); } catch (error) { message = error.message; }
      check(`Rejects ${label} with an actionable error`, typeof message === 'string' && expected.test(message));
      rejected.push({case: label, message});
    }
    return {checks, creationMs, rejected, alignmentOffsets, document: piv.document,
      pivBytes: piv.bytes, stkBytes: stks.map(s => s.bytes)};
  });

  assert.equal(new Set(fontRequests).size, 4, 'All four bundled font variants must be exercised.');
  result.checks.push({name: 'Regular, bold, italic and bold italic load the four real bundled font files', passed: true});
  assert.deepEqual(errors, []);
  const {document, pivBytes, stkBytes, ...report} = result;
  await writeFile(path.join(output, 'text-authored.piv'), Buffer.from(pivBytes));
  for (const [i, bytes] of stkBytes.entries()) await writeFile(path.join(output, `text-style-${i}.stk`), Buffer.from(bytes));
  await writeFile(path.join(output, 'text-verification.json'), JSON.stringify({...report,
    pivBytes: pivBytes.length, stkBytes: stkBytes.map(bytes => bytes.length), fontRequests, errors,
    timestamp: new Date().toISOString()}, null, 2));
  console.log(JSON.stringify({...report, pivBytes: pivBytes.length, stkBytes: stkBytes.map(bytes => bytes.length)}, null, 2));
} catch (error) {
  const checks = result?.checks || await page.evaluate(() => window.textChecks || []).catch(() => []);
  await writeFile(path.join(output, 'text-verification.json'), JSON.stringify({checks, errors, fontRequests, failure: error.stack}, null, 2));
  await page.screenshot({path: path.join(output, 'text-failure.png'), fullPage: true}).catch(() => {});
  throw error;
} finally { await browser.close(); }
