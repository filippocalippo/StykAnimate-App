#!/usr/bin/env node
// Dumps what the current JavaScript editor evaluates for a document, so the
// Rust engine can be checked against it primitive by primitive.
//
//   node tools/reference.mjs <file.styk|decoded.json> <out.json> [--ticks 0,5,9] [--every N] [--max N]
//
// Pivot .piv files go through the repository's Python codec first
// (tools/decode-piv.sh), exactly like the desktop app's import service.
import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const {openDocument} = await import(`${repo}/tests/support/native-files.mjs`);
const {Editor} = await import(`${repo}/src/editor.mjs`);

const [input, output, ...rest] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: node tools/reference.mjs <file.styk|decoded.json> <out.json> [--ticks a,b] [--every N] [--max N]');
  process.exit(2);
}
const option = name => { const i = rest.indexOf(name); return i < 0 ? undefined : rest[i + 1]; };

let document;
if (/\.(styk|stkz|stykmov)$/i.test(input)) {
  const kind = /\.(styk|stkz|stykmov)$/i.exec(input)[1].toLowerCase();
  document = await openDocument(new Uint8Array(readFileSync(input)), kind, {verifySource: false});
} else {
  document = JSON.parse(readFileSync(input, 'utf8'));
}

// Same editor configuration as src/app.mjs.
const started = performance.now();
const editor = new Editor({demo: false, propertyChannels: true, layerTimeline: true});
editor.load(document, path.basename(input));
const loadMs = performance.now() - started;
const total = editor.totalTicks;

let ticks;
if (option('--ticks')) ticks = option('--ticks').split(',').map(Number);
else {
  const every = Number(option('--every') ?? 1);
  ticks = [];
  for (let t = 0; t < total; t += every) ticks.push(t);
}
const max = Number(option('--max') ?? Infinity);
ticks = ticks.filter(t => t >= 0 && t < total).slice(0, max);

const round = v => typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v;
const pt = p => p ? [round(p.x), round(p.y)] : null;
const frames = [];
let evalMs = 0;
for (const tick of ticks) {
  const t0 = performance.now();
  editor.seek(tick);
  const frame = editor.evaluatedFrame;
  const geometry = editor.geometry;
  const drawables = geometry.drawables;
  evalMs += performance.now() - t0;
  const items = drawables.map(d => {
    const item = {
      slot: d.slot, uid: d.obj?.unique_id, type: d.type,
      kind: d.seg?.segment_kind ?? (d.type === 'poly' ? 'poly' : undefined),
      seg: d.seg?.segment_id, poly: d.type === 'poly' ? d.index : undefined,
      z: round(d.z), rgb: d.rgb, alpha: round(d.alpha), opacity: round(d.opacity),
    };
    if (d.type === 'poly') item.points = d.points.map(pt);
    else {
      item.start = pt(d.start); item.end = pt(d.end);
      item.thickness = round(d.thickness); item.length = round(d.length);
      item.angle = round(d.angle); item.bend = round(d.bend);
      if (Math.abs(d.bend ?? 0) > 1e-7) item.points = d.points.map(pt);
    }
    if (d._movieclipOwner || d._movieclipPart !== undefined) item.movieclip = true;
    return item;
  });
  const objects = [];
  for (const [slot, g] of geometry.objects) {
    if (!g) continue;
    objects.push({slot, uid: g.obj.unique_id, figure: g.fig?.figure_type_id, root: pt(g.root),
      joints: [...g.joints].map(([id, p]) => [id, ...pt(p)])});
  }
  frames.push({
    tick,
    camera: frame.camera ?? null,
    background: {id: frame.background_id ?? 0, b: frame.background_id_b ?? 0, mix: frame.background_mix ?? 0},
    objects, drawables: items,
  });
}

writeFileSync(output, JSON.stringify({
  file: path.basename(input), version: editor.report.version,
  canvas: [editor.report.canvas_width, editor.report.canvas_height], fps: editor.report.fps,
  totalTicks: total, loadMs: round(loadMs), evalMsPerFrame: round(evalMs / Math.max(1, ticks.length)),
  frames,
}));
console.error(`${path.basename(input)}: ${ticks.length} frames of ${total}, load ${loadMs.toFixed(0)} ms, ` +
  `${(evalMs / Math.max(1, ticks.length)).toFixed(2)} ms per evaluated frame`);
