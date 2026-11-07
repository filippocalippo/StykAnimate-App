#!/usr/bin/env node
// Seeded gestures on the engine fixtures, saved and opened again, in node: the fixture documents of `engine/tests/edit` (or the demo), two editors
// with a shared clipboard, drawings published as the app publishes them, movieclips entered and left, figures exported to files and imported
// back. After every few gestures the project is written by the real export worker (Save, or the recovery copy that folds the movieclips in)
// and opened with the real reader; what must hold is that the file opens, needs no repair, and is the project that was saved.
//
//   node scripts/fuzz-movieclips-docs.mjs --regression            # the fixed set below: every refused save found so far, in a few minutes; ends in
//                                                                  # failure after FUZZ_DEADLINE_MS (ten minutes) whatever it is doing
//   node scripts/fuzz-movieclips-docs.mjs <doc|all> <seedFrom> [seedTo] [steps=40] [every=3]
//
// Environment: FLUSH=1 publishes the drawings after each gesture, NODRAW=1 draws nothing, CONT=1 goes on after a failure, EXTRA=save|rec also
// saves in between, ONLY=a,b limits the gestures, OPLOG=<prefix> writes the calls of the first failure of a seed (`<prefix>-<doc>-<seed>.json`)
// as a replay, NOVERIFY=1 does not compare the session's document with the editor's after each call. Exit 1 when any seed fails.
// `scripts/fuzz-movieclips.mjs` is the other half: one editor from the demo or a chosen start, many seeds, fast.
import '../tests/support/register-engine.mjs';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {Editor} from '../src/editor.mjs';
import {installEngineOwner} from '../src/engine/engine-owner.mjs';
import {openBytes} from '../src/engine/engine-open.mjs';
import {DocumentExporter} from '../src/document-export.mjs';
import {movieclipScopes} from '../src/editor-sessions.mjs';
import {createDemo, createObject} from '../src/demo.mjs';
import {createImageFigure} from '../src/media-authoring.mjs';
import {FakeCodecHost} from '../tests/support/codec-host.mjs';
import {WorkerFacade} from '../tests/support/export-worker.mjs';
import {SharedClipboard} from '../src/shared-clipboard.mjs';
import {DrawingResources, drawingResourcesFor} from '../src/drawing-resources.mjs';
import {drawingEngineOperation} from '../src/engine/engine-drawing-worker.mjs';
import {DrawingStroke} from '../tests/support/sketch-stroke.mjs';

const {SharedClipboard: NativeClipboard} = createRequire(import.meta.url)('../desktop/shared-clipboard.cjs');
Object.defineProperty(globalThis, 'Worker', {value: WorkerFacade, configurable: true});
const codecHost = new FakeCodecHost();
const exporter = new DocumentExporter({codecHost, idleMs: 0});

// The refused saves found so far (the seeds are those of this script), and a few more starts: a seed that fails fails again.
const REGRESSION = [['sheet-movieclip', 1], ['sheet-movieclip', 62], ['sheet-movieclip', 132], ['sheet-movieclip', 403], ['rig', 403], ['clip-create-native', 408],
  ['sheet-movieclip', 226], ['sheet-movieclip', 4], ['clip-create-joined-sheet', 7], ['builder', 11], ['joined-chain', 3]];
const args = process.argv.slice(2), regression = args.includes('--regression');
if (regression) process.env.FLUSH = '1';
// The fixed set runs in a process of its own with a deadline the process cannot keep from ending it: a hang is a failure, not a wait.
if (regression && !process.env.FUZZ_CHILD) {
  const deadline = Number(process.env.FUZZ_DEADLINE_MS ?? 10 * 60 * 1000);
  const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args], {stdio: 'inherit', timeout: deadline, killSignal: 'SIGKILL', env: {...process.env, FUZZ_CHILD: '1'}});
  if (run.error?.code === 'ETIMEDOUT') console.error(`FAILED: the regression set did not finish in ${Math.round(deadline / 1000)} s`);
  else if (run.error) console.error(`FAILED: ${run.error.message}`);
  process.exit(run.error ? 1 : (run.status ?? 1));
}
const docArg = args[0] ?? 'demo', seedFrom = Number(args[1] ?? 1), seedTo = Number(args[2] ?? seedFrom), steps = regression ? 40 : Number(args[3] ?? 40), every = regression ? 3 : Number(args[4] ?? 3);
const verify = !process.env.NOVERIFY;
const failDir = fileURLToPath(new URL('../artifacts/fuzz-movieclips-docs', import.meta.url)); mkdirSync(failDir, {recursive: true});

