/** Convert a skinned glTF/GLB model (e.g. exported from Blender) into a
 * StykAnimate project containing one 3D spatial figure (docs/SPATIAL-MESHES.md).
 */
import {readFile, writeFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {inflateSync} from 'node:zlib';
import path from 'node:path';
import {buildContainerV2, decodeDocument} from '../src/native-container.mjs';
import {validateScene, syncDerived} from '../src/pivot/model.mjs';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';
import {MESH_LIMITS} from '../src/spatial-mesh.mjs';

const warnings = [];
const warn = text => { if (!warnings.includes(text)) warnings.push(text); };
const fail = text => { throw new Error(text); };

// ---------------------------------------------------------------- glTF input
async function loadGltf(file) {
  const bytes = await readFile(file), dir = path.dirname(file);
  let json, glbBin = null;
  if (path.extname(file).toLowerCase() === '.glb') {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint32(0, true) !== 0x46546C67 || dv.getUint32(4, true) !== 2) fail('Not a glTF 2.0 binary (.glb) file.');
    for (let at = 12; at + 8 <= bytes.length;) {
      const size = dv.getUint32(at, true), type = dv.getUint32(at + 4, true), data = bytes.subarray(at + 8, at + 8 + size);
      if (type === 0x4E4F534A) json = JSON.parse(new TextDecoder().decode(data));
      else if (type === 0x004E4942 && !glbBin) glbBin = data;
      at += 8 + size;
    }
    if (!json) fail('The .glb file has no JSON chunk.');
  } else json = JSON.parse(bytes.toString('utf8'));
  const buffers = [];
  for (const [i, b] of (json.buffers ?? []).entries()) {
    if (b.uri === undefined) buffers.push(glbBin ?? fail(`Buffer ${i} has no data.`));
    else if (b.uri.startsWith('data:')) buffers.push(Buffer.from(b.uri.slice(b.uri.indexOf(',') + 1), 'base64'));
    else buffers.push(await readFile(path.resolve(dir, decodeURIComponent(b.uri))));
  }
  return {g: json, buffers, dir};
}

const TYPE_SIZE = {SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16};
const COMPONENT = {5120: ['getInt8', 1, 127], 5121: ['getUint8', 1, 255], 5122: ['getInt16', 2, 32767], 5123: ['getUint16', 2, 65535], 5125: ['getUint32', 4, 0], 5126: ['getFloat32', 4, 0]};
function readAccessor({g, buffers}, index) {
  const a = g.accessors[index] ?? fail(`Missing accessor ${index}.`);
  const n = TYPE_SIZE[a.type], [method, size, norm] = COMPONENT[a.componentType], out = new Float64Array(a.count * n);
  if (a.bufferView !== undefined) {
    const view = g.bufferViews[a.bufferView], buf = buffers[view.buffer];
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength), base = (view.byteOffset ?? 0) + (a.byteOffset ?? 0), stride = view.byteStride || n * size;
    for (let i = 0; i < a.count; i++) for (let j = 0; j < n; j++) {
      let v = dv[method](base + i * stride + j * size, true);
      if (a.normalized && norm) v = Math.max(v / norm, -1);
      out[i * n + j] = v;
    }
  }
  if (a.sparse) {
    const sp = a.sparse, [im, isize] = COMPONENT[sp.indices.componentType], iv = g.bufferViews[sp.indices.bufferView], vv = g.bufferViews[sp.values.bufferView];
    const ib = buffers[iv.buffer], vb = buffers[vv.buffer], idv = new DataView(ib.buffer, ib.byteOffset, ib.byteLength), vdv = new DataView(vb.buffer, vb.byteOffset, vb.byteLength);
    for (let k = 0; k < sp.count; k++) {
      const at = idv[im]((iv.byteOffset ?? 0) + (sp.indices.byteOffset ?? 0) + k * isize, true);
      for (let j = 0; j < n; j++) {
        let v = vdv[method]((vv.byteOffset ?? 0) + (sp.values.byteOffset ?? 0) + (k * n + j) * size, true);
        if (a.normalized && norm) v = Math.max(v / norm, -1);
        out[at * n + j] = v;
      }
    }
  }
  return {data: out, n};
}

