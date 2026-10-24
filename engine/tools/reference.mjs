#!/usr/bin/env node
// Dumps what the current JavaScript editor evaluates for a document, so the
// Rust engine can be checked against it primitive by primitive.
//
//   node tools/reference.mjs <file.styk|decoded.json> <out.json> [--ticks 0,5,9] [--every N] [--max N] [--vfx] [--camera] [--images] [--scene] [--style] [--native]
//
// A Pivot .piv is decoded first with `node engine/tools/decode-piv.mjs <file.piv> <out.json>`
// (the repository's Python codec); this tool reads the decoded JSON.
//
// --vfx adds, per tick, the effects the editor resolves (`frames[].vfx`): the
// stacks the renderers hand to the effect executors, the generated effects,
// and the clips the inspector shows as active (docs/engine/vfx.md).
//
// --camera adds, per tick, what the scene camera does when it is shown
// (`frames[].shot`): the camera the scene is seen through (`cameraAtTime`: the
// authored camera, follow clips and camera-motion impulses) and how far parallax
// layers move each object, by slot (`parallaxResolver`).
//
// --images adds, per picture drawable, the corners its picture is drawn at
// (`image`: drawGeometry's translate(start)·rotate·scale(±s, s)·translate(-anchor)
// over the displayed size, the transform imageDrawNeed in src/image-resources.mjs
// spells out), from the asset as the drawable holds it (a Stick Nodes sprite's
// stretched one). The size is the displayed one, else the asset's recorded one.
//
// --scene adds, per tick, the evaluated frame's background (`scene`: the image identities,
// their mix and the colour key `_stykBackgroundColor`), what scene channels set.
//
// --style adds, per object, the outline its resolved figure is drawn with (`outline`: the
// width the renderers read from `u28`, the colour and the opacity of `global_style`), what
// outline channels set (`null` without one); and per segment drawable the second colour and
// transparency byte of a two-colour segment (`secondary`, `null` without one).
//
// --native evaluates the document on its native timeline (the editor without layer sheets,
// as documents with property channels were authored) instead of as the app loads it.
//
// --deep loads a document whose movieclips nest deeper than the editor opens a file
// (eight levels, `validateMovieclipGraph`). Nested editing builds such documents in a
// session, where only the clip entered is checked; the evaluation is the same.
import './v8-pin.mjs';
import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const repoUrl = pathToFileURL(repo).href;
const {openDocument} = await import(`${repoUrl}/tests/support/native-files.mjs`);
const {Editor} = await import(`${repoUrl}/src/editor.mjs`);
const {sampleInbetweenPreview} = await import(`${repoUrl}/src/editor-inbetween.mjs`);
const {buildGeometry} = await import(`${repoUrl}/src/pivot/geometry.mjs`);

const [input, output, ...rest] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: node tools/reference.mjs <file.styk|decoded.json> <out.json> [--ticks a,b] [--every N] [--max N] [--vfx] [--camera] [--images] [--scene] [--style] [--native] [--deep]');
  process.exit(2);
}
const option = name => { const i = rest.indexOf(name); return i < 0 ? undefined : rest[i + 1]; };
const effects = rest.includes('--vfx') ? await effectDumper() : null;
const shots = rest.includes('--camera') ? await shotDumper() : null;
const images = rest.includes('--images');
const scenes = rest.includes('--scene'), styles = rest.includes('--style');

let document;
if (/\.(styk|stkz|stykmov)$/i.test(input)) {
  const kind = /\.(styk|stkz|stykmov)$/i.exec(input)[1].toLowerCase();
  document = await openDocument(new Uint8Array(readFileSync(input)), kind, {verifySource: false});
} else {
  document = JSON.parse(readFileSync(input, 'utf8'));
}

// Same editor configuration as src/app.mjs (without layer sheets for --native).
const started = performance.now();
const editor = new Editor({demo: false, propertyChannels: true, layerTimeline: !rest.includes('--native')});
if (rest.includes('--deep')) {
  const {prepareEditorLoadSteps} = await import(`${repoUrl}/src/editor-load.mjs`);
  // A visited set skips the graph check of the root; every nested document is still prepared.
  const steps = prepareEditorLoadSteps(document, {sliceMs: Infinity, movieclipVisited: new Set()});
  let step;
  do step = steps.next(); while (!step.done);
  editor._publishLoadedReport(step.value, path.basename(input));
} else editor.load(document, path.basename(input));
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
const samples = option('--inbetween')?.split(',').map(value => {
  const [index, ratio] = value.split(':').map(Number);
  return {index, ratio};
});