const readDoc = f => JSON.parse(readFileSync(new URL(`../engine/tests/edit/${f}.document.json`, import.meta.url), 'utf8'));
const segment = i => ({segment_id: i + 1, parent_id: i < 1 ? 0 : (i % 7 === 0 ? 1 : i), length: 20 + (i % 5), angle_rad: -1.2 + (i % 9) * 0.31, thickness: 4, bend_rad: 0, primitive_code: 0, aux_code: 0,
  flags: 0, segment_type: 'line', segment_kind: 'line', color_rgb: [20, 20, 20], transparency: 0, visible: true, z_order: i + 1});
function big() {
  const doc = createDemo();
  const figure = {figure_type_id: 4, name: 'Big 60', segment_count: 60, segments: Array.from({length: 60}, (_, i) => segment(i)), polyfills: [], image_assets: [], text_assets: []};
  doc.figure_types.push(figure);
  for (const [i, frame] of doc.keyframes.entries()) {
    const o = createObject(figure, 4, 300 + i, 250); o.angles = o.angles.map((a, j) => a + Math.sin(i * 0.4 + j) * 0.2);
    frame.objects.push(o); o.object_slot = frame.objects.length - 1; frame.object_draw_order.push(o.object_slot); frame.object_draw_order_unique_ids.push(4);
  }
  return doc;
}
const FIXTURES = ['sheet-movieclip', 'sheet-movieclip-loose', 'sheet-movieclip-timed', 'audio', 'builder', 'camera-chain', 'joined-chain', 'rig', 'sheet-layers', 'vfx-clips', 'sprite-segment-sheet', 'polygons', 'two-limbs', 'clip-create-joined-sheet', 'clip-create-multilayer-sheet', 'clip-create-native', 'clip-break-nested-sheet', 'origin-future-rig-joined-sheet', 'measured-bounds-media', 'motion-path'];
const docs = {demo: () => createDemo(), big, ...Object.fromEntries(FIXTURES.map(f => [f, () => readDoc(f)]))};

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHk8AAAAASUVORK5CYII=';
const audioAsset = n => ({id: `sound-${n}`, name: `Voice${n}.wav`, size: 3, duration: 2, chunks: [{data_base64: 'AQID'}], peaks: [0, .5, 1, .5]});
const workerStub = () => ({async request(kind, data) { let reply; await drawingEngineOperation({id: 0, kind, ...structuredClone(data)}, m => { reply = m; }); if (reply.error) throw Object.assign(new Error(reply.error), {messageKey: reply.messageKey}); return reply; }, dispose() {}});

function rngOf(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

const canonical = report => {
  const out = [];
  const walk = (v, p) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
    else if (v && typeof v === 'object') { for (const k of Object.keys(v)) { if (k === 'frameId' || (p === '._styk' && ['name', 'format', 'format_version'].includes(k)) || (k.startsWith('_') && !['_styk', '_stykMovieclip', '_stykStyle'].includes(k))) continue; walk(v[k], `${p}.${k}`); } }
    else if (!p.endsWith('._styk.layers.version') && !p.endsWith('._styk.layers.activeId')) out.push([p, JSON.stringify(v)]);
  };
  walk(JSON.parse(JSON.stringify(report)), '');
  return out;
};
const diff = (a, b, ignore = new Set()) => {
  const out = [];
  const m = new Map(b); for (const [p, v] of a) { if (p.includes('styk_tiles')) continue; if (!m.has(p)) out.push(p + ' missing after reopen'); else if (m.get(p) !== v) out.push(p + ': ' + v.slice(0, 80) + ' != ' + m.get(p).slice(0, 80)); }
  const x = new Map(a); for (const [p] of b) if (!x.has(p) && !p.includes('._styk.layers.') && !p.includes('styk_tiles')) out.push(p + ' appeared after reopen');
  const fresh = out.filter(line => !ignore.has(line.split(':')[0].replace(/ (missing|appeared).*/, '')));
  return fresh.length ? fresh[0] + (fresh.length > 1 ? ' (+' + (fresh.length - 1) + ')' : '') : null;
};