// ------------------------------------------------------------------- matrices
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
function invertAffine(m) {
  const [a, d, g, , b, e, h, , c, f, i, , tx, ty, tz] = m;
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g, det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-18) fail('A joint has a singular inverse-bind matrix.');
  const s = 1 / det;
  const m00 = A * s, m01 = (c * h - b * i) * s, m02 = (b * f - c * e) * s;
  const m10 = B * s, m11 = (a * i - c * g) * s, m12 = (c * d - a * f) * s;
  const m20 = C * s, m21 = (b * g - a * h) * s, m22 = (a * e - b * d) * s;
  return [m00, m10, m20, 0, m01, m11, m21, 0, m02, m12, m22, 0,
    -(m00 * tx + m01 * ty + m02 * tz), -(m10 * tx + m11 * ty + m12 * tz), -(m20 * tx + m21 * ty + m22 * tz), 1];
}
function nodeMatrix(n) {
  if (n.matrix) return n.matrix;
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1], [sx, sy, sz] = n.scale ?? [1, 1, 1], [tx, ty, tz] = n.translation ?? [0, 0, 0];
  return [(1 - 2 * (y * y + z * z)) * sx, (2 * (x * y + z * w)) * sx, (2 * (x * z - y * w)) * sx, 0,
    (2 * (x * y - z * w)) * sy, (1 - 2 * (x * x + z * z)) * sy, (2 * (y * z + x * w)) * sy, 0,
    (2 * (x * z + y * w)) * sz, (2 * (y * z - x * w)) * sz, (1 - 2 * (x * x + y * y)) * sz, 0, tx, ty, tz, 1];
}
const transformPoint = (m, x, y, z) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
const toSrgb = c => Math.round(255 * Math.max(0, Math.min(1, c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)));

// --------------------------------------------------- textures (PNG / JPEG / etc.)
function decodePng(buf) {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504E47) return null;
  let p = 8, w, h, depth, type, interlace, plte = null, trns = null; const idat = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p), kind = buf.toString('latin1', p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
    if (kind === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; type = data[9]; interlace = data[12]; }
    else if (kind === 'PLTE') plte = data; else if (kind === 'tRNS') trns = data; else if (kind === 'IDAT') idat.push(data); else if (kind === 'IEND') break;
    p += 12 + len;
  }
  const channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[type];
  if (!channels || interlace || depth > 8 || (depth < 8 && type !== 3 && type !== 0) || (type === 3 && !plte)) return null;
  const bpp = Math.max(1, Math.ceil(channels * depth / 8)), stride = Math.ceil(w * channels * depth / 8), raw = inflateSync(Buffer.concat(idat)), out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0, b = y ? out[(y - 1) * stride + x] : 0, c = x >= bpp && y ? out[(y - 1) * stride + x - bpp] : 0, v = raw[y * (stride + 1) + 1 + x];
      let r = v;
      if (ft === 1) r = v + a; else if (ft === 2) r = v + b; else if (ft === 3) r = v + ((a + b) >> 1);
      else if (ft === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      out[y * stride + x] = r & 255;
    }
  }
  const pixel = (x, y) => {
    if (type === 3 || (type === 0 && depth < 8)) {
      const bit = x * depth, byte = out[y * stride + (bit >> 3)], v = (byte >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
      if (type === 3) return [plte[v * 3], plte[v * 3 + 1], plte[v * 3 + 2]];
      const g = Math.round(v * 255 / ((1 << depth) - 1)); return [g, g, g];
    }
    const o = y * stride + x * channels;
    return type === 0 || type === 4 ? [out[o], out[o], out[o]] : [out[o], out[o + 1], out[o + 2]];
  };
  void trns;
  return {w, h, pixel};
}

