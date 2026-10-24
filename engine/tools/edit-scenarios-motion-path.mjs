// Command-replay scenarios of motion-path edits on a layer sheet (docs/engine/editing.md): a
// trail point dragged at a tick other than the playhead (`beginMotionPathEdit`,
// `updateMotionPathEdit`, `commitMotionPathEdit`, `cancelMotionPathEdit`), and with a falloff of
// each shape reshaping the target's keys nearby (`setMotionPathFalloff`, `motionPathFalloff`):
// figures' origins and joints, joined figures, IK targets pinned and free, two layers, a
// movieclip, the camera; refusals and history. Run by engine/tools/edit-scenarios.mjs.
import {fileURLToPath} from 'node:url';
import {readFileSync, writeFileSync} from 'node:fs';
import {documentOf, limb, open, nextKey, prune} from './fixture-kit.mjs';
import {falloffWeight, MOTION_PATH_FALLOFF_SHAPES} from '../../src/motion-path-falloff.mjs';

const out = fileURLToPath(new URL('../tests/edit', import.meta.url));
const app = {layerTimeline: true, propertyChannels: true};
const scenario = (name, editor, steps, document) => writeFileSync(`${out}/${name}.scenario.json`, JSON.stringify({name, document, editor, steps}, null, 1) + '\n');
const mirror = editor => JSON.stringify(editor.report, (key, value) => key === 'runtime_segments' ? undefined : value) + '\n';
/** A trail: a figure's joint (`handleId` 0 and `joint` -1: its origin) or the camera. */
const node = (uid, handleId = 0, joint = -1) => ({kind: 'node', uid, handleId, joint});
const camera = {kind: 'camera'};
const begin = (target, tick, options) => ['beginMotionPathEdit', target, tick, ...(options ? [options] : [])];
const to = (x, y, options) => ['updateMotionPathEdit', {x, y}, ...(options ? [options] : [])];
const commit = ['commitMotionPathEdit'], cancel = ['cancelMotionPathEdit'], falloffView = ['motionPathFalloff'];

// Every weight a falloff can give (each shape, radius and distance), as the digest of their
// bits: styk-edit's `falloff_weights` test computes the same (the sharp shape's cube is V8's
// own `pow`, which engine/tools/v8-pin.mjs selects, not the correctly rounded cube).
{
  const view = new DataView(new ArrayBuffer(8));
  let digest = 0xcbf29ce484222325n, count = 0;
  for (const shape of MOTION_PATH_FALLOFF_SHAPES) for (let radius = 1; radius <= 240; radius++) for (let distance = 0; distance <= radius + 1; distance++) {
    view.setFloat64(0, falloffWeight(distance, radius, shape), true);
    for (let i = 0; i < 8; i++) digest = ((digest ^ BigInt(view.getUint8(i))) * 0x100000001b3n) & 0xffffffffffffffffn;
    count++;
  }
  writeFileSync(`${out}/motion-path-falloff.weights.json`, JSON.stringify({count, digest: digest.toString(16).padStart(16, '0')}) + '\n');
}

// Two legs with a static toe (figure 1), a leg hanging from its foot (figure 2) and a figure
// whose second segment bends a full turn (figure 3), over six keys four ticks apart, as the app
// holds it on a layer sheet; the key at 8 is held.
{
  const fixed = {is_static: true, aux_code: 1};
  const document = documentOf([[...limb(true), [77, 33, 12, .4, fixed]], limb(), [[1, 0, 40, .3], [2, 1, 30, 1.1, {bend_rad: 2 * Math.PI}]]], i => [180 + i * 220, 150]);
  const e = open(document);
  e.select(2); e.joinTo(1, 33);
  for (const [dx, dy, turn] of [[30, 10, .2], [25, -15, -.3], [-20, 20, .25], [15, 5, -.2], [10, -10, .15]]) {
    nextKey(e, 4); e.select(1, -1); e.moveSelection(dx, dy); e.select(1, 1); e.rotateJoint(turn); e.select(3, -1); e.moveSelection(-dx, dy);
  }
  e.setFrameDuration(4);
  const layered = open(JSON.parse(JSON.stringify(prune(e.report), (key, value) => key === 'runtime_segments' ? undefined : value)), app);
  layered.sheetSetEasing(['layer-1'], 8, 8, {interpolation: 'constant'});
  layered.seek(0); layered.select(1);
  writeFileSync(`${out}/motion-path.document.json`, mirror(layered));
}

