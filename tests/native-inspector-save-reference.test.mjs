// Explicit oracle run for B1: today's owned editor applies the Inspector's colour and layer edits with the calls
// today's interface makes (src/app.mjs's colour picker resolver, src/inspector-bindings.mjs), twice, then saves
// initial, edited, undo and redo. Outputs go only to the caller's ignored artifacts directory; the native test
// `inspector_paint::saves_equal_today` compares its own saves with them byte for byte.
import assert from 'node:assert/strict';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import test from 'node:test';

const reference = process.env.STYK_REFERENCE_ROOT
  ? pathToFileURL(`${path.resolve(process.env.STYK_REFERENCE_ROOT)}${path.sep}`)
  : new URL('../', import.meta.url);
const {DocumentExporter} = await import(new URL('src/document-export.mjs', reference));
const {attachRead, openBytes} = await import(new URL('src/engine/engine-open.mjs', reference));
const {FakeCodecHost} = await import(new URL('tests/support/codec-host.mjs', reference));
const {useExportWorker} = await import(new URL('tests/support/export-worker.mjs', reference));
const {newOwnedEditor} = await import(new URL('tests/support/owned-editor.mjs', reference));
const {paintBackground} = await import(new URL('src/paint.mjs', reference));

const NATIVE = 'engine/tests/edit/selection-metadata-plain-native.document.json';
const SHEET = 'engine/tests/edit/property-sheet.document.json';
// `rangeFrames()` on a layer sheet: the frame on show's index carrying the chosen ticks and the playhead's.
const range = (editor, ticks) => Object.assign([editor.frameIndex], {sheetTicks: [...new Set([...ticks, editor.tick])]});
const gradient = {type: 'linear', angle: 45, stops: [{offset: 0, color: [255, 0, 0], opacity: 1}, {offset: 0.4, color: [0, 128, 255], opacity: 0.5}, {offset: 1, color: [10, 20, 30], opacity: 1}]};

// [id, source, what today's interface does for the edit]
const cases = [
  ['figure-color', NATIVE, editor => { editor.select(1, -1); return () => editor.setFigureColor('#ff0000', {opacity: 0.5}); }],
  ['figure-opacity', NATIVE, editor => { editor.select(1, -1); return () => editor.setFigureColor(undefined, {opacity: 0.25}); }],
  ['figure-range', NATIVE, editor => { editor.select(1, -1); return () => editor.setFigureColor('#00ff00', {indices: range(editor, [0, 6]), opacity: 1}); }],
  ['palette', NATIVE, (editor, side) => {
    editor.select(1, -1);
    const entry = editor.figurePalette()[0];
    side.from = entry.color;
    return () => editor.replaceFigureColor(entry.color, [0, 128, 0], {targets: entry, indices: undefined});
  }],
  ['polygon', NATIVE, editor => { editor.select(1, -1); return () => editor.updatePolygon(0, {color: [10, 20, 30], opacity: 0.25}); }],
  ['background-solid', NATIVE, editor => () => editor.setSceneColor(paintBackground({type: 'solid', angle: 0, stops: [{offset: 0, color: [1, 2, 3], opacity: 1}]}).color, {indices: undefined})],
  ['background-range', NATIVE, editor => () => editor.setSceneColor(paintBackground({type: 'solid', angle: 0, stops: [{offset: 0, color: [9, 8, 7], opacity: 0.5}]}).color, {indices: range(editor, [0, 6])})],
  ['background-gradient', NATIVE, editor => () => editor.importSceneBackground({...paintBackground(gradient), name: 'linear gradient'}, {indices: undefined})],
  ['segment-paint', NATIVE, editor => { editor.select(1, 0); return () => editor.updateBuilderSegmentStyle({paint: gradient}, {branch: false}); }],
  ['layer', SHEET, editor => {
    editor.select(1, -1);
    return () => { const changed = editor.assignFiguresToLayer([1], 'layer-2'); if (changed) editor.setActiveLayer('layer-2'); return changed; };
  }],
];

test('native inspector save oracle: old-versus-old is byte-identical after each edit, undo and redo', {
  skip: process.env.STYK_NATIVE_SAVE_ORACLE ? false : 'explicit native comparison; set STYK_NATIVE_SAVE_ORACLE to an artifacts directory',
  timeout: 120000,
}, async t => {
  await import(new URL('tests/support/register-engine.mjs', reference));
  useExportWorker(t);
  const directory = path.resolve(process.env.STYK_NATIVE_SAVE_ORACLE);
  assert.ok(directory.includes(`${path.sep}artifacts${path.sep}`), 'oracle outputs belong under ignored artifacts');
  mkdirSync(directory, {recursive: true});
  for (const [id, source, prepare] of cases) {
    const runs = [], sides = [];
    for (let round = 0; round < 2; round++) {
      const bytes = new Uint8Array(readFileSync(new URL(`../${source}`, import.meta.url)));
      const opening = await openBytes(bytes, 'Parity.styk', {layerTimeline: true});
      const read = await opening.read(); attachRead(read.report, read);
      const editor = newOwnedEditor({demo: false, propertyChannels: true, layerTimeline: true});
      editor.load(read.report, 'Parity', {initialFrameIndex: 0});
      const side = {};
      const edit = prepare(editor, side);
      const codecHost = new FakeCodecHost(), exporter = new DocumentExporter({codecHost, idleMs: 0});
      const saved = [];
      try {
        for (const phase of ['initial', 'edited', 'undo', 'redo']) {
          if (phase === 'edited') edit();
          if (phase === 'undo') editor.undo();
          if (phase === 'redo') editor.redo();
          const blob = await exporter.export(editor.report, {name: 'Parity', revision: editor.revision});
          saved.push(Buffer.from(await blob.arrayBuffer()));
          editor.markSaved();
        }
      } finally { exporter.dispose(); codecHost.close(); }
      runs.push(saved); sides.push(side);
    }
    assert.deepEqual(sides[0], sides[1], `${id}: old-versus-old side data`);
    assert.notDeepEqual(runs[0][1], runs[0][0], `${id}: the edit changes the saved bytes`);
    for (let phase = 0; phase < 4; phase++) {
      assert.deepEqual(runs[0][phase], runs[1][phase], `${id}/${phase}: old-versus-old byte baseline`);
      writeFileSync(path.join(directory, `${id}-${phase}.styk`), runs[0][phase]);
    }
    writeFileSync(path.join(directory, `${id}.json`), JSON.stringify(sides[0]));
  }
  console.log(`INSPECTOR_SAVE_ORACLE: ${cases.length * 4} old-versus-old byte comparisons passed; no differing fields`);
});
