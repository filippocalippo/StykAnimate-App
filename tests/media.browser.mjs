import {chromium} from 'playwright';
import {createRequire} from 'node:module';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url), appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {startBackend} = require('../desktop/backend.cjs');
const backend = await startBackend({appRoot});
let browser;
try {
  try { browser = await chromium.launch({headless: true}); }
  catch { browser = await chromium.launch({channel: 'chrome', headless: true}); }
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${backend.origin}/api/health`);
  const result = await page.evaluate(async () => {
    const {imageFileToFigure, imageFileToBackground} = await import('/src/media-authoring.mjs');
    const {Editor} = await import('/src/editor.mjs');
    const {buildGeometry, drawGeometry} = await import('/src/pivot/geometry.mjs');
    const assert = (value, message) => { if (!value) throw new Error(message); }, checks = [];
    const source = document.createElement('canvas'); source.width = source.height = 4;
    const sourceContext = source.getContext('2d');
    sourceContext.fillStyle = '#8054e7'; sourceContext.fillRect(0, 0, 4, 4);
    sourceContext.fillStyle = '#55d8c0'; sourceContext.fillRect(0, 3, 1, 1);
    sourceContext.fillStyle = '#f4b252'; sourceContext.fillRect(2, 1, 2, 2);
    const png = await new Promise(resolve => source.toBlob(resolve, 'image/png'));
    const file = new File([png], 'Palette.png', {type: 'image/png'});
    const sprite = await imageFileToFigure(file), keyed = await imageFileToFigure(file, {preserveOpaqueBackground: false});
    assert(sprite.image_assets[0].data_url.startsWith('data:image/png;base64,'), 'Sprite is not embedded PNG.');
    assert(sprite.image_assets[0].width === 4 && sprite.image_assets[0].height === 4, 'Sprite dimensions changed.');
    const image = new Image(); image.src = keyed.image_assets[0].data_url; await image.decode();
    sourceContext.clearRect(0, 0, 4, 4); sourceContext.drawImage(image, 0, 0);
    const pixel = sourceContext.getImageData(0, 3, 1, 1).data;
    assert(pixel[3] === 0, 'Optional Pivot sprite color key did not remove the bottom-left color.');
    checks.push('Actual PNG File decoded and embedded; native optional color key changes matching alpha.');
    const editor = new Editor({demo: false}); editor.updateProject({canvas_width: 400, canvas_height: 240});
    editor.importFigure(sprite); editor.updateObject({scale: 32});
    const background = await imageFileToBackground(file, {backgroundId: 1});
    editor.report.backgrounds = [background]; editor.frame.background_id = 1;
    const serialized = editor.serialize();
    const exportFile = async format => {
      const response = await fetch('/api/export', {method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({document: serialized, sourceId: null, format, figureTypeId: editor.object.figure_type_id})});
      assert(response.ok, `${format} export failed: ${await response.clone().text()}`);
      const bytes = await response.arrayBuffer();
      const imported = await fetch(`/api/import?filename=media.${format}`, {method: 'POST', headers: {'Content-Type': 'application/octet-stream'}, body: bytes});
      assert(imported.ok, `${format} decoder rejected newly authored media: ${await imported.clone().text()}`);
      return {bytes: bytes.byteLength, result: await imported.json()};
    };
    const piv = await exportFile('piv'), stk = await exportFile('stk');
    const pivDocument = piv.result.document, stkDocument = stk.result.document;
    assert(pivDocument.figure_types.some(f => f.image_assets?.length), 'PIV sprite asset missing after writer round trip.');
    assert(pivDocument.backgrounds.some(b => b.mime_type === 'image/png' && b.data_url === background.data_url), 'PIV image background bytes changed or disappeared after writer round trip.');
    assert(stkDocument.figure_types.some(f => f.image_assets?.length), 'STK sprite asset missing after writer round trip.');
    checks.push('New image sprite and background write as PIV and decode with embedded media intact.');
    checks.push('New sprite writes as STK and decodes with its embedded image.');
    const decoded = new Image(); decoded.src = sprite.image_assets[0].data_url; await decoded.decode();
    const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 240;
    const context = canvas.getContext('2d'); context.fillStyle = '#eef0f6'; context.fillRect(0, 0, 400, 240);
    drawGeometry(context, buildGeometry(editor.report, editor.frame), {url: a => a.data_url, image: () => decoded});
    const center = context.getImageData(144, 64, 1, 1).data;
    assert(center[0] === 128 && center[1] === 84 && center[2] === 231, 'Authored sprite did not render in evaluated scene.');
    checks.push('Authored sprite renders through the actual evaluated Pivot geometry and Canvas reference path.');
    const jpeg = await new Promise(resolve => source.toBlob(resolve, 'image/jpeg'));
    const jpegFigure = await imageFileToFigure(new File([jpeg], 'Photo.jpg', {type: 'image/jpeg'}));
    assert(jpegFigure.image_assets[0].mime_type === 'image/png', 'JPEG was not normalized to PNG.');
    checks.push('JPEG File input normalizes to embedded PNG.');
    let failed = false;
    try { await imageFileToFigure(new File(['damaged'], 'bad.png', {type: 'image/png'})); } catch { failed = true; }
    assert(failed, 'Damaged image did not fail explicitly.'); checks.push('Damaged images fail before returning an authored figure.');
    return {checks, pivBytes: piv.bytes, stkBytes: stk.bytes, preview: canvas.toDataURL('image/png')};
  });
  if (errors.length) throw new Error(errors.join('\n'));
  const artifactRoot = path.join(appRoot, 'artifacts'); await mkdir(artifactRoot, {recursive: true});
  const {preview, ...report} = result;
  await writeFile(path.join(artifactRoot, 'media-authoring.png'), Buffer.from(preview.split(',')[1], 'base64'));
  await writeFile(path.join(artifactRoot, 'media-authoring.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser?.close(); backend.stop(); }