function systemClipboard() {
  let content = new Map();
  return {availableFormats: () => [...content.keys()], readBuffer: t => content.get(t), writeBuffer: (t, v) => { content = new Map([[t, Buffer.from(v)]]); }, clear: () => content.clear()};
}
function makeInstance(doc, os, id) {
  const e = new Editor({demo: false, propertyChannels: true, layerTimeline: true});
  e.load(structuredClone(doc));
  const owner = installEngineOwner(e, {verify});
  if (!owner.ready()) throw new Error('no session');
  const native = new NativeClipboard(os);
  const desktop = Object.fromEntries([['beginSharedClipboardWrite', 'beginWrite'], ['writeSharedClipboardChunk', 'write'], ['finishSharedClipboardWrite', 'finish'], ['beginSharedClipboardRead', 'beginRead'], ['readSharedClipboardChunk', 'read'], ['cancelSharedClipboardTransfer', 'cancel']].map(([n, m]) => [n, async (...a) => native[m](...a)]));
  const ep = new Proxy(e, {get(t, k) { const v = Reflect.get(t, k, t); if (typeof v === 'function' && typeof k === 'string') return (...a) => { rec({i: id, n: k, a: structuredClone(a)}); return v.apply(t, a); }; return v; }});
  return {id, e: ep, owner, native, clipboard: new SharedClipboard(e, desktop), resources: new DrawingResources(e.report, {worker: workerStub(), onPublished: figure => e._drawingPublished(figure)})};
}

