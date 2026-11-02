#!/usr/bin/env node
// A seeded gesture fuzz of movieclips and saving, in Node: the real editor under the engine owner, saves through the real export worker, and
// every file opened again through the app's own open. The same seed gives the same gestures.
//
//   node scripts/fuzz-movieclips.mjs <seed> [steps=60] [--big] [--blank] [--drawn] [--piv[=file]] [--every=1] [--verify] [--quiet] [--log]
//
// `--big` gives the project a figure of 60 segments (pose arrays of 32 numbers or more), `--blank` starts from the blank document, `--drawn`
// from a document with a drawing layer whose cels hold pixels, `--piv` from a Pivot file opened as the app opens one (a small repository fixture,
// or the file given). Besides movieclips the gestures add audio, sprites (images), layers, effects, authored keys, camera motion and drawing
// layers, export a clip as a `.stykmov` file and import it again.
//
// After every gesture the project is written one of the ways the app writes it (Save, which leaves the movieclips being edited, or the recovery
// copy, which folds them in) and opened again. Failures: a file that does not open, one that differs from the project saved, a second round of
// saving and opening that changes it, a save that had to repair or warn for a project gestures made, a join that names no figure, a
// save that was refused. Exit 1 with the gestures leading up to it on the first.
import '../tests/support/register-engine.mjs';
import {readFileSync, writeFileSync} from 'node:fs';
import {Editor} from '../src/editor.mjs';
import {installEngineOwner, ownerOf} from '../src/engine/engine-owner.mjs';
import {attachRead, openBytes} from '../src/engine/engine-open.mjs';
import {DocumentExporter} from '../src/document-export.mjs';
import {FakeCodecHost} from '../tests/support/codec-host.mjs';
import {WorkerFacade} from '../tests/support/export-worker.mjs';
import {createDemo, createObject} from '../src/demo.mjs';
import {createImageFigure} from '../src/media-authoring.mjs';
import {isMovieclip} from '../src/movieclips.mjs';
import {movieclipScopes} from '../src/editor-sessions.mjs';

const args = process.argv.slice(2), flag = name => args.includes(name), value = name => args.find(a => a === name || a.startsWith(name + '='))?.split('=')[1];
const numbers = args.filter(a => /^\d+$/.test(a)).map(Number);
const seed = numbers[0] ?? 1, steps = numbers[1] ?? 60, every = Number(value('--every') ?? 1);
const big = flag('--big'), blank = flag('--blank'), drawn = flag('--drawn'), piv = args.some(a => a === '--piv' || a.startsWith('--piv=')), verify = flag('--verify'), quiet = flag('--quiet');
let s = seed >>> 0;
const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const pick = list => list[Math.floor(rnd() * list.length)], int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
Object.defineProperty(globalThis, 'Worker', {value: WorkerFacade, configurable: true});
const codecHost = new FakeCodecHost(), exporter = new DocumentExporter({codecHost, idleMs: 0});
const options = {demo: false, propertyChannels: true, layerTimeline: true};
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHk8AAAAASUVORK5CYII=';
const sound = () => ({id: `sound-${int(1, 9999)}`, name: 'Voice.wav', size: 3, duration: 2, chunks: [{data_base64: 'AQID'}], peaks: [0, .5, 1, .5]});

