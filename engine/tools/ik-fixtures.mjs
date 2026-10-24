#!/usr/bin/env node
// Builds the inverse-kinematics fixtures of the Rust engine with the real
// JavaScript editor: each is a small project (plain JSON, opened like a .styk)
// and what the editor evaluates for it (tools/reference.mjs).
//
//   node engine/tools/ik-fixtures.mjs [name ...] [--out <folder>] [--list]
//
// Without names it regenerates every fixture into
// engine/crates/styk-eval/tests/fixtures/ik/. The Rust test
// engine/crates/styk-eval/tests/ik.rs compares the engine with each of them.
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {here, repo, repoUrl, Editor, emptyDocument, createObject, createFrame, documentOf, limb, open, joint, whole, nextKey, nextSheetKey, writeProject, writeReference} from './fixture-kit.mjs';

const {createStartupDocument} = await import(`${repoUrl}/src/startup-document.mjs`);
const {construction} = await import(`${repoUrl}/src/rig-examples-3d.mjs`);
const {solveIKPoints, interpolateIK} = await import(`${repoUrl}/src/ik.mjs`);

// ---------------------------------------------------------------- figures

const fixed = {is_static: true, aux_code: 1};
/** The foot of tests/ik-joined.test.mjs: static shin artwork, a construction
 * pivot at the ankle and a polygon that ties the foot's branches together. */
const footed = () => [[11, 0, 90, .8], [12, 11, 20, .3, fixed], [22, 11, 90, 2], [23, 22, .00027, -1.6, fixed], [24, 23, 18, 1.1, fixed],
  [33, 23, 35, 0], [34, 33, 10, .2, fixed], [35, 23, 25, 1.5, fixed], [41, 22, 16, 1.1, fixed]];
const footPolygon = (ids = [22, 35, 34, 33]) => [{polyfill_id: 1, segment_ids: ids, color_rgb: [10, 35, 65], alpha_raw: 0, z_order: 0}];

// --------------------------------------------------------------- fixtures

