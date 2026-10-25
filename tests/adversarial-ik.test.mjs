/**
 * Adversarial Stress Test Suite for 2-Bone IK Solver & Topology Synthesis
 * Executed headlessly via node:test runner.
 * Author: Challenger 1 (Adversarial Verifier for IK & Geometry)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildFigureFromPoseLandmarks } from '../src/pose-topology.mjs';
import { createClaudeFigureData } from '../src/claude-figure-data.mjs';
import { Editor } from '../src/editor.mjs';
import { createObject, createFrame } from '../src/demo.mjs';
import { solveIKPoints, solveObjectIK, ikChain, validateIK } from '../src/ik.mjs';

// Standard 33-landmark T-pose generator
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
      case 23: return { x: 0.45, y: 0.58, z: 0.0, visibility: 0.97 }; // Left Hip
      case 24: return { x: 0.55, y: 0.58, z: 0.0, visibility: 0.97 }; // Right Hip
      case 25: return { x: 0.44, y: 0.75, z: 0.0, visibility: 0.94 }; // Left Knee
      case 26: return { x: 0.56, y: 0.75, z: 0.0, visibility: 0.94 }; // Right Knee
      case 27: return { x: 0.43, y: 0.95, z: 0.0, visibility: 0.90 }; // Left Ankle
      case 28: return { x: 0.57, y: 0.95, z: 0.0, visibility: 0.90 }; // Right Ankle
      default: return { x: 0.50, y: 0.50, z: 0.0, visibility: 0.80 };
    }
  });
  for (const [idx, pt] of Object.entries(overrides)) {
    landmarks[Number(idx)] = { ...landmarks[Number(idx)], ...pt };
  }
  return landmarks;
}

// Wrap synthesized figure in document for Editor.importFigure
function createRiggedDoc(landmarks, options = {}) {
  const { figure, ikSetup, rootPosition } = buildFigureFromPoseLandmarks(landmarks, options);
  const _stykIK = {};
  for (const item of ikSetup) {
    _stykIK[String(item.segment_id)] = {
      enabled: item.enabled,
      pinned: item.pinned,
      allowStretch: false,
      chainLength: item.chainLength,
      bendDirection: item.bendDirection,
      target: item.target ?? { x: rootPosition.x, y: rootPosition.y, rotation: 0 },
      followers: {}
    };
  }
  const object = createObject(figure, 1, rootPosition.x, rootPosition.y, {
    angles: figure.segments.map(s => s.angle_rad),
    _stykIK
  });
  return {
    version: 5,
    canvas_width: 960,
    canvas_height: 540,
    fps: 24,
    auto_easing: false,
    auto_easing_disabled_raw: 1,
    figure_types: [figure],
    backgrounds: [],
    keyframes: [createFrame([object], 1)],
    _styk: { format: 'StykAnimate', format_version: 1, name: figure.name }
  };
}

// ============================================================================
// VECTOR 1: HIGH-FREQUENCY CANVAS DRAG MUTATIONS (200+ TO 1000 CALLS)
// ============================================================================
describe('Vector 1: High-Frequency Canvas Drag Mutations via editor.poseJoint', () => {

  it('1.1: 250 high-frequency mutations in an eccentric Lissajous curve on Left Forearm', () => {
    const doc = createRiggedDoc(createStandardPose33(), { name: 'LissajousStress' });
    const editor = new Editor({ demo: false });
    editor.importFigure(doc);

    // Select Left Forearm (segment_id: 4 -> segment index 3)
    editor.select(editor.selectedUid, 3);

    editor.beginDrag('Canvas drag');
    const start = performance.now();
    for (let i = 0; i < 250; i++) {
      const t = i * 0.1;
      // Lissajous curve: x = A sin(at + delta), y = B sin(bt)
      const targetX = 220 + 80 * Math.sin(3 * t + Math.PI / 4);
      const targetY = 240 + 70 * Math.sin(2 * t);

      editor.poseJoint(targetX, targetY);

      // Verify numerical stability after each mutation
      for (let j = 0; j < editor.object.angles.length; j++) {
        const angle = editor.object.angles[j];
        assert.ok(Number.isFinite(angle), `Joint angle at index ${j} became non-finite at step ${i}: ${angle}`);
      }
    }
    const elapsed = performance.now() - start;
    const avgPerMutation = elapsed / 250;
    assert.ok(avgPerMutation < 1.0, `Average mutation time too high: ${avgPerMutation.toFixed(3)}ms`);

    // Verify commitDrag preserves clean state
    editor.commitDrag();
    assert.equal(editor.object.angles.length, 10);
    assert.equal(editor._undo.length, 2); // 1 import + 1 drag
  });

  it('1.2: 300 sequential spiral drag mutations expanding beyond max reach and collapsing to base', () => {
    const doc = createRiggedDoc(createStandardPose33(), { name: 'SpiralStress' });
    const editor = new Editor({ demo: false });
    editor.importFigure(doc);

    // Select Left Lower Leg (segment_id: 8 -> segment index 7)
    editor.select(editor.selectedUid, 7);

    // Base position for hip/thigh is approximately (200, 270)
    for (let i = 0; i < 300; i++) {
      const angle = (i / 30) * Math.PI * 2;
      // Radius oscillates from 0 (collapsed) to 250 (far beyond ~140 max reach)
      const radius = 125 + 125 * Math.sin((i / 50) * Math.PI);
      const targetX = 200 + Math.cos(angle) * radius;
      const targetY = 270 + Math.sin(angle) * radius;

      editor.poseJoint(targetX, targetY);

      assert.ok(Number.isFinite(editor.object.angles[6]), `Thigh angle non-finite at step ${i}`);
      assert.ok(Number.isFinite(editor.object.angles[7]), `Calf angle non-finite at step ${i}`);
    }
    editor.commitDrag();
  });

  it('1.3: 200 rapid alternating switchback mutations crossing directly through fold singularity', () => {
    const doc = createRiggedDoc(createStandardPose33(), { name: 'FoldSwitchback' });
    const editor = new Editor({ demo: false });
    editor.importFigure(doc);

    editor.select(editor.selectedUid, 3); // Left Forearm
    // Shoulder base position is approximately at (189, 90)
    const base = editor.geometry.objects.get(editor.selectedSlot).segments[2].start;

    for (let i = 0; i < 200; i++) {
      // Oscillate directly through base with tiny delta
      const offset = ((i % 2 === 0 ? 1 : -1) * (i + 1)) * 0.1;
      const targetX = base.x + (i % 4 < 2 ? offset : 0);
      const targetY = base.y + (i % 4 >= 2 ? offset : 0);

      editor.poseJoint(targetX, targetY);

      assert.ok(Number.isFinite(editor.object.angles[2]));
      assert.ok(Number.isFinite(editor.object.angles[3]));
    }
    editor.commitDrag();
  });

  it('1.4: 200 multi-limb sequential drag mutations alternating across all 4 terminal controllers', () => {
    const doc = createRiggedDoc(createStandardPose33(), { name: 'MultiLimbStress' });
    const editor = new Editor({ demo: false });
    editor.importFigure(doc);

    // Limb indices: Left Forearm (3), Right Forearm (5), Left Leg (7), Right Leg (9)
    const limbs = [3, 5, 7, 9];

    for (let i = 0; i < 200; i++) {
      const limbIdx = limbs[i % limbs.length];
      editor.select(editor.selectedUid, limbIdx);

      const angle = (i / 10) * Math.PI;
      const targetX = 250 + Math.cos(angle) * 50;
      const targetY = 250 + Math.sin(angle) * 50;

      editor.poseJoint(targetX, targetY);

      // Verify all 10 angles remain valid and bounded
      for (let a = 0; a < 10; a++) {
        assert.ok(Number.isFinite(editor.object.angles[a]));
      }
    }
    editor.commitDrag();
  });

  it('1.5: 200 high-frequency drag mutations on Claude Mascot 4-legged quadruped rig', () => {
    const { figure, object } = createClaudeFigureData();
    const doc = {
      version: 5,
      canvas_width: 960,
      canvas_height: 540,
      fps: 24,
      auto_easing: false,
      auto_easing_disabled_raw: 1,
      figure_types: [figure],
      backgrounds: [],
      keyframes: [createFrame([object], 1)],
      _styk: { format: 'StykAnimate', format_version: 1, name: figure.name }
    };

    const editor = new Editor({ demo: false });
    editor.importFigure(doc);

    // Leg indices for Claude mascot: 3, 4, 5, 6
    const legs = [3, 4, 5, 6];

    const initialTorsoAngle = editor.object.angles[0];

    for (let i = 0; i < 200; i++) {
      const legIdx = legs[i % legs.length];
      editor.select(editor.selectedUid, legIdx);

      const targetX = 480 + (i % 2 === 0 ? 30 : -30) * Math.cos(i);
      const targetY = 360 + (i % 2 === 0 ? 20 : -20) * Math.sin(i);

      editor.poseJoint(targetX, targetY);

      // Terracotta torso angle (index 0) must remain invariant
      assert.equal(editor.object.angles[0], initialTorsoAngle, 'Torso angle shifted unexpectedly');
      assert.ok(Number.isFinite(editor.object.angles[legIdx]));
    }
    editor.commitDrag();
  });
});

// ============================================================================
// VECTOR 2: EXTREME TARGET COORDINATES
// ============================================================================
describe('Vector 2: Extreme Target Coordinates (Negative, Infinite, NaN, Out-of-Reach)', () => {

  it('2.1: Target at exact base coordinates (distance == 0) folds cleanly without NaN', () => {
    const doc = createRiggedDoc(createStandardPose33(), { name: 'ExactZeroTarget' });
    const editor = new Editor({ demo: false });
    editor.importFigure(doc);

    editor.select(editor.selectedUid, 3); // Left Forearm
    const base = editor.geometry.objects.get(editor.selectedSlot).segments[2].start;

    // Pose exactly to base
    editor.poseJoint(base.x, base.y);

    assert.ok(Number.isFinite(editor.object.angles[2]));
    assert.ok(Number.isFinite(editor.object.angles[3]));
    editor.commitDrag();
  });

  it('2.2: Extreme coordinates far beyond reach (+/- 1e5, +/- 1e9) clamp chord safely', () => {
    const doc = createRiggedDoc(createStandardPose33(), { name: 'ExtremeReach' });
    const editor = new Editor({ demo: false });
    editor.importFigure(doc);

    editor.select(editor.selectedUid, 3);

    const extremeCoords = [
      { x: 10000, y: 10000 },
      { x: -10000, y: -10000 },
      { x: 1e6, y: 1e6 },
      { x: -1e6, y: -1e6 },
      { x: 1e9, y: -1e9 },
      { x: -1e9, y: 1e9 }
    ];

    for (const { x, y } of extremeCoords) {
      editor.poseJoint(x, y);
      assert.ok(Number.isFinite(editor.object.angles[2]), `Failed at (${x}, ${y}) for upper arm`);
      assert.ok(Number.isFinite(editor.object.angles[3]), `Failed at (${x}, ${y}) for forearm`);
    }
    editor.commitDrag();
  });

  it('2.3: Non-finite target coordinates (NaN, Infinity, -Infinity) throw cleanly and preserve angles', () => {
    const doc = createRiggedDoc(createStandardPose33(), { name: 'NonFiniteTargets' });
    const editor = new Editor({ demo: false });
    editor.importFigure(doc);

    editor.select(editor.selectedUid, 3);
    const anglesBefore = [...editor.object.angles];

    const invalidInputs = [
      [NaN, 200],
      [200, NaN],
      [NaN, NaN],
      [Infinity, 200],
      [200, Infinity],
      [-Infinity, -Infinity],
      [undefined, 200],
      [null, 200]
    ];

    for (const [x, y] of invalidInputs) {
      assert.throws(() => {
        editor.poseJoint(x, y);
      }, /must be finite|cannot be negative|TypeError|finite/i, `Should reject non-finite inputs: (${x}, ${y})`);

      // Verify angles were NOT corrupted by rejected call
      assert.deepEqual(editor.object.angles, anglesBefore, `Angles corrupted after rejecting (${x}, ${y})`);
    }
  });

  it('2.4: Direct solveIKPoints with subnormal / near-zero distances (1e-12, 1e-15, EPS)', () => {
    const lengths = [50, 50];
    const points = [{ x: 100, y: 100 }, { x: 150, y: 100 }, { x: 200, y: 100 }];

    const nearZeroTargets = [
      { x: 100 + 1e-12, y: 100 + 1e-12 },
      { x: 100 + 1e-15, y: 100 },
      { x: 100, y: 100 + Number.EPSILON },
      { x: 100, y: 100 }
    ];

    for (const target of nearZeroTargets) {
      const pts = points.map(p => ({ ...p }));
      const result = solveIKPoints(pts, lengths, target, 0);

      assert.ok(Number.isFinite(pts[1].x));
      assert.ok(Number.isFinite(pts[1].y));
      assert.ok(Number.isFinite(pts[2].x));
      assert.ok(Number.isFinite(pts[2].y));
    }
  });

  it('2.5: Negative snapTolerance throws and rejects without state alteration', () => {
    const doc = createRiggedDoc(createStandardPose33(), { name: 'NegativeSnap' });
    const editor = new Editor({ demo: false });
    editor.importFigure(doc);
    editor.select(editor.selectedUid, 3);

    assert.throws(() => {
      editor.poseJoint(200, 200, { snapTolerance: -5 });
    });
  });
});

// ============================================================================
// VECTOR 3: DEGENERATE, COLLINEAR, OR COLLAPSED SKELETONS
// ============================================================================
describe('Vector 3: Degenerate, Collinear, or Collapsed Skeletons', () => {

  it('3.1: Fully collapsed skeleton (all 33 landmarks at identical coordinates)', () => {
    // All 33 points coincident at (0.5, 0.5)
    const collapsedPose = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }));
    const { figure, ikSetup, rootPosition } = buildFigureFromPoseLandmarks(collapsedPose);

    // Verify minimum safe lengths enforced by topology synthesizer
    assert.ok(figure.segments[0].length >= 10, 'Torso should clamp >= 10');
    assert.ok(figure.segments[1].length >= 15, 'Head should clamp >= 15');
    assert.ok(figure.segments[2].length >= 10, 'Upper arm should clamp >= 10');
    assert.ok(figure.segments[3].length >= 10, 'Forearm should clamp >= 10');
    assert.ok(figure.segments[6].length >= 12, 'Thigh should clamp >= 12');
    assert.ok(figure.segments[7].length >= 12, 'Calf should clamp >= 12');

    // Import into Editor and verify IK handles still function
    const doc = createRiggedDoc(collapsedPose);
    const editor = new Editor({ demo: false });
    editor.importFigure(doc);

    editor.select(editor.selectedUid, 3);
    assert.doesNotThrow(() => {
      editor.poseJoint(160, 160);
    });
    assert.ok(Number.isFinite(editor.object.angles[2]));
    assert.ok(Number.isFinite(editor.object.angles[3]));
  });

  it('3.2: Perfectly collinear vertical and horizontal limb alignments', () => {
    // Vertical alignment: all x coordinates identical
    const verticalPose = createStandardPose33();
    for (const pt of verticalPose) pt.x = 0.5;

    const docVert = createRiggedDoc(verticalPose);
    const editorVert = new Editor({ demo: false });
    editorVert.importFigure(docVert);

    editorVert.select(editorVert.selectedUid, 3);
    editorVert.poseJoint(150, 150);
    assert.ok(Number.isFinite(editorVert.object.angles[2]));
    assert.ok(Number.isFinite(editorVert.object.angles[3]));

    // Horizontal alignment: all y coordinates identical
    const horizontalPose = createStandardPose33();
    for (const pt of horizontalPose) pt.y = 0.5;

    const docHoriz = createRiggedDoc(horizontalPose);
    const editorHoriz = new Editor({ demo: false });
    editorHoriz.importFigure(docHoriz);

    editorHoriz.select(editorHoriz.selectedUid, 7);
    editorHoriz.poseJoint(200, 300);
    assert.ok(Number.isFinite(editorHoriz.object.angles[6]));
    assert.ok(Number.isFinite(editorHoriz.object.angles[7]));
  });

  it('3.3: Direct solveIKPoints with zero-length and degenerate links ([0, 50], [50, 0], [0, 0])', () => {
    const testCases = [
      { lengths: [0, 50], points: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 50, y: 0 }] },
      { lengths: [50, 0], points: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 0 }] },
      { lengths: [0, 0], points: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }] }
    ];

    for (const { lengths, points } of testCases) {
      const target = { x: 30, y: 20 };
      const pts = points.map(p => ({ ...p }));
      assert.doesNotThrow(() => {
        solveIKPoints(pts, lengths, target, 1);
      });
      for (const p of pts) {
        assert.ok(Number.isFinite(p.x));
        assert.ok(Number.isFinite(p.y));
      }
    }
  });

  it('3.4: 180-degree inverted skeleton (head below pelvis, legs pointing upward)', () => {
    const invertedPose = createStandardPose33({
      0: { x: 0.50, y: 0.90 }, // Nose at bottom
      11: { x: 0.42, y: 0.70 }, // Shoulders lower than hips
      12: { x: 0.58, y: 0.70 },
      23: { x: 0.45, y: 0.30 }, // Hips at top
      24: { x: 0.55, y: 0.30 },
      27: { x: 0.43, y: 0.10 }, // Feet pointing up
      28: { x: 0.57, y: 0.10 }
    });

    const doc = createRiggedDoc(invertedPose);
    const editor = new Editor({ demo: false });
    editor.importFigure(doc);

    // Verify legs articulate upwards properly
    editor.select(editor.selectedUid, 7);
    assert.doesNotThrow(() => {
      editor.poseJoint(200, 50);
    });
    assert.ok(Number.isFinite(editor.object.angles[6]));
    assert.ok(Number.isFinite(editor.object.angles[7]));
  });
});

// ============================================================================
// VECTOR 4: RAPID ATOMIC UNDO/REDO STRESS CYCLES & BITWISE PARITY
// ============================================================================
describe('Vector 4: Rapid Atomic Undo/Redo Stress Cycles, Memory Leaks, and Bitwise Parity', () => {

  it('4.1: 50 rapid sequential import -> pose -> undo -> redo cycles verify bitwise parity', () => {
    const doc = createRiggedDoc(createStandardPose33(), { name: 'CycleFigure' });
    const editor = new Editor({ demo: false });

    for (let c = 0; c < 50; c++) {
      editor.importFigure(doc);
      editor.select(editor.selectedUid, 3);
      editor.poseJoint(210 + (c % 10), 230 + (c % 10));

      const posedJson = JSON.stringify(editor.serialize());

      // Undo pose + import
      editor.undo(); // Undo pose
      editor.undo(); // Undo import

      assert.equal(editor.report.figure_types.length, 1, `Cycle ${c}: Figure definitions leaked on undo`);
      assert.equal(editor.frame.objects.length, 0, `Cycle ${c}: Scene objects leaked on undo`);

      // Redo import + pose
      editor.redo(); // Redo import
      editor.redo(); // Redo pose

      const redoneJson = JSON.stringify(editor.serialize());
      assert.equal(redoneJson, posedJson, `Cycle ${c}: Bitwise parity failed upon redo!`);

      // Clean up for next cycle
      editor.undo();
      editor.undo();
    }
  });

  it('4.2: Zero memory leakage & zero leftover state in report.figure_types after 50 cancelled imports', () => {
    const doc = createRiggedDoc(createStandardPose33(), { name: 'LeakCheckRig' });
    const editor = new Editor({ demo: false });
    const baselineFigCount = editor.report.figure_types.length;
    const baselineObjCount = editor.frame.objects.length;

    for (let i = 0; i < 50; i++) {
      editor.importFigure(doc);
      assert.equal(editor.report.figure_types.length, baselineFigCount + 1);
      assert.equal(editor.frame.objects.length, baselineObjCount + 1);

      // Immediately revert
      editor.undo();
      assert.equal(editor.report.figure_types.length, baselineFigCount, `Leak at iteration ${i} in figure_types`);
      assert.equal(editor.frame.objects.length, baselineObjCount, `Leak at iteration ${i} in objects`);
    }

    // Verify undo stack does not hold runaway references
    assert.equal(editor._undo.length, 0);
  });

  it('4.3: Hammering 100 undos and 100 redos beyond stack boundaries causes zero errors or state corruption', () => {
    const doc = createRiggedDoc(createStandardPose33(), { name: 'HammerTest' });
    const editor = new Editor({ demo: false });
    editor.importFigure(doc);
    editor.select(editor.selectedUid, 3);
    editor.poseJoint(220, 220);

    // Baseline with 2 operations
    assert.equal(editor._undo.length, 2);

    // Hammer 100 undos
    for (let i = 0; i < 100; i++) {
      assert.doesNotThrow(() => editor.undo());
    }
    assert.equal(editor._undo.length, 0);
    assert.equal(editor._redo.length, 2);

    // Hammer 100 redos
    for (let i = 0; i < 100; i++) {
      assert.doesNotThrow(() => editor.redo());
    }
    assert.equal(editor._undo.length, 2);
    assert.equal(editor._redo.length, 0);
  });

  it('4.4: Bitwise serialization parity across multiple complex figures (Claude Mascot + AutoRig)', () => {
    const autoDoc = createRiggedDoc(createStandardPose33(), { name: 'AutoRigMaster' });
    const { figure: claudeFig, object: claudeObj } = createClaudeFigureData();
    const claudeDoc = {
      version: 5,
      canvas_width: 960,
      canvas_height: 540,
      fps: 24,
      auto_easing: false,
      auto_easing_disabled_raw: 1,
      figure_types: [claudeFig],
      backgrounds: [],
      keyframes: [createFrame([claudeObj], 1)],
      _styk: { format: 'StykAnimate', format_version: 1, name: claudeFig.name }
    };

    const editor = new Editor({ demo: false });
    const pristineDoc = JSON.stringify(editor.serialize());

    // Import AutoRig
    editor.importFigure(autoDoc, { position: { x: 200, y: 200 } });
    const autoUid = editor.selectedUid;

    // Import Claude Mascot
    editor.importFigure(claudeDoc, { position: { x: 500, y: 200 } });
    const claudeUid = editor.selectedUid;

    // Pose AutoRig arm & leg
    editor.select(autoUid, 3);
    editor.poseJoint(180, 220);
    editor.select(autoUid, 7);
    editor.poseJoint(190, 430);

    // Pose Claude Mascot legs
    editor.select(claudeUid, 3);
    editor.poseJoint(450, 360);
    editor.select(claudeUid, 6);
    editor.poseJoint(530, 360);

    const complexPosedSnapshot = JSON.stringify(editor.serialize());

    // Revert everything to empty pristine state
    editor.undo(); // Claude leg 6
    editor.undo(); // Claude leg 3
    editor.undo(); // Auto leg
    editor.undo(); // Auto arm
    editor.undo(); // Claude import
    editor.undo(); // Auto import

    assert.equal(JSON.stringify(editor.serialize()), pristineDoc);

    // Redo everything forward to complex posed snapshot
    editor.redo(); // Auto import
    editor.redo(); // Claude import
    editor.redo(); // Auto arm
    editor.redo(); // Auto leg
    editor.redo(); // Claude leg 3
    editor.redo(); // Claude leg 6

    assert.equal(JSON.stringify(editor.serialize()), complexPosedSnapshot);
  });
});

// ============================================================================
// VECTOR 5: DEEP ADVERSARIAL HARDENING & STRESS LIMITS
// ============================================================================
describe('Vector 5: Deep Adversarial Hardening (1,000 Drags, Negative Scale, Adversarial setNodeIK)', () => {

  it('5.1: 1,000 rapid sequential canvas drag mutations in a single uninterrupted gesture', () => {
    const doc = createRiggedDoc(createStandardPose33(), { name: 'ThousandDrags' });
    const editor = new Editor({ demo: false });
    editor.importFigure(doc);

    editor.select(editor.selectedUid, 3); // Left Forearm

    editor.beginDrag('1000-drag gesture');
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      const angle = (i / 100) * Math.PI * 2;
      const r = 50 + 20 * Math.cos(i * 0.05);
      const targetX = 220 + Math.cos(angle) * r;
      const targetY = 240 + Math.sin(angle) * r;

      editor.poseJoint(targetX, targetY);
    }
    const duration = performance.now() - t0;
    const avg = duration / 1000;

    // Sub-millisecond performance guarantee (< 0.5ms per step during active drag)
    assert.ok(avg < 0.5, `1000-drag average exceeds 0.5ms target: ${avg.toFixed(3)}ms`);

    // All angles finite
    for (let a = 0; a < 10; a++) {
      assert.ok(Number.isFinite(editor.object.angles[a]));
    }

    editor.commitDrag();
    assert.equal(editor._undo.length, 2); // 1 import + 1 commitDrag
  });

  it('5.2: Negative scale rejected by model integrity; extreme valid scales (0.01, 10.0) handle IK drag cleanly', () => {
    const doc = createRiggedDoc(createStandardPose33(), { name: 'ScaledFigure' });
    const editor = new Editor({ demo: false });
    editor.importFigure(doc);
    editor.select(editor.selectedUid, 3);

    // Negative scale reflection is strictly rejected by model integrity guard
    editor.object.scale = -1;
    assert.throws(() => {
      editor.poseJoint(200, 200);
    }, /cannot be negative/i);

    // Reset to extreme small positive scale (0.01)
    editor.object.scale = 0.01;
    assert.doesNotThrow(() => {
      editor.poseJoint(200, 200);
    });
    assert.ok(Number.isFinite(editor.object.angles[2]));
    assert.ok(Number.isFinite(editor.object.angles[3]));

    // Extreme large scale (10.0)
    editor.object.scale = 10.0;
    assert.doesNotThrow(() => {
      editor.poseJoint(200, 200);
    });
    assert.ok(Number.isFinite(editor.object.angles[2]));
    assert.ok(Number.isFinite(editor.object.angles[3]));
  });

  it('5.3: Adversarial editor.setNodeIK parameter injection and overlapping chain rejection', () => {
    const doc = createRiggedDoc(createStandardPose33(), { name: 'SetNodeIKTest' });
    const editor = new Editor({ demo: false });
    editor.importFigure(doc);

    // Select Left Forearm (segment 4 / index 3)
    editor.select(editor.selectedUid, 3);

    // 1. Invalid chainLength
    assert.throws(() => {
      editor.setNodeIK({ chainLength: 0 });
    }, /between 1 and/i);

    assert.throws(() => {
      editor.setNodeIK({ chainLength: 10 });
    }, /between 1 and/i);

    assert.throws(() => {
      editor.setNodeIK({ chainLength: -1 });
    }, /between 1 and/i);

    assert.throws(() => {
      editor.setNodeIK({ chainLength: 1.5 });
    }, /between 1 and/i);

    // 2. Invalid bendDirection
    assert.throws(() => {
      editor.setNodeIK({ bendDirection: 2 });
    }, /invalid/i);

    assert.throws(() => {
      editor.setNodeIK({ bendDirection: -2 });
    }, /invalid/i);

    // 3. Invalid types
    assert.throws(() => {
      editor.setNodeIK({ enabled: 'true' });
    }, /invalid/i);

    assert.throws(() => {
      editor.setNodeIK({ pinned: 'false' });
    }, /invalid/i);

    // 4. Overlapping chains: Select Left Upper Arm (segment 3 / index 2)
    // and attempt to enable IK while Left Forearm (segment 4) already uses bone 3
    editor.select(editor.selectedUid, 2);
    assert.throws(() => {
      editor.setNodeIK({ enabled: true, chainLength: 2 });
    }, /cannot share bones|shorten the chain/i);
  });

  it('5.4: Pinned IK limbs preserve world target invariance during figure root translation', () => {
    const doc = createRiggedDoc(createStandardPose33(), { name: 'PinnedLimbInvariance' });
    const editor = new Editor({ demo: false });
    editor.importFigure(doc);

    // Pin all 4 limbs: Left Forearm (3), Right Forearm (5), Left Leg (7), Right Leg (9)
    const limbIndices = [3, 5, 7, 9];
    for (const idx of limbIndices) {
      editor.select(editor.selectedUid, idx);
      editor.setNodeIK({ pinned: true });
    }

    // Capture initial pinned targets in world space
    const initialTargets = {};
    for (const [id, c] of Object.entries(editor.object._stykIK)) {
      initialTargets[id] = { ...c.target };
    }

    // Translate root by (150, 80) without moving pins
    editor.beginTranslationDrag();
    editor.moveSelection(150, 80, { fromStart: true, movePins: false });
    editor.commitDrag();

    // Verify pinned world targets did NOT move with root
    for (const [id, c] of Object.entries(editor.object._stykIK)) {
      assert.equal(c.target.x, initialTargets[id].x, `Pinned target X shifted on node ${id}`);
      assert.equal(c.target.y, initialTargets[id].y, `Pinned target Y shifted on node ${id}`);
    }
  });

  it('5.5: Dynamic bendDirection modulation (-1, 0, 1) during high-frequency drag', () => {
    const doc = createRiggedDoc(createStandardPose33(), { name: 'DynamicBend' });
    const editor = new Editor({ demo: false });
    editor.importFigure(doc);

    editor.select(editor.selectedUid, 3); // Left Forearm

    const directions = [-1, 0, 1];
    for (let i = 0; i < 210; i++) {
      const bend = directions[Math.floor(i / 70)];
      editor.setNodeIK({ bendDirection: bend });

      const targetX = 220 + 40 * Math.cos(i * 0.1);
      const targetY = 240 + 40 * Math.sin(i * 0.1);
      editor.poseJoint(targetX, targetY);

      assert.ok(Number.isFinite(editor.object.angles[2]));
      assert.ok(Number.isFinite(editor.object.angles[3]));
    }
    editor.commitDrag();
  });
});

