/** Imported native text editing through the real STK/PIV writer and decoder. */
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'artifacts', 'native-text-authoring');
const origin = process.env.STYK_URL || 'http://127.0.0.1:47831';
const names = ['text_abc_66903de7', 'text_bike_f18f65c7', 'text_speech_bubble_0f3b81ef'];
const reports = await Promise.all(names.map(async name => JSON.parse(await readFile(
  path.join(root, '..', 'reports', 'browser_corpus', name, 'scene.json'), 'utf8'))));
const figures = reports.flatMap(report => report.figure_types.filter(figure => figure.text_assets?.length));
await mkdir(output, {recursive: true});
const browser = await chromium.launch({channel: 'chrome', headless: true});
const page = await browser.newPage({viewport: {width: 1320, height: 1180}});
const errors = [];
page.on('pageerror', error => errors.push(error.stack));
let result;
try {
  const health = await page.goto(`${origin}/api/health`);
  assert.ok(health.ok(), 'The actual codec backend is running.');
  result = await page.evaluate(async figures => {
    const {compileEmbeddedTextFigure, replaceTextAssetFigure, readTextFigureOptions} = await import('/src/native-text-authoring.mjs');
    const {createTextFigure} = await import('/src/text-authoring.mjs');
    const {Editor} = await import('/src/editor.mjs');
    const {drawGeometry, buildGeometry} = await import('/src/pivot/geometry.mjs');
    const checks = window.nativeTextChecks = [];
    const check = (name, condition) => { if (!condition) throw new Error(name); checks.push({name, passed: true}); };
    const near = (a, b) => typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b)
      && Math.abs(a - b) <= Math.max(.00002, Math.abs(a) * .0000002);
    const cases = figures.map(figure => ({label: `Unchanged ${figure.text_assets[0].font_name} ${figure.name}`,
      figure: compileEmbeddedTextFigure(readTextFigureOptions(figure), figure)}));
    const arial = figures.find(f => f.text_assets[0].font_name === 'Arial');
    const bike = figures.find(f => f.text_assets[0].font_name === 'Webdings');
    const speech = figures.find(f => f.text_assets[0].text === 'thought\r\nbubble');
    cases.push(
      {label: 'Reflowed Arial', figure: compileEmbeddedTextFigure({text: 'cb Ac', color: [78, 67, 162]}, arial)},
      {label: 'Repeated Webdings bicycle', figure: compileEmbeddedTextFigure({text: 'b b'}, bike)},
      {label: 'Reflowed Segoe Print', figure: compileEmbeddedTextFigure({text: 'bubble\nthought', alignment: 'right',
        color: [96, 63, 185], gradientColor: [224, 82, 130], outlineWidth: .7, outlineColor: [43, 29, 66]}, speech)},
      {label: 'Scaled centered Segoe Print', figure: compileEmbeddedTextFigure({embeddedScale: 150}, speech)},
      {label: 'Explicit replacement font', figure: replaceTextAssetFigure(arial,
        await createTextFigure({text: 'New font!', fontSize: 28, name: 'New font', bold: true, color: [32, 105, 90]}))},
    );
    const editor = new Editor({demo: false});
    editor.updateProject({canvas_width: 1200, canvas_height: 1000});
    for (const [index, item] of cases.entries()) {
      editor.importFigure(item.figure);
      editor.updateObject({root_x: 24 + index % 3 * 400, root_y: 205 + Math.floor(index / 3) * 240, scale: 2.7});
      item.figureTypeId = editor.figure.figure_type_id;
    }
    const document = editor.serialize();
    const render = scene => {
      const canvas = window.document.createElement('canvas'); canvas.width = 1200; canvas.height = 1000;
      const ctx = canvas.getContext('2d', {willReadFrequently: true});
      ctx.fillText = ctx.strokeText = ctx.measureText = () => { throw new Error('Embedded text used a platform font.'); };
      drawGeometry(ctx, buildGeometry(scene, scene.keyframes[0]));
      const pixels = ctx.getImageData(0, 0, 1200, 1000).data;
      let coverage = 0;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 100) coverage++;
      return {preview: canvas.toDataURL('image/png'), pixels, coverage};
    };
    const source = render(document);
    check('Real native Arial, Comic Sans, Webdings and Segoe Print paths render without platform fonts', source.coverage > 10000);
    const exportImport = async (format, figureTypeId) => {
      const exported = await fetch('/api/export', {method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({document, format, sourceId: null, figureTypeId})});
      if (!exported.ok) throw new Error(`${format} export: ${await exported.text()}`);
      const bytes = await exported.arrayBuffer();
      const imported = await fetch(`/api/import?filename=native-text-edited.${format}`, {method: 'POST',
        headers: {'Content-Type': 'application/octet-stream'}, body: bytes});
      if (!imported.ok) throw new Error(`${format} import: ${await imported.text()}`);
      return {bytes: [...new Uint8Array(bytes)], document: (await imported.json()).document};
    };
    const compare = (before, after, label) => {
      check(`${label}: exact text, font family, style, alignment and UTF-16 glyph order`,
        after?.text === before.text && after.font_name === before.font_name && after.font_style === before.font_style
        && after.alignment === before.alignment && JSON.stringify(after.glyphs.map(g => g.utf16_code_unit))
          === JSON.stringify(before.glyphs.map(g => g.utf16_code_unit)));
      check(`${label}: every vector opcode and float32 coordinate survives`, before.glyphs.every((glyph, i) => {
        const other = after.glyphs[i];
        return glyph.commands.length === other.commands.length && glyph.commands.every((command, j) => {
          const target = other.commands[j];
          return command.op === target.op && command.values.length === target.values.length
            && command.values.every((value, k) => near(value, target.values[k]));
        });
      }));
      check(`${label}: visible placements and normalized bounds survive`, before.placements.length === after.placements.length
        && before.placements.every((p, i) => {
          const q = after.placements[i];
          return p.utf16_code_unit === q.utf16_code_unit && p.glyph_index === q.glyph_index && p.visible === q.visible
            && (!p.visible || near(p.x, q.x) && near(p.y, q.y));
        }) && Object.keys(before.bounds).every(key => near(before.bounds[key], after.bounds[key]))
        && after.normalized_svg_path.length > 50);
    };
    const piv = await exportImport('piv'), stks = [];
    check('PIV retains all edited native text definitions and scene poses', piv.document.keyframes[0].objects.length === cases.length);
    const importedFigures = piv.document.figure_types.filter(figure => figure.text_assets?.length);
    check('PIV retains every portable text definition', importedFigures.length === cases.length);
    for (const [caseIndex, item] of cases.entries()) {
      const before = document.figure_types.find(f => f.figure_type_id === item.figureTypeId).text_assets[0];
      // The native writer compacts unused figure slots, so compare source order, not authoring IDs.
      const reopened = importedFigures[caseIndex];
      compare(before, reopened?.text_assets?.[0], `PIV ${item.label}`);
      const stk = await exportImport('stk', item.figureTypeId);
      compare(before, stk.document.figure_types.find(f => f.text_assets?.length)?.text_assets[0], `STK ${item.label}`);
      stks.push({label: item.label, bytes: stk.bytes});
    }
    const reopened = render(piv.document);
    let totalError = 0, changed = 0;
    for (let i = 0; i < source.pixels.length; i++) {
      const delta = Math.abs(source.pixels[i] - reopened.pixels[i]); totalError += delta; if (delta > 2) changed++;
    }
    const raster = {sourceCoverage: source.coverage, reopenedCoverage: reopened.coverage,
      meanAbsoluteChannelError: totalError / source.pixels.length, changedChannelFraction: changed / source.pixels.length};
    check('Actual PIV rendering preserves edited native outlines, multiline layout, paint and scale',
      raster.meanAbsoluteChannelError < .15 && raster.changedChannelFraction < .003);
    return {checks, raster, document: piv.document, sourcePreview: source.preview, reopenedPreview: reopened.preview,
      pivBytes: piv.bytes, stks, cases: cases.map(item => ({label: item.label, figureTypeId: item.figureTypeId}))};
  }, figures);
  const isolated = await browser.newContext();
  const fontRequests = [];
  await isolated.route(/\/vendor\/text\/|\.(?:ttf|otf|woff2?)(?:\?|$)/i, route => {
    fontRequests.push(route.request().url()); return route.abort();
  });
  const portablePage = await isolated.newPage();
  await portablePage.goto(`${origin}/api/health`);
  const portablePreview = await portablePage.evaluate(async scene => {
    const {drawGeometry, buildGeometry} = await import('/src/pivot/geometry.mjs');
    const reject = () => { throw new Error('Reopened native text used a platform font.'); };
    CanvasRenderingContext2D.prototype.fillText = CanvasRenderingContext2D.prototype.strokeText = CanvasRenderingContext2D.prototype.measureText = reject;
    for (const figure of scene.figure_types) for (const asset of figure.text_assets || []) asset.font_name = 'Deliberately unavailable font 983127';
    const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 1000;
    drawGeometry(canvas.getContext('2d', {willReadFrequently: true}), buildGeometry(scene, scene.keyframes[0]));
    return canvas.toDataURL('image/png');
  }, result.document);
  assert.ok(portablePreview === result.reopenedPreview, 'Reopened edited text renders identical pixels without its original fonts.');
  assert.deepEqual(fontRequests, []);
  assert.deepEqual(errors, []);
  result.checks.push({name: 'Fresh font-blocked browser renders edited native text identically with platform text APIs forbidden', passed: true});
  await isolated.close();
  const {document, pivBytes, stks, sourcePreview, reopenedPreview, ...report} = result;
  await writeFile(path.join(output, 'edited-native-text.piv'), Buffer.from(pivBytes));
  for (const [i, stk] of stks.entries()) await writeFile(path.join(output, `edited-native-${i}.stk`), Buffer.from(stk.bytes));
  await writeFile(path.join(output, 'source.png'), Buffer.from(sourcePreview.split(',')[1], 'base64'));
  await writeFile(path.join(output, 'reopened.png'), Buffer.from(reopenedPreview.split(',')[1], 'base64'));
  await writeFile(path.join(output, 'report.json'), JSON.stringify({...report, errors, fontRequests,
    pivBytes: pivBytes.length, stkBytes: stks.map(stk => ({label: stk.label, bytes: stk.bytes.length})), timestamp: new Date().toISOString()}, null, 2));
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>body{margin:24px;background:#f5f5f5;color:#252525;font:14px system-ui}h1{font-size:22px}p{color:#666}img{display:block;width:1200px;background:white;border:1px solid #ddd;border-radius:8px}</style><h1>Edited native Pivot text</h1><p>Arial, Comic Sans, Webdings and Segoe Print. PIV reopened in a fresh browser with font loading disabled.</p><img src="${portablePreview}" alt="Imported and edited native vector text, including a bicycle glyph and multiline captions">`);
  await page.screenshot({path: path.join(output, 'preview.png'), fullPage: true});
  console.log(JSON.stringify({...report, pivBytes: pivBytes.length, stkCount: stks.length}, null, 2));
} catch (error) {
  const checks = result?.checks || await page.evaluate(() => window.nativeTextChecks || []).catch(() => []);
  await writeFile(path.join(output, 'report.json'), JSON.stringify({checks, errors, failure: error.stack}, null, 2));
  throw error;
} finally {
  await browser.close();
}