const fixtures = {
  /** A pinned two-bone limb on a native timeline: the root moves, the ankle stays. */
  'two-bone-pinned': () => {
    const e = joint(open(documentOf([limb()])), 22);
    e.setNodeIK({enabled: true}); e.poseJoint(420, 190);
    nextKey(e, 6); whole(e).moveSelection(40, -24);
    return {document: e.serialize(), ticks: [0, 2, 3, 5, 6]};
  },
  /** Left and Right: two limbs of one figure with explicit, opposing sides. */
  'two-bone-sides': () => {
    const e = open(documentOf([limb(true)]));
    joint(e, 22); e.setNodeIK({enabled: true, bendDirection: 1}); e.poseJoint(410, 170);
    joint(e, 55); e.setNodeIK({enabled: true, bendDirection: -1}); e.poseJoint(210, 230);
    nextKey(e, 4); whole(e).moveSelection(-30, 36); whole(e).rotateSelection(.3);
    return {document: e.serialize(), ticks: [0, 1, 2, 4]};
  },
  /** Both: the target path passes through the folded limb and past full extension. */
  'two-bone-both': () => {
    const e = joint(open(documentOf([limb()])), 22);
    e.setNodeIK({enabled: true}); e.poseJoint(360, 150);
    nextKey(e, 8); whole(e).moveSelection(120, 0);
    nextKey(e, 4); whole(e).moveSelection(150, 40);
    return {document: e.serialize(), ticks: [0, 3, 4, 5, 8, 10, 12]};
  },
  /** Both at an exactly folded limb of equal bones: the target sits on the hip. */
  'two-bone-folded': () => {
    const e = joint(open(documentOf([limb()])), 22);
    e.setNodeIK({enabled: true}); e.poseJoint(360, 150); e.poseJoint(300, 150);
    nextKey(e, 4); whole(e).moveSelection(0, .0001);
    nextKey(e, 4); whole(e).moveSelection(-30, 12);
    return {document: e.serialize(), ticks: [0, 2, 4, 6, 8]};
  },
  /** One bone: the target turns it and, with stretch, lengthens it. */
  'one-bone': () => {
    const e = joint(open(documentOf([limb()])), 11);
    e.setNodeIK({enabled: true, chainLength: 1, allowStretch: true});
    nextKey(e, 4); whole(e).moveSelection(-35, -20);
    return {document: e.serialize(), ticks: [0, 2, 4]};
  },
  /** An enabled controller that is not pinned leaves the pose as authored. */
  'unpinned': () => {
    const e = joint(open(documentOf([limb()])), 22);
    e.setNodeIK({enabled: true}); e.poseJoint(400, 210); e.setNodeIK({pinned: false});
    nextKey(e, 4); whole(e).moveSelection(40, -24);
    return {document: e.serialize(), ticks: [0, 2, 4]};
  },
  /** Chains longer than two bones solve by FABRIK: Both continues its shape, Right keeps its side. */
  'chain-long': () => {
    const chain = [[1, 0, 60, .3], [2, 1, 55, .9], [3, 2, 50, 1.4], [4, 3, 45, 1.9], [5, 4, 20, 0]];
    const e = open(documentOf([chain, chain], i => [200 + i * 320, 120]));
    joint(e, 4, 1); e.setNodeIK({enabled: true, chainLength: 4}); e.poseJoint(300, 250);
    joint(e, 4, 2); e.setNodeIK({enabled: true, chainLength: 4, bendDirection: 1}); e.poseJoint(560, 270);
    nextKey(e, 6); whole(e, 1).moveSelection(50, 30); whole(e, 2).moveSelection(-40, 20);
    nextKey(e, 3); whole(e, 1).moveSelection(-120, -10); whole(e, 2).moveSelection(90, -60);
    return {document: e.serialize(), ticks: [2, 6, 8]};
  },
  /** A perfectly straight chain pulled inward: the solver seeds a bend on the chosen side. */
  'chain-straight': () => {
    const e = open(documentOf([[[1, 0, 60, .4], [2, 1, 55, .4], [3, 2, 50, .4], [4, 3, 20, 1.2]]], () => [200, 120]));
    joint(e, 3); e.setNodeIK({enabled: true, chainLength: 3, bendDirection: 1});
    nextKey(e, 4); whole(e).moveSelection(40, 17);
    return {document: e.serialize(), ticks: [0, 2, 4]};
  },
  /** Curved bones at a scale: the solver works on each bone's chord. */
  'bent': () => {
    const e = open(documentOf([limb()]));
    joint(e, 11); const knee = e.geometry.objects.get(0).joints.get(11); e.bendJoint(knee.x / 2 + 150 - 14, knee.y / 2 + 75 + 9);
    whole(e).scaleSelection(1.3);
    joint(e, 22); e.setNodeIK({enabled: true, bendDirection: -1}); e.poseJoint(430, 260);
    nextKey(e, 4); whole(e).moveSelection(-24, 18);
    return {document: e.serialize(), ticks: [0, 1, 3, 4]};
  },
  /** A target out of reach: one limb stretches to it, the other stops at its reach. */
  'stretch': () => {
    const e = open(documentOf([limb(), limb()], i => [250 + i * 300, 150]));
    joint(e, 22, 1); e.setNodeIK({enabled: true, allowStretch: true}); e.poseJoint(380, 260);
    joint(e, 22, 2); e.setNodeIK({enabled: true, allowStretch: false}); e.poseJoint(680, 260);
    nextKey(e, 5);
    for (const uid of [1, 2]) whole(e, uid).moveSelection(-90, -120);
    return {document: e.serialize(), ticks: [0, 1, 3, 5]};
  },
  /** Followers: the foot keeps the target's orientation (which turns between
   * the keys); static shin artwork and the thigh's attachment follow their bones. */
  'followers': () => {
    const document = documentOf([footed()]);
    document.figure_types[0].polyfills = footPolygon();
    const e = joint(open(document), 22);
    e.setNodeIK({enabled: true}); e.poseJoint(365, 265);
    nextKey(e, 5); whole(e).moveSelection(18, -14);
    joint(e, 22); e.rotateIKTarget(.4);
    return {document: e.serialize(), ticks: [0, 2, 4, 5]};
  },
  /** A chain that crosses a join: thigh, shin and foot are separate figures. */
  'joined': () => {
    const document = documentOf([
      [[11, 0, 90, .8], [12, 11, 20, .3, fixed]],
      [[22, 0, 90, 2], [24, 22, 18, 1.1, fixed]],
      [[33, 0, 35, 0], [34, 33, 10, .2, fixed], [35, 0, 25, 1.5, fixed]],
      [[41, 0, 16, 1.1, fixed]],
    ]);
    document.figure_types[2].polyfills = footPolygon([0, 35, 34, 33]);
    const objects = document.keyframes[0].objects;
    for (const [slot, parent, handle] of [[1, 0, 11], [2, 1, 22], [3, 1, 22]])
      objects[slot].join = {target_object_slot: parent, target_unique_id: parent + 1, target_handle_id: handle};
    const e = open(document); e.select(2, 0);
    e.setNodeIK({enabled: true}); e.poseJoint(365, 265);
    nextKey(e, 5); whole(e, 1).moveSelection(22, -16);
    e.select(2, 0); e.rotateIKTarget(-.3);
    return {document: e.serialize(), ticks: [0, 2, 3, 5]};
  },
  /** Stretch across a join between figures of different scale. */
  'joined-stretch': () => {
    const document = documentOf([[[11, 0, 90, .8]], [[22, 0, 60, 2], [33, 22, 20, 0]]]);
    const objects = document.keyframes[0].objects;
    objects[1].scale = 1.5; objects[1].join = {target_object_slot: 0, target_unique_id: 1, target_handle_id: 11};
    const e = open(document); e.select(2, 0);
    e.setNodeIK({enabled: true, allowStretch: true}); e.poseJoint(380, 260);
    nextKey(e, 4); whole(e, 1).moveSelection(-70, -90);
    return {document: e.serialize(), ticks: [0, 1, 2, 4]};
  },
  /** IK through rig relationships: the bones follow stretch drivers, so the
   * solver corrects authored angles until the rendered endpoint reaches the target. */
  'rig-follow': () => {
    const {e, b} = projected(70, 80);
    e.setNodeIK({enabled: true});
    const p = e.geometry.objects.get(0).joints.get(b); e.poseIKTarget(p.x - 10, p.y + 8);
    nextKey(e, 4); whole(e).moveSelection(14, -9);
    return {document: e.serialize(), ticks: [0, 1, 3, 4]};
  },
  /** The same rig seen edge-on: the upper bone's driver has collapsed its
   * projected axis, so one coordinate of the target cannot be inverted. */
  'rig-edge-on': () => {
    const {e, b} = projected(50, 90);
    e.setNodeIK({enabled: true});
    const p = e.geometry.objects.get(0).joints.get(b); e.poseIKTarget(p.x - 6, p.y + 9);
    nextKey(e, 4); whole(e).moveSelection(8, -5);
    return {document: e.serialize(), ticks: [0, 2, 4]};
  },
  /** A stretched branch whose bones follow it automatically (the rig of the
   * pinned leg in the corpus): a pinned two-bone chain below a stretch driver. */
  'rig-stretch': () => {
    const document = documentOf([[
      [1, 0, 46, 1.96, {_stykRig: {stretch: {restLength: 46, min: 0, max: 10, width: 'keep', branch: true}}}],
      [2, 1, 42, 1.65, {_stykRig: {follow: {driver: 1, mode: 'stretch', influence: 1, automatic: true}}}],
      [3, 2, 8, 3.1, {_stykRig: {follow: {driver: 1, mode: 'stretch', influence: 1, automatic: true}}}],
      [4, 2, 30, -1.3, {...fixed, _stykRig: {follow: {driver: 1, mode: 'stretch', influence: 1, automatic: true}}}],
    ]]);
    const e = joint(open(document), 1);
    const tip = e.geometry.objects.get(0).joints.get(1); e.poseJoint(tip.x - 8, tip.y + 14, {stretch: true});
    joint(e, 2); e.setNodeIK({enabled: true});
    const p = e.geometry.objects.get(0).joints.get(2); e.poseIKTarget(p.x + 6, p.y - 5);
    nextKey(e, 4); whole(e).moveSelection(9, -7);
    return {document: e.serialize(), ticks: [0, 1, 2, 4]};
  },
  /** A chain across a join between two rigged figures of different scale: each
   * bone follows a stretch driver of its own figure. */
  'rig-joined': () => {
    const stretch = {restLength: 100, min: 0, max: 1, width: 'keep'};
    const follow = driver => ({orientation: 'world', follow: {driver, mode: 'stretch', influence: 1}, response: {mode: 'stretch', multiplier: 2}});
    const figure = (id, name, projection, length, angle) => {
      const q = construction(); q.add(0, 0, 0, 'Rotation');
      const driver = q.add(0, projection, 0, `${name} projection`, {rig: {stretch}}), bone = q.add(0, length, angle, `${name} bone`, {control: true, rig: follow(driver)});
      return {figure: {figure_type_id: id, name, segments: q.segments, polyfills: [], image_assets: [], text_assets: []}, bone};
    };
    const upper = figure(1, 'Upper', 70, 100, .6), lower = figure(2, 'Lower', 80, 85, -.7);
    const child = createObject(lower.figure, 2, 0, 0); child.scale = .8;
    child.join = {target_object_slot: 0, target_unique_id: 1, target_handle_id: upper.bone};
    const document = {...emptyDocument(), figure_types: [upper.figure, lower.figure], keyframes: [createFrame([createObject(upper.figure, 1, 250, 200), child], 1)]};
    const e = open(document); e.select(2, lower.bone - 1);
    e.setNodeIK({enabled: true, chainLength: 2});
    const p = e.geometry.objects.get(1).joints.get(lower.bone); e.poseIKTarget(p.x - 9, p.y + 12);
    nextKey(e, 4); whole(e, 1).moveSelection(11, -8);
    return {document: e.serialize(), ticks: [0, 2, 4]};
  },
  /** A spatial (3D) leg: depth, pole and swivel beside the 2D target, and a
   * foot that keeps its orientation while the hip moves and the body turns. */
  'spatial': () => {
    const {e, body, lower, foot, toe} = spatialLeg();
    e.select(1, foot - 1); e.setSpatialPose({turn: .4, pitch: -.25, bend: .1}); e.select(1, toe - 1); e.setSpatialPose({pitch: .2});
    e.select(1, lower - 1); e.setNodeIK({enabled: true, pinned: true, bendDirection: 0, chainLength: 2});
    e.poseIKTarget(215, 245);
    nextKey(e, 4); whole(e).moveSelection(18, 20); e.select(1, body - 1); e.setSpatialPose({turn: .9, pitch: .25, bend: .2});
    return {document: e.serialize(), ticks: [0, 1, 3, 4]};
  },
  /** The spatial leg on a mirrored figure. */
  'spatial-mirrored': () => {
    const {e, body, lower, foot} = spatialLeg();
    whole(e).mirrorFigure();
    e.select(1, foot - 1); e.setSpatialPose({turn: .4, pitch: -.25, bend: .1});
    e.select(1, lower - 1); e.setNodeIK({enabled: true, pinned: true, bendDirection: 0, chainLength: 2});
    e.poseIKTarget(185, 245);
    nextKey(e, 4); whole(e).moveSelection(-18, 20); e.select(1, body - 1); e.setSpatialPose({turn: .9, pitch: .25, bend: .2});
    return {document: e.serialize(), ticks: [0, 2, 4]};
  },
  /** A spatial leg with an explicit side: no 3D target, the projection solver
   * turns the bones' bend, turn and tilt channels. */
  'spatial-side': () => {
    const {e, lower} = spatialLeg();
    e.select(1, lower - 1); e.setNodeIK({enabled: true, pinned: true, bendDirection: 1});
    nextKey(e, 4); whole(e).moveSelection(-12, -16);
    return {document: e.serialize(), ticks: [0, 2, 4]};
  },
  /** A layer-sheet pose track: three keys with linear, Auto and eased spans;
   * the target moves and turns between them. */
  'layer-sheet': () => {
    const e = joint(open(documentOf([limb()]), {layerTimeline: true}), 22), layer = e.layerForUid(1);
    e.setNodeIK({enabled: true}); e.poseJoint(365, 265);
    nextSheetKey(e, 4); whole(e).moveSelection(30, -18);
    nextSheetKey(e, 9); joint(e, 22); e.poseIKTarget(340, 250); e.rotateIKTarget(.5); whole(e).moveSelection(-20, 10);
    nextSheetKey(e, 12); whole(e).moveSelection(-25, -12);
    e.sheetSetEasing([layer], 0, 0, {interpolation: 'linear'});
    e.sheetSetEasing([layer], 4, 4, {interpolation: 'auto'});
    e.sheetSetEasing([layer], 9, 9, {interpolation: 'ease-in'});
    return {document: e.serialize(), ticks: [0, 2, 4, 6, 8, 9, 11, 12]};
  },
  /** A native timeline with Pivot's own easing between four keys. */
  'native-easing': () => {
    const document = documentOf([limb()]); document.auto_easing = true; delete document.auto_easing_disabled_raw;
    const e = joint(open(document), 22);
    e.setNodeIK({enabled: true}); e.poseJoint(400, 215);
    nextKey(e, 4); whole(e).moveSelection(30, -10); joint(e, 22); e.poseIKTarget(410, 230);
    nextKey(e, 4); whole(e).moveSelection(25, 20); joint(e, 22); e.rotateIKTarget(.6);
    nextKey(e, 4); whole(e).moveSelection(-40, 15); joint(e, 22); e.poseIKTarget(380, 240);
    return {document: e.serialize(), ticks: [0, 1, 3, 5, 6, 9, 11, 12]};
  },
  /** IK inside a movieclip: the clip's own timeline holds the pinned limb. The
   * editor captures the clip; its instance is placed in a plain native pose,
   * because the editor's own placement (movieclip patches on a layer sheet,
   * pose channels on a native timeline) is not evaluated by the engine yet. */
  'movieclip': () => {
    const e = joint(open(documentOf([limb()])), 22);
    e.setNodeIK({enabled: true}); e.poseJoint(420, 190);
    nextKey(e, 5); whole(e).moveSelection(40, -24);
    e.seek(0); e.select(1);
    const clip = e.createMovieclip({start: 0, end: 6, replace: false});
    const instance = (x, y, angle, scale) => createObject(clip, 7, x, y, {angles: [angle], scale, _stykMovieclip: {start: 0, end: 9, offset: 1, speed: 1, mode: 'loop'}});
    const document = {...emptyDocument(), figure_types: [clip],
      keyframes: [createFrame([instance(480, 270, 0, 1)], 8), createFrame([instance(520, 250, .5, 1.3)], 1)]};
    return {document: open(document).serialize(), ticks: [0, 3, 5, 8]};
  },
  /** Written by hand: tables older builds saved. Partial followers (only one
   * outgoing branch captured) and explicit attachment offsets, which the
   * editor still evaluates but no longer writes. */
  'legacy-tables': () => {
    const document = documentOf([footed()]); document.figure_types[0].polyfills = footPolygon();
    const object = document.keyframes[0].objects[0];
    object._stykIK = {22: {enabled: true, pinned: true, allowStretch: false, chainLength: 2, bendDirection: 1,
      target: {x: 372, y: 258, rotation: .25}, followers: {33: -.1, 41: .7}, attachmentOffsets: {23: .3, 41: -.5}}};
    const moved = structuredClone(document.keyframes[0]); moved.objects[0].root_x += 20; moved.objects[0].root_y -= 15;
    moved.objects[0]._stykIK[22].target.rotation = -.2;
    document.keyframes[0].duration_raw = 4; document.keyframes.push(moved);
    return {document: open(document).serialize(), ticks: [0, 2, 4]};
  },
  /** Written by hand: two controllers that share a bone, which the editor's
   * commands refuse. Evaluation solves the chain nearer the root and leaves
   * the other as posed. */
  'conflict': () => {
    const document = documentOf([limb()], () => [260, 150]);
    const target = (x, y) => ({enabled: true, pinned: true, allowStretch: false, chainLength: 2, bendDirection: 1, target: {x, y, rotation: 0}, followers: {}});
    document.keyframes[0].objects[0]._stykIK = {33: target(330, 300), 22: target(360, 250)};
    const moved = structuredClone(document.keyframes[0]); for (const object of moved.objects) { object.root_x -= 25; object.root_y += 10; }
    document.keyframes[0].duration_raw = 4; document.keyframes.push(moved);
    return {document: open(document).serialize(), ticks: [0, 2, 4]};
  },
  /** The start-up document: Blue, four two-bone controllers, none pinned. */
  'startup': () => ({document: createStartupDocument(), ticks: [0, 9]}),
  /** Blue with its hands and feet pinned while the body moves and leans. */
  'startup-pinned': () => {
    const e = new Editor({demo: false, layerTimeline: true}).load(createStartupDocument());
    for (const handle of Object.keys(e.frame.objects[0]._stykIK).map(Number)) { joint(e, handle, 1); e.setNodeIK({pinned: true}); }
    nextSheetKey(e, 6); whole(e).moveSelection(26, 34); whole(e).rotateSelection(-.2);
    e.sheetSetEasing([e.layerForUid(1)], 0, 6, {interpolation: 'auto'});
    return {document: e.serialize(), ticks: [0, 3, 6]};
  },
};

