import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildFigureFromPoseLandmarks } from '../src/pose-topology.mjs';
import { createClaudeFigureData } from '../src/claude-figure-data.mjs';

describe('AI Auto-Rigging & Pose Topology Synthesis', () => {
  // Synthetic T-pose fixture (33 MediaPipe landmarks)
  const syntheticPose33 = Array.from({ length: 33 }, (_, i) => {
    switch (i) {
      case 0: return { x: 0.5, y: 0.15 }; // Nose
      case 11: return { x: 0.42, y: 0.3 }; // L Shoulder
      case 12: return { x: 0.58, y: 0.3 }; // R Shoulder
      case 13: return { x: 0.35, y: 0.45 }; // L Elbow
      case 14: return { x: 0.65, y: 0.45 }; // R Elbow
      case 15: return { x: 0.28, y: 0.55 }; // L Wrist
      case 16: return { x: 0.72, y: 0.55 }; // R Wrist
      case 23: return { x: 0.45, y: 0.58 }; // L Hip
      case 24: return { x: 0.55, y: 0.58 }; // R Hip
      case 25: return { x: 0.44, y: 0.75 }; // L Knee
      case 26: return { x: 0.56, y: 0.75 }; // R Knee
      case 27: return { x: 0.43, y: 0.95 }; // L Ankle
      case 28: return { x: 0.57, y: 0.95 }; // R Ankle
      default: return { x: 0.5, y: 0.5 };
    }
  });

  it('synthesizes a 10-segment StykAnimate figure from MediaPipe landmarks', () => {
    const { figure, ikSetup, rootPosition } = buildFigureFromPoseLandmarks(syntheticPose33, {
      scale: 300,
      name: 'TestRig'
    });

    assert.equal(figure.name, 'TestRig');
    assert.equal(figure.segment_count, 10);
    assert.equal(figure.segments.length, 10);

    // Verify segments have valid numbers and no NaNs
    for (const segment of figure.segments) {
      assert(Number.isFinite(segment.length), `Segment ${segment.name} length is not finite`);
      assert(Number.isFinite(segment.angle_rad), `Segment ${segment.name} angle is not finite`);
      assert(segment.length > 0, `Segment ${segment.name} length should be > 0`);
      assert(Array.isArray(segment.color_rgb) && segment.color_rgb.length === 3);
    }

    // Verify parent-child hierarchy
    const torso = figure.segments.find(s => s.name === 'Torso');
    assert.equal(torso.parent_id, 0);

    const head = figure.segments.find(s => s.name === 'Head');
    assert.equal(head.parent_id, torso.segment_id);
    assert.equal(head.segment_kind, 'circleFill');

    const lUpperArm = figure.segments.find(s => s.name === 'Left upper arm');
    assert.equal(lUpperArm.parent_id, torso.segment_id);

    const lForearm = figure.segments.find(s => s.name === 'Left forearm');
    assert.equal(lForearm.parent_id, lUpperArm.segment_id);

    const lThigh = figure.segments.find(s => s.name === 'Left thigh');
    assert.equal(lThigh.parent_id, 0);

    const lCalf = figure.segments.find(s => s.name === 'Left lower leg');
    assert.equal(lCalf.parent_id, lThigh.segment_id);

    // Verify 4 IK controllers configured
    assert.equal(ikSetup.length, 4);
    assert.deepEqual(
      ikSetup.map(k => k.name).sort(),
      ['Left forearm', 'Left lower leg', 'Right forearm', 'Right lower leg'].sort()
    );
  });

  it('rejects malformed or undersized landmark arrays', () => {
    assert.throws(() => {
      buildFigureFromPoseLandmarks([]);
    }, TypeError);

    assert.throws(() => {
      buildFigureFromPoseLandmarks(null);
    }, TypeError);
  });

  it('instantiates valid Claude Mascot figure data with 4 IK-controlled legs', () => {
    const { figure, object } = createClaudeFigureData();

    assert.equal(figure.name, 'Claude');
    assert.equal(figure.segments.length, 7);

    // Terracotta color check
    const torso = figure.segments.find(s => s.name === 'Torso');
    assert.deepEqual(torso.color_rgb, [217, 119, 87]);

    // IK setup check for 4 legs
    const ikKeys = Object.keys(object._stykIK);
    assert.equal(ikKeys.length, 4);
    for (const key of ikKeys) {
      assert.equal(object._stykIK[key].enabled, true);
      assert.equal(object._stykIK[key].chainLength, 1);
    }
  });
});
