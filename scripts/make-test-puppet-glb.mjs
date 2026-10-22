/** Writes a small skinned humanoid .glb (17 joints, 12 boxes, 4 flat colours,
 * blended torso/limb weights) for testing scripts/glb-to-styk.mjs without Blender.
 *   node scripts/make-test-puppet-glb.mjs puppet.glb */
import {writeFile} from 'node:fs/promises';

const joints = [ // name, parent, world position (metres, y up, facing +z)
  ['Hips', -1, [0, .95, 0]], ['Spine', 0, [0, 1.1, 0]], ['Chest', 1, [0, 1.3, 0]], ['Neck', 2, [0, 1.5, 0]], ['Head', 3, [0, 1.6, 0]],
  ['Shoulder.L', 2, [.22, 1.45, 0]], ['Elbow.L', 5, [.22, 1.2, 0]], ['Wrist.L', 6, [.22, .95, 0]],
  ['Shoulder.R', 2, [-.22, 1.45, 0]], ['Elbow.R', 8, [-.22, 1.2, 0]], ['Wrist.R', 9, [-.22, .95, 0]],
  ['Thigh.L', 0, [.1, .95, 0]], ['Knee.L', 11, [.1, .5, 0]], ['Ankle.L', 12, [.1, .1, 0]],
  ['Thigh.R', 0, [-.1, .95, 0]], ['Knee.R', 14, [-.1, .5, 0]], ['Ankle.R', 15, [-.1, .1, 0]]];
const J = Object.fromEntries(joints.map((j, i) => [j[0], i]));
const lin = c => { c /= 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; };
const colors = {skin: [240, 180, 130], gi: [235, 105, 15], blue: [35, 95, 180], dark: [30, 30, 40]};
const materials = Object.entries(colors).map(([name, c]) => ({name, pbrMetallicRoughness: {baseColorFactor: [...c.map(lin), 1], metallicFactor: 0, roughnessFactor: 1}}));
const matIndex = Object.keys(colors);
const ramp = (y, stops) => { // stops: [[y, jointName], ...] ascending y -> two-bone linear blend
  if (y <= stops[0][0]) return [[J[stops[0][1]], 1]];
  for (let i = 1; i < stops.length; i++) if (y <= stops[i][0]) { const t = (y - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]); return [[J[stops[i - 1][1]], 1 - t], [J[stops[i][1]], t]]; }
  return [[J[stops.at(-1)[1]], 1]];
};
const boxes = [
  ['Torso', 'gi', [-.18, .18, .95, 1.5, -.1, .1], 8, y => ramp(y, [[.95, 'Hips'], [1.1, 'Spine'], [1.3, 'Chest']])],
  ['Head', 'skin', [-.1, .1, 1.5, 1.8, -.1, .1], 3, () => [[J.Head, 1]]],
  ...['L', 'R'].flatMap(s => { const x = s === 'L' ? .22 : -.22;
    return [[`UpperArm.${s}`, 'gi', [x - .05, x + .05, 1.2, 1.45, -.05, .05], 4, y => y > 1.3 ? [[J[`Shoulder.${s}`], 1]] : ramp(-y, [[-1.3, `Shoulder.${s}`], [-1.2, `Elbow.${s}`]]).map(([j, w]) => [j, w])],
      [`Forearm.${s}`, 'skin', [x - .045, x + .045, .95, 1.2, -.045, .045], 3, () => [[J[`Elbow.${s}`], 1]]],
      [`Hand.${s}`, 'skin', [x - .05, x + .05, .87, .95, -.05, .05], 1, () => [[J[`Wrist.${s}`], 1]]]]; }),
  ...['L', 'R'].flatMap(s => { const x = s === 'L' ? .1 : -.1;
    return [[`Thigh.${s}`, 'blue', [x - .07, x + .07, .5, .95, -.07, .07], 5, y => y > .6 ? [[J[`Thigh.${s}`], 1]] : ramp(-y, [[-.6, `Thigh.${s}`], [-.5, `Knee.${s}`]])],
      [`Shin.${s}`, 'blue', [x - .06, x + .06, .1, .5, -.06, .06], 4, () => [[J[`Knee.${s}`], 1]]],
      [`Foot.${s}`, 'dark', [x - .06, x + .06, 0, .1, -.06, .2], 1, () => [[J[`Ankle.${s}`], 1]]]]; }),
];

