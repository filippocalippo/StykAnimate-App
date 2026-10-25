/**
 * StykAnimate Pose Topology Synthesizer
 * Maps MediaPipe 33-landmark or COCO 17-landmark coordinates into
 * a native StykAnimate figure definition with 2-bone IK handles.
 */

/**
 * Calculates Euclidean distance between two 2D points.
 */
function distance(p1, p2) {
  return Math.hypot(p2.x - p1.x, p2.y - p1.y);
}

/**
 * Calculates 2D angle from p1 to p2 in radians.
 */
function angleRad(p1, p2) {
  return Math.atan2(p2.y - p1.y, p2.x - p1.x);
}

/**
 * Midpoint between two 2D points.
 */
function midpoint(p1, p2) {
  return {
    x: (p1.x + p2.x) / 2,
    y: (p1.y + p2.y) / 2
  };
}

/**
 * Transforms normalized pose landmarks ([0,1]) to StykAnimate native segment tree.
 * @param {Array<{x: number, y: number, score?: number}>} landmarks - MediaPipe (33) or COCO (17) points.
 * @param {Object} [options]
 * @param {number} [options.scale=300] - Scale multiplier for world units.
 * @param {string} [options.name='AutoRig'] - Name of the generated figure.
 * @param {Array<number>} [options.color=[13, 153, 255]] - RGB segment color.
 * @returns {{figure: Object, ikSetup: Array<Object>}}
 */
