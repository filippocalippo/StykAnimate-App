#!/usr/bin/env node
// Builds the 3D fixtures of the Rust engine with the real JavaScript editor:
// each is a small project (plain JSON, opened like a .styk) and what the editor
// evaluates for it (tools/reference.mjs): spatial poses and their tweens,
// one-sided surfaces, figure meshes and attached movieclip meshes
// (docs/engine/spatial.md).
//
//   node engine/tools/spatial-fixtures.mjs [name ...] [--out <folder>] [--list]
//
// Without names it regenerates every fixture into
// engine/crates/styk-eval/tests/fixtures/spatial/. The Rust test
// engine/crates/styk-eval/tests/spatial.rs compares the engine with each of
// them and checks that each stops matching without the feature it is about.
//
// Figure definitions are written here, as the asset builders write them
// (scripts/build-spider-man-rig.mjs): a mesh is authored data, the editor has no
// command that creates one. Meshes come from the editor's own converter
// (src/spatial-mesh-legacy.mjs); every pose, key, camera and proportion is set
// with the editor's commands.
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {here, repo, repoUrl, emptyDocument, createObject, createFrame, open, joint, whole, nextKey, nextSheetKey, writeProject, writeReference} from './fixture-kit.mjs';

const {construction} = await import(`${repoUrl}/src/rig-examples-3d.mjs`);
const {convertDocumentSpatialMeshes} = await import(`${repoUrl}/src/spatial-mesh-legacy.mjs`);
const {movieclipFigure} = await import(`${repoUrl}/src/movieclips.mjs`);
const {rigExampleDocument} = await import(`${repoUrl}/src/rig-examples.mjs`);
const {interpolateSpatialPose} = await import(`${repoUrl}/src/spatial-projection.mjs`);
const {defaultFigure} = await import(`${repoUrl}/src/demo.mjs`);

// ---------------------------------------------------------------- figures