function decodeImageFallback(buf) {
  try {
    const ps = `
      Add-Type -AssemblyName System.Drawing
      $ms = New-Object System.IO.MemoryStream
      [Console]::OpenStandardInput().CopyTo($ms)
      $ms.Position = 0
      $bmp = New-Object System.Drawing.Bitmap($ms)
      $w = $bmp.Width; $h = $bmp.Height
      $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
      $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
      $stride = [Math]::Abs($data.Stride)
      $bytes = New-Object byte[] ($stride * $h)
      [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
      $bmp.UnlockBits($data)
      $out = [Console]::OpenStandardOutput()
      $hdr = [BitConverter]::GetBytes([int]$w) + [BitConverter]::GetBytes([int]$h) + [BitConverter]::GetBytes([int]$stride)
      $out.Write($hdr, 0, 12)
      $out.Write($bytes, 0, $bytes.Length)
    `;
    const res = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {input: buf, maxBuffer: 128 * 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore']});
    if (res.length < 12) return null;
    const w = res.readInt32LE(0), h = res.readInt32LE(4), stride = res.readInt32LE(8), raw = res.subarray(12);
    if (w <= 0 || h <= 0 || raw.length < stride * h) return null;
    return {w, h, pixel: (x, y) => { const o = y * stride + x * 3; return [raw[o + 2], raw[o + 1], raw[o]]; }};
  } catch {
    return null;
  }
}

function getMaterialInfo(g, materialIndex) {
  const m = g.materials?.[materialIndex];
  const pbr = m?.pbrMetallicRoughness;
  const sg = m?.extensions?.KHR_materials_pbrSpecularGlossiness;
  const info = pbr?.baseColorTexture ?? sg?.diffuseTexture ?? m?.emissiveTexture ?? null;
  const rawFactor = pbr?.baseColorFactor ?? sg?.diffuseFactor ?? null;
  return {info, factor: (rawFactor ?? [1, 1, 1, 1]).slice(0, 3), flatFactor: rawFactor ?? [0.6, 0.6, 0.6, 1]};
}

const textureCache = new Map();
function loadTexture(gl, materialIndex) {
  const {g, buffers, dir} = gl, {info} = getMaterialInfo(g, materialIndex);
  if (!info) return null;
  const key = info.index;
  if (!textureCache.has(key)) {
    const image = g.images?.[g.textures?.[info.index]?.source];
    let bytes = null;
    if (image?.bufferView !== undefined) { const v = g.bufferViews[image.bufferView], b = buffers[v.buffer]; bytes = Buffer.from(b.buffer, b.byteOffset + (v.byteOffset ?? 0), v.byteLength); }
    else if (image?.uri?.startsWith('data:')) bytes = Buffer.from(image.uri.slice(image.uri.indexOf(',') + 1), 'base64');
    else if (image?.uri) { try { bytes = readFileSync(path.resolve(dir, decodeURIComponent(image.uri))); } catch {} }
    const decoded = bytes ? (decodePng(bytes) ?? decodeImageFallback(bytes)) : null;
    if (!decoded) warn(`Texture ${key} could not be decoded; the material's flat colour is used instead.`);
    textureCache.set(key, decoded);
  }
  const png = textureCache.get(key);
  return png ? {png, texCoord: info.texCoord ?? 0} : null;
}
const toLinear = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };

// ------------------------------------------------------------ finger chains
function cutChains(chains, pos, J0, W0, uv, src) {
  const P3 = [], JJ = [], WW = [], UV = [], EPS = 1e-7, dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const n0 = pos.length / 3;
  for (let v = 0; v < n0; v++) { P3.push([pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]]); JJ.push([0, 1, 2, 3].map(k => J0[v * 4 + k])); WW.push([0, 1, 2, 3].map(k => W0[v * 4 + k])); UV.push(uv ? [uv[v * 2], uv[v * 2 + 1]] : null); }
  let tris = []; for (let t = 0; t + 2 < src.length; t += 3) tris.push([src[t], src[t + 1], src[t + 2]]);
  const dominant = v => JJ[v][WW[v].indexOf(Math.max(...WW[v]))];
  for (const chain of chains) {
    const weld = new Map();
    const id = v => { const k = P3[v].map(c => Math.round(c / 1e-4)).join(); if (!weld.has(k)) weld.set(k, weld.size); return weld.get(k); };
    const parent = []; const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const vid = P3.map((_, v) => id(v)); vid.forEach(x => { parent[x] = x; });
    for (const [a, b, c] of tris) { parent[find(vid[a])] = find(vid[b]); parent[find(vid[b])] = find(vid[c]); }
    const tip = chain.points.at(-1), length = chain.points.slice(1).reduce((s, p, i) => s + Math.hypot(...sub(p, chain.points[i])), 0), seeds = new Set();
    for (let v = 0; v < n0; v++) if (dominant(v) === chain.bind && Math.hypot(...sub(P3[v], tip)) <= (chain.seedRadius ?? length * 0.2)) seeds.add(find(vid[v]));
    if (!seeds.size) { warn(`Chain "${chain.name}": no geometry found at its tip; check the points.`); continue; }
    const cand = new Set(); for (let v = 0; v < n0; v++) if (seeds.has(find(vid[v])) && dominant(v) === chain.bind) cand.add(v);
    const unit = (a, b) => { const d = sub(b, a), l = Math.hypot(...d); return d.map(x => x / l); };
    const planes = [];
    for (let k = 1; k < chain.points.length - 1; k++) { const u0 = unit(chain.points[k - 1], chain.points[k]), u1 = unit(chain.points[k], chain.points[k + 1]), n = u0.map((x, i) => x + u1[i]), l = Math.hypot(...n); planes.push({q: chain.points[k], n: n.map(x => x / l)}); }
    for (const {q, n} of planes) {
      const d = v => dot(sub(P3[v], q), n), edges = new Map(), next = [];
      const cut = (a, b) => {
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        if (!edges.has(key)) {
          const t = d(a) / (d(a) - d(b)), lerp = (x, y) => x.map((c, i) => c + (y[i] - c) * t);
          P3.push(lerp(P3[a], P3[b])); UV.push(UV[a] && UV[b] ? lerp(UV[a], UV[b]) : null); JJ.push(JJ[a].slice()); WW.push(WW[a].slice()); cand.add(P3.length - 1); edges.set(key, P3.length - 1);
        }
        return edges.get(key);
      };
      for (const tri of tris) {
        if (!tri.every(v => cand.has(v))) { next.push(tri); continue; }
        const ds = tri.map(d);
        if (ds.every(x => x >= -EPS) || ds.every(x => x <= EPS)) { next.push(tri); continue; }
        const front = [], back = [];
        for (let i = 0; i < 3; i++) {
          const u = tri[i], w = tri[(i + 1) % 3], du = ds[i], dw = ds[(i + 1) % 3];
          if (du > EPS) front.push(u); else if (du < -EPS) back.push(u); else { front.push(u); back.push(u); }
          if ((du > EPS && dw < -EPS) || (du < -EPS && dw > EPS)) { const m = cut(u, w); front.push(m); back.push(m); }
        }
        for (const poly of [front, back]) for (let i = 1; i + 1 < poly.length; i++) next.push([poly[0], poly[i], poly[i + 1]]);
      }
      tris = next;
    }
    for (const v of cand) {
      const ds = planes.map(({q, n}) => dot(sub(P3[v], q), n)), onRing = ds.findIndex(x => Math.abs(x) <= 1e-6);
      if (onRing >= 0) { JJ[v] = [chain.ids[onRing], chain.ids[onRing + 1], 0, 0]; WW[v] = [0.5, 0.5, 0, 0]; }
      else { JJ[v] = [chain.ids[ds.filter(x => x > 0).length], 0, 0, 0]; WW[v] = [1, 0, 0, 0]; }
    }
  }
  const out = {pos: new Float64Array(P3.length * 3), J0: new Float64Array(P3.length * 4), W0: new Float64Array(P3.length * 4), uv: uv ? new Float64Array(P3.length * 2) : null, src: new Float64Array(tris.length * 3)};
  P3.forEach((p, v) => { out.pos.set(p, v * 3); out.J0.set(JJ[v], v * 4); out.W0.set(WW[v], v * 4); if (uv) out.uv.set(UV[v] ?? [0, 0], v * 2); });
  tris.forEach((t, i) => out.src.set(t, i * 3));
  return out;
}