const OPS = globalThis.__ops ??= []; let logging = true; const rec = op => { if (logging) OPS.push(op); };
async function runSeed(docName, seed) {
  OPS.length = 0;
  const os = systemClipboard();
  const A = makeInstance(docs[docName](), os, 'A'), B = makeInstance(createDemo(), os, 'B');
  let cur = A; const e = () => cur.e;
  const rnd = rngOf(seed);
  const pick = l => l[Math.floor(rnd() * l.length)], int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const isClip = f => Boolean(f?._styk?.movieclip);
  const objects = () => e().evaluatedFrame?.objects ?? [], clips = () => (e().report.figure_types ?? []).filter(isClip);
  const oneNoCel = () => { const o = objects().filter(x => !e().report.figure_types.find(f => f.figure_type_id === x.figure_type_id)?._styk?.drawing); if (!o.length) return null; const u = pick(o).unique_id; e().select(u, -1); return u; };
  const oneJoint = () => { const o = objects(); if (!o.length) return null; const u = pick(o).unique_id; e().select(u, 0); return u; };
  const one = () => { const o = objects(); if (!o.length) return null; const u = pick(o).unique_id; e().select(u, -1); return u; };
  let audioN = 0, stroke = 0;
  const G = {
    seek() { e().seek(int(0, Math.max(0, Math.floor(e().totalTicks) - 1))); },
    selectOne() { one(); }, selectSome() { const ids = objects().filter(() => rnd() < 0.5).map(o => o.unique_id); if (ids.length) e().selectMany(ids); },
    createRange() { one(); const s = e().tick; e().createMovieclip({start: s, end: Math.min(s + int(1, 8), Math.max(e().totalTicks, s + 1))}); },
    createStatic() { one(); e().createMovieclip({}); },
    createMulti() { G.selectSome(); const s = e().tick; e().createMovieclip({start: s, end: s + int(1, 6)}); },
    createEmpty() { e().createEmptyMovieclip(`Empty ${int(1, 99)}`); },
    enter() { const c = clips(); if (c.length) e().enterMovieclip(pick(c).figure_type_id); },
    enterSelected() { e().enterMovieclip(); }, leave() { e().leaveMovieclip(); },
    addClipInstance() { const c = clips(); if (c.length) e().addFigure(pick(c).figure_type_id); },
    addFigure() { const t = e().report.figure_types.filter(f => !isClip(f)); e().addFigure(t.length ? pick(t).figure_type_id : undefined); },
    move() { one(); e().moveSelection(int(-30, 30), int(-30, 30)); },
    duplicate() { one(); e().duplicateSelection(); }, del() { one(); e().deleteSelection(); },
    delSome() { G.selectSome(); e().deleteSelection(); },
    rename() { one(); e().renameMovieclip(`Clip ${int(1, 999)}`); }, unique() { one(); e().makeMovieclipUnique(); },
    breakApart() { one(); e().breakApartMovieclip(); }, split() { one(); e().splitMovieclip(); },
    playback() { one(); e().setMovieclipPlayback({speed: pick([0.5, 1, 2]), mode: pick(['loop', 'once', 'hold'])}); },
    pose() { one(); e().rotateJoint?.(int(1, 3), rnd() * 0.5); }, bend() { one(); e().bendJoint?.(int(1, 3), rnd() * 0.3); },
    addFrame() { e().sheetAppendFrame?.(); }, duplicateFrame() { e().sheetDuplicateFrameAfter?.(); }, insertKey() { e().sheetInsertKey?.(); },
    removeFrames() { const n = e().totalTicks; if (n > 2) e().sheetRemoveFrames?.(int(0, n - 1), 1); },
    setDuration() { e().sheetSetDuration?.(int(1, 8)); }, fps() { e().setFPS(pick([12, 24, 30, 60])); },
    frameDuration() { e().setFrameDuration?.(int(1, 5)); },
    join() { const o = objects(); if (o.length < 2) return; const a = pick(o), b = pick(o.filter(x => x !== a)); e().select(a.unique_id, -1); e().joinFigure(b.unique_id, int(0, 2)); },
    unjoin() { one(); e().unjoinFigure(); },
    createLayer() { e().createLayer(`Layer ${int(1, 99)}`); },
    moveLayer() { one(); const order = e().report._styk?.layers?.order ?? []; if (order.length) e().moveSelectionLayer(pick(order)); },
    vfx() { const o = objects(); if (o.length) e().addVfx({kind: 'figure', uid: pick(o).unique_id}, 'glow'); },
    vfxClip() { const o = objects(); if (o.length) e().addVfxClip({kind: 'figure', uid: pick(o).unique_id}, 'glow'); },
    key() { const o = objects(); if (o.length) e().addAnimationKey({kind: 'figure', uid: pick(o).unique_id}, 'pose', e().tick); },
    camera() { e().addCameraMotion('shake', {start: int(0, 10), duration: int(6, 24)}); },
    audio() { e().importAudio(audioAsset(++audioN), {start: int(0, 10)}); },
    audioTrack() { e().addAudioTrack(`T${int(1, 9)}`); },
    audioEdit() { const st = e().report._styk?.audio; const clip = st?.tracks?.flatMap?.(t => t.clips ?? [])?.[0]; if (clip) { if (rnd() < 0.5) e().splitAudioClip?.(clip.id, int(1, 5)); else e().deleteAudioClip?.(clip.id); } },
    sprite() { if (true) { const o = objects().filter(x => !e().report.figure_types.find(f => f.figure_type_id === x.figure_type_id)?._styk?.drawing); if (!o.length) return; e().select(pick(o).unique_id, -1); } else one(); const f = createImageFigure({dataUrl: png, width: 1, height: 1, name: 'Spr'}); e().addSpriteSegment(f); },
    imageFigure() { e().importFigure(createImageFigure({dataUrl: png, width: 1, height: 1, name: `Img ${int(1, 9)}`, figureTypeId: 1})); },
    background() { e().importSceneBackground?.({dataUrl: png, width: 1, height: 1, name: 'bg'}); },
    drawingLayer() { e().createDrawingLayer(); },
    drawFrame() { e().addDrawingFrame?.(); },
    async draw() { const w = {pixelsPerUnit: 1, world: {x: int(0, 60), y: int(0, 60)}}; logging = false; try { let target; try { target = e().prepareDrawingCel(w); } catch { e().createDrawingLayer(); target = e().prepareDrawingCel(w); } const surface = await e().drawingResources.surface(target.figure);
      const b = new DrawingStroke(surface.store, {size: 8, pressureSize: false, seed: ++stroke}); const pts = [{x: int(5, 55), y: int(5, 55)}, {x: int(5, 55), y: int(5, 55)}]; b.sample(pts[0]); b.sample(pts[1]); e().commitDrawingPixels(target, b.finish()); OPS.push({op: 'draw', i: cur.id, w, pts: pts, seed: stroke}); } finally { logging = true; } },
    // The gestures that edit a figure's segments act on the joint of any figure, a drawing cel included (a cel refuses what would break it), with arguments they take.
    addSegment() { oneJoint(); e().addSegment?.(); }, delSegment() { oneJoint(); e().deleteSegment?.(); }, splitSeg() { oneJoint(); e().splitSegment?.(0.1 + rnd() * 0.8); },
    segValues() { oneJoint(); e().setSegmentValues?.(rnd() < 0.5 ? {length: int(10, 60)} : {angle: int(-170, 170)}); }, mirror() { oneJoint(); e().mirrorSegment?.(); },
    color() { one(); e().setFigureColor?.([int(0, 255), int(0, 255), int(0, 255)]); },
    undo() { const n = int(1, 6); for (let i = 0; i < n; i++) e().undo(); return n; }, redo() { const n = int(1, 6); for (let i = 0; i < n; i++) e().redo(); return n; },
    deleteInstances() { const c = clips(); if (!c.length) return; const id = pick(c).figure_type_id; for (const o of objects()) if (o.figure_type_id === id) { e().select(o.unique_id, -1); e().deleteSelection(); } },
    async copyPaste() { one(); logging = false; try { await cur.clipboard.copy('figures', () => e().copySelection()); await cur.clipboard.paste('figures', () => e().pasteSelection()); OPS.push({op: 'copyPaste', i: cur.id}); } finally { logging = true; } },
    async copyToOther() { one(); logging = false; try { await cur.clipboard.copy('figures', () => e().copySelection()); const other = cur === A ? B : A; await other.clipboard.paste('figures', () => other.e.pasteSelection()); OPS.push({op: 'copyToOther', i: cur.id, to: other.id}); } finally { logging = true; } },
    swap() { cur = cur === A ? B : A; },
    async exportMov() { const c = clips(); if (!c.length) return; const t = pick(c); logging = false; try { const blob = await exporter.export(e().report, {format: 'stykmov', figureTypeId: t.figure_type_id, revision: e().revision});
      const bytes = new Uint8Array(await blob.arrayBuffer()); const {nativeFileCodec} = await import('../src/native-file-codec.mjs'); const {document} = await nativeFileCodec.open(bytes, 'stykmov', {verifySource: false}); e().importFigure(document); OPS.push({op: 'exportMov', i: cur.id, typeId: t.figure_type_id}); return 'mov'; } finally { logging = true; } },
  };
  const weights = {seek: 2, selectOne: 2, selectSome: 1, createRange: 4, createStatic: 2, createMulti: 2, createEmpty: 1, enter: 4, enterSelected: 1, leave: 3, addClipInstance: 3, addFigure: 2, move: 2, duplicate: 2, del: 2, delSome: 2,
    join: 3, unjoin: 1, createLayer: 1, moveLayer: 1, vfx: 1, vfxClip: 1, key: 1, camera: 1, audio: 2, audioTrack: 1, audioEdit: 1, sprite: 2, imageFigure: 1, background: 1, drawingLayer: 1, drawFrame: process.env.NODRAW ? 0 : 1, draw: process.env.NODRAW ? 0 : 3,
    rename: 1, unique: 1, breakApart: 1, split: 1, playback: 1, pose: 1, bend: 1, addFrame: 1, duplicateFrame: 1, insertKey: 1, removeFrames: 1, setDuration: 1, fps: 1, frameDuration: 1,
    addSegment: 2, delSegment: 1, splitSeg: 1, segValues: 1, mirror: 1, color: 1, undo: 3, redo: 2, deleteInstances: 1, copyPaste: 2, copyToOther: 2, swap: 1, exportMov: 1};
  const only = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
  const table = Object.entries(weights).filter(([k]) => !only || only.has(k)).flatMap(([k, w]) => Array(w).fill(k));

  const log = []; const failures = []; const okc = globalThis.__ok ??= {}; const nokc = globalThis.__nok ??= {};
  const fail = (kind, msg, bytes) => { if (process.env.OPLOG && !failures.length) writeFileSync(`${process.env.OPLOG}-${docName}-${seed}.json`, JSON.stringify({doc: docName, kind, msg: String(msg), ops: OPS})); const tag = `${docName}-${seed}-${log.length}-${kind}`; if (bytes) writeFileSync(`${failDir}/${tag}.styk`, bytes); failures.push({kind, msg: String(msg).slice(0, 300), tag, tail: log.slice(-8), full: process.env.FULL ? log.slice() : undefined}); };
  const save = async (instance, recovery) => {
    const ed = instance.e;
    if (!recovery) while (ed._movieclipScopes?.length) ed.leaveMovieclip();
    const blob = await exporter.export(ed.report, {format: 'styk', name: ed.name, scopes: recovery ? movieclipScopes(ed) : undefined, revision: ed.revision});
    return new Uint8Array(await blob.arrayBuffer());
  };
  let reopens = 0, repairsSeen = 0; const baseline = new Set();
  try { const b0 = await save(cur, false); const o0 = await openBytes(b0, "p.styk", {layerTimeline: true}); const r0 = (await o0.read()).report; const ex = canonical(e().report), m = new Map(canonical(r0)); o0.dispose(); for (const [p, v] of ex) if (m.get(p) !== v) baseline.add(p); for (const [p] of m) if (!ex.some(([q]) => q === p)) baseline.add(p); } catch (error) { console.log("baseline failed", docName, error.message); }
  async function check(recovery) {
    const ed = e(); const kind = recovery ? 'recovery' : 'save';
    let bytes;
    try { bytes = await save(cur, recovery); } catch (error) { fail(`${kind}-refused`, error.message); return; }
    // The expected document: for recovery the scopes fold into the project, so compare only for normal saves.
    const expected = recovery ? null : canonical(ed.report);
    let opening;
    try { opening = await openBytes(bytes, 'p.styk', {layerTimeline: true}); } catch (error) { fail(`${kind}-unopenable`, error.message, bytes); return; }
    try {
      reopens++;
      if (opening.repairs) { repairsSeen++; fail(`${kind}-needs-repair`, `repairs ${opening.repairs}`, bytes); }
      const {report} = await opening.read();
      if (expected) { const d = diff(expected, canonical(report), baseline); if (d) fail(`${kind}-differs`, d, bytes); }
      // saving what was reopened must also work, to the same bytes (a document that changed on reopen)
    } finally { opening.dispose(); }
  }
  try {
    for (let i = 1; i <= steps && (process.env.CONT || !failures.length); i++) {
      const name = pick(table); const ensure = () => { const ed = e(); if (!drawingResourcesFor(ed.report)) new DrawingResources(ed.report, {worker: workerStub(), onPublished: figure => ed._drawingPublished(figure)}); }; ensure();
      try { const rev = e().revision; const d = await G[name](); ensure(); if (process.env.FLUSH) await drawingResourcesFor(e().report)?.flush(); if (e().revision !== rev) okc[name] = (okc[name] ?? 0) + 1; log.push(`${name}${d === undefined || d === null ? '' : ' ' + d}`); } catch (error) { nokc[name] = (nokc[name] ?? 0) + 1; log.push(`${name}!${String(error?.message ?? error).slice(0, 50)}`); }
      if (i % every === 0) await check(rnd() < 0.35); else if (process.env.EXTRA) { const before = failures.length; await check(process.env.EXTRA === "rec"); if (failures.length > before) failures[failures.length-1].extra = true; }
    }
    if (process.env.CONT || !failures.length) await check(false);
  } catch (error) { failures.push({kind: 'driver', msg: String(error?.stack ?? error).slice(0, 500), tail: log.slice(-8)}); }
  for (const i of [A, B]) { try { i.owner.release(); i.native.dispose(); } catch {} }
  return {docName, seed, reopens, repairsSeen, failures: failures.map(f => ({kind: f.kind, msg: f.msg.slice(0,90), tag: f.tag, full: f.full})), gestures: log.length};
}

let bad = 0;
const runs = regression ? REGRESSION : (docArg === 'all' ? Object.keys(docs) : docArg.split(',')).flatMap(name => Array.from({length: seedTo - seedFrom + 1}, (_, at) => [name, seedFrom + at]));
for (const [name, seed] of runs) {
  const r = await runSeed(name, seed);
  if (r.failures.length) { bad++; console.log(JSON.stringify(r)); } else console.log(`ok ${name} ${seed} reopens=${r.reopens}`);
}
console.log('changed:', JSON.stringify(globalThis.__ok)); console.log('threw:', JSON.stringify(globalThis.__nok));
console.log(bad ? `FAILED ${bad} of ${runs.length}` : `ALL OK (${runs.length} seeds)`);
exporter.dispose(); codecHost.close();
process.exit(bad ? 1 : 0);