// One frame: an origin between keys and a joint on a key, stretched and isolated; a joined
// figure's origin (its parent's joint turns); cancelled and empty gestures; the frame on show
// (a committed gesture's draft); ended by commitDrag, cancelDrag, a seek, undo and another
// begin; refusals; history.
scenario('motion-path-sheet', app, [
  ['@select', 1, -1], falloffView, begin(node(1), 6), falloffView, to(260, 170), to(272, 182), commit, ['undo'], ['redo'],
  begin(node(1, 22, 1), 8), to(330, 300), to(340, 310, {stretch: true}), to(345, 305, {stretch: true}), commit,
  begin(node(1, 22, 1), 12, {label: 'Arc the shin'}), to(300, 320, {isolate: true}), commit,
  begin(node(2), 10), to(420, 330), commit,
  begin(node(2, 22, 1), 14), to(500, 350), to(505, 360), commit,
  begin(node(1, 55, 4), 18), to(250, 340), cancel, to(260, 350), commit, cancel,
  begin(node(1), 2), commit, begin(node(1), 3), to(214, 160), to(214, 160), commit,
  // The frame on show: after a gesture there its committed draft is the source.
  ['@seek', 4], ['@select', 1, 1], ['poseJoint', 300, 260], begin(node(1, 11, 0), 4), to(320, 250), commit,
  begin(node(1), 5), to(240, 170), ['commitDrag'], begin(node(1), 7), to(240, 175), ['cancelDrag'],
  begin(node(1, 44, 3), 9), to(220, 330), ['@seek', 1], begin(node(1, 22, 1), 11), to(260, 330), ['undo'],
  begin(node(1), 13), to(260, 175), begin(node(1, 22, 1), 15), to(270, 320), commit,
  // Refusals: ticks outside the animation or between frames, a figure or joint that is not there,
  // a static joint, a full-turn bend stretched.
  begin(node(1), -1), begin(node(1), 2.5), begin(node(1), 24), begin(node(1), 99), begin(node(1), '3'), begin(node(1), null),
  begin(node(99), 3), begin(node(1, 99, 1), 3), begin(node(1, 22, 2), 3), begin(node(1, 77, 6), 3),
  begin(node(3, 2, 1), 6), to(560, 260, {stretch: true}), to(565, 270), commit,
  ['updateMotionPathEdit', {x: 1, y: 2}], ['setMotionPathFalloff', {radius: 3}],
  begin(node(1), 3), ['updateMotionPathEdit', {x: 'a', y: 2}], ['updateMotionPathEdit', {x: 1, y: Infinity}], ['updateMotionPathEdit', {x: 1}], to(230, 165), commit,
  ['undo'], ['undo'], ['undo'], ['undo'], ['redo'], ['redo'],
], 'motion-path.document.json');

