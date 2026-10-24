// The stickman rig and its named poses.
//
// The rig is the app's own default "Walker" figure (src/demo.mjs). Its joint
// angles are absolute screen angles in degrees: 0 points right, 90 down,
// -90 up and 180 left. "right" and "left" name the side of the screen a limb
// is on in the rest pose, so a figure facing right swings its "right" leg
// forward. `flip` mirrors a pose to face left.

export const JOINTS = Object.freeze([
  'torso', 'head',
  'rightUpperArm', 'rightForearm', 'leftUpperArm', 'leftForearm',
  'rightThigh', 'rightShin', 'leftThigh', 'leftShin',
]);

// Upper body joints rotate with `lean`; the arms hang from the neck, which moves with the torso.
const UPPER = new Set(['torso', 'head', 'rightUpperArm', 'rightForearm', 'leftUpperArm', 'leftForearm']);

const pose = (torso, head, rua, rfa, lua, lfa, rth, rsh, lth, lsh) => Object.freeze({
  torso, head, rightUpperArm: rua, rightForearm: rfa, leftUpperArm: lua, leftForearm: lfa,
  rightThigh: rth, rightShin: rsh, leftThigh: lth, leftShin: lsh,
});

// Directional poses face right; flip them to face left.
export const POSES = Object.freeze({
  rest:           pose(-90, -90,  60,  76, 116,  95,  64,  87, 115,  96),
  stand:          pose(-90, -90,  78,  86, 102,  94,  84,  90,  96,  90),
  hands_on_hips:  pose(-90, -90,  40, 140, 140,  40,  80,  90, 100,  90),
  arms_crossed:   pose(-90, -90, 120, -10,  60, 190,  84,  90,  96,  90),
  wave_a:         pose(-90, -90, -25, -95, 102,  94,  84,  90,  96,  90),
  wave_b:         pose(-90, -90, -25, -45, 102,  94,  84,  90,  96,  90),
  point:          pose(-88, -88,   0,  -5, 105,  95,  80,  90, 100,  90),
  arms_up:        pose(-90, -90, -50, -65, 230, 245,  72,  82, 108,  98),
  shrug:          pose(-90, -84,  35, -40, 145, 220,  84,  90,  96,  90),
  think:          pose(-90, -82, 115, -75, 135,  45,  84,  90,  96,  90),
  facepalm:       pose(-95,-110, 130,-105, 105,  95,  84,  90,  96,  90),
  sad:            pose(-96, -55,  88,  90,  94,  92,  86,  90,  94,  90),
  surprised:      pose(-92, -92,  20, -60, 160, 240,  75,  88, 105,  92),
  walk_contact_a: pose(-86, -86, 115, 105,  62,  45,  60,  78, 120, 102),
  walk_pass_a:    pose(-86, -86,  95,  85,  85,  70,  72, 115,  90,  90),
  walk_contact_b: pose(-86, -86,  62,  45, 115, 105, 120, 102,  60,  78),
  walk_pass_b:    pose(-86, -86,  85,  70,  95,  85,  90,  90,  72, 115),
  run_a:          pose(-68, -68, 150, 100,  25, -50,  25,  85, 135, 175),
  run_b:          pose(-68, -68,  25, -50, 150, 100, 135, 175,  25,  85),
  crouch:         pose(-80, -80,  65,  25, 115, 155,  25, 110, 155,  70),
  jump:           pose(-90, -90, -55, -70, 235, 250,  55, 115, 125,  65),
  sit:            pose(-95, -90,  75,  15, 105,  20,   0,  90,  10,  95),
  punch:          pose(-82, -82,   0,   0, 120, -40,  60,  82, 125, 100),
  kick:           pose(-115,-110, 150, 100, 200, 120, -15, -15, 100,  95),
  fall_back:      pose(-135,-150, 200, 230, 240, 260,  40,  70,  20,  50),
  lie:            pose( 180, 180, 170, 175, 185, 180,   0,   0,   5,   0),
});

/** Joint angles in degrees: a named pose, then `joints` overrides, then `lean`, then `flip`. */
export function resolveAngles({pose: name = 'stand', joints = {}, lean = 0, flip = false} = {}, previous = null) {
  let base;
  if (name === undefined || name === null) base = previous ?? POSES.stand;
  else {
    base = POSES[name];
    if (!base) throw new Error(`Unknown pose "${name}". Known poses: ${Object.keys(POSES).join(', ')}`);
  }
  const angles = {...base};
  for (const [joint, value] of Object.entries(joints ?? {})) {
    if (!JOINTS.includes(joint)) throw new Error(`Unknown joint "${joint}". Joints: ${JOINTS.join(', ')}`);
    if (!Number.isFinite(value)) throw new Error(`Joint "${joint}" needs a number of degrees`);
    angles[joint] = value;
  }
  if (lean) for (const joint of UPPER) angles[joint] += lean;
  if (flip) for (const joint of JOINTS) angles[joint] = 180 - angles[joint];
  return angles;
}

const radians = degrees => degrees * Math.PI / 180;

/** Angles in the order of the figure's segments, in radians. */
export const segmentAngles = (figure, angles) =>
  figure.segments.map((segment, index) => radians(angles[JOINTS[index]] ?? segment.angle_rad * 180 / Math.PI));

/** The lowest point the figure reaches below its root (the hip), in canvas pixels before scale. */
export function lowestPoint(figure, radiansBySegment) {
  const ends = new Map([[0, {x: 0, y: 0}]]);
  let lowest = 0;
  figure.segments.forEach((segment, index) => {
    const start = ends.get(segment.parent_id) ?? {x: 0, y: 0}, angle = radiansBySegment[index];
    const end = {x: start.x + segment.length * Math.cos(angle), y: start.y + segment.length * Math.sin(angle)};
    ends.set(segment.segment_id, end);
    lowest = Math.max(lowest, end.y + segment.thickness / 2);
  });
  return lowest;
}