const round = v => typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v;
const pt = p => p ? [round(p.x), round(p.y)] : null;
const frames = [];
let evalMs = 0;
for (const entry of samples ?? ticks) {
  const t0 = performance.now();
  const sample = samples ? sampleInbetweenPreview(editor.report, entry.ratio, entry.index) : null;
  const tick = sample?.sourceTick ?? entry;
  if (!sample) editor.seek(tick);
  const frame = sample?.frame ?? editor.evaluatedFrame;
  const geometry = sample ? buildGeometry(editor.report, frame) : editor.geometry;
  const drawables = geometry.drawables;
  evalMs += performance.now() - t0;
  // Evaluated meshes (docs/engine/spatial.md): each once per tick, in the order
  // their first drawable appears; a drawable names its mesh and its faces.
  const meshes = [], meshIds = new Map();
  const meshId = mesh => {
    if (!meshIds.has(mesh)) {
      meshIds.set(mesh, meshes.length);
      const n = mesh.vertexCount, list = values => Array.from(values, round);
      meshes.push({vertexCount: n, positions: list(mesh.positions.subarray(0, n * 2)), depth: list(mesh.depth.subarray(0, n)), colors: mesh.colors.map(c => [...c]),
        bounds: mesh.bounds ? [mesh.bounds.x0, mesh.bounds.y0, mesh.bounds.x1, mesh.bounds.y1].map(round) : null, zMin: round(mesh.zMin), zMax: round(mesh.zMax)});
    }
    return meshIds.get(mesh);
  };
  const items = drawables.map(d => {
    const item = {
      slot: d.slot, uid: d.obj?.unique_id, type: d.type,
      kind: d.seg?.segment_kind ?? (d.type === 'poly' ? 'poly' : undefined),
      seg: d.seg?.segment_id, poly: d.type === 'poly' ? d.index : undefined,
      z: round(d.z), rgb: d.rgb, alpha: round(d.alpha), opacity: round(d.opacity),
    };
    if (d.type === 'mesh') item.mesh = {id: meshId(d.spatialMesh), index: d.index, count: d.count,
      triangles: Array.from(d.triangles.subarray(0, d.count * 3)), materials: Array.from(d.materials.subarray(0, d.count))};
    else if (d.type === 'poly') {
      item.points = d.points.map(pt);
      // A depth-tested surface: one depth per point.
      if (d.depthValues) item.depth = d.depthValues.map(round);
    } else {
      item.start = pt(d.start); item.end = pt(d.end);
      item.thickness = round(d.thickness); item.length = round(d.length);
      item.angle = round(d.angle); item.bend = round(d.bend);
      if (Math.abs(d.bend ?? 0) > 1e-7) item.points = d.points.map(pt);
    }
    if (images && d.type === 'image' && d.asset?.anchor_length) item.image = imageCorners(d);
    if (styles && d.seg) item.secondary = d.seg.secondary ? [...d.seg.secondary.rgb, Number(d.seg.secondary.a ?? 0)] : null;
    if (d._movieclipOwner || d._movieclipPart !== undefined) item.movieclip = true;
    return item;
  });
  const objects = [];
  for (const [slot, g] of geometry.objects) {
    if (!g) continue;
    objects.push({slot, uid: g.obj.unique_id, figure: g.fig?.figure_type_id, root: pt(g.root),
      joints: [...g.joints].map(([id, p]) => [id, ...pt(p)]), ...(styles ? {outline: outline(g.fig)} : {})});
  }
  frames.push({
    tick,
    ...(sample ? {inbetween: {index: sample.index, ratio: sample.ratio}} : {}),
    camera: frame.camera ?? null,
    background: {id: frame.background_id ?? 0, b: frame.background_id_b ?? 0, mix: frame.background_mix ?? 0},
    objects, drawables: items,
    ...(meshes.length ? {meshes} : {}),
    ...(effects ? {vfx: effects(editor.report, frame, geometry, tick)} : {}),
    ...(shots ? {shot: shots(editor.report, frame)} : {}),
    ...(scenes ? {scene: {background: [frame.background_id ?? 0, frame.background_id_b ?? 0, frame.background_mix ?? 0], color: frame._stykBackgroundColor ?? null}} : {}),
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

/** The outline a resolved figure is drawn with: the renderers read its width from `u28` (single precision bits). */
function outline(figure) {
  const style = figure?.segment_decode?.global_style, width = style?.u28 ? new Float32Array(new Uint32Array([style.u28]).buffer)[0] : 0;
  return width > 0 && Number.isFinite(width) ? {width: round(width), rgb: style.rgb ?? [0, 0, 0], alpha: round(1 - Number(style.u30 ?? 0) / 255)} : null;
}

/** The corners a picture drawable is drawn at: origin, along its width, along its height, opposite. */
function imageCorners(d) {
  const a = d.asset, w = a.display_width ?? a.width, h = a.display_height ?? a.height;
  const reverse = Boolean(d.seg?.extra_u8_a ?? d.seg?.extra?.[1]), mirror = Boolean(d.seg?.extra_u8_b ?? d.seg?.extra?.[2]) !== Boolean(d.obj?.image_text_flags);
  const start = reverse ? d.end : d.start, scale = Math.hypot(d.end.x - d.start.x, d.end.y - d.start.y) / a.anchor_length;
  const angle = (mirror ? d.angle + a.anchor_angle_rad - Math.PI : d.angle - a.anchor_angle_rad) + (reverse ? Math.PI : 0);
  const cos = Math.cos(angle), sin = Math.sin(angle), mx = mirror ? -1 : 1, anchor = a.anchor_start || {x: 0, y: 0};
  const corner = (x, y) => { const px = mx * scale * (x - anchor.x), py = scale * (y - anchor.y); return [round(start.x + px * cos - py * sin), round(start.y + px * sin + py * cos)]; };
  return [corner(0, 0), corner(w, 0), corner(0, h), corner(w, h)];
}

/** What the scene camera does to a frame when it is shown (the engine's styk_eval::view::camera_matrix). */
async function shotDumper() {
  const {cameraAtTime} = await import(`${repoUrl}/src/camera-motion.mjs`);
  const {parallaxResolver} = await import(`${repoUrl}/src/layer-parallax.mjs`);
  return (report, frame) => {
    const camera = cameraAtTime(report, frame), depth = parallaxResolver(report, frame);
    return {camera: camera ? {x: camera.x ?? 0, y: camera.y ?? 0, scale: camera.scale ?? 1, angle: camera.angle_rad ?? 0, isDefault: Boolean(camera.is_default)} : null,
      parallax: frame.objects.map(object => { const d = depth(object.unique_id); return [d.x, d.y]; })};
  };
}

/**
 * What the editor resolves for effects at one tick, as the renderers hand it to
 * the effect executors:
 *
 * - `scene`: `activeVfx(vfxStack(frame))`, the camera's stack;
 * - `objects`: per slot with anything to draw, the stack of the object's own
 *   artwork (`vfxStack(obj)`, or a movieclip container's owner effects, without
 *   what its connected group applies), its connected group from
 *   `connectedVfxGeometry` (`attached`: the group's stack and the slots of its
 *   drawn parts) and its node stacks by handle id (`segmentVfx`);
 * - `roots`: the connected groups, in the order they are composited;
 * - `layerHidden` / `empty`: slots on a hidden layer / without artwork, which
 *   no group draws;
 * - `generators`: generated effects inside their clip's range, with the
 *   parameters, opacity and start `collectLayers` (src/vfx-generators.mjs) reads;
 * - `activeClips`: the clips the inspector lists "At playhead" (`vfxClipActiveAt`).
 *
 * Each stack carries its padding (`vfxPadding`, `vfxSamplingPadding` at fixed
 * scales and the canvas extent) and `vfxWorkingSlots`.
 */
async function effectDumper() {
  const {activeVfx, vfxStack, resolvedVfx, vfxPadding, vfxSamplingPadding, vfxWorkingSlots} = await import(`${repoUrl}/src/vfx.mjs`);
  const {vfxRenderFrame, vfxClips, vfxClipActiveAt, vfxFadeAt, sampleVfxClip} = await import(`${repoUrl}/src/vfx-clips.mjs`);
  const {connectedVfxGeometry} = await import(`${repoUrl}/src/vfx-connected.mjs`);
  const {isGeneratorType} = await import(`${repoUrl}/src/vfx-registry.mjs`);
  const {generatorClipActiveAt} = await import(`${repoUrl}/src/vfx-generators.mjs`);
  const {layerVisible} = await import(`${repoUrl}/src/layers.mjs`);
  const {movieclipTypes} = await import(`${repoUrl}/src/movieclips.mjs`);
  const effect = e => ({id: e.id, type: e.type, params: e.params});
  return (report, frame, geometry, tick) => {
    const extent = Math.max(report.canvas_width, report.canvas_height);
    const stack = raw => {
      const active = activeVfx(raw), slots = vfxWorkingSlots(active);
      if (slots.gpu.join() !== slots.cpu.join()) throw new Error('vfxWorkingSlots: GPU and CPU slots differ');
      return {effects: active.map(effect), slots: slots.gpu,
        padding: [vfxPadding(active, 1, extent), vfxPadding(active, 2.5, extent), vfxSamplingPadding(active, 1, extent), vfxSamplingPadding(active, .75, extent)]};
    };
    const rendered = vfxRenderFrame(report, frame), grouped = connectedVfxGeometry(geometry, frame, report);
    const assemblies = grouped.connectedVfxAssemblies ?? new Map(), clipTypes = movieclipTypes(report);
    // A group's items keep their member's identity (movieclip content takes its instance's).
    const slotOf = new Map(rendered.objects.map((o, slot) => [o.unique_id, slot]));
    const objects = [], layerHidden = [], empty = [];
    rendered.objects.forEach((o, slot) => {
      const g = geometry.objects.get(slot), container = clipTypes.has(o.figure_type_id);
      if (!layerVisible(report, o.unique_id)) layerHidden.push(slot);
      if (!g?.drawables?.length) empty.push(slot);
      let own = container ? g?.drawables?.[0]?._movieclipOwner?.effects ?? vfxStack(o) : vfxStack(o), attached;
      const items = assemblies.get(slot);
      if (items) {
        // The root's own artwork keeps what the group does not apply (connectedVfxGeometry).
        const mine = items.find(item => item.obj.unique_id === o.unique_id);
        const connected = items[0]?._movieclipOwner.effects ?? o._vfxConnectedEffects ?? vfxStack(o), ids = new Set(connected.map(e => e.id));
        own = mine ? (container ? mine._movieclipInner?.owner?.effects ?? [] : vfxStack(mine.obj)) : own.filter(e => !ids.has(e.id));
        attached = {...stack(connected), members: [...new Set(items.map(item => slotOf.get(item.obj.unique_id)))].sort((a, b) => a - b)};
      }
      const segments = {};
      if (!container) for (const [key, raw] of Object.entries(o._stykVfx ?? {})) {
        const [scope, handle] = key.split('/');
        if (key !== 'figure' && scope === String(o.figure_type_id) && activeVfx(raw).length) segments[handle] = stack(raw);
      }
      const figure = stack(own);
      if (figure.effects.length || attached || Object.keys(segments).length) objects.push({slot, uid: o.unique_id, figure, ...(attached ? {attached} : {}), segments});
    });
    const generators = [];
    for (const clip of vfxClips(report)) {
      const timed = clip.duration !== null, end = timed ? clip.start + clip.duration : Infinity;
      if (!generatorClipActiveAt(clip, tick) || tick >= end) continue;
      const strength = clip.strength * (timed ? vfxFadeAt(clip, Math.max(0, Math.min(clip.duration, tick - clip.start))) : 1);
      if (strength <= 0) continue;
      sampleVfxClip(clip, Math.min(tick, timed ? end - 1e-6 : tick)).forEach((sampled, index) => {
        if (!isGeneratorType(sampled.type) || !sampled.enabled) return;
        const resolved = resolvedVfx(sampled), alpha = strength * resolved.params.effectStrength, start = clip.start + resolved.params.delay;
        if (alpha <= 0 || timed && resolved.params.delay >= clip.duration || tick < start) return;
        generators.push({clip: clip.id, index, alpha, start, ...effect(resolved)});
      });
    }
    return {scene: stack(vfxStack(frame)), objects, roots: [...assemblies.keys()], layerHidden, empty, generators,
      warnings: grouped.warnings?.filter(w => w.startsWith('Connected VFX')).length ?? 0,
      activeClips: vfxClips(report).filter(clip => vfxClipActiveAt(clip, tick)).map(clip => clip.id)};
  };
}
