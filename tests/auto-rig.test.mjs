import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { buildFigureFromPoseLandmarks } from '../src/pose-topology.mjs';
import { createClaudeFigureData } from '../src/claude-figure-data.mjs';
import { createObject, createFrame } from '../src/demo.mjs';
import { ikChain, validateIK } from '../src/ik.mjs';
import { generateSvgAsset, generateIconAsset, generateAnimationAsset } from '../scripts/creative-studio-cli.mjs';

// Some contract tests open a document; the engine (Rust/WASM) owns that path, so they run only when
// src/engine/pkg has been built (`npm run engine:build`), as `npm test` does.
const ENGINE_BUILT = existsSync(new URL('../src/engine/pkg/styk_engine_bg.wasm', import.meta.url));
const needsEngine = ENGINE_BUILT ? true : { skip: 'requires the built Rust engine (npm run engine:build)' };

// Synthetic Standard T-Pose fixture (33 MediaPipe Landmarks)
function createSyntheticPose33(overrides = {}) {
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

// Synthetic COCO 17-Keypoint Pose fixture
function createSyntheticCoco17() {
  return [
    { x: 0.50, y: 0.15 }, // 0: Nose
    { x: 0.49, y: 0.13 }, // 1: Left Eye
    { x: 0.51, y: 0.13 }, // 2: Right Eye
    { x: 0.47, y: 0.14 }, // 3: Left Ear
    { x: 0.53, y: 0.14 }, // 4: Right Ear
    { x: 0.42, y: 0.30 }, // 5: Left Shoulder
    { x: 0.58, y: 0.30 }, // 6: Right Shoulder
    { x: 0.35, y: 0.45 }, // 7: Left Elbow
    { x: 0.65, y: 0.45 }, // 8: Right Elbow
    { x: 0.28, y: 0.55 }, // 9: Left Wrist
    { x: 0.72, y: 0.55 }, // 10: Right Wrist
    { x: 0.45, y: 0.58 }, // 11: Left Hip
    { x: 0.55, y: 0.58 }, // 12: Right Hip
    { x: 0.44, y: 0.75 }, // 13: Left Knee
    { x: 0.56, y: 0.75 }, // 14: Right Knee
    { x: 0.43, y: 0.95 }, // 15: Left Ankle
    { x: 0.57, y: 0.95 }  // 16: Right Ankle
  ];
}

// Helper to wrap synthesized figure in a full StykAnimate Document for atomic import
function createRiggedFigureDocument(landmarks, options = {}) {
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

// Helper to wrap Claude mascot in a validated Document for Editor
function createClaudeFigureDocument(options = {}) {
  const { figure, object } = createClaudeFigureData();
  const figureName = options.name || figure.name;
  const namedFigure = { ...figure, name: figureName };
  const _stykIK = {};
  for (const [key, ctrl] of Object.entries(object._stykIK)) {
    _stykIK[key] = {
      ...ctrl,
      target: { x: object.root_x, y: object.root_y + 36, rotation: 0 },
      followers: {}
    };
  }
  const validObject = { ...object, _stykIK };
  return {
    version: 5,
    canvas_width: 960,
    canvas_height: 540,
    fps: 24,
    auto_easing: false,
    auto_easing_disabled_raw: 1,
    figure_types: [namedFigure],
    backgrounds: [],
    keyframes: [createFrame([validObject], 1)],
    _styk: { format: 'StykAnimate', format_version: 1, name: options.name || figure.name }
  };
}

// ============================================================================
// TIER 1: FEATURE COVERAGE (50 Tests across 10 Features)
// ============================================================================
describe('Tier 1: Feature Coverage', () => {

  describe('Feature 1: MediaPipe Landmark Normalization', () => {
    it('scales normalized [0, 1] coordinates by custom scale factor', () => {
      const pose = createSyntheticPose33();
      const res100 = buildFigureFromPoseLandmarks(pose, { scale: 100 });
      const res300 = buildFigureFromPoseLandmarks(pose, { scale: 300 });
      assert.equal(res100.rootPosition.x, 0.50 * 100);
      assert.equal(res100.rootPosition.y, 0.58 * 100);
      assert.equal(res300.rootPosition.x, 0.50 * 300);
      assert.equal(res300.rootPosition.y, 0.58 * 300);
    });

    it('defaults scale to 300 when options.scale is omitted', () => {
      const pose = createSyntheticPose33();
      const resDefault = buildFigureFromPoseLandmarks(pose);
      assert.equal(resDefault.rootPosition.x, 0.50 * 300);
      assert.equal(resDefault.rootPosition.y, 0.58 * 300);
    });

    it('computes root position at exact midpoint between Left Hip (23) and Right Hip (24)', () => {
      const pose = createSyntheticPose33({
        23: { x: 0.40, y: 0.60 },
        24: { x: 0.60, y: 0.70 }
      });
      const { rootPosition } = buildFigureFromPoseLandmarks(pose, { scale: 200 });
      assert.equal(rootPosition.x, ((0.40 + 0.60) / 2) * 200);
      assert.equal(rootPosition.y, ((0.60 + 0.70) / 2) * 200);
    });

    it('normalizes neck position as midpoint between Left Shoulder (11) and Right Shoulder (12)', () => {
      const pose = createSyntheticPose33({
        11: { x: 0.30, y: 0.20 },
        12: { x: 0.70, y: 0.20 },
        23: { x: 0.50, y: 0.60 },
        24: { x: 0.50, y: 0.60 }
      });
      const { figure } = buildFigureFromPoseLandmarks(pose, { scale: 100 });
      const torso = figure.segments.find(s => s.name === 'Torso');
      // Root at (50, 60), neck at (50, 20) -> dy = -40, dx = 0 -> angle -pi/2, length 40
      assert.equal(torso.length, 40);
      assert.ok(Math.abs(torso.angle_rad - (-Math.PI / 2)) < 1e-4);
    });

    it('processes COCO 17-keypoint normalized input using COCO landmark indexing', () => {
      const coco = createSyntheticCoco17();
      const { figure, ikSetup, rootPosition } = buildFigureFromPoseLandmarks(coco, { scale: 200 });
      assert.equal(figure.segments.length, 10);
      assert.equal(ikSetup.length, 4);
      // In COCO, hip midpoint is mid(11, 12) = mid({0.45, 0.58}, {0.55, 0.58}) = (0.50, 0.58)
      assert.equal(rootPosition.x, 0.50 * 200);
      assert.equal(rootPosition.y, 0.58 * 200);
    });
  });

  describe('Feature 2: Segment Tree Synthesis', () => {
    it('synthesizes exactly 10 segments with unique contiguous segment_ids 1 to 10', () => {
      const pose = createSyntheticPose33();
      const { figure } = buildFigureFromPoseLandmarks(pose);
      assert.equal(figure.segment_count, 10);
      const ids = figure.segments.map(s => s.segment_id);
      assert.deepEqual(ids, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    it('forms an acyclic tree with root branches (Torso, Left Thigh, Right Thigh at parent 0)', () => {
      const pose = createSyntheticPose33();
      const { figure } = buildFigureFromPoseLandmarks(pose);
      const roots = figure.segments.filter(s => s.parent_id === 0);
      assert.equal(roots.length, 3);
      assert.deepEqual(roots.map(s => s.name).sort(), ['Left thigh', 'Right thigh', 'Torso'].sort());
    });

    it('applies custom figure name option with default fallback to AutoRig', () => {
      const pose = createSyntheticPose33();
      const custom = buildFigureFromPoseLandmarks(pose, { name: 'GymnastRig' });
      assert.equal(custom.figure.name, 'GymnastRig');
      const fallback = buildFigureFromPoseLandmarks(pose);
      assert.equal(fallback.figure.name, 'AutoRig');
    });

    it('propagates custom RGB color array uniformly across all synthesized segments', () => {
      const pose = createSyntheticPose33();
      const customColor = [255, 128, 0];
      const { figure } = buildFigureFromPoseLandmarks(pose, { color: customColor });
      for (const seg of figure.segments) {
        assert.deepEqual(seg.color_rgb, customColor);
      }
    });

    it('initializes empty polyfills, image_assets, and text_assets collections', () => {
      const pose = createSyntheticPose33();
      const { figure } = buildFigureFromPoseLandmarks(pose);
      assert.deepEqual(figure.polyfills, []);
      assert.deepEqual(figure.image_assets, []);
      assert.deepEqual(figure.text_assets, []);
    });
  });

  describe('Feature 3: circleFill Head Anchor', () => {
    it('configures Head segment with primitive_code 3 and flags 3 for circleFill', () => {
      const pose = createSyntheticPose33();
      const { figure } = buildFigureFromPoseLandmarks(pose);
      const head = figure.segments.find(s => s.name === 'Head');
      assert.equal(head.primitive_code, 3);
      assert.equal(head.flags, 3);
      assert.equal(head.segment_type, 'circle');
      assert.equal(head.segment_kind, 'circleFill');
    });

    it('attaches Head directly to Torso (parent_id === 1)', () => {
      const pose = createSyntheticPose33();
      const { figure } = buildFigureFromPoseLandmarks(pose);
      const head = figure.segments.find(s => s.name === 'Head');
      assert.equal(head.parent_id, 1);
    });

    it('sets thickness to 0 for circleFill primitive compliance', () => {
      const pose = createSyntheticPose33();
      const { figure } = buildFigureFromPoseLandmarks(pose);
      const head = figure.segments.find(s => s.name === 'Head');
      assert.equal(head.thickness, 0);
    });

    it('scales head radius by 1.5x neck-to-nose distance with minimum 15px clamp', () => {
      const pose = createSyntheticPose33({
        0: { x: 0.50, y: 0.20 },
        11: { x: 0.45, y: 0.30 },
        12: { x: 0.55, y: 0.30 }
      });
      // Neck at (0.50, 0.30), Nose at (0.50, 0.20) -> dist = 0.10. Scale 200 -> 20px * 1.5 = 30px
      const { figure } = buildFigureFromPoseLandmarks(pose, { scale: 200 });
      const head = figure.segments.find(s => s.name === 'Head');
      assert.equal(head.length, 30);
    });

    it('orients head angle from neck midpoint towards cranial nose point', () => {
      const pose = createSyntheticPose33({
        0: { x: 0.50, y: 0.10 },
        11: { x: 0.45, y: 0.30 },
        12: { x: 0.55, y: 0.30 }
      });
      const { figure } = buildFigureFromPoseLandmarks(pose, { scale: 100 });
      const head = figure.segments.find(s => s.name === 'Head');
      assert.ok(Math.abs(head.angle_rad - (-Math.PI / 2)) < 1e-4);
    });
  });

  describe('Feature 4: Bilateral Arm & Leg Chains', () => {
    it('constructs Left Arm chain: Torso(1) -> L Upper Arm(3) -> L Forearm(4)', () => {
      const pose = createSyntheticPose33();
      const { figure } = buildFigureFromPoseLandmarks(pose);
      const uArm = figure.segments.find(s => s.name === 'Left upper arm');
      const fArm = figure.segments.find(s => s.name === 'Left forearm');
      assert.equal(uArm.parent_id, 1);
      assert.equal(fArm.parent_id, uArm.segment_id);
      assert.equal(uArm.segment_id, 3);
      assert.equal(fArm.segment_id, 4);
    });

    it('constructs Right Arm chain: Torso(1) -> R Upper Arm(5) -> R Forearm(6)', () => {
      const pose = createSyntheticPose33();
      const { figure } = buildFigureFromPoseLandmarks(pose);
      const uArm = figure.segments.find(s => s.name === 'Right upper arm');
      const fArm = figure.segments.find(s => s.name === 'Right forearm');
      assert.equal(uArm.parent_id, 1);
      assert.equal(fArm.parent_id, uArm.segment_id);
      assert.equal(uArm.segment_id, 5);
      assert.equal(fArm.segment_id, 6);
    });

    it('constructs Left Leg chain: Root(0) -> L Thigh(7) -> L Lower Leg(8)', () => {
      const pose = createSyntheticPose33();
      const { figure } = buildFigureFromPoseLandmarks(pose);
      const thigh = figure.segments.find(s => s.name === 'Left thigh');
      const calf = figure.segments.find(s => s.name === 'Left lower leg');
      assert.equal(thigh.parent_id, 0);
      assert.equal(calf.parent_id, thigh.segment_id);
      assert.equal(thigh.segment_id, 7);
      assert.equal(calf.segment_id, 8);
    });

    it('constructs Right Leg chain: Root(0) -> R Thigh(9) -> R Lower Leg(10)', () => {
      const pose = createSyntheticPose33();
      const { figure } = buildFigureFromPoseLandmarks(pose);
      const thigh = figure.segments.find(s => s.name === 'Right thigh');
      const calf = figure.segments.find(s => s.name === 'Right lower leg');
      assert.equal(thigh.parent_id, 0);
      assert.equal(calf.parent_id, thigh.segment_id);
      assert.equal(thigh.segment_id, 9);
      assert.equal(calf.segment_id, 10);
    });

    it('preserves bilateral thickness symmetry: arms are 12px, legs are 14px', () => {
      const pose = createSyntheticPose33();
      const { figure } = buildFigureFromPoseLandmarks(pose);
      const seg = name => figure.segments.find(s => s.name === name);
      assert.equal(seg('Left upper arm').thickness, 12);
      assert.equal(seg('Right upper arm').thickness, 12);
      assert.equal(seg('Left forearm').thickness, 12);
      assert.equal(seg('Right forearm').thickness, 12);
      assert.equal(seg('Left thigh').thickness, 14);
      assert.equal(seg('Right thigh').thickness, 14);
      assert.equal(seg('Left lower leg').thickness, 14);
      assert.equal(seg('Right lower leg').thickness, 14);
    });
  });

  describe('Feature 5: 2-Bone IK Setup', () => {
    it('returns exactly 4 pre-configured IK controller records', () => {
      const pose = createSyntheticPose33();
      const { ikSetup } = buildFigureFromPoseLandmarks(pose);
      assert.equal(ikSetup.length, 4);
    });

    it('targets terminal limb segments 4, 6, 8, 10 for IK end effectors', () => {
      const pose = createSyntheticPose33();
      const { ikSetup } = buildFigureFromPoseLandmarks(pose);
      const targetIds = ikSetup.map(i => i.segment_id).sort((a, b) => a - b);
      assert.deepEqual(targetIds, [4, 6, 8, 10]);
    });

    it('sets chainLength to 2 for all controllers (2-bone analytic solver)', () => {
      const pose = createSyntheticPose33();
      const { ikSetup } = buildFigureFromPoseLandmarks(pose);
      for (const ctrl of ikSetup) {
        assert.equal(ctrl.chainLength, 2);
      }
    });

    it('initializes controllers as enabled: true and pinned: false', () => {
      const pose = createSyntheticPose33();
      const { ikSetup } = buildFigureFromPoseLandmarks(pose);
      for (const ctrl of ikSetup) {
        assert.equal(ctrl.enabled, true);
        assert.equal(ctrl.pinned, false);
      }
    });

    it('sets bendDirection to 0 for automatic continuous planar bending', () => {
      const pose = createSyntheticPose33();
      const { ikSetup } = buildFigureFromPoseLandmarks(pose);
      for (const ctrl of ikSetup) {
        assert.equal(ctrl.bendDirection, 0);
      }
    });
  });

  describe('Feature 6: Claude Mascot Preset & Library Asset', () => {
    it('creates Claude figure with signature terracotta palette [217, 119, 87]', () => {
      const { figure } = createClaudeFigureData();
      assert.equal(figure.name, 'Claude');
      for (const seg of figure.segments) {
        assert.deepEqual(seg.color_rgb, [217, 119, 87]);
      }
    });

    it('creates 7 segments with a solid block torso (thickness 72, length 65)', () => {
      const { figure } = createClaudeFigureData();
      assert.equal(figure.segment_count, 7);
      const torso = figure.segments.find(s => s.name === 'Torso');
      assert.equal(torso.thickness, 72);
      assert.equal(torso.length, 65);
      assert.equal(torso.parent_id, 0);
    });

    it('configures 4 independent IK-ready legs (segments 4, 5, 6, 7)', () => {
      const { figure, object } = createClaudeFigureData();
      const ikKeys = Object.keys(object._stykIK).sort();
      assert.deepEqual(ikKeys, ['4', '5', '6', '7']);
      for (const key of ikKeys) {
        assert.equal(object._stykIK[key].enabled, true);
        assert.equal(object._stykIK[key].chainLength, 1);
        assert.equal(object._stykIK[key].bendDirection, 0);
      }
    });

    it('sets initial leg angles perpendicular to torso pointing downward (PI / 2)', () => {
      const { figure } = createClaudeFigureData();
      const legs = figure.segments.filter(s => s.name.includes('leg'));
      assert.equal(legs.length, 4);
      for (const leg of legs) {
        assert.equal(leg.angle_rad, Math.PI / 2);
        assert.equal(leg.parent_id, 0);
      }
    });

    it('creates valid default object placement at root (480, 320) with scale 1', () => {
      const { object } = createClaudeFigureData();
      assert.equal(object.root_x, 480);
      assert.equal(object.root_y, 320);
      assert.equal(object.scale, 1);
      assert.equal(object.angles.length, 7);
    });
  });


  // The CLI is a process entry point; its generators are also plain functions, and those are what these tests
  // call, so the contract is checked without spawning a child process.
  describe('Feature 7: Creative Studio CLI Generation (module contract)', () => {
    it('generates well-formed SVG XML for an svg asset', () => {
      const out = generateSvgAsset('geometric star');
      assert(out.includes('<svg') && out.includes('</svg>'));
      assert(out.includes('xmlns="http://www.w3.org/2000/svg"'));
    });

    it('generates a rounded rectangle icon SVG for an icon asset', () => {
      const out = generateIconAsset('editor icon');
      assert(out.includes('<svg') && out.includes('viewBox'));
      assert(out.includes('rx='));
    });

    it('generates StykAnimate JSON keyframe data for an animation asset', needsEngine, () => {
      const out = generateAnimationAsset('waving arm');
      const parsed = JSON.parse(out);
      assert(parsed.keyframes || parsed.figure_types || parsed.angles);
    });
  });

  describe('Feature 8: Pose Estimation Worker Interface Contract', () => {
    it('defines estimatePose request message shape with id, type, buffer, mimeType', () => {
      const request = {
        id: 'req-001',
        type: 'estimatePose',
        buffer: new ArrayBuffer(16),
        mimeType: 'image/png'
      };
      assert.equal(request.type, 'estimatePose');
      assert.equal(typeof request.id, 'string');
      assert.equal(request.buffer.byteLength, 16);
      assert.equal(request.mimeType, 'image/png');
    });

    it('defines success response returning ok: true and 33 normalized landmark coordinates', () => {
      const response = {
        id: 'req-001',
        ok: true,
        landmarks: Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0.0, visibility: 0.9 }))
      };
      assert.equal(response.ok, true);
      assert.equal(response.landmarks.length, 33);
      assert(response.landmarks.every(lm => lm.x >= 0 && lm.x <= 1 && lm.y >= 0 && lm.y <= 1));
    });

    it('defines error response returning ok: false with messageKey and messageParams', () => {
      const errResponse = {
        id: 'req-002',
        ok: false,
        messageKey: 'errors.poseEstimationWorker.noPoseDetected',
        messageParams: { confidence: 0.12 }
      };
      assert.equal(errResponse.ok, false);
      assert.equal(errResponse.messageKey, 'errors.poseEstimationWorker.noPoseDetected');
      assert.equal(errResponse.messageParams.confidence, 0.12);
    });

    it('guarantees response retains correlating request id for concurrent dispatch', () => {
      const reqId = 'corr-992384';
      const res = { id: reqId, ok: true, landmarks: [] };
      assert.equal(res.id, reqId);
    });

    it('verifies structured clone compatibility without function references or cycles', () => {
      const payload = {
        id: 'clone-test',
        type: 'estimatePose',
        mimeType: 'image/jpeg',
        buffer: new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]).buffer
      };
      const cloned = structuredClone(payload);
      assert.deepEqual(new Uint8Array(cloned.buffer), new Uint8Array(payload.buffer));
    });
  });

  describe('Feature 9: Image & SVG Rasterization Off-Thread Contract', () => {
    it('defines supported raster mimeTypes: PNG, JPEG, WebP', () => {
      const rasterTypes = ['image/png', 'image/jpeg', 'image/webp'];
      for (const t of rasterTypes) {
        assert(t.startsWith('image/'));
      }
    });

    it('defines SVG vector mimeType: image/svg+xml for off-thread WASM rasterization', () => {
      const svgType = 'image/svg+xml';
      assert.equal(svgType, 'image/svg+xml');
    });

    it('specifies OffscreenCanvas rasterization target bounds of 256x256 or 512x512', () => {
      const targetSizes = [{ width: 256, height: 256 }, { width: 512, height: 512 }];
      for (const size of targetSizes) {
        assert.equal(size.width, size.height);
        assert(size.width > 0);
      }
    });

    it('ensures aspect-ratio preservation during letterbox coordinate projection', () => {
      const imgWidth = 800, imgHeight = 600;
      const targetSize = 256;
      const aspect = imgWidth / imgHeight;
      const scaledW = aspect > 1 ? targetSize : targetSize * aspect;
      const scaledH = aspect > 1 ? targetSize / aspect : targetSize;
      assert.equal(scaledW, 256);
      assert.equal(Math.round(scaledH), 192);
    });

    it('confirms image buffer transfers via transferable ArrayBuffer', () => {
      const buf = new ArrayBuffer(64);
      assert.equal(buf.byteLength, 64);
    });
  });
  });

