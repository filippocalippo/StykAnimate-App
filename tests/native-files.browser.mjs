import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import backend from '../desktop/backend.cjs';
import {readNativeDocument} from '../scripts/read-native-document.mjs';

const appRoot = path.resolve('.'), out = path.join(appRoot, 'artifacts', 'native-files');
await mkdir(out, {recursive: true});
const service = await backend.startBackend({appRoot});
const browser = await chromium.launch({channel: 'chrome', headless: true});
const page = await browser.newPage({viewport: {width: 1440, height: 1000}, acceptDownloads: true});
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(service.origin);
  await page.waitForFunction(() => window.styk?.ready);
  await page.evaluate(async () => {
    const {createDemo} = await import('/src/demo.mjs');
    const report = createDemo();
    report.figure_types[0].name = 'Native figure 日本語';
    report.figure_types[0].segments[0].paint = {type: 'radial', angle: 35, stops: [
      {offset: 0, color: [255, 0, 0], opacity: 1}, {offset: .35, color: [0, 255, 0], opacity: .75}, {offset: 1, color: [0, 0, 255], opacity: 1}]};
    report.keyframes[0].objects[0]._stykStyle = {outlineOpacity: .123456789};
    styk.editor.load(report, 'Native saving'); styk.editor.select(1); styk.fit();
  });
  await page.evaluate(() => styk.actions.export());
  assert.equal(await page.locator('[data-action="export-stkz"]').isEnabled(), true);
  assert.equal(await page.locator('[data-action="export-stk"]').isEnabled(), true);
  await page.locator('[data-category="editable"]').click();
  await page.locator('#output-format').selectOption('export-stkz');
  await page.screenshot({path: path.join(out, 'export-dialog.png')});
  const figureDownload = page.waitForEvent('download');
  await page.locator('#export-submit').click();
  const figureFile = path.join(out, 'figure.stkz');
  const downloadedFigure = await figureDownload;
  assert.match(downloadedFigure.suggestedFilename(), /\.stkz$/);
  await downloadedFigure.saveAs(figureFile);
  const figure = await readNativeDocument(figureFile);
  assert.equal((await readFile(figureFile)).subarray(0, 4).toString(), 'STKZ');
  assert.equal(figure.figure_types.length, 1);
  assert.equal(figure.keyframes[0].objects.length, 1);
  assert.equal(figure.keyframes[0].objects[0]._stykStyle.outlineOpacity, .123456789);
  assert.equal(figure.figure_types[0].segments[0].paint.type, 'radial');
  const before = await page.evaluate(() => ({name: styk.editor.name, count: styk.editor.frame.objects.length}));
  await page.locator('#file-input').setInputFiles(figureFile);
  await page.waitForFunction(count => styk.editor.frame.objects.length === count + 1, before.count);
  assert.equal(await page.evaluate(() => styk.editor.name), before.name);
  assert.deepEqual(await page.evaluate(() => styk.editor.object.angles), figure.keyframes[0].objects[0].angles);
  const projectDownload = page.waitForEvent('download');
  await page.evaluate(() => styk.actions.save());
  const projectFile = path.join(out, 'saved.styk');
  await (await projectDownload).saveAs(projectFile);
  const projectBytes = await readFile(projectFile), project = await readNativeDocument(projectFile);
  assert.equal(projectBytes.subarray(0, 4).toString(), 'STYK');
  assert.ok(projectBytes.length < Buffer.byteLength(JSON.stringify(project)) / 2);
  await page.locator('#file-input').setInputFiles(projectFile);
  await page.waitForFunction(() => styk.editor.name === 'saved');
  assert.equal(await page.evaluate(() => styk.editor.report.keyframes[0].objects.length), before.count + 1);
  const corrupt = Buffer.from(projectBytes); corrupt[24] ^= 1;
  const rejection = await page.evaluate(async bytes => {
    const {ImportClient} = await import('/src/import-client.mjs'); const importer = new ImportClient();
    try { await importer.importFile(new File([new Uint8Array(bytes)], 'damaged.styk')); return null; }
    catch (error) { return error.message; } finally { importer.dispose(); }
  }, [...corrupt]);
  assert.match(rejection, /checksum/);
  assert.equal(await page.evaluate(() => styk.editor.name), 'saved');
  const mediaRoundtrip = await page.evaluate(async () => {
    const {createImageFigure} = await import('/src/media-authoring.mjs');
    const {createFrame, createObject, emptyDocument} = await import('/src/demo.mjs');
    const {DocumentExporter} = await import('/src/document-export.mjs');
    const {ImportClient} = await import('/src/import-client.mjs');
    const canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 2;
    canvas.getContext('2d').fillRect(0, 0, 2, 2);
    const dataUrl = canvas.toDataURL(), figure = createImageFigure({dataUrl, width: 2, height: 2});
    const report = emptyDocument(); report.figure_types = [figure]; report.keyframes = [createFrame([createObject(figure, 1, 10, 20)])];
    const exporter = new DocumentExporter(), importer = new ImportClient();
    try {
      const blob = await exporter.export(report, {format: 'stkz', figureUid: 1});
      const reopened = await importer.importFile(new File([blob], 'sprite.stkz'));
      return reopened.kind === 'stkz' && reopened.document.figure_types[0].image_assets[0].data_url === dataUrl;
    } finally { exporter.dispose(); importer.dispose(); }
  });
  assert.equal(mediaRoundtrip, true);
  await page.screenshot({path: path.join(out, 'reopened.png')});
  assert.deepEqual(errors, []);
  const evidence = {projectBytes: projectBytes.length, uncompressedBytes: Buffer.byteLength(JSON.stringify(project)),
    figureBytes: (await readFile(figureFile)).length, figureImportAddsToProject: true,
    exactStyleAndPose: true, embeddedSpritePreserved: mediaRoundtrip, checksumRejected: true, pageErrors: errors};
  await writeFile(path.join(out, 'results.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally { await browser.close(); service.stop(); }