// -------------------------------------------------------------------- convert
export async function convert(file, {height = 240, origin = 'root', name, rig: rigFile, includeUnskinned = false, keepUnweighted = false, turn = 0, extra: extraFile} = {}) {
  warnings.length = 0; textureCache.clear();
  const gl = await loadGltf(file), {g} = gl, nodes = g.nodes ?? [];
  const parentOf = new Map();
  nodes.forEach((n, i) => (n.children ?? []).forEach(c => parentOf.set(c, i)));
  const worldOf = i => { let m = IDENTITY; for (let n = i; n !== undefined; n = parentOf.get(n)) m = mul(nodeMatrix(nodes[n]), m); return m; };

  const meshNodes = nodes.map((n, i) => [n, i]).filter(([n]) => n.mesh !== undefined);
  if (!meshNodes.length) fail('The model contains no meshes.');
  let joint, jointOfNode = new Map(), partBone = new Map(), J;
  if (rigFile) {
    const spec = JSON.parse(await readFile(rigFile, 'utf8')), byName = new Map(spec.bones.map((b, i) => [b.name, i]));
    if (!Array.isArray(spec.bones) || !spec.bones.length) fail('The rig file needs a "bones" list.');
    joint = spec.bones.map(b => ({node: -1, name: String(b.name), parent: b.parent == null ? -1 : (byName.get(b.parent) ?? fail(`Unknown parent "${b.parent}" in the rig file.`)), children: [], pos: b.origin, tip: b.tip}));
    spec.bones.forEach((b, i) => (b.parts ?? []).forEach(part => {
      let node;
      if (typeof part === 'number') node = part;
      else if (/^node:\d+$/.test(part)) node = Number(part.slice(5));
      else if (/^mesh:\d+$/.test(part)) node = nodes.findIndex(n => n.mesh === Number(part.slice(5)));
      else node = nodes.findIndex(n => n.name === part);
      if (node < 0 || !nodes[node] || nodes[node].mesh === undefined) fail(`Rig part "${part}" is not a mesh in the model.`);
      partBone.set(node, i);
    }));
    const missing = meshNodes.filter(([, i]) => !partBone.has(i)).map(([n, i]) => n.name ?? `node:${i}`);
    if (missing.length) fail(`These parts are not assigned to any bone in the rig file: ${missing.join(', ')}`);
    J = joint.length;
  } else {
    const skinIds = new Set(meshNodes.map(([n]) => n.skin).filter(s => s !== undefined));
    if (!skinIds.size) fail('The model has no skin. Export from Blender with an Armature and "Skinning" enabled, or pass --rig for a model made of rigid parts.');
    if (skinIds.size > 1) fail('The model uses several skins (armatures). Join them into one armature before exporting.');
    const skin = g.skins[[...skinIds][0]], jointNodes = skin.joints;
    J = jointNodes.length;
    jointOfNode = new Map(jointNodes.map((n, i) => [n, i]));
    if (J > 65535) fail('Too many joints.');
    const ibm = skin.inverseBindMatrices !== undefined ? readAccessor(gl, skin.inverseBindMatrices).data : null;
    const bind = jointNodes.map((n, i) => ibm ? invertAffine(Array.from(ibm.subarray(i * 16, i * 16 + 16))) : worldOf(n));
    joint = jointNodes.map((n, i) => {
      let p = parentOf.get(n);
      while (p !== undefined && !jointOfNode.has(p)) p = parentOf.get(p);
      return {node: n, name: nodes[n].name || `Joint ${i + 1}`, parent: p === undefined ? -1 : jointOfNode.get(p), children: [], pos: [bind[i][12], bind[i][13], bind[i][14]]};
    });
  }
  joint.forEach((j, i) => { if (j.parent >= 0) joint[j.parent].children.push(i); });
  if (!joint.some(j => j.parent < 0)) fail('The skeleton has no root joint.');

  const chains = [];
  if (extraFile) {
    const spec = JSON.parse(await readFile(extraFile, 'utf8')), byName = new Map(joint.map((j, i) => [j.name, i]));
    for (const c of spec.chains ?? []) {
      const parentJoint = byName.get(c.parent) ?? fail(`Chain "${c.name}": unknown parent bone "${c.parent}".`), bind = byName.get(c.bind ?? c.parent) ?? fail(`Chain "${c.name}": unknown bind bone "${c.bind}".`);
      if (!Array.isArray(c.points) || c.points.length < 2) fail(`Chain "${c.name}" needs at least two points.`);
      const ids = []; let prev = parentJoint;
      for (let k = 0; k + 1 < c.points.length; k++) {
        joint.push({node: -1, name: `${c.name}.${k + 1}`, parent: prev, children: [], pos: c.points[k], tip: c.points[k + 1]});
        joint[prev].children.push(joint.length - 1); ids.push(joint.length - 1); prev = joint.length - 1;
      }
      chains.push({name: c.name, bind, ids, points: c.points, seedRadius: c.seedRadius});
    }
  }

  // ---- gather mesh data (glTF space)
  const P = [], B = [], W = [], idx = [], mat = [], groups = [], palette = [], paletteKey = new Map();
  let vertexBase = 0, unweighted = 0;
  const paletteIndex = rgb => {
    const key = rgb.join();
    if (!paletteKey.has(key)) { paletteKey.set(key, palette.length); palette.push(rgb); }
    return paletteKey.get(key);
  };
  const colorOf = materialIndex => {
    const {flatFactor: f} = getMaterialInfo(g, materialIndex);
    return paletteIndex([toSrgb(f[0]), toSrgb(f[1]), toSrgb(f[2])]);
  };
  const sampleColor = (tex, uv, i0, i1, i2, factor) => {
    const u = (uv[i0 * 2] + uv[i1 * 2] + uv[i2 * 2]) / 3, v = (uv[i0 * 2 + 1] + uv[i1 * 2 + 1] + uv[i2 * 2 + 1]) / 3, {png} = tex;
    const x = Math.min(png.w - 1, Math.floor((u - Math.floor(u)) * png.w)), y = Math.min(png.h - 1, Math.floor((v - Math.floor(v)) * png.h)), c = png.pixel(x, y);
    return paletteIndex(c.map((value, k) => factor[k] === 1 ? value : toSrgb(toLinear(value) * factor[k])));
  };
  const sampleVertexColor = (vc, vcn, i0, i1, i2, factor) => {
    const rgb = [0, 1, 2].map(k => toSrgb(((vc[i0 * vcn + k] + vc[i1 * vcn + k] + vc[i2 * vcn + k]) / 3) * factor[k]));
    return paletteIndex(rgb);
  };
  for (const [node, nodeIndex] of meshNodes) {
    const mesh = g.meshes[node.mesh], skinned = !rigFile && node.skin !== undefined, world = skinned ? null : worldOf(nodeIndex);
    let fallback = 0;
    if (rigFile) fallback = partBone.get(nodeIndex);
    else if (!skinned) {
      let a = parentOf.get(nodeIndex);
      while (a !== undefined && !jointOfNode.has(a)) a = parentOf.get(a);
      if (a === undefined && !includeUnskinned) { warn(`"${node.name ?? mesh.name}" is neither skinned nor attached to a bone, so it was left out (scene decoration?). Pass --include-unskinned yes to bind it to the root.`); continue; }
      fallback = a === undefined ? joint.findIndex(j => j.parent < 0) : jointOfNode.get(a);
      warn(`Mesh "${mesh.name ?? node.name}" is not skinned; it is bound rigidly to joint "${joint[fallback].name}".`);
    }
    for (const prim of mesh.primitives) {
      if ((prim.mode ?? 4) !== 4) { warn('A non-triangle primitive was skipped.'); continue; }
      const pos0 = readAccessor(gl, prim.attributes.POSITION).data;
      if (prim.attributes.JOINTS_1 !== undefined) warn('The model has more than 4 bone influences per vertex; extras are ignored. Limit influences to 4 when exporting.');
      const J00 = skinned && prim.attributes.JOINTS_0 !== undefined ? readAccessor(gl, prim.attributes.JOINTS_0).data : null;
      const W00 = skinned && prim.attributes.WEIGHTS_0 !== undefined ? readAccessor(gl, prim.attributes.WEIGHTS_0).data : null;
      const tex = loadTexture(gl, prim.material), uv0 = tex && prim.attributes[`TEXCOORD_${tex.texCoord}`] !== undefined ? readAccessor(gl, prim.attributes[`TEXCOORD_${tex.texCoord}`]).data : null;
      const vcol = !tex && prim.attributes.COLOR_0 !== undefined ? readAccessor(gl, prim.attributes.COLOR_0) : null;
      const src0 = prim.indices !== undefined ? readAccessor(gl, prim.indices).data : Float64Array.from({length: pos0.length / 3}, (_, i) => i);
      const {pos, J0, W0, uv, src} = chains.length && J00 && W00 ? (({pos: a, J0: b, W0: c, uv: d, src: e}) => ({pos: a, J0: b, W0: c, uv: d, src: e}))(cutChains(chains, pos0, J00, W00, uv0, src0)) : {pos: pos0, J0: J00, W0: W00, uv: uv0, src: src0};
      const count = pos.length / 3;
      for (let v = 0; v < count; v++) {
        let p = [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]];
        if (world) p = transformPoint(world, ...p);
        P.push(p);
        const acc = new Map();
        if (J0 && W0) for (let k = 0; k < 4; k++) { const w = W0[v * 4 + k]; if (w > 1e-4) acc.set(J0[v * 4 + k], (acc.get(J0[v * 4 + k]) ?? 0) + w); }
        else if (!skinned) acc.set(fallback, 1);
        if (!acc.size) { acc.set(joint.findIndex(j => j.parent < 0), 1); unweighted++; }
        const entries = [...acc].sort((a, b) => b[1] - a[1]), total = entries.reduce((s, e) => s + e[1], 0);
        const q = entries.map(([j, w]) => [j, Math.round(w / total * 65536) / 65536]);
        q[0][1] = 1 - q.slice(1).reduce((s, e) => s + e[1], 0);
        if (q[0][1] <= 0) { q.length = 1; q[0][1] = 1; }
        B.push(q.map(e => e[0])); W.push(q.map(e => e[1]));
      }
      const {factor} = getMaterialInfo(g, prim.material), flat = (tex && uv) || (vcol && !chains.length) ? null : colorOf(prim.material), start = mat.length;
      if (tex && !uv) warn('A textured material has no UV coordinates; its flat colour is used.');
      for (let t = 0; t + 2 < src.length; t += 3) {
        const a = src[t] + vertexBase, b = src[t + 1] + vertexBase, c = src[t + 2] + vertexBase;
        if (a === b || b === c || a === c) continue;
        idx.push(a, c, b);
        mat.push(flat ?? (tex && uv ? sampleColor(tex, uv, src[t], src[t + 1], src[t + 2], factor) : sampleVertexColor(vcol.data, vcol.n, src[t], src[t + 1], src[t + 2], factor)));
      }
      const used = mat.length - start, label = (rigFile ? joint[fallback].name : (mesh.name || node.name || 'Mesh')).slice(0, 200);
      if (used) {
        const last = groups.at(-1);
        if (last && last.name === label && last.start + last.count === start) last.count += used;
        else groups.push({name: label, start, count: used});
      }
      vertexBase += count;
    }
  }
  if (palette.length <= 1 && !(g.images?.length)) warn('This GLB file contains 0 embedded texture images and only 1 flat material colour. The creator uploaded it without glTF textures.');
  if (unweighted) warn(`${unweighted} vertices had no bone weights and were bound to the root joint.`);
  if (P.length > MESH_LIMITS.vertices) fail(`The mesh has ${P.length} vertices; the limit is ${MESH_LIMITS.vertices}. Decimate it.`);
  if (mat.length > MESH_LIMITS.triangles) fail(`The mesh has ${mat.length} triangles; the limit is ${MESH_LIMITS.triangles}. Decimate it.`);
  if (palette.length > MESH_LIMITS.colors) {
    for (const step of [4, 8, 12, 16, 24, 32, 48, 64]) {
      const merged = new Map(), remap = palette.map(c => { const q = c.map(v => Math.min(255, Math.round(v / step) * step)), key = q.join(); if (!merged.has(key)) merged.set(key, [merged.size, q]); return merged.get(key)[0]; });
      if (merged.size > MESH_LIMITS.colors) continue;
      warn(`The textures gave ${palette.length} colours; similar ones were merged (step ${step}) to fit the ${MESH_LIMITS.colors}-colour limit.`);
      const next = [...merged.values()].map(e => e[1]); palette.length = 0; palette.push(...next);
      for (let i = 0; i < mat.length; i++) mat[i] = remap[mat[i]];
      break;
    }
    if (palette.length > MESH_LIMITS.colors) fail(`The mesh uses ${palette.length} colours; the limit is ${MESH_LIMITS.colors}.`);
  }
  if (groups.length > MESH_LIMITS.groups) groups.length = 0;

  if (!keepUnweighted) {
    const own = new Set(B.flat()), keep = new Set(own);
    for (const i of own) for (let q = joint[i].parent; q >= 0; q = joint[q].parent) keep.add(q);
    for (;;) {
      const roots = [...keep].filter(i => joint[i].parent < 0 || !keep.has(joint[i].parent)), kids = joint[roots[0]]?.children.filter(c => keep.has(c)) ?? [];
      if (roots.length === 1 && !own.has(roots[0]) && kids.length === 1) keep.delete(roots[0]); else break;
    }
    if (keep.size < joint.length) {
      const order = [...keep].sort((x, y) => x - y), remap = new Map(order.map((old, i) => [old, i]));
      const next = order.map(old => ({...joint[old], parent: remap.get(joint[old].parent) ?? -1, children: []}));
      next.forEach((j, i) => { if (j.parent >= 0) next[j.parent].children.push(i); });
      B.forEach((list, k) => { B[k] = list.map(x => remap.get(x)); });
      warn(`${joint.length - next.length} bones without skin weights (controls, IK targets) were left out.`);
      joint = next;
    }
  }

  // ---- model space -> app space
  if (turn) {
    const c = Math.cos(turn * Math.PI / 180), sn = Math.sin(turn * Math.PI / 180), spin = q => [q[0] * c + q[2] * sn, q[1], -q[0] * sn + q[2] * c];
    P.forEach((q, i) => { P[i] = spin(q); });
    joint.forEach(j => { j.pos = spin(j.pos); if (j.tip) j.tip = spin(j.tip); });
  }
  const ys = P.map(p => p[1]), modelHeight = Math.max(...ys) - Math.min(...ys);
  if (!(modelHeight > 0)) fail('The mesh has no height.');
  const roots = joint.map((_, i) => i).filter(i => joint[i].parent < 0);
  if (roots.length > 1) {
    const first = joint[roots[0]];
    joint.push({node: -1, name: 'Root', parent: -1, children: roots.slice(), pos: [...first.pos], tip: [first.pos[0], first.pos[1] + modelHeight * 0.05, first.pos[2]]});
    roots.forEach(i => { joint[i].parent = joint.length - 1; });
    warn(`The skeleton had ${roots.length} separate root bones; a "Root" bone was added above them so the figure turns as a whole.`);
  }
  const S = height / modelHeight, rootJoint = joint[joint.findIndex(j => j.parent < 0)];
  const o = origin === 'feet' ? [rootJoint.pos[0], Math.min(...ys), rootJoint.pos[2]]
    : origin === 'center' ? [rootJoint.pos[0], (Math.max(...ys) + Math.min(...ys)) / 2, rootJoint.pos[2]] : rootJoint.pos;
  const map = p => [(p[0] - o[0]) * S, -(p[1] - o[1]) * S, (p[2] - o[2]) * S];
  const positions = P.flatMap(p => map(p).map(Math.fround));

  // ---- segments: reference joints, then Turn / Tilt / Bone for every joint
  const segments = [];
  const add = (parent, length, angle, label, control = false, rig) => {
    const id = segments.length + 1;
    segments.push({segment_id: id, parent_id: parent, length, angle_rad: angle, thickness: 0, bend_rad: 0, primitive_code: 0, aux_code: control ? 0 : 1, flags: control ? 0 : 256,
      segment_type: 'line', segment_kind: 'line', color_rgb: [40, 66, 85], transparency: 0, transparency_mode: 0, visible: false, z_order: id, name: label, ...(rig ? {_stykRig: rig} : {})});
    return id;
  };
  add(0, 0, 0, 'Figure rotation');
  const refX = add(0, 30, 0, 'Surface X'), refY = add(0, 30, Math.PI / 2, 'Surface Y');
  const used = new Set(), uniqueName = base => { let n = base, k = 2; while (used.has(n)) n = `${base} ${k++}`; used.add(n); return n; };
  const segmentOf = new Array(joint.length).fill(0), order = [], visit = i => { order.push(i); joint[i].children.forEach(visit); };
  joint.forEach((j, i) => { if (j.parent < 0) visit(i); });
  const unit = height / 40;
  for (const i of order) {
    const j = joint[i], p = map(j.pos), parentPos = j.parent >= 0 ? map(joint[j.parent].pos) : null;
    let tip;
    const kids = j.children.map(c => map(joint[c].pos)).sort((a, b) => Math.hypot(...b.map((v, k) => v - p[k])) - Math.hypot(...a.map((v, k) => v - p[k])));
    if (j.tip) tip = map(j.tip);
    else if (kids.length && Math.hypot(...kids[0].map((v, k) => v - p[k])) > 1e-3) tip = kids[0];
    else {
      let d = parentPos ? p.map((v, k) => v - parentPos[k]) : [0, -1, 0];
      const len = Math.hypot(...d) || 1;
      d = d.map(v => v / len);
      const L = Math.max(unit, parentPos ? len * 0.5 : unit * 3);
      tip = p.map((v, k) => v + d[k] * L);
    }
    const label = uniqueName(j.name), v = tip.map((n, k) => n - p[k]);
    const turn = add(0, 0, 0, `${label} turn`), pitch = add(0, 0, 0, `${label} tilt`);
    const id = add(j.parent >= 0 ? segmentOf[j.parent] : 0, Math.hypot(...v), Math.hypot(v[0], v[1]) > 1e-9 ? Math.atan2(v[1], v[0]) : 0, label, true,
      {spatial: {parent: j.parent >= 0 ? segmentOf[j.parent] : 0, origin: p.map(Math.fround), tip: tip.map(Math.fround), turn, pitch}});
    segmentOf[i] = id;
  }

  const mesh = {positions, bones: B.flatMap(b => [...b.map(x => segmentOf[x]), ...Array(4 - b.length).fill(0)]),
    weights: W.flatMap(w => [...w, ...Array(4 - w.length).fill(0)]), indices: idx, colors: palette, materials: mat, basis: [0, refX, refY],
    ...(groups.length ? {groups} : {})};
  const title = name ?? path.basename(file, path.extname(file));
  const figure = {figure_type_id: 1, name: title, segment_count: segments.length, segments, polyfills: [], image_assets: [], text_assets: [],
    _styk: {colorMode: 'segments', spatialMesh: mesh}};

  const sy = positions.filter((_, i) => i % 3 === 1), top = Math.min(...sy), bottom = Math.max(...sy);
  const document = emptyDocument();
  document.figure_types = [figure];
  document.keyframes = [createFrame([createObject(figure, 1, document.canvas_width / 2, document.canvas_height / 2 - (top + bottom) / 2)], 10)];
  document._styk = {...document._styk, name: title};
  validateScene(document); syncDerived(document);
  return {document, summary: {name: title, joints: joint.length, segments: segments.length, vertices: P.length, triangles: mat.length, colors: palette.length, groups: groups.map(x => x.name), scale: S, warnings: [...warnings]}};
}

