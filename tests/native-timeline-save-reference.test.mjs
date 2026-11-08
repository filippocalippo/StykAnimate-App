// Explicit oracle run for K-timeline: today's owned editor and export worker, twice before comparing native bytes.
// Outputs go only to the caller's ignored artifacts directory; frozen fixtures are read, never regenerated.
import assert from 'node:assert/strict';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import test from 'node:test';

// A pinned reference checkout avoids pairing native-app's newer binding calls with today's WASM.
// Only read its modules and package; the oracle writes exclusively in this checkout's artifacts.
const reference = process.env.STYK_REFERENCE_ROOT
  ? pathToFileURL(`${path.resolve(process.env.STYK_REFERENCE_ROOT)}${path.sep}`)
  : new URL('../', import.meta.url);
const {DocumentExporter} = await import(new URL('src/document-export.mjs', reference));
const {attachRead, openBytes} = await import(new URL('src/engine/engine-open.mjs', reference));
const {FakeCodecHost} = await import(new URL('tests/support/codec-host.mjs', reference));
const {useExportWorker} = await import(new URL('tests/support/export-worker.mjs', reference));
const {newOwnedEditor} = await import(new URL('tests/support/owned-editor.mjs', reference));

const cases = [
  ['startup', 'engine/tests/edit/startup.document.json', 'Parity.styk'],
  ['channels', 'engine/tests/containers/project-channels.styk', 'Parity.styk'],
  ['drawing', 'engine/tests/containers/project-drawing.styk', 'Parity.styk'],
  ['pivot', 'engine/crates/styk-piv/tests/fixtures/modern-type-change.piv', 'Parity.piv'],
];

test('native timeline selection save oracle: old-versus-old is byte-identical after edits, undo and redo', {
  skip: process.env.STYK_NATIVE_SAVE_ORACLE ? false : 'explicit native comparison; set STYK_NATIVE_SAVE_ORACLE to an artifacts directory',
  timeout: 120000,
}, async t => {
  await import(new URL('tests/support/register-engine.mjs', reference));
  useExportWorker(t);
  const directory = path.resolve(process.env.STYK_NATIVE_SAVE_ORACLE);
  assert.ok(directory.includes(`${path.sep}artifacts${path.sep}`), 'oracle outputs belong under ignored artifacts');
  mkdirSync(directory, {recursive: true});
  for (const [id, source, filename] of cases) {
    const runs = [];
    for (let round = 0; round < 2; round++) {
      const bytes = new Uint8Array(readFileSync(new URL(`../${source}`, import.meta.url)));
      const opening = await openBytes(bytes, filename, {layerTimeline: true});
      if (opening.hasSource) opening.attachSource(bytes);
      const read = await opening.read(); attachRead(read.report, read);
      const editor = newOwnedEditor({demo: false, propertyChannels: true, layerTimeline: true});
      editor.load(read.report, 'Parity', {initialFrameIndex: opening.kind === 'piv' && !opening.savedDraft ? 'last' : 0});
      const codecHost = new FakeCodecHost(), exporter = new DocumentExporter({codecHost, idleMs: 0});
      const saved = [];
      try {
        for (const phase of ['initial', 'edited', 'undo', 'redo']) {
          if (phase === 'edited') editor.setFPS(30);
          if (phase === 'undo') editor.undo();
          if (phase === 'redo') editor.redo();
          assert.equal(editor.selectSheetLayer('camera', {contents:false}), true);
          editor.keepSelectionOnSeek();
          editor.seek(3, {allowBeyondEnd:true});
          const blob = await exporter.export(editor.report, {name: 'Parity', revision: editor.revision});
          saved.push(Buffer.from(await blob.arrayBuffer()));
          editor.markSaved();
        }
      } finally { exporter.dispose(); codecHost.close(); }
      runs.push(saved);
    }
    for (let phase = 0; phase < 4; phase++) {
      assert.deepEqual(runs[0][phase], runs[1][phase], `${id}/${phase}: old-versus-old byte baseline`);
      writeFileSync(path.join(directory, `${id}-navigation-${phase}.styk`), runs[0][phase]);
    }
  }
  console.log(`TIMELINE_SELECTION_ORACLE: ${4 * 4} old-versus-old byte comparisons passed; no differing fields`);
});
