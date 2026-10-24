#!/usr/bin/env node
// What the editor's evaluated frame stores when a gesture commits (docs/engine/editing.md,
// "The evaluated frame as records"): for each tick, `snapshotPoseFrame(editor.evaluatedFrame)`
// as JSON, byte for byte, next to the loaded report the engine receives.
//
//   node engine/tools/records-reference.mjs <file.styk|.piv|document.json> <out-folder> [--ticks a,b] [--every N] [--max N] [--full] [--native] [--entries <entries.json>]
//
// Writes <out>/report.json (the editor's report as the mirror sends it: without the
// `runtime_segments` caches) and <out>/records.json: {ticks: [{tick, sha256, bytes, json?}]}
// (`json` with --full, or always for documents under 2 MiB). The editor is configured as in
// src/app.mjs, so every document has a layer sheet. `styk records <out>` compares.
import './v8-pin.mjs';
import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {decodePiv} from './decode-piv.mjs';
const here = path.dirname(fileURLToPath(import.meta.url)), repo = path.resolve(here, '../..');
const repoUrl = pathToFileURL(repo).href;
const {openDocument} = await import(`${repoUrl}/tests/support/native-files.mjs`);
const {Editor} = await import(`${repoUrl}/src/editor.mjs`);
const {snapshotPoseFrame} = await import(`${repoUrl}/src/pose-snapshot.mjs`);
const {timeline, evaluatedFrame, evaluatedNativeFrame, buildGeometry} = await import(`${repoUrl}/src/pivot/geometry.mjs`);
const {composePoseChannels} = await import(`${repoUrl}/src/animation-pose.mjs`);
const {composeAnimationChannels, animationChannelId, normalizeAnimationTarget, validateAnimationValue} = await import(`${repoUrl}/src/animation-channels.mjs`);
const [input, out, ...rest] = process.argv.slice(2);
if (!input || !out) { console.error('usage: node engine/tools/records-reference.mjs <file> <out-folder> [--ticks a,b] [--every N] [--max N] [--full]'); process.exit(2); }
const option = name => { const i = rest.indexOf(name); return i < 0 ? undefined : rest[i + 1]; };
let document;
if (/\.(styk|stkz|stykmov)$/i.test(input)) {
  const kind = /\.(styk|stkz|stykmov)$/i.exec(input)[1].toLowerCase();
  document = await openDocument(new Uint8Array(readFileSync(input)), kind, {verifySource: false});
} else if (/\.(piv|stk)$/i.test(input)) {
  // Through the repository's Python codec (engine/tools/decode-piv.mjs).
  const {tmpdir} = await import('node:os'), {rmSync} = await import('node:fs');
  const decoded = path.join(tmpdir(), `styk-records-${process.pid}.json`);
  decodePiv(input, decoded, {stdio: ['ignore', 'ignore', 'inherit']});
  document = JSON.parse(readFileSync(decoded, 'utf8')); rmSync(decoded, {force: true});
} else document = JSON.parse(readFileSync(input, 'utf8'));
const native = rest.includes('--native');
const editor = new Editor({demo: false, propertyChannels: true, layerTimeline: !native}).load(document, path.basename(input));
const entries = option('--entries') ? JSON.parse(readFileSync(option('--entries'), 'utf8')) : null;
/** `_sheetPropertyEntries`' frame at `tick`: `at(report, tick)` with the entries' one-key channels composed. */
function propertyFrame(tick) {
  const channels = [];
  for (const e of entries) {
    if (e.property === 'pose' && e.value === undefined) continue;
    const target = e.exactTarget ? normalizeAnimationTarget(e.target) : editor.resolveAnimationTarget(e.target, e.property, tick);
    channels.push({id: animationChannelId(target, e.property), target, property: e.property,
      keys: [{id: `preview-${channels.length}`, tick, value: e.property === 'pose' ? e.value : validateAnimationValue(target, e.property, e.value), interpolation: 'constant'}]});
  }
  const report = editor.report, rows = timeline(report);
  let low = 0, high = rows.length - 1;
  while (low < high) { const mid = (low + high + 1) >>> 1; if (rows[mid].start <= tick) low = mid; else high = mid - 1; }
  const row = rows[low];
  let frame = evaluatedFrame(report, low, row?.count ? (tick - row.start) / row.count : 0, tick, {skipMovieclips: true});
  const source = {...report, _styk: {...report._styk, animation: {channels}}};
  frame = composePoseChannels(source, frame, tick, {sampleNative: evaluatedNativeFrame, resolveGeometry: buildGeometry});
  return {channels, frame: composeAnimationChannels(source, frame, tick, {resolveGeometry: buildGeometry})};
}
const strip = (key, value) => key === 'runtime_segments' ? undefined : value;
const report = JSON.stringify(editor.report, strip);
let ticks;
if (option('--ticks')) ticks = option('--ticks').split(',').map(Number);
else { const every = Number(option('--every') ?? 1); ticks = []; for (let t = 0; t < editor.totalTicks; t += every) ticks.push(t); }
ticks = ticks.filter(t => t >= 0 && t < editor.totalTicks).slice(0, Number(option('--max') ?? Infinity));
const full = rest.includes('--full') || report.length < 2 * 1024 * 1024;
const records = ticks.map(tick => {
  editor.seek(tick);
  const composed = entries ? propertyFrame(tick) : null;
  const json = JSON.stringify(snapshotPoseFrame(composed ? composed.frame : editor.evaluatedFrame), strip);
  return {tick, ...(composed ? {channels: JSON.parse(JSON.stringify(composed.channels))} : {}), sha256: createHash('sha256').update(json).digest('hex'), bytes: Buffer.byteLength(json), ...(full ? {json} : {})};
});
mkdirSync(out, {recursive: true});
writeFileSync(path.join(out, 'report.json'), report + '\n');
writeFileSync(path.join(out, 'records.json'), JSON.stringify({file: path.basename(input), ticks: records}) + '\n');
console.log(`${path.basename(input)}: report ${(report.length / 1024).toFixed(1)} KiB, ${records.length} ticks`);