// ------------------------------------------------------------------------ CLI
if (import.meta.url === new URL(process.argv[1], 'file://').href || process.argv[1]?.endsWith('glb-to-styk.mjs')) {
  const args = process.argv.slice(2), opts = {}, files = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) opts[args[i].slice(2)] = args[++i]; else files.push(args[i]);
  }
  const [input, output] = files;
  if (!input || !output || path.extname(output).toLowerCase() !== '.styk') fail('Usage: node scripts/glb-to-styk.mjs <model.glb|gltf> <output.styk> [--height 240] [--origin root|feet|center] [--name text] [--rig rig.json] [--include-unskinned yes] [--keep-unweighted yes] [--turn degrees] [--extra chains.json]');
  if (path.resolve(input) === path.resolve(output)) fail('Choose a different output file; the input is kept unchanged.');
  if (opts.origin && !['root', 'feet', 'center'].includes(opts.origin)) fail('--origin must be root, feet or center.');
  const {document, summary} = await convert(input, {height: Number(opts.height ?? 240), origin: opts.origin ?? 'root', name: opts.name, rig: opts.rig, includeUnskinned: opts['include-unskinned'] === 'yes', keepUnweighted: opts['keep-unweighted'] === 'yes', turn: Number(opts.turn ?? 0), extra: opts.extra});
  const encoded = await buildContainerV2(document, 'styk');
  validateScene((await decodeDocument(encoded, 'styk')).document);
  await writeFile(output, encoded);
  console.log(JSON.stringify({output, bytes: encoded.byteLength, ...summary}, null, 2));
}