export function buildFigureFromPoseLandmarks(landmarks, options = {}) {
  if (!Array.isArray(landmarks) || landmarks.length < 17) {
    throw new TypeError('Invalid pose landmarks: expected at least 17 keypoints.');
  }

  const scale = options.scale || 300;
  const figureName = options.name || 'AutoRig';
  const color = options.color || [13, 153, 255];

  // Resolve landmarks (MediaPipe indices 0-32 or COCO 0-16)
  const isMediaPipe = landmarks.length >= 33;
  const nose = landmarks[0];
  const lShoulder = landmarks[isMediaPipe ? 11 : 5];
  const rShoulder = landmarks[isMediaPipe ? 12 : 6];
  const lElbow = landmarks[isMediaPipe ? 13 : 7];
  const rElbow = landmarks[isMediaPipe ? 14 : 8];
  const lWrist = landmarks[isMediaPipe ? 15 : 9];
  const rWrist = landmarks[isMediaPipe ? 16 : 10];
  const lHip = landmarks[isMediaPipe ? 23 : 11];
  const rHip = landmarks[isMediaPipe ? 24 : 12];
  const lKnee = landmarks[isMediaPipe ? 25 : 13];
  const rKnee = landmarks[isMediaPipe ? 26 : 14];
  const lAnkle = landmarks[isMediaPipe ? 27 : 15];
  const rAnkle = landmarks[isMediaPipe ? 28 : 16];

  // Scaled coordinates
  const toWorld = pt => ({ x: pt.x * scale, y: pt.y * scale });

  const pRoot = toWorld(midpoint(lHip, rHip));
  const pNeck = toWorld(midpoint(lShoulder, rShoulder));
  const pHead = toWorld(nose);
  const pLShoulder = toWorld(lShoulder);
  const pRShoulder = toWorld(rShoulder);
  const pLElbow = toWorld(lElbow);
  const pRElbow = toWorld(rElbow);
  const pLWrist = toWorld(lWrist);
  const pRWrist = toWorld(rWrist);
  const pLHip = toWorld(lHip);
  const pRHip = toWorld(rHip);
  const pLKnee = toWorld(lKnee);
  const pRKnee = toWorld(rKnee);
  const pLAnkle = toWorld(lAnkle);
  const pRAnkle = toWorld(rAnkle);

  // Construct segments conforming to StykAnimate figure definition schema
  const segments = [
    // 1: Torso (parent 0 = root)
    {
      segment_id: 1,
      parent_id: 0,
      name: 'Torso',
      length: Math.max(10, Math.round(distance(pRoot, pNeck))),
      angle_rad: angleRad(pRoot, pNeck),
      thickness: 16,
      bend_rad: 0,
      primitive_code: 0,
      aux_code: 0,
      flags: 0,
      segment_type: 'line',
      segment_kind: 'line',
      color_rgb: [...color],
      transparency: 0,
      visible: true,
      z_order: 1
    },
    // 2: Head (circle fill, attached to Torso)
    {
      segment_id: 2,
      parent_id: 1,
      name: 'Head',
      length: Math.max(15, Math.round(distance(pNeck, pHead) * 1.5)),
      angle_rad: angleRad(pNeck, pHead),
      thickness: 0,
      bend_rad: 0,
      primitive_code: 3,
      aux_code: 0,
      flags: 3,
      segment_type: 'circle',
      segment_kind: 'circleFill',
      color_rgb: [...color],
      transparency: 0,
      visible: true,
      z_order: 2
    },
    // 3: Left Upper Arm
    {
      segment_id: 3,
      parent_id: 1,
      name: 'Left upper arm',
      length: Math.max(10, Math.round(distance(pLShoulder, pLElbow))),
      angle_rad: angleRad(pLShoulder, pLElbow),
      thickness: 12,
      bend_rad: 0,
      primitive_code: 0,
      aux_code: 0,
      flags: 0,
      segment_type: 'line',
      segment_kind: 'line',
      color_rgb: [...color],
      transparency: 0,
      visible: true,
      z_order: 3
    },
    // 4: Left Forearm (IK End Effector)
    {
      segment_id: 4,
      parent_id: 3,
      name: 'Left forearm',
      length: Math.max(10, Math.round(distance(pLElbow, pLWrist))),
      angle_rad: angleRad(pLElbow, pLWrist),
      thickness: 12,
      bend_rad: 0,
      primitive_code: 0,
      aux_code: 0,
      flags: 0,
      segment_type: 'line',
      segment_kind: 'line',
      color_rgb: [...color],
      transparency: 0,
      visible: true,
      z_order: 4
    },
    // 5: Right Upper Arm
    {
      segment_id: 5,
      parent_id: 1,
      name: 'Right upper arm',
      length: Math.max(10, Math.round(distance(pRShoulder, pRElbow))),
      angle_rad: angleRad(pRShoulder, pRElbow),
      thickness: 12,
      bend_rad: 0,
      primitive_code: 0,
      aux_code: 0,
      flags: 0,
      segment_type: 'line',
      segment_kind: 'line',
      color_rgb: [...color],
      transparency: 0,
      visible: true,
      z_order: 5
    },
    // 6: Right Forearm (IK End Effector)
    {
      segment_id: 6,
      parent_id: 5,
      name: 'Right forearm',
      length: Math.max(10, Math.round(distance(pRElbow, pRWrist))),
      angle_rad: angleRad(pRElbow, pRWrist),
      thickness: 12,
      bend_rad: 0,
      primitive_code: 0,
      aux_code: 0,
      flags: 0,
      segment_type: 'line',
      segment_kind: 'line',
      color_rgb: [...color],
      transparency: 0,
      visible: true,
      z_order: 6
    },
    // 7: Left Thigh (attached to root)
    {
      segment_id: 7,
      parent_id: 0,
      name: 'Left thigh',
      length: Math.max(12, Math.round(distance(pLHip, pLKnee))),
      angle_rad: angleRad(pLHip, pLKnee),
      thickness: 14,
      bend_rad: 0,
      primitive_code: 0,
      aux_code: 0,
      flags: 0,
      segment_type: 'line',
      segment_kind: 'line',
      color_rgb: [...color],
      transparency: 0,
      visible: true,
      z_order: 7
    },
    // 8: Left Lower Leg (IK End Effector)
    {
      segment_id: 8,
      parent_id: 7,
      name: 'Left lower leg',
      length: Math.max(12, Math.round(distance(pLKnee, pLAnkle))),
      angle_rad: angleRad(pLKnee, pLAnkle),
      thickness: 14,
      bend_rad: 0,
      primitive_code: 0,
      aux_code: 0,
      flags: 0,
      segment_type: 'line',
      segment_kind: 'line',
      color_rgb: [...color],
      transparency: 0,
      visible: true,
      z_order: 8
    },
    // 9: Right Thigh (attached to root)
    {
      segment_id: 9,
      parent_id: 0,
      name: 'Right thigh',
      length: Math.max(12, Math.round(distance(pRHip, pRKnee))),
      angle_rad: angleRad(pRHip, pRKnee),
      thickness: 14,
      bend_rad: 0,
      primitive_code: 0,
      aux_code: 0,
      flags: 0,
      segment_type: 'line',
      segment_kind: 'line',
      color_rgb: [...color],
      transparency: 0,
      visible: true,
      z_order: 9
    },
    // 10: Right Lower Leg (IK End Effector)
    {
      segment_id: 10,
      parent_id: 9,
      name: 'Right lower leg',
      length: Math.max(12, Math.round(distance(pRKnee, pRAnkle))),
      angle_rad: angleRad(pRKnee, pRAnkle),
      thickness: 14,
      bend_rad: 0,
      primitive_code: 0,
      aux_code: 0,
      flags: 0,
      segment_type: 'line',
      segment_kind: 'line',
      color_rgb: [...color],
      transparency: 0,
      visible: true,
      z_order: 10
    }
  ];

  const figure = {
    figure_type_id: 1,
    name: figureName,
    segment_count: segments.length,
    segments,
    polyfills: [],
    image_assets: [],
    text_assets: []
  };

  // Pre-configured 2-bone IK handles matching StykAnimate's conventions
  const ikSetup = [
    { segment_id: 4, name: 'Left forearm', chainLength: 2, enabled: true, pinned: false, bendDirection: 0 },
    { segment_id: 6, name: 'Right forearm', chainLength: 2, enabled: true, pinned: false, bendDirection: 0 },
    { segment_id: 8, name: 'Left lower leg', chainLength: 2, enabled: true, pinned: false, bendDirection: 0 },
    { segment_id: 10, name: 'Right lower leg', chainLength: 2, enabled: true, pinned: false, bendDirection: 0 }
  ];

  return { figure, ikSetup, rootPosition: pRoot };
}