// Falloffs of each shape: the plan (`motionPathFalloff`), the grabbed frame and the keys inside
// the influence moved by weight, edge keys holding the original pose, a held key claimed once;
// on a joint; switched on, changed and off mid-gesture; the radius normalized; history.
scenario('motion-path-falloff-sheet', app, [
  ['@select', 1, -1],
  ...MOTION_PATH_FALLOFF_SHAPES.flatMap((shape, i) => [
    begin(node(1), 10, {falloff: {radius: 5 + i, shape}}), falloffView, to(250 + i * 10, 180), falloffView, to(262 + i * 10, 190 - i * 4), falloffView, commit,
  ]),
  ['undo'], ['undo'], ['redo'],
  begin(node(1, 22, 1), 6, {falloff: {radius: 8, shape: 'linear'}}), to(330, 320), to(320, 330, {stretch: true}), commit,
  begin(node(1, 55, 4), 13, {falloff: {radius: 3, shape: 'sharp'}}), to(210, 330, {isolate: true}), commit,
  begin(node(2), 9, {falloff: {radius: 4}}), to(430, 320), commit,
  begin(node(2, 22, 1), 16, {falloff: {radius: 30, shape: 'flat'}}), to(470, 330), commit,
  // Switched mid-gesture: on, its radius and shape changed, the same again, off.
  begin(node(1), 14), to(260, 160), ['setMotionPathFalloff', {radius: 4, shape: 'sharp'}], falloffView, ['setMotionPathFalloff', {radius: 4, shape: 'sharp'}],
  ['setMotionPathFalloff', {radius: 7, shape: 'smooth'}], to(266, 166), ['setMotionPathFalloff', null], falloffView, ['setMotionPathFalloff', {radius: 2}], commit,
  begin(node(1), 17, {falloff: {radius: 3}}), ['setMotionPathFalloff', {radius: 5, shape: 'linear'}], to(270, 150), commit,
  // Radii normalized: below one edits one frame, fractions round, the largest is 240, an unknown shape is smooth.
  begin(node(1), 11, {falloff: {radius: 0.4}}), falloffView, cancel, begin(node(1), 11, {falloff: {radius: 2.5, shape: 'bogus'}}), falloffView, cancel,
  begin(node(1), 11, {falloff: {radius: 1000}}), falloffView, to(240, 175), falloffView, commit, begin(node(1), 11, {falloff: {radius: true}}), falloffView, cancel,
  begin(node(1), 11, {falloff: null}), falloffView, cancel, begin(node(1), 1, {falloff: {radius: 2}, label: 'Reshape the step'}), to(205, 155), commit,
  // Nothing moved: a falloff that ends as it began.
  begin(node(1), 19, {falloff: {radius: 3}}), commit, begin(node(1), 19, {falloff: {radius: 3}}), to(1000, 1000), cancel,
  ['undo'], ['undo'], ['undo'], ['undo'], ['undo'], ['redo'],
], 'motion-path.document.json');
scenario('motion-path-autokey-sheet', {...app, autoKey: true}, [
  ['@select', 1, -1], begin(node(1), 10), to(250, 170), commit, begin(node(1, 22, 1), 9, {falloff: {radius: 4, shape: 'smooth'}}), to(320, 310), commit,
  ['undo'], ['undo'], ['redo'],
], 'motion-path.document.json');

// Two layers: figure 3 (joined to 2's shin) on its own layer, the first layer's first key held.
// Turning 2's shin moves 3: both layers are keyed, in one edit; with a falloff the held key is
// claimed by the strongest write.
scenario('motion-path-layers-sheet', app, [
  begin(node(2, 22, 1), 3), to(420, 330), commit, begin(node(3), 2), to(520, 300), commit,
  begin(node(1), 4, {falloff: {radius: 3, shape: 'linear'}}), falloffView, to(230, 190), commit,
  begin(node(2, 11, 0), 1, {falloff: {radius: 4, shape: 'smooth'}}), to(380, 260), falloffView, commit,
  begin(node(3, 22, 1), 5, {falloff: {radius: 2}}), to(560, 320), commit,
  ['undo'], ['undo'], ['undo'], ['redo'],
], 'sheet-layers.document.json');
// The second layer locked: figures joined to one on it are refused; the camera is not.
scenario('motion-path-locked-sheet', app, [
  begin(node(1), 3), begin(node(3, 22, 1), 3), begin(node(2), 3, {falloff: {radius: 3}}), begin(camera, 3), to(420, 300), commit, ['undo'],
], 'sheet-locked.document.json');

// A movieclip on a layer sheet: its instance is placed by the keys' replacements, which a trail
// edit of it captures again (the keys keep their poses); the figures beside it are keyed as usual.
scenario('motion-path-movieclip-sheet', app, [
  begin(node(4), 3), to(500, 200), to(510, 210), commit, begin(node(4), 0, {falloff: {radius: 4}}), to(470, 180), commit,
  begin(node(1), 3), to(230, 180), commit, ['undo'], ['undo'], ['undo'], ['redo'],
], 'sheet-movieclip-loose.document.json');

// The camera's trail: its keys of the camera track (a clip shaking it at 3).
scenario('motion-path-camera-sheet', app, [
  begin(camera, 3), to(420, 300), to(430, 310), commit, begin(camera, 6), to(380, 290), commit,
  begin(camera, 2, {falloff: {radius: 4, shape: 'smooth'}}), falloffView, to(400, 320), falloffView, commit,
  begin(camera, 5, {falloff: {radius: 2, shape: 'sharp'}}), to(390, 280), cancel,
  ['undo'], ['undo'], ['undo'], ['redo'],
], 'camera-chain.document.json');