/** The projected limb of tests/ik-rig.test.mjs: two bones that follow stretch
 * drivers (`upper` and `lower` are the drivers' lengths, 100 at rest) and hang
 * from a weighted attachment. The editor has the lower bone selected. */
function projected(upper, lower) {
  const q = construction(); q.add(0, 0, 0, 'Rotation');
  const stretch = {restLength: 100, min: 0, max: 1, width: 'keep'};
  const first = q.add(0, upper, 0, 'Upper projection', {rig: {stretch}}), second = q.add(0, lower, 0, 'Lower projection', {rig: {stretch}});
  const anchor = q.add(0, 40, -Math.PI / 2, 'Body'), base = q.add(0, 0, 0, 'Attachment', {rig: {weighted: {origin: 0, anchors: [{joint: anchor, weight: .8}]}}});
  const follow = driver => ({orientation: 'world', follow: {driver, mode: 'stretch', influence: 1}, response: {mode: 'stretch', multiplier: 2}});
  const a = q.add(base, 100, .6, 'Upper bone', {control: true, rig: follow(first)}), b = q.add(a, 85, -.7, 'Lower bone', {control: true, rig: follow(second)});
  const figure = {figure_type_id: 1, name: 'Projected', segments: q.segments, polyfills: [], image_assets: [], text_assets: []};
  const e = open({...emptyDocument(), figure_types: [figure], keyframes: [createFrame([createObject(figure, 1, 250, 200)], 1)]});
  e.select(1, b - 1);
  return {e, a, b};
}

