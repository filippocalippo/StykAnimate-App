/**
 * Adversarial tests for pose-topology synthesis and the stored IK controller table.
 *
 * The 2-bone analytic solver these tests once exercised (solveIKPoints/solveObjectIK) no longer exists in
 * JavaScript: the Rust engine solves stored IK controllers (styk-edit/styk-eval), and the interface only
 * validates and describes the table through src/ik.mjs. The solver's own edge cases belong in the Rust
 * suite; what can be checked here is the document contract the engine receives: finite geometry, stable
 * segment ids, and an IK table that passes validateIK(). The engine-owned drag/undo stress vectors moved to
 * tests/auto-rig.test.mjs, where they are gated on a built engine.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildFigureFromPoseLandmarks } from '../src/pose-topology.mjs';
import { createClaudeFigureData } from '../src/claude-figure-data.mjs';
import { createObject, createFrame } from '../src/demo.mjs';
import { hasPinnedIK, ikChain, validateIK } from '../src/ik.mjs';

// Standard 33-landmark T-pose generator.
function createStandardPose33(overrides = {}) {
  const landmarks = Array.from({ length: 33 }, (_, i) => {
    switch (i) {
      case 0: return { x: 0.50, y: 0.15, z: 0.0, visibility: 0.99 }; // Nose
      case 11: return { x: 0.42, y: 0.30, z: 0.0, visibility: 0.98 }; // Left Shoulder
      case 12: return { x: 0.58, y: 0.30, z: 0.0, visibility: 0.98 }; // Right Shoulder
      case 13: return { x: 0.35, y: 0.45, z: 0.0, visibility: 0.95 }; // Left Elbow
      case 14: return { x: 0.65, y: 0.45, z: 0.0, visibility: 0.95 }; // Right Elbow
      case 15: return { x: 0.28, y: 0.55, z: 0.0, visibility: 0.92 }; // Left Wrist
      case 16: return { x: 0.72, y: 0.55, z: 0.0, visibility: 0.92 }; // Right Wrist
      case 23: return { x: 0.45, y: 0.58, z: 0.0, visibility: 0.98 }; // Left Hip
      case 24: return { x: 0.55, y: 0.58, z: 0.0, visibility: 0.98 }; // Right Hip
      case 25: return { x: 0.44, y: 0.75, z: 0.0, visibility: 0.98 }; // Left Knee
      case 26: return { x: 0.56, y: 0.75, z: 0.0, visibility: 0.98 }; // Right Knee
      case 27: return { x: 0.43, y: 0.95, z: 0.0, visibility: 0.98 }; // Left Ankle
      case 28: return { x: 0.57, y: 0.95, z: 0.0, visibility: 0.98 }; // Right Ankle
      default: return { x: 0.5, y: 0.5, z: 0.0, visibility: 0.5 };
    }
  });
  for (const [index, point] of Object.entries(overrides)) {
    landmarks[Number(index)] = { ...landmarks[Number(index)], ...point };
  }
  return landmarks;
}

/** Wraps synthesized landmarks into the document shape the app imports, with the IK table the dialog builds. */
function riggedDocument(landmarks, options = {}) {
  const { figure, ikSetup, rootPosition } = buildFigureFromPoseLandmarks(landmarks, options);
  const _stykIK = {};
  for (const item of ikSetup) {
    _stykIK[String(item.segment_id)] = {
      enabled: item.enabled,
      pinned: item.pinned,
      allowStretch: false,
      chainLength: item.chainLength,
      bendDirection: item.bendDirection,
      target: { x: rootPosition.x, y: rootPosition.y, rotation: 0 },
      followers: {}
    };
  }
  const object = createObject(figure, 1, rootPosition.x, rootPosition.y, {
    angles: figure.segments.map(segment => segment.angle_rad),
    _stykIK
  });
  const document = {
    version: 5,
    canvas_width: 640,
    canvas_height: 460,
    fps: 24,
    figure_types: [figure],
    backgrounds: [],
    keyframes: [createFrame([object], 1)]
  };
  return { figure, object, document, ikSetup };
}

const finite = segment => Number.isFinite(segment.length) && Number.isFinite(segment.angle_rad);

describe('Vector 1: Degenerate and collinear skeletons stay finite', () => {
  it('1.1: a fully collapsed skeleton (all 33 landmarks coincident) keeps minimum lengths and unique ids', () => {
    const collapsed = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5 }));
    const { figure, document } = riggedDocument(collapsed);
    assert.equal(figure.segments.length, 10);
    assert.equal(new Set(figure.segments.map(segment => segment.segment_id)).size, 10);
    for (const segment of figure.segments) assert.ok(finite(segment), `segment ${segment.segment_id} is not finite`);
    assert.ok(figure.segments[0].length >= 10);
    assert.ok(figure.segments[7].length >= 12);
    assert.doesNotThrow(() => validateIK(document.keyframes[0].objects[0]));
  });

  it('1.2: perfectly vertical and perfectly horizontal skeletons do not divide by zero', () => {
    const vertical = createStandardPose33();
    for (const index of [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) vertical[index] = { ...vertical[index], x: 0.5 };
    const verticalFigure = buildFigureFromPoseLandmarks(vertical).figure;
    for (const segment of verticalFigure.segments) assert.ok(finite(segment));

    const horizontal = createStandardPose33();
    for (const index of [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) horizontal[index] = { ...horizontal[index], y: 0.5 };
    const horizontalFigure = buildFigureFromPoseLandmarks(horizontal).figure;
    for (const segment of horizontalFigure.segments) assert.ok(finite(segment));
  });

  it('1.3: a 180-degree inverted skeleton (head below the pelvis) still yields finite geometry', () => {
    const inverted = createStandardPose33({
      0: { x: 0.5, y: 0.95 },
      23: { x: 0.45, y: 0.5 }, 24: { x: 0.55, y: 0.5 },
      25: { x: 0.44, y: 0.3 }, 26: { x: 0.56, y: 0.3 },
      27: { x: 0.43, y: 0.1 }, 28: { x: 0.57, y: 0.1 }
    });
    const { figure } = riggedDocument(inverted);
    for (const segment of figure.segments) assert.ok(finite(segment));
    assert.ok(Math.abs(figure.segments[0].angle_rad) <= Math.PI);
  });
});