// IK controllers. The document the app starts with: unpinned hands and feet, solved to the
// trail point and baked; an elbow turned; the figure moved; a falloff on a hand.
scenario('motion-path-ik-sheet', app, [
  ['@select', 1, -1], ['sheetInsertKey', ['layer-1'], 6], begin(node(1, 4, 3), 3), to(560, 260), to(570, 280), commit,
  begin(node(1, 3, 2), 8), to(560, 230), commit, begin(node(1, 10, 9), 4), to(470, 420), commit, begin(node(1), 5), to(500, 200), commit,
  begin(node(1, 6, 5), 2, {falloff: {radius: 4, shape: 'smooth'}}), to(420, 270), to(410, 280), commit,
  ['undo'], ['undo'], ['redo'],
], 'startup.document.json');
// Free limbs whose branches follow the target (a foot with static artwork and a polygon), and
// a three-bone chain on one side that stretches out of reach.
scenario('motion-path-ik-unpinned-sheet', app, [
  ['sheetSetDuration', 10], ['@select', 1, -1], begin(node(1, 22, 2), 4), to(250, 300), to(270, 320), commit,
  begin(node(2, 3, 2), 6), to(560, 260), to(700, 380), commit, begin(node(2, 3, 2), 2, {falloff: {radius: 5, shape: 'linear'}}), to(600, 320), commit,
  begin(node(1, 33, 5), 7), to(260, 360), commit, ['undo'], ['undo'], ['redo'],
], 'ik-unpinned.document.json');
// Pinned limbs: a pinned foot's target moves; a knee turned bakes the solution first; the figure
// moved leaves the targets, or carries them with `movePins`; a falloff remembers the bends.
scenario('motion-path-ik-pinned-sheet', app, [
  ['@select', 1, -1], ['sheetInsertKey', ['layer-1'], 6], begin(node(1, 8, 7), 3), to(500, 430), commit,
  begin(node(1, 7, 6), 2), to(520, 360), commit, begin(node(1, 2, 1), 7), to(560, 240), commit,
  begin(node(1), 4), to(510, 210), commit, begin(node(1), 8), to(520, 190, {movePins: true}), to(530, 195, {movePins: true}), commit,
  begin(node(1, 10, 9), 5, {falloff: {radius: 3, shape: 'linear'}}), to(450, 440), commit,
  begin(node(1, 9, 8), 1, {falloff: {radius: 6, shape: 'flat'}}), to(430, 380), commit,
  ['undo'], ['undo'], ['undo'], ['redo'],
], '../../crates/styk-eval/tests/fixtures/ik/startup-pinned.json');
// A pinned foot with followers: turning the shin above it turns its followers' offsets back
// (the target's orientation stays planted); turning a follower changes its offset.
scenario('motion-path-ik-followers-sheet', app, [
  ['@select', 1, -1], begin(node(1, 11, 0), 2), to(260, 300), commit, begin(node(1, 33, 5), 4), to(330, 420), commit, begin(node(1, 11, 0), 5), to(250, 310), commit,
  begin(node(1, 22, 2), 3, {falloff: {radius: 4}}), to(340, 380), commit, ['undo'], ['redo'],
], '../../crates/styk-eval/tests/fixtures/ik/followers.json');
// IK across joined figures: a shin's controller drives another figure's thigh, pinned and free.
scenario('motion-path-ik-joined-sheet', app, [
  ['@select', 2, -1], begin(node(2, 22, 0), 2), to(360, 300), commit, begin(node(1, 11, 0), 4), to(300, 300), commit,
  begin(node(3), 3), to(380, 330), commit, begin(node(2, 22, 0), 5, {falloff: {radius: 4}}), to(350, 310), commit, ['undo'], ['redo'],
], '../../crates/styk-eval/tests/fixtures/ik/joined.json');
scenario('motion-path-ik-joined-unpinned-sheet', app, [
  ['@select', 2, -1], begin(node(2, 22, 0), 2), to(350, 280), to(370, 300), commit, begin(node(2, 22, 0), 5, {falloff: {radius: 4, shape: 'sharp'}}), to(340, 300), commit,
  begin(node(1, 11, 0), 4), to(310, 290), commit, ['undo'], ['undo'], ['redo'],
], 'ik-joined-unpinned.document.json');
// Stick Nodes curves: a straight segment with a sagitta is drawn as a curve.
scenario('motion-path-sticknodes-sheet', app, [
  ['sheetSetDuration', 8], begin(node(1, 22, 1), 4), to(300, 300), commit, begin(node(1, 33, 2), 5, {falloff: {radius: 3}}), to(280, 330, {stretch: true}), commit, ['undo'],
], 'sticknodes.document.json');