const sub = (a, b) => a.map((v, i) => v - b[i]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const COLORS = [[214, 92, 64], [64, 132, 214], [92, 184, 108], [226, 188, 72], [140, 104, 196]];

/** A spatial rig under construction: bones, skin joints and one-sided,
 * depth-tested triangles between them, with the reference joints every face shares. */
function rig() {
  const q = construction(), skins = new Map();
  q.add(0, 0, 0, 'Figure rotation');
  const basis = [0, q.add(0, 30, 0, 'Surface X'), q.add(0, 30, Math.PI / 2, 'Surface Y')];
  /** An articulated bone from `origin` to `tip`, with its turn and tilt controls. */
  const bone = (parent, tip, name, {origin = parent?.tip ?? [0, 0, 0], motion, extra = {}} = {}) => {
    const turn = q.add(0, 0, 0, `${name} turn`), pitch = q.add(0, 0, 0, `${name} tilt`), v = sub(tip, origin);
    const id = q.add(parent?.id ?? 0, Math.hypot(...v), Math.atan2(v[1], v[0]), name,
      {control: true, rig: {spatial: {parent: parent?.id ?? 0, origin, tip, turn, pitch, ...(motion ? {motion} : {})}}});
    Object.assign(q.segments[id - 1], extra);
    return {id, origin, tip, turn, pitch};
  };
  /** A skin joint at `point`, bound to bones by weight; equal joints are shared. */
  const skin = (point, bindings, viewPoints) => {
    const key = JSON.stringify([point, bindings.map(([b, w]) => [b.id, w])]);
    if (!skins.has(key)) skins.set(key, q.add(0, 0, 0, 'Skin', {rig: {spatial: {point, bindings: bindings.map(([b, weight]) => ({joint: b.id, weight})), ...(viewPoints ? {viewPoints} : {})}}}));
    return skins.get(key);
  };
  /** A triangle of skin joints facing along `normal`. */
  const face = (vertices, color, normal, surface = {}) => {
    const points = vertices.map(v => v.point);
    if (cross(sub(points[1], points[0]), sub(points[2], points[0])).reduce((n, v, i) => n + v * normal[i], 0) < 0) vertices = vertices.toReversed();
    const ids = vertices.map(v => skin(v.point, v.bindings, v.viewPoints));
    q.polyfills.push({polyfill_id: q.polyfills.length + 1, segment_ids: ids, color_rgb: color.slice(), color_alpha: 1, z_order: 0,
      _stykSurface: {basis: basis.slice(), side: 'front', depthTest: true, depth: ids.slice(), ...surface}});
  };
  /** A square tube through `rings` ([y, half size, bindings, view]), closed at both ends. */
  const tube = (rings, {views = 0} = {}) => {
    const corners = rings.map(([y, r, bindings], level) => [[-r, y, -r], [r, y, -r], [r, y, r], [-r, y, r]].map((point, k) => ({point, bindings,
      // Art-directed views: one target per heading, relative to the bone's origin.
      ...(views && bindings.length === 1 ? {viewPoints: Array.from({length: views}, (_, n) => [point[0] - bindings[0][0].origin[0] + n * (k % 2 ? 1.5 : -1), point[1] - bindings[0][0].origin[1] - n * .75, point[2] - bindings[0][0].origin[2] + (level + 1) * n * .5])} : {})})));
    for (let level = 1; level < corners.length; level++) for (let k = 0; k < 4; k++) {
      const [a, b, c, d] = [corners[level - 1][k], corners[level - 1][(k + 1) % 4], corners[level][(k + 1) % 4], corners[level][k]];
      const normal = [(a.point[0] + b.point[0]) / 2, 0, (a.point[2] + b.point[2]) / 2];
      face([a, b, c], COLORS[k], normal); face([a, c, d], COLORS[k], normal);
    }
    for (const [ring, normal] of [[corners[0], [0, 1, 0]], [corners.at(-1), [0, -1, 0]]]) { face([ring[0], ring[1], ring[2]], COLORS[4], normal); face([ring[0], ring[2], ring[3]], COLORS[4], normal); }
  };
  const figure = (id = 1, name = 'Rig') => ({figure_type_id: id, name, segments: q.segments, segment_count: q.segments.length, polyfills: q.polyfills, image_assets: [], text_assets: [], _styk: {colorMode: 'segments'}});
  return {q, basis, bone, skin, face, tube, figure};
}

/** An arm of two bones (upper, lower) skinned by a tube: the elbow ring follows
 * both bones, so it blends their frames. Up is negative Y, as on screen. */
function arm(options = {}) {
  const r = rig(), upper = r.bone(null, [0, -60, 0], 'Upper'), lower = r.bone(upper, [0, -120, 0], 'Lower', options.lower);
  r.tube([[0, 14, [[upper, 1]]], [-60, 11, [[upper, .5], [lower, .5]]], [-120, 8, [[lower, 1]]]], options);
  return {...r, upper, lower};
}

const documentOf = (figures, objects) => ({...emptyDocument(), figure_types: figures, keyframes: [createFrame(objects, 1)]});
/** One figure at (x, y) in a document, as native skin surfaces or converted to a mesh. */
function project(figure, {mesh = true, x = 320, y = 300, object = {}} = {}) {
  const document = documentOf([figure], [createObject(figure, 1, x, y, object)]);
  if (!mesh) return document;
  const {document: converted, converted: done, skipped} = convertDocumentSpatialMeshes(document);
  if (done.length !== 1) throw new Error(`the figure was not converted to a mesh: ${skipped.map(s => s.reason).join('; ')}`);
  return converted;
}
/** Poses the bone `b` of object `uid`. */
const pose = (e, b, patch, uid = 1) => { joint(e, b.id, uid).setSpatialPose(patch); return e; };

// --------------------------------------------------------------- fixtures

const fixtures = {
  /** Native skin surfaces: depth-tested triangles between skin joints, culled when
   * they look away, each with one depth per corner. Two bones turn between keys. */
  'surfaces-skin': () => {
    const a = arm(), e = open(project(a.figure(), {mesh: false}));
    pose(e, a.upper, {turn: .5, pitch: .3});
    nextKey(e, 6); pose(e, a.upper, {turn: 2.2, pitch: -.6, bend: .4}); pose(e, a.lower, {bend: -.9, turn: .7});
    return {document: e.serialize(), ticks: [0, 2, 3, 5, 6]};
  },
  /** The same surfaces under perspective, then so close that faces cross the near
   * plane and are clipped before projection (a triangle may become a quad). The
   * camera tweens between the keys. */
  'surfaces-perspective': () => {
    const a = arm(), e = open(project(a.figure(), {mesh: false}));
    pose(e, a.upper, {turn: .8, pitch: .5}); e.setSpatialCamera({strength: .8, distance: 400});
    nextKey(e, 4); pose(e, a.upper, {turn: .4, pitch: -1}); e.setSpatialCamera({strength: 1, distance: 40});
    return {document: e.serialize(), ticks: [0, 1, 2, 3, 4]};
  },
  /** One-sided faces without depth guides: the Box solid of the rig examples,
   * whose faces are culled by their reference triangle alone as it turns. */
  'surfaces-solid': () => {
    const e = open(rigExampleDocument('solid-box-3d'));
    const turn = e.report.figure_types[0].segments.find(s => s.name === 'Turn').segment_id;
    joint(e, turn).rotateJoint(.9);
    nextKey(e, 6); joint(e, turn).rotateJoint(1.7);
    return {document: e.serialize(), ticks: [0, 2, 3, 5, 6]};
  },
  /** A figure mesh skinned by two bones: single-bone vertices follow their bone's
   * frame, the elbow ring blends both by dual quaternion. */
  'mesh-skinned': () => {
    const a = arm(), e = open(project(a.figure()));
    pose(e, a.upper, {turn: .5, pitch: .3});
    nextKey(e, 6); pose(e, a.upper, {turn: 2.2, pitch: -.6, bend: .4}); pose(e, a.lower, {bend: -.9, turn: .7});
    nextKey(e, 4); pose(e, a.lower, {bend: .6, pitch: 1.1}); whole(e).moveSelection(40, -30);
    return {document: e.serialize(), ticks: [0, 2, 3, 5, 6, 8, 10]};
  },
  /** Stretched and resized bones: while a bone stretches its blended vertices
   * blend positions linearly; width and taper move vertices radially, tweened
   * between the keys with the rest of `_stykSpatial`. */
  'mesh-proportions': () => {
    const a = arm(), e = open(project(a.figure()));
    pose(e, a.upper, {turn: .6, pitch: .2}); pose(e, a.lower, {bend: .5});
    nextKey(e, 6); joint(e, a.upper.id).setSpatialProportions({width: 1.8, taper: -.5});
    joint(e, a.lower.id).setSpatialProportions({length: 1.5, width: .6, taper: 1.2});
    nextKey(e, 4); joint(e, a.upper.id).setSpatialProportions({size: 1.4});
    return {document: e.serialize(), ticks: [0, 2, 3, 5, 6, 8, 10]};
  },
  /** Perspective and near clipping of a mesh: the camera's strength, distance
   * and centre tween between the keys; at the last key faces cross the near plane. */
  'mesh-perspective': () => {
    const a = arm(), e = open(project(a.figure()));
    pose(e, a.upper, {turn: .8, pitch: .5}); e.setSpatialCamera({strength: .8, distance: 400});
    nextKey(e, 4); pose(e, a.upper, {turn: .4, pitch: -1}); e.setSpatialCamera({strength: 1, distance: 40, centerX: 300, centerY: 260});
    nextKey(e, 3); whole(e).moveSelection(-25, 10); whole(e).scaleSelection(1.6);
    return {document: e.serialize(), ticks: [0, 1, 2, 3, 4, 5, 7]};
  },
  /** View-corrected vertices: eight authored targets per single-bone vertex,
   * blended around the bone's heading and faded out as it tilts toward vertical. */
  'mesh-views': () => {
    const a = arm({views: 8}), e = open(project(a.figure()));
    pose(e, a.upper, {turn: .3});
    nextKey(e, 5); pose(e, a.upper, {turn: 2.9, pitch: .4}); pose(e, a.lower, {turn: -1.3});
    nextKey(e, 5); pose(e, a.upper, {turn: 5.2, pitch: 1.45});
    return {document: e.serialize(), ticks: [0, 1, 3, 5, 6, 8, 10]};
  },
  /** The figure's other visible primitives split the mesh in painter order: two
   * visible limbs and a flat fill lie inside its depth range, a zero-width line
   * does not split it. The mesh has a depth-order offset. */
  'mesh-split': () => {
    const a = arm();
    const limb = a.q.add(0, 70, -.4, 'Front limb', {width: 6}), back = a.q.add(0, 60, -2.6, 'Back limb', {width: 5}), guide = a.q.add(0, 50, 1.2, 'Guide', {width: 0});
    Object.assign(a.q.segments[limb - 1], {z_order: .12, visible: true}); Object.assign(a.q.segments[back - 1], {z_order: -.2, visible: true});
    Object.assign(a.q.segments[guide - 1], {z_order: .05, visible: true});
    const document = project(a.figure());
    document.figure_types[0].polyfills.push({polyfill_id: 900, segment_ids: [0, limb, back], color_rgb: [30, 30, 30], color_alpha: .5, z_order: 0});
    document.figure_types[0]._styk.spatialMesh.z = .02;
    const e = open(document);
    pose(e, a.upper, {turn: .9, pitch: .4});
    nextKey(e, 4); pose(e, a.upper, {turn: 2.4, pitch: -.3}); pose(e, a.lower, {bend: 1.1});
    return {document: e.serialize(), ticks: [0, 1, 2, 3, 4]};
  },
  /** A mirrored, rotated, scaled and recoloured instance beside a plain one: the
   * colour override mixes into the palette, and one palette entry is replaced
   * for this instance only (`_stykStyle.meshColors`). */
  'mesh-instances': () => {
    const a = arm(), document = project(a.figure()), figure = document.figure_types[0];
    document.keyframes[0] = createFrame([createObject(figure, 1, 220, 300), createObject(figure, 2, 440, 300)], 1);
    const e = open(document);
    pose(e, a.upper, {turn: .7, pitch: .3}, 1); pose(e, a.upper, {turn: .7, pitch: .3}, 2);
    whole(e, 2).mirrorSelection('horizontal'); whole(e, 2).rotateSelection(.6); whole(e, 2).scaleSelection(1.3);
    e.select(2); const entry = e.figurePalette().find(row => row.meshColors?.includes(1));
    e.replaceFigureColor(entry.color, '#20c0a0', {targets: entry});
    nextKey(e, 4); whole(e, 2).rotateSelection(-1.1); pose(e, a.lower, {bend: .8}, 2);
    return {document: e.serialize(), ticks: [0, 1, 2, 3, 4]};
  },
  /** Mechanical joints: a hinge about its own axis, a slide along its rest axis
   * and a hinge driven by the first, each carrying mesh vertices; and a hidden
   * expression, which scales about its origin instead of stretching. */
  'mesh-mechanism': () => {
    const r = rig(), frame = r.bone(null, [0, -50, 0], 'Frame');
    const hinge = r.bone(frame, [30, -50, 0], 'Hinge', {origin: [0, -50, 0], motion: {type: 'hinge', min: -1.2, max: 1.2, axis: [0, .6, .8]}});
    const slide = r.bone(frame, [0, -90, 0], 'Slide', {origin: [0, -50, 0], motion: {type: 'slide', min: 0, max: 25}});
    const follower = r.bone(hinge, [55, -50, 0], 'Follower', {origin: [30, -50, 0], motion: {type: 'hinge', min: -2, max: 2, driver: {joint: hinge.id, multiplier: .5}}});
    const choice = r.bone(frame, [-30, -20, 0], 'Expression', {origin: [0, -20, 0], extra: {_stykPoseChoice: {group: 'Mouth', label: 'Open', shown: 30, hidden: 0}}});
    r.tube([[0, 12, [[frame, 1]]], [-50, 12, [[frame, 1]]]]);
    for (const [b, from, to] of [[hinge, [0, -50, 0], [30, -50, 0]], [slide, [0, -50, 0], [0, -90, 0]], [follower, [30, -50, 0], [55, -50, 0]], [choice, [0, -20, 0], [-30, -20, 0]]]) {
      const side = [from[1] === to[1] ? 0 : 5, from[1] === to[1] ? 5 : 0, 0], corners = [from, to, to.map((v, i) => v + side[i]), [from[0], from[1], 6]].map(point => ({point, bindings: [[b, 1]]}));
      r.face([corners[0], corners[1], corners[2]], COLORS[1], [0, 0, 1]); r.face([corners[0], corners[2], corners[3]], COLORS[2], [side[1] ? 0 : 1, side[1] ? -1 : 0, .2]);
    }
    const e = open(project(r.figure()));
    pose(e, frame, {turn: .6, pitch: .25});
    nextKey(e, 6); joint(e, hinge.id).setSpatialMotion(.9); joint(e, slide.id).setSpatialMotion(18); joint(e, follower.id).setSpatialMotion(-.4);
    // Hiding the expression takes its length to zero; between the keys it shrinks.
    e.select(1); e.setPoseChoice('Mouth', 0);
    return {document: e.serialize(), ticks: [0, 2, 3, 5, 6]};
  },
  /** A mesh figure on a layer sheet: its pose, perspective and proportions tween
   * between the layer's keys. */
  'mesh-sheet': () => {
    const a = arm(), e = open(project(a.figure()), {layerTimeline: true});
    pose(e, a.upper, {turn: .4, pitch: .2}); e.setSpatialCamera({strength: .5, distance: 300});
    nextSheetKey(e, 6); pose(e, a.upper, {turn: 1.9, pitch: -.5}); joint(e, a.lower.id).setSpatialProportions({width: 1.6, taper: .8}); e.setSpatialCamera({strength: .9, distance: 150});
    e.seek(0);
    return {document: e.serialize(), ticks: [0, 1, 3, 5, 6]};
  },
  /** A mesh figure captured in a movieclip. The editor places a clip's points,
   * starts and ends at its instance; a mesh drawable has none, so its faces stay
   * where the clip's own frame evaluates them (reproduced, docs/engine/spatial.md). */
  'mesh-in-movieclip': () => {
    const a = arm(), e = open(project(a.figure()), {layerTimeline: true});
    pose(e, a.upper, {turn: .6, pitch: .3});
    nextSheetKey(e, 6); pose(e, a.upper, {turn: 1.5}); e.seek(0); e.select(1);
    const clip = e.createMovieclip({start: 0, end: 7});
    const instance = e.evaluatedFrame.objects.find(object => object.figure_type_id === clip.figure_type_id).unique_id;
    e.seek(3); whole(e, instance).moveSelection(90, -40); e.seek(0);
    return {document: e.serialize(), ticks: [0, 2, 3, 5, 6]};
  },
  /** Attached movieclip meshes: one joined to a spatial bone, which alone owns
   * its orientation (with eight authored views, per-view turns and turn
   * weights, under perspective that clips it at the near plane); one placed
   * flat by its own angle, scale and reflection, showing the clip's second form. */
  'clip-mesh': () => {
    const r = rig(), head = r.bone(null, [0, -30, 0], 'Head');
    const body = r.figure(1, 'Body');
    const forms = movieclipFigure(2, 'Forms', {...emptyDocument(), figure_types: [], keyframes: [createFrame([]), createFrame([])]}, {duration: 2, pivot: {x: 2, y: -3}});
    const positions = [-10, -20, 0, 10, -20, 0, 0, 0, 10, 0, 0, -10, 0, -34, 4];
    const mesh = {positions, indices: [0, 1, 2, 1, 0, 3, 0, 2, 3, 2, 1, 3, 0, 4, 1, 1, 4, 2], colors: [[240, 80, 0], [250, 200, 60]], materials: [0, 0, 1, 1, 0, 1]};
    const viewPositions = Array.from({length: 8}, (_, k) => positions.map((v, i) => i % 3 === 0 ? v + k * 1.5 : i % 3 === 1 ? v - k * .5 : v + k));
    forms._styk.movieclip.spatialMeshes = [{...mesh, viewPositions, viewTurns: [0, .4, 1.2, 2.2, 3.1, -2.2, -1.2, -.4], viewPivot: [0, -10, 0], viewTurnWeights: [1, 1, .5, .5, 0]},
      {...mesh, colors: [[0, 80, 240], [120, 200, 250]]}];
    forms._styk.movieclip.drawingSets = [{name: 'Orange', views: [{name: 'Mesh', frame: 0}]}, {name: 'Blue', views: [{name: 'Mesh', frame: 1}]}];
    const attached = createObject(forms, 2, 0, 0, {join: {target_object_slot: 0, target_unique_id: 1, target_handle_id: head.id}, _stykMovieclip: {start: 0, end: 100, mode: 'single', offset: 0}, scale: 2.5});
    const flat = createObject(forms, 3, 470, 220, {_stykMovieclip: {start: 0, end: 100, mode: 'single', offset: 1}, scale: 1.8, image_text_flags: 1, angles: [.5], color_override_raw: 0x80ff00ff, field28: 60});
    const e = open(documentOf([body, forms], [createObject(body, 1, 240, 240), attached, flat]));
    pose(e, head, {turn: .7, pitch: .3, bend: .2});
    nextKey(e, 6); pose(e, head, {turn: 3.6, pitch: -.8}); whole(e, 1).mirrorSelection('horizontal');
    nextKey(e, 4); pose(e, head, {turn: 4.4, pitch: 1.3}); e.select(1); e.setSpatialCamera({strength: 1, distance: 12});
    return {document: e.serialize(), ticks: [0, 2, 3, 5, 6, 8, 10]};
  },
  /** Drawings a spatial bone turns (`drawingRotation`): a movieclip of two forms, each eight
   * directions at three tilts (authored as the editor's own test of them authors it), joined
   * to a head bone whose origin sits off the figure's plane. It shows the view the bone's turn
   * and tilt select, rolled with its bend; then the second form, picked with the drawing
   * control; then the figure mirrored and seen in perspective (scaled by the bone's depth). */
  'rotated-drawings': () => {
    const r = rig(), head = r.bone(null, [0, -30, 50], 'Head', {origin: [0, 0, 50]});
    const body = r.figure(1, 'Body'), ink = defaultFigure(1);
    // Each frame places its ink where it can be told from every other frame.
    const inner = {...emptyDocument(), figure_types: [ink], keyframes: Array.from({length: 48}, (_, i) => createFrame([createObject(ink, 1, (i % 8) * 14, Math.floor(i / 8) * 14)]))};
    const forms = movieclipFigure(2, 'Head forms', inner, {duration: 48, pivot: {x: 0, y: 0}});
    const sets = Array.from({length: 2}, (_, g) => ({name: `Form ${g}`, views: Array.from({length: 24}, (_, i) => ({name: `View ${i}`, frame: g * 24 + i}))}));
    Object.assign(forms._styk.movieclip, {drawingSets: sets, drawingRotation: {steps: 8, tiltThreshold: 20 * Math.PI / 180}});
    const attached = createObject(forms, 2, 0, 0, {join: {target_object_slot: 0, target_unique_id: 1, target_handle_id: head.id}, _stykMovieclip: {start: 0, end: 100, mode: 'single', offset: 0}, scale: 1.5});
    const e = open(documentOf([body, forms], [createObject(body, 1, 260, 260), attached]));
    pose(e, head, {turn: .7, pitch: .2, bend: .3});
    nextKey(e, 6); pose(e, head, {turn: 2.4, pitch: -.6, bend: -.4}); e.setMovieclipDrawing(2, 1, 0);
    nextKey(e, 6); pose(e, head, {turn: 4.1, pitch: .5, bend: .2}); whole(e, 1).mirrorSelection('horizontal');
    nextKey(e, 4); e.select(1); e.setSpatialCamera({strength: .8, distance: 300}); pose(e, head, {turn: 5.5, pitch: .1});
    return {document: e.serialize(), ticks: [0, 3, 6, 9, 12, 14, 16]};
  },
};

// ------------------------------------------------------------ pose vectors

/** Recorded inputs and results of `interpolateSpatialPose`, unrounded: a pose
 * without perspective takes its root as the camera centre, a bone without
 * proportions the defaults, every value stays inside its limits (also for the
 * extrapolation the editor's tweener asks for, t = -1). */
function vectors() {
  const object = (root_x, root_y, spatial) => ({unique_id: 1, figure_type_id: 1, root_x, root_y, ...(spatial ? {_stykSpatial: spatial} : {})});
  const poses = [
    object(100, 50),
    object(120.5, 80.25, {camera: {strength: .4, distance: 300}}),
    object(-20, 10, {camera: {strength: 1, distance: 10, centerX: 30, centerY: -5}}),
    object(0, 0, {shape: {7: {width: 1.5, taper: -.3}}}),
    object(5, 5, {camera: {strength: 0, distance: 100000}, shape: {3: {width: .1, taper: 3}, 7: {width: 5, taper: -.9}}}),
  ];
  const interpolate = [];
  for (const a of poses) for (const b of poses) for (const t of [.25, .5, .9, -1, 1.5])
    if (a._stykSpatial || b._stykSpatial) interpolate.push({a, b, t, result: interpolateSpatialPose(a, b, t)});
  return {interpolate};
}

const args = process.argv.slice(2);
if (args.includes('--list')) { console.log([...Object.keys(fixtures), 'vectors'].join('\n')); process.exit(0); }
const outAt = args.indexOf('--out');
const out = path.resolve(outAt < 0 ? `${here}/../crates/styk-eval/tests/fixtures/spatial` : args[outAt + 1]);
const names = args.filter((a, i) => !a.startsWith('--') && (outAt < 0 || i !== outAt + 1));
for (const name of names) if (!fixtures[name] && name !== 'vectors') { console.error(`unknown fixture ${name}`); process.exit(2); }
mkdirSync(out, {recursive: true});
if (!names.length || names.includes('vectors')) {
  const cases = vectors();
  writeFileSync(`${out}/vectors.json`, JSON.stringify(cases) + '\n');
  console.log(`vectors: ${cases.interpolate.length} pose interpolations, ${(JSON.stringify(cases).length / 1024).toFixed(1)} KiB`);
}
for (const name of (names.length ? names : Object.keys(fixtures)).filter(name => name !== 'vectors')) {
  const built = fixtures[name]();
  writeReference(writeProject(out, name, built.document, built.ticks), name);
}