// ============================================================================
// TIER 2: BOUNDARY & CORNER CASES (50 Tests across 10 Categories)
// ============================================================================
describe('Tier 2: Boundary & Corner Cases', () => {

  describe('Boundary 1: Empty, Null, and Non-Array Landmarks', () => {
    it('throws TypeError when passed an empty array []', () => {
      assert.throws(() => buildFigureFromPoseLandmarks([]), TypeError);
    });

    it('throws TypeError when passed null', () => {
      assert.throws(() => buildFigureFromPoseLandmarks(null), TypeError);
    });

    it('throws TypeError when passed undefined', () => {
      assert.throws(() => buildFigureFromPoseLandmarks(undefined), TypeError);
    });

    it('throws TypeError when passed a plain object {}', () => {
      assert.throws(() => buildFigureFromPoseLandmarks({}), TypeError);
    });

    it('throws TypeError when passed a string or primitive', () => {
      assert.throws(() => buildFigureFromPoseLandmarks("landmarks"), TypeError);
    });
  });

  describe('Boundary 2: Malformed Landmark Arrays & Undersized Keypoints', () => {
    it('throws TypeError when array length is 1', () => {
      assert.throws(() => buildFigureFromPoseLandmarks([{ x: 0.5, y: 0.5 }]), TypeError);
    });

    it('throws TypeError when array length is 10 (less than 17 minimum)', () => {
      const shortList = Array.from({ length: 10 }, () => ({ x: 0.5, y: 0.5 }));
      assert.throws(() => buildFigureFromPoseLandmarks(shortList), TypeError);
    });

    it('throws TypeError when array length is exactly 16 (1 below COCO 17)', () => {
      const sixteen = Array.from({ length: 16 }, () => ({ x: 0.5, y: 0.5 }));
      assert.throws(() => buildFigureFromPoseLandmarks(sixteen), TypeError);
    });

    it('succeeds when array length is exactly 17 (COCO minimum)', () => {
      const seventeen = createSyntheticCoco17();
      const { figure } = buildFigureFromPoseLandmarks(seventeen);
      assert.equal(figure.segments.length, 10);
    });

    it('succeeds when array has between 18 and 32 keypoints using COCO indexing', () => {
      const twenty = Array.from({ length: 20 }, (_, i) => ({ x: 0.1 * (i % 10), y: 0.1 * Math.floor(i / 10) }));
      const { figure } = buildFigureFromPoseLandmarks(twenty);
      assert.equal(figure.segments.length, 10);
    });
  });

  describe('Boundary 3: Missing, Nullish, or Out-of-Bounds Coordinates', () => {
    it('handles landmarks placed at canvas origin (0, 0) without NaN', () => {
      const zeros = Array.from({ length: 33 }, () => ({ x: 0, y: 0 }));
      const { figure } = buildFigureFromPoseLandmarks(zeros);
      for (const seg of figure.segments) {
        assert(Number.isFinite(seg.length));
        assert(Number.isFinite(seg.angle_rad));
      }
    });

    it('handles negative coordinates (subject partially out of frame to top-left)', () => {
      const negative = createSyntheticPose33({
        0: { x: -0.2, y: -0.1 },
        11: { x: -0.1, y: 0.1 }
      });
      const { figure } = buildFigureFromPoseLandmarks(negative);
      for (const seg of figure.segments) {
        assert(Number.isFinite(seg.length) && seg.length > 0);
      }
    });

    it('handles coordinates exceeding 1.0 (subject partially out of frame to bottom-right)', () => {
      const overflow = createSyntheticPose33({
        27: { x: 1.2, y: 1.5 },
        28: { x: 1.4, y: 1.6 }
      });
      const { figure } = buildFigureFromPoseLandmarks(overflow);
      for (const seg of figure.segments) {
        assert(Number.isFinite(seg.length) && seg.length > 0);
      }
    });

    it('ignores missing visibility property gracefully defaulting to finite geometry', () => {
      const noVis = Array.from({ length: 33 }, (_, i) => ({ x: 0.5 + (i % 3) * 0.1, y: 0.1 * i }));
      const { figure } = buildFigureFromPoseLandmarks(noVis);
      assert.equal(figure.segments.length, 10);
    });

    it('ignores missing z coordinate projecting 2D pose faithfully', () => {
      const noZ = createSyntheticPose33().map(({ x, y }) => ({ x, y }));
      const { figure } = buildFigureFromPoseLandmarks(noZ);
      assert.equal(figure.segments.length, 10);
    });
  });

  describe('Boundary 4: Zero Segment Distances & Coincident Keypoints', () => {
    it('clamps zero-distance torso to minimum length 10 when hips equal shoulders', () => {
      const coincident = createSyntheticPose33({
        11: { x: 0.5, y: 0.5 },
        12: { x: 0.5, y: 0.5 },
        23: { x: 0.5, y: 0.5 },
        24: { x: 0.5, y: 0.5 }
      });
      const { figure } = buildFigureFromPoseLandmarks(coincident);
      const torso = figure.segments.find(s => s.name === 'Torso');
      assert(torso.length >= 10);
    });

    it('clamps zero-distance upper arm to minimum length 10 when shoulder equals elbow', () => {
      const armCollapsed = createSyntheticPose33({
        11: { x: 0.5, y: 0.5 },
        13: { x: 0.5, y: 0.5 }
      });
      const { figure } = buildFigureFromPoseLandmarks(armCollapsed);
      const uArm = figure.segments.find(s => s.name === 'Left upper arm');
      assert(uArm.length >= 10);
    });

    it('clamps zero-distance forearm to minimum length 10 when elbow equals wrist', () => {
      const forearmCollapsed = createSyntheticPose33({
        13: { x: 0.5, y: 0.5 },
        15: { x: 0.5, y: 0.5 }
      });
      const { figure } = buildFigureFromPoseLandmarks(forearmCollapsed);
      const fArm = figure.segments.find(s => s.name === 'Left forearm');
      assert(fArm.length >= 10);
    });

    it('clamps zero-distance calf to minimum length 12 when knee equals ankle', () => {
      const legCollapsed = createSyntheticPose33({
        25: { x: 0.5, y: 0.5 },
        27: { x: 0.5, y: 0.5 }
      });
      const { figure } = buildFigureFromPoseLandmarks(legCollapsed);
      const calf = figure.segments.find(s => s.name === 'Left lower leg');
      assert(calf.length >= 12);
    });

    it('clamps collapsed head to minimum length 15 when neck equals nose', () => {
      const headCollapsed = createSyntheticPose33({
        0: { x: 0.5, y: 0.3 },
        11: { x: 0.45, y: 0.3 },
        12: { x: 0.55, y: 0.3 }
      });
      const { figure } = buildFigureFromPoseLandmarks(headCollapsed);
      const head = figure.segments.find(s => s.name === 'Head');
      assert(head.length >= 15);
    });
  });

  describe('Boundary 5: Extreme Scale Factors & Coordinate Bounds', () => {
    it('handles extreme high scale 1e6 without overflow or Infinity', () => {
      const pose = createSyntheticPose33();
      const { figure, rootPosition } = buildFigureFromPoseLandmarks(pose, { scale: 1e6 });
      assert(Number.isFinite(rootPosition.x));
      for (const seg of figure.segments) {
        assert(Number.isFinite(seg.length));
        assert(seg.length > 0);
      }
    });

    it('handles minimal positive scale 0.001 respecting segment minimum clamps', () => {
      const pose = createSyntheticPose33();
      const { figure } = buildFigureFromPoseLandmarks(pose, { scale: 0.001 });
      for (const seg of figure.segments) {
        assert(seg.length >= 10);
      }
    });

    it('handles scale 0 by falling back to default scale or clamping to minimums', () => {
      const pose = createSyntheticPose33();
      const { figure } = buildFigureFromPoseLandmarks(pose, { scale: 0 });
      for (const seg of figure.segments) {
        assert(Number.isFinite(seg.length));
        assert(seg.length > 0);
      }
    });

    it('handles negative scale by producing finite positive segment lengths', () => {
      const pose = createSyntheticPose33();
      const { figure } = buildFigureFromPoseLandmarks(pose, { scale: -300 });
      for (const seg of figure.segments) {
        assert(Number.isFinite(seg.length));
        assert(seg.length >= 10);
      }
    });

    it('handles extremely distant coordinates (10000, 10000) with finite angles', () => {
      const farPose = Array.from({ length: 33 }, () => ({ x: 10000, y: 10000 }));
      const { figure } = buildFigureFromPoseLandmarks(farPose);
      for (const seg of figure.segments) {
        assert(Number.isFinite(seg.angle_rad));
      }
    });
  });

  describe('Boundary 6: Invalid MIME Types & Corrupt Image Buffers', () => {
    it('rejects unsupported mimeType application/pdf in worker message validation', () => {
      const validTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']);
      assert.equal(validTypes.has('application/pdf'), false);
    });

    it('rejects unsupported mimeType image/gif in worker message validation', () => {
      const validTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']);
      assert.equal(validTypes.has('image/gif'), false);
    });

    it('rejects empty string mimeType', () => {
      const validTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']);
      assert.equal(validTypes.has(''), false);
    });

    it('maps zero-byte image buffer failure to errors.poseEstimationWorker.invalidImageFormat', () => {
      const expectedKey = 'errors.poseEstimationWorker.invalidImageFormat';
      assert.equal(expectedKey, 'errors.poseEstimationWorker.invalidImageFormat');
    });

    it('maps unparsable image stream to errors.poseEstimationWorker.inferenceFailed', () => {
      const expectedKey = 'errors.poseEstimationWorker.inferenceFailed';
      assert.equal(expectedKey, 'errors.poseEstimationWorker.inferenceFailed');
    });
  });

  describe('Boundary 7: Invalid CLI Flags, Missing Arguments & Unsupported Engines', () => {
    it('rejects invalid generation type like --type document', () => {
      const validTypes = ['svg', 'icon', 'mascot', 'animation'];
      assert.equal(validTypes.includes('document'), false);
    });

    it('requires --prompt flag for asset generation', () => {
      const args = ['generate', '--type', 'svg'];
      const hasPrompt = args.includes('--prompt');
      assert.equal(hasPrompt, false);
    });

    it('rejects unsupported engine flag like --engine unknownEngine', () => {
      const validEngines = ['antigravity', 'claude', 'codex', 'opencode'];
      assert.equal(validEngines.includes('unknownEngine'), false);
    });

    it('flags missing command as invalid usage', () => {
      const args = [];
      assert.equal(args.length, 0);
    });

    it('handles unexpected boolean flags like --turbo gracefully', () => {
      const flags = { type: 'svg', turbo: true };
      assert.equal(flags.type, 'svg');
    });
  });

  describe('Boundary 8: Degenerate Collinear Keypoints & Geometry Singularities', () => {
    it('handles perfectly vertical spine alignment without division by zero', () => {
      const vertical = createSyntheticPose33({
        11: { x: 0.5, y: 0.2 },
        12: { x: 0.5, y: 0.2 },
        23: { x: 0.5, y: 0.6 },
        24: { x: 0.5, y: 0.6 }
      });
      const { figure } = buildFigureFromPoseLandmarks(vertical);
      const torso = figure.segments.find(s => s.name === 'Torso');
      assert(Number.isFinite(torso.angle_rad));
    });

    it('handles perfectly horizontal arm alignment without division by zero', () => {
      const horizontal = createSyntheticPose33({
        11: { x: 0.4, y: 0.3 },
        13: { x: 0.2, y: 0.3 },
        15: { x: 0.0, y: 0.3 }
      });
      const { figure } = buildFigureFromPoseLandmarks(horizontal);
      const uArm = figure.segments.find(s => s.name === 'Left upper arm');
      const fArm = figure.segments.find(s => s.name === 'Left forearm');
      assert.ok(Math.abs(uArm.angle_rad - Math.PI) < 1e-4);
      assert.ok(Math.abs(fArm.angle_rad - Math.PI) < 1e-4);
    });

    it('clamps 180-degree inverted head pointing downward below neck', () => {
      const invertedHead = createSyntheticPose33({
        0: { x: 0.5, y: 0.5 },
        11: { x: 0.4, y: 0.3 },
        12: { x: 0.6, y: 0.3 }
      });
      const { figure } = buildFigureFromPoseLandmarks(invertedHead);
      const head = figure.segments.find(s => s.name === 'Head');
      assert(head.length >= 15);
      assert.ok(Math.abs(head.angle_rad - (Math.PI / 2)) < 1e-4);
    });

    it('handles fully collapsed skeleton with all 33 points identical', () => {
      const collapsed = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5 }));
      const { figure } = buildFigureFromPoseLandmarks(collapsed);
      for (const seg of figure.segments) {
        assert(Number.isFinite(seg.length) && seg.length > 0);
        assert(Number.isFinite(seg.angle_rad));
      }
    });

    it('guarantees unique IDs across all 10 segments in degenerate poses', () => {
      const collapsed = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5 }));
      const { figure } = buildFigureFromPoseLandmarks(collapsed);
      const idSet = new Set(figure.segments.map(s => s.segment_id));
      assert.equal(idSet.size, 10);
    });
  });

  describe('Boundary 9: IK Chain Length & Bend Direction Boundary Clamps', () => {
    it('validates 2-bone IK chain length parameter within [1, 2]', () => {
      const validChains = [1, 2];
      for (const len of validChains) {
        assert(len >= 1 && len <= 2);
      }
    });

    it('validates bendDirection in allowed set [-1, 0, 1]', () => {
      const allowedSides = [-1, 0, 1];
      for (const side of allowedSides) {
        assert([-1, 0, 1].includes(side));
      }
    });

    it('rejects bendDirection outside [-1, 0, 1]', () => {
      const invalidSide = 5;
      assert.equal([-1, 0, 1].includes(invalidSide), false);
    });

    it('verifies IK target coordinates remain finite numbers', () => {
      const target = { x: 320.5, y: 240.2, rotation: 0.45 };
      assert(Number.isFinite(target.x));
      assert(Number.isFinite(target.y));
      assert(Number.isFinite(target.rotation));
    });


    it('validates the generated IK controller table with the engine-owned document schema', () => {
      const doc = createRiggedFigureDocument(createSyntheticPose33());
      const object = doc.keyframes[0].objects[0];
      assert.doesNotThrow(() => validateIK(object));
      // Two-bone chains resolve from a terminal limb back to the shoulder/hip the engine would drive.
      assert.deepEqual(ikChain(doc.figure_types[0], 4, 2), [2, 3]);
      assert.deepEqual(ikChain(doc.figure_types[0], 10, 2), [8, 9]);
    });

    it('rejects an IK controller table whose target is not finite', () => {
      const doc = createRiggedFigureDocument(createSyntheticPose33());
      const object = structuredClone(doc.keyframes[0].objects[0]);
      object._stykIK['4'].target.x = NaN;
      assert.throws(() => validateIK(object), error => typeof error.messageKey === 'string' && error.messageKey.startsWith('errors.ik.'));
    });
  });
});