function spatialLeg() {
  const q = construction(); q.add(0, 0, 0, 'Figure rotation');
  const bone = (parent, origin, tip, name) => {
    const turn = q.add(0, 0, 0, name + ' turn'), pitch = q.add(0, 0, 0, name + ' tilt'), v = tip.map((n, i) => n - origin[i]);
    return q.add(parent, Math.hypot(...v), Math.atan2(v[1], v[0]), name, {control: true, rig: {spatial: {parent, origin, tip, turn, pitch}}});
  };
  const body = bone(0, [0, 0, 0], [0, 0, 0], 'Body'), upper = bone(body, [0, 0, 0], [0, 90, 15], 'Thigh'), lower = bone(upper, [0, 90, 15], [0, 170, 0], 'Shin'),
    foot = bone(lower, [0, 170, 0], [0, 185, 35], 'Foot'), toe = bone(foot, [0, 185, 35], [0, 185, 50], 'Toe');
  const figure = {figure_type_id: 1, name: 'Leg', segments: q.segments, polyfills: [], image_assets: [], text_assets: []};
  const e = open({...emptyDocument(), figure_types: [figure], keyframes: [createFrame([createObject(figure, 1, 200, 100)], 1)]});
  return {e, body, upper, lower, foot, toe};
}

// ---------------------------------------------------------- solver vectors

