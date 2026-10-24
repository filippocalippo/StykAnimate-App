// Reuse the existing actual Editor-built CEL producer and retain its unfiltered
// drawing through ordinary selection/delete commands. No image bytes are rebuilt.
import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {here, open} from './fixture-kit.mjs';

const at = process.argv.indexOf('--out');
const out = path.resolve(at < 0 ? path.join(here, '../crates/styk-raster/tests/fixtures/drawing-root-sampling') : process.argv[at + 1]);
mkdirSync(out, {recursive: true});
const temporary = mkdtempSync(path.join(tmpdir(), 'styk-cel-root-'));
try {
  execFileSync(process.execPath, [path.join(here, 'vfx-parity-docs.mjs'), '--out', temporary], {stdio: 'ignore'});
  const document = JSON.parse(readFileSync(path.join(temporary, 'drawing-cels.json'), 'utf8'));
  let next = 0;
  Object.defineProperty(globalThis.crypto, 'randomUUID', {configurable: true, value: () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`});
  const editor = open(document, {layerTimeline: true, propertyChannels: true});
  editor.seek(0);
  editor.selectMany(editor.evaluatedFrame.objects.filter(object => object.unique_id !== 5).map(object => object.unique_id));
  editor.deleteSelection();
  if (editor.evaluatedFrame.objects.length !== 1 || editor.evaluatedFrame.objects[0].unique_id !== 5) throw new Error('The editor did not retain the plain CEL.');
  writeFileSync(path.join(out, 'raw-cel-only.json'), JSON.stringify(editor.serialize(), null, 2) + '\n');
} finally {
  rmSync(temporary, {recursive: true, force: true});
}