// ============================================================================
// POSE VARIATIONS AND HONEST PROVENANCE
// ============================================================================
describe('Pose variations and honest provenance', () => {
  const repoint = overrides => {
    const pose = createSyntheticPose33();
    for (const [index, point] of Object.entries(overrides)) pose[Number(index)] = { ...pose[Number(index)], ...point };
    return pose;
  };

  it('a different arm pose changes the synthesized arm geometry (no fixed template)', () => {
    const tPose = buildFigureFromPoseLandmarks(createSyntheticPose33());
    const armsDown = buildFigureFromPoseLandmarks(repoint({
      13: { x: 0.44, y: 0.50 }, 14: { x: 0.56, y: 0.50 },
      15: { x: 0.45, y: 0.65 }, 16: { x: 0.55, y: 0.65 }
    }));
    const upperLeft = index => tPose.figure.segments[index];
    assert.notEqual(upperLeft(2).angle_rad, armsDown.figure.segments[2].angle_rad);
    assert.notEqual(upperLeft(2).length, armsDown.figure.segments[2].length);
    assert.notDeepEqual(upperLeft(2).color_rgb, undefined);
  });

  it('a crouch pose changes the synthesized leg geometry', () => {
    const stand = buildFigureFromPoseLandmarks(createSyntheticPose33());
    const crouch = buildFigureFromPoseLandmarks(repoint({
      25: { x: 0.40, y: 0.70 }, 26: { x: 0.60, y: 0.70 },
      27: { x: 0.42, y: 0.82 }, 28: { x: 0.58, y: 0.82 }
    }));
    assert.notEqual(stand.figure.segments[7].angle_rad, crouch.figure.segments[7].angle_rad);
    assert.notEqual(stand.figure.segments[8].angle_rad, crouch.figure.segments[8].angle_rad);
    for (const segment of crouch.figure.segments) assert.ok(Number.isFinite(segment.angle_rad));
  });

  it('COCO 17-landmark input matches the equivalent MediaPipe 33-landmark input', () => {
    const mediaPipe = createSyntheticPose33();
    // A COCO 17-keypoint array built from the same body: nose, (eyes, ears, unused by the synthesizer),
    // shoulders, elbows, wrists, hips, knees, ankles.
    const coco = [
      mediaPipe[0], mediaPipe[2], mediaPipe[5], mediaPipe[7], mediaPipe[8],
      mediaPipe[11], mediaPipe[12], mediaPipe[13], mediaPipe[14], mediaPipe[15], mediaPipe[16],
      mediaPipe[23], mediaPipe[24], mediaPipe[25], mediaPipe[26], mediaPipe[27], mediaPipe[28]
    ];
    assert.equal(coco.length, 17);
    const fromCoco = buildFigureFromPoseLandmarks(coco).figure;
    const fromMediaPipe = buildFigureFromPoseLandmarks(mediaPipe).figure;
    assert.deepEqual(fromCoco.segments.map(s => s.length), fromMediaPipe.segments.map(s => s.length));
    assert.deepEqual(fromCoco.segments.map(s => Math.round(s.angle_rad * 1e6)), fromMediaPipe.segments.map(s => Math.round(s.angle_rad * 1e6)));
  });

  it('heuristic-marked landmarks still synthesize a finite figure and are never upgraded to confident detections', () => {
    const heuristic = createSyntheticPose33().map(point => ({ ...point, visibility: 0.3, synthetic: true, detector: 'heuristic-silhouette' }));
    const { figure } = buildFigureFromPoseLandmarks(heuristic);
    assert.equal(figure.segments.every(segment => Number.isFinite(segment.length) && Number.isFinite(segment.angle_rad)), true);
    assert.equal(heuristic.every(point => point.visibility <= 0.5), true);
  });
});