/** Inputs and outputs of the pure functions, for cases no document reaches
 * reliably: degenerate lengths, exact folds, collinear chains, every side. */
function vectors() {
  let seed = 20261002;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const round = v => Math.round(v * 1000) / 1000, between = (a, b) => round(a + (b - a) * random());
  const solve = [];
  const add = (points, lengths, target, bendDirection, bendReference) => {
    const solved = points.map(p => ({x: p[0], y: p[1]}));
    const result = solveIKPoints(solved, lengths, {x: target[0], y: target[1]}, bendDirection, {bendReference});
    solve.push({points, lengths, target, bendDirection, ...(bendReference ? {bendReference} : {}), result: {...result, points: solved.map(p => [p.x, p.y])}});
  };
  const chain = (lengths, angles, base = [between(-50, 50), between(-50, 50)]) => {
    const points = [base];
    lengths.forEach((length, i) => points.push([round(points[i][0] + Math.cos(angles[i]) * length), round(points[i][1] + Math.sin(angles[i]) * length)]));
    return points;
  };
  for (let i = 0; i < 12; i++) {
    const n = 1 + (i % 5), lengths = Array.from({length: n}, () => between(8, 60)), angles = Array.from({length: n}, () => between(-3, 3));
    const points = chain(lengths, angles), reach = lengths.reduce((a, b) => a + b, 0), far = i % 6 === 5 ? 1.4 : between(.05, .95), direction = between(-3, 3);
    const target = [round(points[0][0] + Math.cos(direction) * reach * far), round(points[0][1] + Math.sin(direction) * reach * far)];
    const side = [1, -1, 0][i % 3];
    const reference = side === 0 && i % 2 ? {side: i % 4 === 1 ? 1 : -1, angle: between(-3, 3), axis: between(-3, 3), ratio: between(0, 1),
      ...(n > 2 && i % 4 === 3 ? {shape: Array.from({length: n}, () => between(-3, 3))} : {})} : undefined;
    add(points, lengths, target, side, reference);
  }
  // Equal bones folded onto the base, with and without a reference.
  add([[0, 0], [30, 0], [0, 0]], [30, 30], [0, 0], 0);
  add([[10, 5], [40, 5], [10, 5]], [30, 30], [10, 5], 0, {side: -1, angle: .7, axis: 1.1, ratio: .4});
  add([[10, 5], [40, 5], [10, 5]], [30, 30], [10, 5], 0, {side: 1, angle: .7, axis: 1.1, ratio: 0});
  // Near extension and through the fold: Both may change sides.
  add([[0, 0], [28, 10], [59, 2]], [30, 32], [61.9, 0], 0, {side: 1, angle: .3, axis: 0, ratio: .97});
  add([[0, 0], [28, 10], [59, 2]], [30, 32], [-3, .4], 0, {side: -1, angle: 2.6, axis: 0, ratio: .06});
  // A straight chain pulled inward, on each explicit side and on Both.
  for (const side of [1, -1, 0]) add([[0, 0], [20, 0], [45, 0], [75, 0]], [20, 25, 30], [40, 12], side);
  // The same chain pulled along its own axis: collinear, so a bend is seeded.
  for (const side of [1, -1]) add([[0, 0], [20, 0], [45, 0], [75, 0]], [20, 25, 30], [40, 0], side);
  // Zero lengths: an empty chain, a collapsed bone, a collapsed chain.
  add([[3, 4]], [], [9, 9], 1);
  add([[0, 0], [0, 0], [25, 0]], [0, 25], [10, 15], -1);
  add([[0, 0], [0, 0], [0, 0]], [0, 0], [5, 5], 0);
  // Already on target: nothing to do.
  add([[0, 0], [20, 0], [20, 25], [50, 25]], [20, 25, 30], [50, 25], 0);
  add([[0, 0], [20, 0], [20, 25], [50, 25]], [20, 25, 30], [50, 25], -1);

  const controller = (x, rotation, extra = {}) => ({enabled: true, pinned: true, allowStretch: false, chainLength: 2, bendDirection: 0,
    target: {x, y: 20, rotation}, followers: {7: .2, 9: 3}, ...extra});
  const q = (bend, turn) => { const h = bend / 2, k = turn / 2; return [-Math.cos(h) * 0 - Math.sin(k) * Math.sin(h), Math.sin(k) * Math.cos(h), Math.cos(k) * Math.sin(h), Math.cos(k) * Math.cos(h)]; };
  const unit = v => { const n = Math.hypot(...v); return v.map(x => x / n); };
  const pairs = [
    [{5: controller(10, 3)}, {5: controller(30, -3, {followers: {7: -3, 9: 3.1, 11: 1}})}],
    [{5: controller(10, 0)}, {5: controller(30, 1, {pinned: false})}],
    [{5: controller(10, 0), 8: controller(1, 1)}, {5: controller(30, 1, {enabled: false})}],
    [{5: controller(10, .5, {joinedFollowers: {2: {4: 3, 6: 1}}, bendReference: {side: 1, angle: 0, axis: 0, ratio: .5, shape: [3, -3, .5]}})},
      {5: controller(-4, 1.5, {joinedFollowers: {2: {4: -3}}, bendReference: {side: 1, angle: 0, axis: 0, ratio: .5, shape: [-3, 3, 1]}})}],
    [{5: controller(10, 0, {spatialFollowers: {6: q(.3, .2), 7: q(1, -1)}, joinedSpatialFollowers: {3: {2: q(0, 0)}},
        spatialTarget: {depth: 10, pole: unit([0, .3, 1]), swivel: 3, normals: [unit([1, 0, 0]), unit([1, .2, 0])]}})},
      {5: controller(20, 1, {spatialFollowers: {6: q(2.9, -1.2)}, joinedSpatialFollowers: {3: {2: q(3.1, .1)}},
        spatialTarget: {depth: -30, pole: unit([1, 0, .2]), swivel: -3, normals: [unit([0, 1, 0]), unit([0, .2, 1])]}})}],
  ];
  const interpolate = pairs.flatMap(([a, b]) => [.25, .8].map(t => ({a, b, t, result: interpolateIK({_stykIK: a}, {_stykIK: b}, t)})));
  return {solve, interpolate};
}

