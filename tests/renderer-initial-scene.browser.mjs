import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

const output = path.resolve('artifacts/renderer-initial-scene'); await mkdir(output, {recursive: true});
const browser = await chromium.launch({channel: 'chrome', headless: true});
const checks = [], errors = [];
try {
  const page = await browser.newPage({viewport: {width: 1280, height: 850}});
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.STYK_URL || 'http://127.0.0.1:47831'); await page.waitForFunction(() => window.styk?.ready);
  const result = await page.evaluate(async () => {
    const {createRenderer} = await import('/src/renderer.mjs'), {buildGeometry} = await import('/src/pivot/geometry.mjs');
    const {createFrame, createObject, defaultFigure} = await import('/src/demo.mjs');
    const {imageFileToFigure} = await import('/src/media-authoring.mjs');
    const source = document.createElement('canvas'); source.width = 32; source.height = 24;
    const context = source.getContext('2d'); context.fillStyle = '#d8542c'; context.fillRect(0, 0, 32, 24);
    context.fillStyle = '#2077c9'; context.fillRect(0, 12, 16, 12); context.fillStyle = '#35c976'; context.fillRect(16, 0, 16, 12);
    const url = source.toDataURL('image/png'), blob = await new Promise(resolve => source.toBlob(resolve, 'image/png'));
    const sprite = await imageFileToFigure(new File([blob], 'initial-sprite.png', {type: 'image/png'}), {preserveOpaqueBackground: true});
    sprite.figure_type_id = 2;
    const figure = defaultFigure(), a = createObject(figure, 1, 80, 120, {scale: .4, field28: 65});
    const b = createObject(sprite, 2, 110, 70, {scale: 1.8});
    const frame = createFrame([a, b]); frame.background_id = 1; frame.camera = {is_default: false, x: 15, y: 20, scale: .65, angle_rad: .3};
    const incoming = {version: 5, canvas_width: 240, canvas_height: 180, fps: 24, figure_types: [figure, sprite],
      backgrounds: [{background_id: 1, kind: 1, mime_type: 'image/png', asset_url: url}], keyframes: [createFrame([createObject(figure, 1, 15, 20)]), frame]};
    const renderer = styk.state.renderer, priorReport = styk.editor.report, priorBuffer = renderer.shapeBuffer;
    const originalPrepare = renderer.prepareInitialScene.bind(renderer), originalRender = renderer.render.bind(renderer), preparationChecks = [], submissions = [];
    renderer.prepareInitialScene = async options => {
      const prepared = await originalPrepare({...options, sliceMs: .05, onProgress: () => {
        preparationChecks.push(renderer.activeReport === priorReport && renderer.shapeBuffer === priorBuffer && styk.editor.report === priorReport);
      }});
      preparationChecks.push(renderer.activeReport === priorReport && renderer.shapeBuffer === priorBuffer && styk.editor.report === priorReport);
      return prepared;
    };
    renderer.render = options => {
      const result = originalRender(options);
      if (options.report === incoming) submissions.push({stats: structuredClone(renderer.stats), frame: options.frame,
        cameraEnabled: options.cameraEnabled, backgrounds: renderer.backgroundsReady(incoming, options.frame),
        textures: renderer.layout.filter(entry => !entry.g && entry.texture).length});
      return result;
    };
    styk.editor.markSaved(); await styk.acceptImport({document: incoming, kind: 'piv'}, 'Initial prepared scene.piv');
    await new Promise(requestAnimationFrame); await renderer.device.queue.onSubmittedWorkDone();
    renderer.prepareInitialScene = originalPrepare; renderer.render = originalRender;
    const first = submissions[0], options = {...renderer.last, geometry: styk.editor.geometry};
    renderer.render(options); const actual = renderer.canvas.toDataURL('image/png');
    const capturedStats = structuredClone(renderer.stats);
    const entries = [...renderer.layout]; for (const entry of entries) renderer.uploadEntry(entry);
    renderer.render(options); const legacy = renderer.canvas.toDataURL('image/png');
    const referenceCanvas = document.createElement('canvas'), fresh = await createRenderer(referenceCanvas, {resources: renderer.resources});
    fresh.resize(renderer.width, renderer.height, renderer.dpr);
    const freshGeometry = buildGeometry(incoming, styk.editor.evaluatedFrame);
    fresh.render({...options, geometry: freshGeometry}); const reference = referenceCanvas.toDataURL('image/png'); fresh.destroy();
    const liveReport = styk.editor.report, liveBuffer = renderer.shapeBuffer, broken = structuredClone(incoming);
    broken.backgrounds[0].asset_url = 'data:image/png;base64,AAAA';
    styk.editor.markSaved(); let rejected = false;
    try {await styk.acceptImport({document: broken, kind: 'piv'}, 'Broken media.piv');} catch {rejected = true;}
    renderer.render(options); const afterFailure = renderer.canvas.toDataURL('image/png');
    return {first: first && {stats: first.stats, cameraEnabled: first.cameraEnabled, backgrounds: first.backgrounds, textures: first.textures},
      frameIndex: styk.editor.frameIndex, firstIsFinalFrame: first?.frame === styk.editor.evaluatedFrame,
      stagedOldScenePreserved: preparationChecks.length > 0 && preparationChecks.every(Boolean),
      cachedFirstGeometry: options.geometry === renderer.lastGeometry, capturedStats, batchMatchesLegacy: actual === legacy,
      pixelsMatchFresh: actual === reference, failedMediaPreservesScene: rejected && styk.editor.report === liveReport && renderer.shapeBuffer === liveBuffer && actual === afterFailure,
      actual, reference, legacy};
  });
  const check = (name, condition) => {assert.ok(condition, name); checks.push(name);};
  check('Old report and GPU buffers remain live throughout private preparation', result.stagedOldScenePreserved);
  check('First visible frame is the final native key and exact prepared evaluated frame', result.frameIndex === 1 && result.firstIsFinalFrame);
  check('First render uses completed background and sprite media', result.first.backgrounds && result.first.textures === 1 && result.first.stats.textureObjects >= 2);
  check('First canvas render uses retained geometry with zero compilation or primitive uploads', result.first.stats.preparation === 'retained' && result.first.stats.compiledObjects === 0 && result.first.stats.uploadBytes === 0);
  check('Editor camera remains neutral despite saved animation camera', result.first.cameraEnabled === false);
  check('Prepared GPU pixels match independent fresh geometry and compilation exactly', result.pixelsMatchFresh);
  check('Current batched GPU layout matches old per-object uploads exactly', result.batchMatchesLegacy);
  check('Failed incoming image decode preserves the prior editor and exact canvas', result.failedMediaPreservesScene);
  check('No browser or WebGPU error escaped', errors.length === 0);
  for (const key of ['actual', 'reference', 'legacy']) {await writeFile(path.join(output, `${key}.png`), Buffer.from(result[key].split(',')[1], 'base64')); delete result[key];}
  await writeFile(path.join(output, 'report.json'), JSON.stringify({checks, errors, result}, null, 2));
  console.log(JSON.stringify({checks, first: result.first, output}));
} finally {await browser.close();}
