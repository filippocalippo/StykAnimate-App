import {JOINTS, POSES} from './rig.mjs';
import {EASINGS} from './spec.mjs';

export const GUIDE = `# Writing a StykAnimate animation spec

Workflow: build_animation → preview_frames (look, fix, rebuild) → export_video {preset:"shorts"} → save_project.

## Canvas and time
- Default canvas 540×960 (vertical 9:16). Export preset "shorts" scales it to 1080×1920 without loss (vectors).
- Coordinates are canvas pixels; x grows right, y grows DOWN. Centre of the default canvas is (270, 480).
- fps defaults to 24. A keyframe's "hold" is the number of frames until the next keyframe (12 = 0.5 s).
  The last keyframe holds for its own "hold". Total length = sum of holds.
- Motion between keyframes tweens automatically ("ease": ${Object.keys(EASINGS).join(', ')}; default auto).
  Use "constant" for an instant cut, "ease-out" for a snappy arrival.

## Cast
Declare every figure once in "cast"; keyframes then say where each one is.
- stickman: color, thickness (weight multiplier), headColor, headFilled. About 250 px tall at scale 1
  (hip to head top ≈ 122 px, hip to feet ≈ 125 px). scale 1.3 suits the 540×960 canvas.
- line: length, thickness, color. Placed by its start point; good for floors and walls.
- circle: radius, color, filled (default true). Placed by its centre.
- text: text, fontSize, bold, italic, align, color, outline, outlineColor. Placed by its centre.
  Text cannot change; use one cast member per caption and hide/show them.
- file: path to a Pivot .stk figure (e.g. from the community library); placed by its root.

## Keyframes
"figures" maps a cast id to changes. Anything left out carries over from the previous keyframe, so a
keyframe only lists what moves. A figure appears from the first keyframe that names it; {"hide": true}
removes it. Fields: x, y, ground, pose, joints, lean, flip, scale, rotate, opacity, hide.
- ground: stand the stickman on this y (feet on the floor whatever the pose). Use the floor line's y.
- pose: one of the library poses below. Poses face RIGHT; add "flip": true to face left (flip carries over).
- joints: absolute angles in degrees over the pose: 0 = right, 90 = down, -90 = up, 180 = left.
  Joints: ${JOINTS.join(', ')}.
  "right"/"left" mean the screen side in the rest pose. Each angle is the direction of that bone on screen,
  not relative to its parent: turning the upper arm does not turn the forearm.
- lean: tilt the upper body forward (positive) or back (negative), in degrees.
- camera (per keyframe, carries over): {x, y, zoom, rotate}; x/y is the canvas point at the centre of the shot.
  zoom 1.5 = closer. Tweens like figures. Reset with {"x":270,"y":480,"zoom":1}.
- background: a hex colour from this keyframe on.

## Pose library
${Object.keys(POSES).join(', ')}
- Walk cycle (facing right): walk_contact_a → walk_pass_a → walk_contact_b → walk_pass_b, hold 6 each,
  moving x about 30–40 px per keyframe at scale 1.3, ease "linear".
- Run: run_a ↔ run_b, hold 4–5, x +60 px per keyframe, ease "linear".
- Wave: alternate wave_a and wave_b, hold 6.
- Talking: alternate small joint changes (forearm ±15°) or between point/shrug/think every 12–18 frames.
- Jump: crouch (hold 6) → jump with smaller ground (y up 80–120 px, hold 8, ease-out) → crouch → stand.

## Audio
"audio": [{"path": "/abs/voice.mp3", "start": 0}] adds voiceover or music; the animation is lengthened to the
end of the audio unless "extendToAudio": false. Time keyframe holds to the script: at 24 fps,
seconds × 24 = frames.

## Example
{"title":"Hi","background":"#f4f1ea",
 "cast":[{"id":"floor","kind":"line","length":540},{"id":"bob","kind":"stickman"},
         {"id":"cap","kind":"text","text":"Hello!","fontSize":64,"bold":true,"color":"#1c7ed6"}],
 "keyframes":[
  {"hold":12,"figures":{"floor":{"x":0,"y":760},"bob":{"x":200,"ground":760,"pose":"stand","scale":1.3}}},
  {"hold":6,"figures":{"bob":{"pose":"wave_a"},"cap":{"x":270,"y":300}}},
  {"hold":6,"figures":{"bob":{"pose":"wave_b"}}},
  {"hold":12,"ease":"ease-out","figures":{"bob":{"pose":"arms_up"}},"camera":{"x":220,"y":600,"zoom":1.4}}]}
`;
