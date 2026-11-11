// Effect passes: a port of the editor's WGSL effect executor (src/vfx-webgpu.mjs,
// itself a port of src/vfx-shaders.mjs). Operation bodies are kept as written
// there so the two can be compared line by line; what differs is how textures
// are read. The editor gives every pass textures of exactly its size; here
// slots are pooled at one larger size and a pass uses their top-left corner,
// so sampling scales into that corner and clamps where the editor's
// clamp-to-edge sampler would. The operation is a uniform: one pipeline serves
// every effect (WebGL2 included).
//
// Conventions kept from the editor: uv.y is 0 at the bottom of a pass (GL), the
// samplers flip it, `dimensions` is the source's size and `origin` the global
// pixel position of the pass's lower-left texel row start.

struct Params {
  dimensions: vec2f,
  origin: vec2f,
  outputSize: vec2f,
  paintType: i32,
  stopCount: i32,
  paintAngle: f32,
  operation: i32,
  // This pass's own size, and 1 / the pooled slot texture size.
  targetSize: vec2f,
  texel: vec2f,
  unused: vec2f,
  p: vec4f,
  q: vec4f,
  stops: array<vec4f, 32>,
  stopOffsets: array<vec4f, 8>,
};

@group(0) @binding(0) var sourceImage: texture_2d<f32>;
@group(0) @binding(1) var originalImage: texture_2d<f32>;
@group(0) @binding(2) var maskImage: texture_2d<f32>;
@group(0) @binding(3) var smp: sampler;
@group(0) @binding(4) var<uniform> params: Params;

const PI: f32 = 3.141592653589793;

@vertex
fn vertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2. - 1., 0., 1.);
}

fn stopOffset(i: i32) -> f32 { return params.stopOffsets[(u32(i)) >> 2u][(u32(i)) & 3u]; }

// A texel-space position inside a pooled slot used at `size`, clamped as an
// exact-size texture's clamp-to-edge sampler would clamp it.
fn slotAt(at: vec2f, size: vec2f) -> vec2f {
  return clamp(vec2f(at.x, 1. - at.y) * size, vec2f(.5), size - vec2f(.5)) * params.texel;
}
fn sampleAt(at: vec2f) -> vec4f {
  if (at.x < 0. || at.y < 0. || at.x > 1. || at.y > 1.) { return vec4f(0.); }
  return textureSampleLevel(sourceImage, smp, slotAt(at, params.dimensions), 0.);
}
fn sampleOrig(at: vec2f) -> vec4f { return textureSampleLevel(originalImage, smp, slotAt(at, params.targetSize), 0.); }
fn sampleMask(at: vec2f) -> vec4f { return textureSampleLevel(maskImage, smp, slotAt(at, params.targetSize), 0.); }
fn globalPixel(uv: vec2f) -> vec2f { return vec2f(uv.x, 1. - uv.y) * params.dimensions + params.origin; }
fn sampleGlobal(at: vec2f) -> vec4f { let pos = (at - params.origin) / params.dimensions; return sampleAt(vec2f(pos.x, 1. - pos.y)); }
fn brush(uv: vec2f) -> vec4f {
  if (params.paintType == 0) { return params.stops[0]; }
  var pos = globalPixel(uv) / params.outputSize - vec2f(.5);
  let cs = cos(params.paintAngle);
  let sn = sin(params.paintAngle);
  pos = mat2x2f(cs, -sn, sn, cs) * pos;
  var t = pos.x + .5;
  if (params.paintType == 2) { t = length(pos) * 2.; }
  if (params.paintType == 3) { t = fract(atan2(pos.y, pos.x) / (2. * PI) + 1.); }
  if (params.paintType == 4) { t = (abs(pos.x) + abs(pos.y)) * 2.; }
  var a = params.stops[0];
  var offset = stopOffset(0);
  for (var i = 1; i < 32; i++) {
    if (i >= params.stopCount) { break; }
    let next = stopOffset(i);
    if (t < next) { return mix(a, params.stops[u32(i)], clamp((t - offset) / max(.00001, next - offset), 0., 1.)); }
    a = params.stops[u32(i)];
    offset = next;
  }
  return a;
}
fn hashValue(n0: u32) -> u32 { var n = n0; n ^= n >> 16u; n *= 0x7feb352du; n ^= n >> 15u; n *= 0x846ca68bu; n ^= n >> 16u; return n; }
fn hashPoint(xy: vec2f, seed: f32) -> f32 {
  let vi = vec2i(floor(xy));
  let v = vec2u(bitcast<u32>(vi.x), bitcast<u32>(vi.y));
  return f32(hashValue(v.x * 1973u + v.y * 9277u + u32(seed) * 26699u) & 65535u) / 65535.;
}
fn noiseAt(pos: vec2f, seed: f32, smoothness: f32) -> f32 {
  let i = floor(pos);
  var f = fract(pos);
  f = mix(vec2f(0.), f * f * (3. - 2. * f), vec2f(smoothness));
  return mix(mix(hashPoint(i, seed), hashPoint(i + vec2f(1., 0.), seed), f.x), mix(hashPoint(i + vec2f(0., 1.), seed), hashPoint(i + vec2f(1.), seed), f.x), f.y);
}