function bigFigure(id, count) {
  const segments = Array.from({length: count}, (_, i) => ({segment_id: i + 1, parent_id: i < 1 ? 0 : (i % 7 === 0 ? 1 : i), length: 20 + (i % 5), angle_rad: -1.2 + (i % 9) * 0.31,
    thickness: 4, bend_rad: 0, primitive_code: 0, aux_code: 0, flags: 0, segment_type: 'line', segment_kind: 'line', color_rgb: [20, 20, 20], transparency: 0, visible: true, z_order: i + 1}));
  return {figure_type_id: id, name: `Big ${count}`, segment_count: count, segments, polyfills: [], image_assets: [], text_assets: []};
}
function startDocument() {
  const doc = createDemo();
  if (big) {
    const figure = bigFigure(4, 60); doc.figure_types.push(figure);
    for (const [i, frame] of doc.keyframes.entries()) {
      const o = createObject(figure, 4, 300 + i, 250, {}); o.angles = o.angles.map((a, j) => a + Math.sin(i * 0.4 + j) * 0.2);
      frame.objects.push(o); o.object_slot = frame.objects.length - 1; frame.object_draw_order.push(o.object_slot); frame.object_draw_order_unique_ids.push(4);
    }
  }
  return doc;
}
async function startEditor() {
  const editor = new Editor(options);
  if (blank) editor.newDocument();
  else if (drawn) editor.load((await (await import('../tests/support/painted-document.mjs')).paintedDocument()).document);
  else if (piv) {
    const file = value('--piv') ?? new URL('../engine/crates/styk-piv/tests/fixtures/legacy-v3.piv', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    const opening = await openBytes(new Uint8Array(readFileSync(decodeURIComponent(file))), 'x.piv', {layerTimeline: true}), read = await opening.read();
    attachRead(read.report, read); editor.load(read.report);
  } else editor.load(startDocument());
  return editor;
}
const editor = await startEditor();
const owner = installEngineOwner(editor, {verify});
if (!owner.ready()) throw new Error('no session');

const log = [], failures = [];
const note = (name, detail = '') => { log.push(`${name}${detail ? ' ' + detail : ''}`); };
const objects = () => editor.evaluatedFrame?.objects ?? [];
const clips = () => (editor.report.figure_types ?? []).filter(isMovieclip);
const depth = () => editor._movieclipScopes?.length ?? 0;
let exportedClip = null;
const gestures = {
  seek() { const t = int(0, Math.max(0, Math.floor(editor.totalTicks) - 1)); editor.seek(t); return t; },
  selectOne() { const o = objects(); if (!o.length) return 'none'; const u = pick(o).unique_id; editor.select(u, -1); return u; },
  selectSome() { const ids = objects().filter(() => rnd() < 0.5).map(x => x.unique_id); if (!ids.length) return 'none'; editor.selectMany?.(ids); return ids.join(','); },
  createRange() { gestures.selectOne(); const start = editor.tick, end = start + int(1, 8); editor.createMovieclip({start, end: Math.min(end, Math.max(editor.totalTicks, start + 1))}); return `${start}-${end}`; },
  createStatic() { gestures.selectOne(); editor.createMovieclip({}); },
  createEmpty() { editor.createEmptyMovieclip(`Empty ${int(1, 99)}`); },
  enter() { const c = clips(); if (!c.length) return 'none'; const id = pick(c).figure_type_id; editor.enterMovieclip(id); return id; },
  enterSelected() { editor.enterMovieclip(); },
  leave() { editor.leaveMovieclip(); },
  addClipInstance() { const c = clips(); if (!c.length) return 'none'; const id = pick(c).figure_type_id; editor.addFigure(id); return id; },
  addFigure() { const t = editor.report.figure_types.filter(f => !isMovieclip(f)); if (!t.length) return editor.addFigure(); const id = pick(t).figure_type_id; editor.addFigure(id); return id; },
  move() { gestures.selectOne(); editor.moveSelection(int(-30, 30), int(-30, 30)); },
  duplicate() { gestures.selectOne(); editor.duplicateSelection(); },
  del() { gestures.selectOne(); editor.deleteSelection(); },
  rename() { gestures.selectOne(); editor.renameMovieclip(`Clip ${int(1, 999)}`); },
  unique() { gestures.selectOne(); editor.makeMovieclipUnique(); },
  breakApart() { gestures.selectOne(); editor.breakApartMovieclip(); },
  split() { gestures.selectOne(); editor.splitMovieclip(); },
  playback() { gestures.selectOne(); editor.setMovieclipPlayback({speed: pick([0.5, 1, 2]), mode: pick(['loop', 'once', 'hold'])}); },
  pose() { const o = objects(); if (!o.length) return 'none'; editor.select(pick(o).unique_id, -1); editor.rotateJoint?.(1, rnd() * 0.5); },
  addFrame() { editor.sheetAppendFrame?.(); },
  duplicateFrame() { editor.sheetDuplicateFrameAfter?.(); },
  insertKey() { editor.sheetInsertKey?.(); },
  join() { const o = objects(); if (o.length < 2) return 'none'; const a = pick(o), b = pick(o.filter(x => x !== a)); editor.select(a.unique_id, -1); editor.joinFigure(b.unique_id, int(0, 2)); return `${a.unique_id}->${b.unique_id}`; },
  unjoin() { gestures.selectOne(); editor.unjoinFigure(); },
  createLayer() { editor.createLayer(`Layer ${int(1, 99)}`); },
  moveLayer() { gestures.selectOne(); const order = editor.report._styk?.layers?.order ?? []; if (order.length) editor.moveSelectionLayer(pick(order)); },
  vfx() { const o = objects(); if (!o.length) return 'none'; editor.addVfx({kind: 'figure', uid: pick(o).unique_id}, 'glow'); },
  vfxClip() { const o = objects(); if (!o.length) return 'none'; editor.addVfxClip({kind: 'figure', uid: pick(o).unique_id}, 'glow'); },
  key() { const o = objects(); if (!o.length) return 'none'; editor.addAnimationKey({kind: 'figure', uid: pick(o).unique_id}, 'pose', editor.tick); },
  camera() { editor.addCameraMotion('shake', {start: int(0, 10), duration: int(6, 24)}); },
  drawingLayer() { editor.createDrawingLayer(); },
  audio() { editor.importAudio(sound(), {start: int(0, 6)}); },
  sprite() { gestures.selectOne(); const figure = createImageFigure({dataUrl: png, width: 1, height: 1, name: 'Sprite'}); Object.assign(figure.image_assets[0], {anchor_start: {x: -7, y: 5}, anchor_end: {x: 23, y: -35}}); editor.addSpriteSegment(figure); },
  async exportClip() {
    const placed = objects().filter(o => isMovieclip(editor.report.figure_types.find(f => f.figure_type_id === o.figure_type_id)));
    if (!placed.length) return 'no clip placed';
    editor.select(pick(placed).unique_id, -1); const figure = editor.figure; if (!isMovieclip(figure)) return 'not a clip';
    ownerOf(editor).activate(); // the engine holds the document an export reads: the stage does this in the app
    const blob = await exporter.export(editor.report, {format: 'stykmov', name: 'clip', figureTypeId: figure.figure_type_id, figureUid: editor.selectedUid, tick: editor.tick, revision: editor.revision});
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const opening = await openBytes(bytes, 'clip.stykmov', {layerTimeline: false}), read = await opening.read(); exportedClip = read.report; attachRead(read.report, read);
    return `${bytes.length} bytes`;
  },
  importClip() { if (!exportedClip) return 'none'; editor.importFigure(structuredClone(exportedClip)); },
  undo() { return editor.undo(); },
  redo() { return editor.redo(); },
  deleteClipDefinitionInstances() { const c = clips(); if (!c.length) return 'none'; const id = pick(c).figure_type_id; for (const o of objects()) if (o.figure_type_id === id) { editor.select(o.unique_id, -1); editor.deleteSelection(); } },
};
const weights = {seek: 2, selectOne: 2, selectSome: 1, createRange: 4, createStatic: 2, createEmpty: 1, enter: 4, enterSelected: 1, leave: 3, addClipInstance: 3, addFigure: 2, move: 2, duplicate: 2, del: 2,
  join: 3, unjoin: 1, createLayer: 1, moveLayer: 1, vfx: 1, vfxClip: 1, key: 1, camera: 1, drawingLayer: 1, audio: 1, sprite: 1, exportClip: 1, importClip: 1, rename: 1, unique: 1, breakApart: 1, split: 1,
  playback: 1, pose: 1, addFrame: 1, duplicateFrame: 1, insertKey: 1, undo: 3, redo: 2, deleteClipDefinitionInstances: 1};
const table = Object.entries(weights).flatMap(([k, w]) => Array(w).fill(k));

const canon = (v, path = '', out = []) => {
  if (Array.isArray(v)) v.forEach((x, i) => canon(x, `${path}[${i}]`, out));
  else if (v && typeof v === 'object') for (const k of Object.keys(v)) {
    if (k === 'frameId' || ['duration_frames', 'total_output_frames', 'duration_seconds'].includes(k) || (path === '._styk' && ['name', 'format', 'format_version'].includes(k)) || (k.startsWith('_') && !['_styk', '_stykMovieclip', '_stykStyle'].includes(k))) continue;
    canon(v[k], `${path}.${k}`, out);
  } else if (!path.endsWith('._styk.layers.version') && !path.endsWith('._styk.layers.activeId')) out.push([path, JSON.stringify(v)]);
  return out;
};
function firstDiff(a, b) {
  const x = canon(a), y = canon(b), m = new Map(y);
  for (const [p, v] of x) if (!m.has(p)) return `${p} missing after reopen`; else if (m.get(p) !== v) return `${p}: ${v.slice(0, 60)} != ${m.get(p).slice(0, 60)}`;
  const mx = new Map(x); for (const [p] of y) if (!mx.has(p) && !p.includes('._styk.layers.')) return `${p} appeared after reopen`;
  return null;
}
// Every join of every frame of every document the project holds names the figure it says, and no figure is joined to itself.
function joinProblems(doc, where = 'project', out = []) {
  const frames = [...(doc.keyframes ?? []).map((f, i) => [`kf${i}`, f]), ...Object.entries(doc._styk?.frameSources ?? {})];
  for (const [id, frame] of frames) for (const o of frame.objects ?? []) if (o.join) {
    const parent = frame.objects[o.join.target_object_slot];
    if (!parent) out.push(`${where} ${id} uid ${o.unique_id}: join has no target (${JSON.stringify(o.join)})`);
    else if (parent === o) out.push(`${where} ${id} uid ${o.unique_id}: joined to itself`);
    else if (o.join.target_unique_id !== undefined && o.join.target_unique_id !== parent.unique_id) out.push(`${where} ${id} uid ${o.unique_id}: slot says ${parent.unique_id}, uid says ${o.join.target_unique_id}`);
  }
  for (const f of doc.figure_types ?? []) if (f._styk?.movieclip) joinProblems(f._styk.movieclip.document, `${where}/clip#${f.figure_type_id}`, out);
  if (doc._styk?.movieclipSource?.document) joinProblems(doc._styk.movieclipSource.document, `${where}/source`, out);
  return out;
}
/** How deep the movieclip graph runs, as the load counts it. */
function nesting(doc, level = 0) {
  let deepest = level;
  const source = doc._styk?.movieclipSource?.document;
  if (source) deepest = Math.max(deepest, nesting(source, level + 1));
  for (const f of doc.figure_types ?? []) if (f._styk?.movieclip) deepest = Math.max(deepest, nesting(f._styk.movieclip.document, level + 1));
  return deepest;
}
async function save(kind) {
  const scopes = kind === 'recovery' ? movieclipScopes(editor) : undefined;
  let report = editor.report;
  if (kind === 'save') { while (editor._movieclipScopes?.length) editor.leaveMovieclip(); report = editor.report; }
  const expected = kind === 'save' ? JSON.parse(JSON.stringify(report)) : null;
  const blob = await exporter.export(report, {format: 'styk', name: 'fuzz', scopes, revision: editor.revision});
  return {bytes: new Uint8Array(await blob.arrayBuffer()), expected, engine: exporter.lastTimings?.engine};
}
async function reopen(bytes) {
  const opening = await openBytes(bytes, 'fuzz.styk', {layerTimeline: true});
  const read = await opening.read(); attachRead(read.report, read);
  const e = new Editor(options); installEngineOwner(e, {verify: false}); e.load(read.report);
  return {editor: e, repairs: opening.repairs};
}
let step = 0, saves = 0, refused = 0;
async function check(kind) {
  const where = `step ${step} after [${log.slice(-3).join(' | ')}] depth ${depth()} kind ${kind}`;
  const problems = joinProblems(editor.report);
  if (problems.length) { failures.push({where, phase: 'joins', error: problems.slice(0, 3).join(' ; ')}); return; }
  if (flag('--joins-only')) return;
  let bytes, expected, engine;
  try { ({bytes, expected, engine} = await save(kind)); }
  catch (error) { failures.push({where, phase: 'save', error: String(error?.message ?? error), key: error?.messageKey, nesting: nesting(editor.report)}); return; }
  saves++;
  if (engine?.repairs || engine?.warning) { failures.push({where, phase: 'save-needed-mending', error: `repairs ${engine.repairs}, warning ${engine.warning}`}); if (flag('--dump')) writeFileSync(`fail-${seed}.styk`, bytes); return; }
  try {
    const {editor: again, repairs} = await reopen(bytes);
    if (repairs) failures.push({where, phase: 'open-needed-mending', error: `${repairs} repairs`});
    if (expected) { const diff = firstDiff(expected, JSON.parse(JSON.stringify(again.report))); if (diff) failures.push({where, phase: 'differs', error: diff}); }
    const blob = await exporter.export(again.report, {format: 'styk', name: 'fuzz', revision: again.revision});
    const second = await reopen(new Uint8Array(await blob.arrayBuffer()));
    const diff = firstDiff(JSON.parse(JSON.stringify(again.report)), JSON.parse(JSON.stringify(second.editor.report))); if (diff) failures.push({where, phase: 'second-round', error: diff});
  } catch (error) { if (flag('--dump')) writeFileSync(`fail-${seed}.styk`, bytes); failures.push({where, phase: 'open', error: String(error?.message ?? error), key: error?.messageKey}); }
}
for (step = 1; step <= steps; step++) {
  const name = pick(table);
  try { const d = await gestures[name](); note(name, d === undefined ? '' : String(d)); }
  catch (error) { refused++; note(`${name}!refused`, String(error?.message ?? error).slice(0, 50)); }
  if (step % every === 0) await check(depth() ? pick(['recovery', 'recovery', 'save']) : pick(['save', 'recovery']));
  if (failures.length) break;
}
if (!failures.length) await check('save');
console.log(JSON.stringify({seed, steps: step - 1, big, blank, drawn, piv, saves, refused, clips: clips().length, failures: failures.slice(0, 3), tail: failures.length ? log.slice(-12) : undefined}, null, quiet ? 0 : 1));
if (flag('--log')) console.log(log.join('\n'));
owner.release(); exporter.dispose(); codecHost.close();
process.exit(failures.length ? 1 : 0);