function buildBox([name, mat, [x0, x1, y0, y1, z0, z1], n, weightsAt]) {
  const pos = [], jn = [], wt = [], tri = [], corner = [[x0, z1], [x1, z1], [x1, z0], [x0, z0]];
  for (let s = 0; s <= n; s++) {
    const y = y0 + (y1 - y0) * s / n, w = weightsAt(y);
    for (const [x, z] of corner) { pos.push(x, y, z); const a = [...w, [0, 0], [0, 0], [0, 0], [0, 0]].slice(0, 4); jn.push(...a.map(e => w.length && e[1] ? e[0] : 0)); wt.push(...a.map(e => e[1])); }
  }
  const q = (a, b, c, d) => tri.push([a, b, c], [a, c, d]);
  for (let s = 0; s < n; s++) for (let k = 0; k < 4; k++) q(s * 4 + k, s * 4 + (k + 1) % 4, (s + 1) * 4 + (k + 1) % 4, (s + 1) * 4 + k);
  tri.push([0, 1, 2], [0, 2, 3], [n * 4, n * 4 + 1, n * 4 + 2], [n * 4, n * 4 + 2, n * 4 + 3]);
  const center = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], index = [];
  for (const [a, b, c] of tri) { // make every face wind counter-clockwise seen from outside
    const P = i => pos.slice(i * 3, i * 3 + 3), pa = P(a), pb = P(b), pc = P(c);
    const u = pb.map((v, i) => v - pa[i]), v = pc.map((n2, i) => n2 - pa[i]), nrm = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const out = pa.map((_, i) => (pa[i] + pb[i] + pc[i]) / 3 - center[i]);
    index.push(...(nrm[0] * out[0] + nrm[1] * out[1] + nrm[2] * out[2] >= 0 ? [a, b, c] : [a, c, b]));
  }
  return {name, material: matIndex.indexOf(mat), pos, jn, wt, index};
}

const chunks = [], views = [], accessors = [];
const push = (typed, target) => {
  let bytes = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
  const pad = (4 - bytes.length % 4) % 4, offset = chunks.reduce((s, c) => s + c.length, 0);
  chunks.push(Buffer.concat([bytes, Buffer.alloc(pad)]));
  views.push({buffer: 0, byteOffset: offset, byteLength: bytes.length, ...(target ? {target} : {})});
  return views.length - 1;
};
const accessor = (typed, componentType, type, count, extra = {}, target) => { accessors.push({bufferView: push(typed, target), componentType, type, count, ...extra}); return accessors.length - 1; };

const nodes = joints.map(([name, parent, p], i) => { const q = parent >= 0 ? joints[parent][2] : [0, 0, 0]; return {name, translation: p.map((v, k) => v - q[k]), children: []}; });
joints.forEach(([, parent], i) => { if (parent >= 0) nodes[parent].children.push(i); });
const ibm = new Float32Array(joints.length * 16);
joints.forEach(([, , p], i) => { ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -p[0], -p[1], -p[2], 1], i * 16); });
const ibmAccessor = accessor(ibm, 5126, 'MAT4', joints.length);
const meshes = [], meshNodes = [];
for (const spec of boxes) {
  const b = buildBox(spec), count = b.pos.length / 3;
  const lo = [0, 1, 2].map(k => Math.min(...b.pos.filter((_, i) => i % 3 === k))), hi = [0, 1, 2].map(k => Math.max(...b.pos.filter((_, i) => i % 3 === k)));
  const attributes = {POSITION: accessor(new Float32Array(b.pos), 5126, 'VEC3', count, {min: lo, max: hi}, 34962),
    JOINTS_0: accessor(new Uint8Array(b.jn), 5121, 'VEC4', count, {}, 34962), WEIGHTS_0: accessor(new Float32Array(b.wt), 5126, 'VEC4', count, {}, 34962)};
  const indices = accessor(new Uint16Array(b.index), 5123, 'SCALAR', b.index.length, {}, 34963);
  meshes.push({name: b.name, primitives: [{attributes, indices, material: b.material}]});
}
const jointCount = joints.length, rootIndices = [0];
meshes.forEach((m, i) => meshNodes.push({name: m.name, mesh: i, skin: 0}));
const all = [...nodes, ...meshNodes], armature = {name: 'Armature', children: [0, ...meshNodes.map((_, i) => jointCount + i)]};
const gltf = {asset: {version: '2.0', generator: 'make-test-puppet-glb'}, scene: 0, scenes: [{nodes: [all.length]}], nodes: [...all, armature],
  skins: [{joints: joints.map((_, i) => i), inverseBindMatrices: ibmAccessor, skeleton: 0}], meshes, materials, accessors, bufferViews: views,
  buffers: [{byteLength: chunks.reduce((s, c) => s + c.length, 0)}]};
void rootIndices;
const bin = Buffer.concat(chunks);
let json = Buffer.from(JSON.stringify(gltf)); json = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)]);
const head = Buffer.alloc(12); head.writeUInt32LE(0x46546C67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
const chunk = (type, data) => { const h = Buffer.alloc(8); h.writeUInt32LE(data.length, 0); h.writeUInt32LE(type, 4); return Buffer.concat([h, data]); };
const out = process.argv[2] ?? 'puppet.glb';
await writeFile(out, Buffer.concat([head, chunk(0x4E4F534A, json), chunk(0x004E4942, bin)]));
console.log(`wrote ${out}: ${joints.length} joints, ${boxes.length} meshes`);
