import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
// The workers that open and save StykAnimate's own files load the Rust container module themselves
// (src/native-file-codec.mjs): the import worker opens a .styk, a .stkz and a .stykmov, and the export
// worker writes the same bytes the page's own copy of the module does. Needs the app served
// (STYK_URL, default http://127.0.0.1:47843).
const browser = await chromium.launch({channel: 'chrome', headless: true});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.STYK_URL || 'http://127.0.0.1:47843');
  await page.waitForFunction(() => window.styk?.ready);
  const result = await page.evaluate(async () => {
    const {buildContainerV2, decodeDocument} = await import('/tests/support/native-files.mjs');
    const {ImportClient} = await import('/src/import-client.mjs'), {DocumentExporter} = await import('/src/document-export.mjs');
    // The app's editor: the engine holds its document, and makes the figure and the exports from it.
    const editor = styk.editor;
    const figure = editor._shown.figureDocument({figureUid: 1, tick: 0});
    const figureSaved = new Uint8Array(await (await new DocumentExporter().export(editor.report, {format: 'stkz', figureUid: 1, tick: 0, revision: editor.revision})).arrayBuffer());
    editor.select(1);
    const clip = editor.createMovieclip({start: 0, end: editor.totalTicks}), clipUid = editor.selectedUid;
    const files = {
      'project.styk': await buildContainerV2(structuredClone(editor.report), 'styk'),
      'figure.stkz': await buildContainerV2(figure, 'stkz'),
      'clip.stykmov': await buildContainerV2(editor._shown.figureDocument({figureUid: clipUid, tick: 0}), 'stykmov'),
    };
    const importer = new ImportClient({}), opened = {};
    for (const [name, bytes] of Object.entries(files)) {
      const imported = await importer.importFile(new File([bytes], name));
      opened[name] = {kind: imported.kind, transport: imported.timings.transport, figures: imported.document.figure_types.length,
        frames: imported.document.keyframes.length, source: imported.sourceId};
    }
    importer.dispose();
    const exporter = new DocumentExporter();
    const saved = new Uint8Array(await (await exporter.export(editor.report, {format: 'styk', revision: editor.revision})).arrayBuffer());
    exporter.dispose();
    return {opened, clip: Boolean(clip && clipUid),
      savedMagic: new TextDecoder().decode(saved.subarray(0, 4)), savedVersion: saved[4],
      savedReopens: (await decodeDocument(saved, 'styk')).document.keyframes.length === editor.report.keyframes.length,
      figureMagic: new TextDecoder().decode(figureSaved.subarray(0, 4)), figureReopens: (await decodeDocument(figureSaved, 'stkz')).document.figure_types.length > 0};
  });
  assert.ok(result.clip, 'the fixture has a movieclip to save as .stykmov');
  assert.deepEqual(Object.fromEntries(Object.entries(result.opened).map(([name, item]) => [name, [item.kind, item.transport]])),
    {'project.styk': ['styk', 'local-container-v2'], 'figure.stkz': ['stkz', 'local-container-v2'], 'clip.stykmov': ['stykmov', 'local-container-v2']});
  assert.ok(result.opened['project.styk'].frames >= 1 && result.opened['figure.stkz'].frames === 1 && result.opened['clip.stykmov'].frames === 1);
  assert.deepEqual([result.savedMagic, result.savedVersion, result.savedReopens, result.figureMagic, result.figureReopens], ['STYK', 2, true, 'STKZ', true]);
  assert.deepEqual(errors, []);
  console.log('The import and document-export workers open and save native files through the Rust container module.');
} finally { await browser.close(); }