describe('Vector 2: Extreme coordinate values stay finite', () => {
  it('2.1: coordinates far outside [0, 1] and negative coordinates clamp to finite lengths', () => {
    for (const pose of [
      createStandardPose33({ 0: { x: 1e6, y: -1e6 }, 11: { x: -1e6, y: 1e6 } }),
      createStandardPose33({ 27: { x: -500, y: 900 }, 28: { x: 500, y: -900 } })
    ]) {
      const { figure } = riggedDocument(pose);
      for (const segment of figure.segments) {
        assert.ok(finite(segment));
        assert.ok(segment.length > 0 && Number.isFinite(segment.length));
      }
    }
  });

  it('2.2: an array with fewer than 17 landmarks is rejected as invalid input', () => {
    for (const invalid of [[], null, undefined, {}, 'pose', Array.from({ length: 16 }, () => ({ x: 0.5, y: 0.5 }))]) {
      assert.throws(() => buildFigureFromPoseLandmarks(invalid), TypeError);
    }
  });

  it('2.3: exactly 17 COCO landmarks are accepted; 18-32 also use COCO indexing', () => {
    const mediaPipe = createStandardPose33();
    const coco = [mediaPipe[0], mediaPipe[2], mediaPipe[5], mediaPipe[7], mediaPipe[8],
      mediaPipe[11], mediaPipe[12], mediaPipe[13], mediaPipe[14], mediaPipe[15], mediaPipe[16],
      mediaPipe[23], mediaPipe[24], mediaPipe[25], mediaPipe[26], mediaPipe[27], mediaPipe[28]];
    assert.equal(coco.length, 17);
    assert.equal(buildFigureFromPoseLandmarks(coco).figure.segments.length, 10);
    const extended = [...coco, ...Array.from({ length: 10 }, () => ({ x: 0.5, y: 0.5 }))];
    assert.equal(buildFigureFromPoseLandmarks(extended).figure.segments.length, 10);
  });
});

describe('Vector 3: The stored IK controller table is valid document data', () => {
  it('3.1: the synthesized table passes validateIK, with four 2-bone terminal controllers', () => {
    const { figure, document } = riggedDocument(createStandardPose33());
    const object = document.keyframes[0].objects[0];
    assert.doesNotThrow(() => validateIK(object));
    assert.deepEqual(Object.keys(object._stykIK).sort(), ['10', '4', '6', '8']);
    for (const controller of Object.values(object._stykIK)) {
      assert.equal(controller.chainLength, 2);
      assert.equal(controller.enabled, true);
      assert.equal(controller.pinned, false);
      assert.deepEqual(Object.keys(controller.followers), []);
    }
    // The terminal ids the controllers address close a two-bone chain back to the torso/root.
    const chains = { 4: [3, 4], 6: [5, 6], 8: [7, 8], 10: [9, 10] };
    for (const [terminal, ids] of Object.entries(chains)) {
      assert.deepEqual(ikChain(figure, Number(terminal), 2).map(index => figure.segments[index].segment_id), ids);
    }
  });

  it('3.2: validateIK rejects every malformed controller field the engine would trust', () => {
    const base = () => riggedDocument(createStandardPose33()).document.keyframes[0].objects[0];
    const reject = mutate => {
      const object = structuredClone(base());
      mutate(object._stykIK['4']);
      assert.throws(() => validateIK(object), error => typeof error.messageKey === 'string' && error.messageKey.startsWith('errors.ik.'));
    };
    reject(controller => { controller.chainLength = 0; });
    reject(controller => { controller.bendDirection = 2; });
    reject(controller => { controller.target.x = Infinity; });
    reject(controller => { controller.followers = []; });
    reject(controller => { controller.enabled = 'yes'; });
  });

  it('3.3: pinned controllers are detectable and do not change table validity', () => {
    const { document } = riggedDocument(createStandardPose33());
    const object = document.keyframes[0].objects[0];
    assert.equal(hasPinnedIK(object), false);
    object._stykIK['4'].pinned = true;
    assert.equal(hasPinnedIK(object), true);
    assert.doesNotThrow(() => validateIK(object));
  });

  it('3.4: the Claude mascot rig has seven segments and four valid IK legs', () => {
    const { figure, object } = createClaudeFigureData();
    assert.equal(figure.segments.length, 7);
    assert.equal(Object.keys(object._stykIK).length, 4);
    assert.deepEqual(Object.keys(object._stykIK).sort(), ['4', '5', '6', '7']);
    assert.doesNotThrow(() => validateIK(object));
    assert.equal(figure.segments.every(segment => Number.isFinite(segment.length) && Number.isFinite(segment.angle_rad)), true);
  });
});