@fragment
fn fragment(@builtin(position) fragPos: vec4f) -> @location(0) vec4f {
  let uv = vec2f(fragPos.x / params.targetSize.x, 1. - fragPos.y / params.targetSize.y);
  let operation = params.operation;
  let p = params.p;
  let q = params.q;
  var c = sampleAt(uv);
  var rgb = vec3f(0.);
  if (c.a > .000001) { rgb = c.rgb / c.a; }
  if (operation == 1) { let b = brush(uv); return vec4f(mix(rgb, b.rgb, p.x * b.a) * c.a, c.a); }
  if (operation == 2) {
    rgb *= exp2(p.x);
    rgb = (rgb - vec3f(.5)) * p.y + vec3f(.5);
    let l = dot(rgb, vec3f(.2126, .7152, .0722));
    rgb = mix(vec3f(l), rgb, p.z);
    rgb += vec3f(p.w * .12, q.x * .12, -p.w * .12);
    rgb += vec3f(q.y * pow(1. - clamp(l, 0., 1.), 2.) * .4 + q.z * pow(clamp(l, 0., 1.), 2.) * .4);
    rgb = pow(max(rgb, vec3f(0.)), vec3f(1. / q.w));
    return vec4f(clamp(rgb, vec3f(0.), vec3f(1.)) * c.a, c.a);
  }
  if (operation == 3 || operation == 4) {
    let delta = select(vec2f(0., 1. / params.dimensions.y), vec2f(1. / params.dimensions.x, 0.), operation == 3);
    var sum = vec4f(0.);
    let radius = clamp(i32(p.x), 0, 128);
    for (var i = -radius; i <= radius; i++) { sum += sampleAt(uv + delta * f32(i)); }
    return sum / f32(radius * 2 + 1);
  }
  if (operation == 5 || operation == 6) {
    let delta = select(vec2f(0., 1. / params.dimensions.y), vec2f(1. / params.dimensions.x, 0.), operation == 5);
    var alpha = 0.;
    let radius = clamp(i32(p.x), 0, 128);
    for (var i = -radius; i <= radius; i++) { alpha = max(alpha, sampleAt(uv + delta * f32(i)).a); }
    return vec4f(alpha);
  }
  if (operation == 7) {
    let front = sampleOrig(uv);
    let b = brush(uv);
    let a = clamp(pow(sampleAt(uv - vec2f(q.x, -q.y) / params.dimensions).a, p.y) * p.x * b.a, 0., 1.);
    if (p.z > 0.) {
      var frgb = mix(front.rgb, b.rgb * front.a, vec3f(a));
      if (p.w == 1.) { frgb = min(front.rgb + b.rgb * front.a * a, vec3f(front.a)); }
      if (p.w == 2.) { frgb = front.rgb + b.rgb * a * (front.a - front.rgb); }
      return vec4f(frgb, front.a);
    }
    let under = vec4f(b.rgb * a, a);
    var pixel = front + under * (1. - front.a);
    if (p.w == 1.) { pixel = vec4f(min(front.rgb + under.rgb, vec3f(max(front.a, a))), max(front.a, a)); }
    if (p.w == 2.) { pixel = vec4f(front.rgb + under.rgb - front.rgb * under.rgb, max(front.a, a)); }
    return pixel;
  }
  if (operation == 8) {
    let xy = globalPixel(uv);
    let size = p.xy;
    let cell = clamp((floor((xy - q.xy) / size) + vec2f(.5)) * size + q.xy, vec2f(.5), params.outputSize - vec2f(.5));
    return sampleGlobal(cell);
  }
  if (operation == 9) {
    let xy = globalPixel(uv) / p.y;
    let seed = p.z + p.w;
    let smoothness = max(q.z, q.w);
    let n = noiseAt(xy, seed, smoothness) - .5;
    var grain = vec3f(n);
    if (q.x > 0.) { grain = vec3f(n, noiseAt(xy, seed + 131., smoothness) - .5, noiseAt(xy, seed + 719., smoothness) - .5); }
    return vec4f(clamp(rgb + grain * p.x * q.y, vec3f(0.), vec3f(1.)) * c.a, c.a);
  }
  if (operation == 10) {
    var xy = (globalPixel(uv) / params.outputSize - q.xy) * 2.;
    xy.x /= q.z;
    let distance = mix(max(abs(xy.x), abs(xy.y)), length(xy) / 1.41421356237, q.w) / p.z;
    let dark = smoothstep(1. - p.y, 1., distance) * p.x;
    let b = brush(uv);
    return vec4f(mix(c.rgb, b.rgb * c.a, vec3f(dark * b.a)), c.a);
  }
  if (operation == 11) { let xy = (vec2f(fragPos.x, fragPos.y) * p.x - p.yz) / params.dimensions; return sampleAt(vec2f(xy.x, 1. - xy.y)); }
  if (operation == 12) { let xy = (vec2f(fragPos.x, fragPos.y) + p.yz) / p.x / params.dimensions; return sampleAt(vec2f(xy.x, 1. - xy.y)); }
  if (operation == 13) { return vec4f(1. - c.a); }
  if (operation == 14) {
    var a = c.a;
    for (var i = 0; i < 16; i++) {
      let angle = f32(i) * PI / 8.;
      a = max(a, sampleAt(uv + vec2f(cos(angle), sin(angle)) * p.x / params.dimensions).a);
    }
    return vec4f(a);
  }
  if (operation == 15) {
    let front = sampleOrig(uv);
    let b = brush(uv);
    var a = select(max(0., c.a - front.a), c.a * front.a, p.y > 0.);
    a *= p.x * b.a;
    if (p.z > 0.) { return vec4f(b.rgb * a, a); }
    if (p.y > 0.) { return vec4f(mix(front.rgb, b.rgb * front.a, vec3f(clamp(c.a * p.x * b.a, 0., 1.))), front.a); }
    return front + vec4f(b.rgb * a, a) * (1. - front.a);
  }
  if (operation == 16) {
    let xy = globalPixel(uv);
    let delta = xy - q.xy * params.outputSize;
    var dir = select(normalize(delta + vec2f(.00001)), vec2f(cos(p.z), sin(p.z)), p.y == 1.);
    if (p.y == 3.) { dir = vec2f(-dir.y, dir.x); }
    var sum = vec4f(0.);
    for (var i = 0; i < 33; i++) { let t = f32(i) / 32. - .5; sum += sampleGlobal(xy + dir * p.x * t * 2.); }
    return sum / 33.;
  }
  if (operation == 17) {
    let n = noiseAt(globalPixel(uv) / p.y, p.w, 1.);
    var keep: f32;
    if (p.x <= 0.) { keep = 1.; } else if (p.x >= 1.) { keep = 0.; } else { keep = smoothstep(p.x - p.z, p.x + p.z, n); }
    let edge = (1. - smoothstep(p.x, p.x + q.x + p.z, n)) * keep;
    let b = brush(uv);
    return vec4f(mix(c.rgb, b.rgb * c.a, vec3f(edge * b.a)) * keep, c.a * keep);
  }
  if (operation == 18) {
    let delta = vec2f(cos(p.y), sin(p.y)) * p.x;
    let xy = globalPixel(uv);
    let red = sampleGlobal(xy + delta * q.x);
    let green = sampleGlobal(xy + delta * q.y);
    let blue = sampleGlobal(xy + delta * q.z);
    let alpha = max(red.a, max(green.a, blue.a));
    return vec4f(red.r, green.g, blue.b, alpha);
  }
  if (operation == 19) {
    let axis = vec2f(cos(p.z), sin(p.z));
    let xy = globalPixel(uv);
    let wave = sin(dot(xy, axis) * 2. * PI / p.y + p.w);
    return sampleGlobal(xy + vec2f(-axis.y, axis.x) * wave * p.x);
  }
  if (operation == 20) {
    let xy = globalPixel(uv);
    let delta = xy - q.xy * params.outputSize;
    let distance = length(delta);
    let ring = (distance - p.x) / p.y;
    let strength = sin(ring * PI) * pow(max(0., 1. - abs(ring)), p.w) * p.z;
    return sampleGlobal(xy + delta / max(.0001, distance) * strength);
  }
  if (operation == 21) { let l = max(rgb.r, max(rgb.g, rgb.b)); let mask = smoothstep(p.x - p.y, p.x + p.y, l); return c * mask; }
  if (operation == 22) {
    let front = sampleOrig(uv);
    let b = brush(uv);
    return vec4f(min(front.rgb + c.rgb * b.rgb * b.a * p.x, vec3f(max(front.a, c.a))), max(front.a, c.a));
  }
  if (operation == 23) {
    let xy = globalPixel(uv) / params.outputSize - vec2f(.5);
    let position = dot(xy, vec2f(cos(p.y), sin(p.y))) + .5;
    let distance = abs(position - p.x) * 2. / p.z;
    let light = 1. - smoothstep(1. - p.w, 1., distance);
    let b = brush(uv);
    return vec4f(clamp(c.rgb + b.rgb * b.a * light * q.x * c.a, vec3f(0.), vec3f(c.a)), c.a);
  }
  if (operation == 24) {
    let xy = globalPixel(uv);
    let pos = xy / params.outputSize * 2. - vec2f(1.);
    let warped = (pos * (1. + p.z * dot(pos, pos)) * .5 + vec2f(.5)) * params.outputSize;
    var s = sampleGlobal(warped);
    if (any(warped < vec2f(0.)) || any(warped >= params.outputSize)) { s = vec4f(0.); }
    if (p.w > 0.) {
      s.r = sampleGlobal(warped + vec2f(p.w, 0.)).r;
      s.b = sampleGlobal(warped - vec2f(p.w, 0.)).b;
      s = vec4f(min(s.rgb, vec3f(s.a)), s.a);
    }
    let line = (.5 + .5 * cos((xy.y + q.x) * 2. * PI / p.y)) * p.x;
    let b = brush(uv);
    return vec4f(mix(s.rgb, b.rgb * s.a, vec3f(line * b.a)), s.a);
  }
  if (operation == 25) {
    let front = sampleOrig(uv);
    let inner = sampleMask(uv);
    let b = brush(uv);
    let outer = max(0., c.a - front.a) * p.x * b.a;
    let ring = inner + vec4f(b.rgb * outer, outer) * (1. - inner.a);
    if (p.y > 0.) { return ring; }
    return ring + front * (1. - ring.a);
  }
  if (operation == 26) { return mix(sampleOrig(uv), c, p.x); }
  if (operation == 27) {
    var xy = globalPixel(uv) / p.y + vec2f(p.z * .73, p.z * 1.17);
    var offset = vec2f(0.);
    var weight = 1.;
    var total = 0.;
    for (var i = 0; i < 4; i++) {
      if (f32(i) >= q.x) { break; }
      offset += vec2f(noiseAt(xy, p.w + f32(i) * 37., 1.), noiseAt(xy + vec2f(19.1, 7.7), p.w + 131. + f32(i) * 37., 1.)) * weight;
      total += weight;
      weight *= .5;
      xy *= 2.;
    }
    return sampleGlobal(globalPixel(uv) + (offset / total * 2. - vec2f(1.)) * p.x);
  }
  return c;
}