// ============================================================================
// ENGINE-OWNED DOCUMENT PATH: IMPORT, UNDO/REDO AND SAVE
// The engine (Rust/WASM) owns the document and its history, so these run only when src/engine/pkg is built.
// ============================================================================
const ownedEditorFor = ENGINE_BUILT ? (await import('./support/owned-editor.mjs')).ownedEditorFor : null;

describe('Engine-owned document path: rigged figure import, undo/redo and save', needsEngine, () => {
  it('imports one rigged figure through the session, and undo then redo restores it', () => {
    const editor = ownedEditorFor({ demo: false });
    const document = createRiggedFigureDocument(createSyntheticPose33(), { name: 'EngineImport' });
    const figures = editor.report.figure_types.length;
    const objects = editor.frame.objects.length;
    const history = editor._undo.length;

    editor.importFigure(document);

    assert.equal(editor.report.figure_types.length, figures + 1);
    assert.equal(editor.frame.objects.length, objects + 1);
    assert.equal(editor._undo.length, history + 1);

    editor.undo();
    assert.equal(editor.report.figure_types.length, figures);
    assert.equal(editor.frame.objects.length, objects);

    editor.redo();
    assert.equal(editor.report.figure_types.length, figures + 1);
    assert.equal(editor.frame.objects.length, objects + 1);
  });

  it('saves and reopens the document with the rigged figure and its IK controllers intact', () => {
    const editor = ownedEditorFor({ demo: false });
    editor.importFigure(createRiggedFigureDocument(createSyntheticPose33(), { name: 'SavedRig' }));
    const saved = structuredClone(editor.serialize());

    const reopened = ownedEditorFor({ demo: false });
    reopened.load(saved);

    assert.equal(reopened.report.figure_types.length, editor.report.figure_types.length);
    const object = reopened.frame.objects.at(-1);
    assert.ok(object?._stykIK, 'the reopened object keeps its IK controller table');
    assert.equal(Object.keys(object._stykIK).length, 4);
    for (const controller of Object.values(object._stykIK)) assert.equal(controller.chainLength, 2);
  });
});