// ------------------------------------------------------------------- main

const args = process.argv.slice(2);
if (args.includes('--list')) { console.log([...Object.keys(fixtures), 'vectors'].join('\n')); process.exit(0); }
const outAt = args.indexOf('--out');
const out = path.resolve(outAt < 0 ? `${here}/../crates/styk-eval/tests/fixtures/ik` : args[outAt + 1]);
const names = args.filter((a, i) => !a.startsWith('--') && (outAt < 0 || i !== outAt + 1));
for (const name of names) if (!fixtures[name] && name !== 'vectors') { console.error(`unknown fixture ${name}`); process.exit(2); }
mkdirSync(out, {recursive: true});
if (!names.length || names.includes('vectors')) {
  const cases = vectors();
  writeFileSync(`${out}/vectors.json`, JSON.stringify(cases) + '\n');
  console.log(`vectors: ${cases.solve.length} point solves, ${cases.interpolate.length} interpolations, ${(JSON.stringify(cases).length / 1024).toFixed(1)} KiB`);
}
for (const name of (names.length ? names : Object.keys(fixtures)).filter(name => name !== 'vectors')) {
  const built = fixtures[name](), written = writeProject(out, name, built.document, built.ticks), {file, dump} = written;
  // What the solver derived, unrounded (the dump above rounds positions to
  // 1e-6): the angles and stretched lengths of every object a pinned
  // controller reaches, and each controller's outcome. Same editor
  // configuration as tools/reference.mjs.
  const editor = new Editor({demo: false, propertyChannels: true, layerTimeline: true});
  editor.load(JSON.parse(readFileSync(file, 'utf8')), `${name}.json`);
  for (const frame of dump.frames) {
    editor.seek(frame.tick);
    frame.ik = [...editor.geometry.objects].filter(([, g]) => g?.solvedAngles).map(([slot, g]) => ({slot, uid: g.obj.unique_id,
      angles: [...g.solvedAngles], lengths: g.solvedLengths ? [...g.solvedLengths] : null,
      controllers: [...g.ik].map(([handle, r]) => ({handle, conflict: Boolean(r.conflict), iterations: r.iterations ?? 0, error: r.error ?? 0, stretch: r.stretch ?? 1}))}));
  }
  writeReference(written, name);
}
