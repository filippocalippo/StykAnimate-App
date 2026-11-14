// What every effect shader shares (docs/engine/vfx.md, Passes): the pass's parameters, its
// textures, the full-target triangle and the sampling helpers. Each family's shader is this
// prelude followed by its own fragment stage, compiled the first time a frame needs it.
//
// Conventions kept from the editor: uv.y is 0 at the bottom of a pass (GL), the samplers flip
// it, `dimensions` is the source's size and `origin` the global pixel position of the pass's
// first texel. Images are placed in pooled textures at least as large as they are, so
// sampling scales into the image's corner of its texture (`texel`: one over the texture's
// size) and clamps where an exact-size texture's clamp-to-edge sampler would.

struct Params {
  dimensions: vec2f,
  origin: vec2f,
  outputSize: vec2f,
  paintType: i32,
  stopCount: i32,
  paintAngle: f32,
  operation: i32,
  // This pass's own size, and one over the size of the textures holding the source and
  // the original (or mask).
  targetSize: vec2f,
  texel: vec2f,
  texelOther: vec2f,
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

// A texel-space position inside an image of `size` placed in a texture whose texel is
// `texel`, clamped as an exact-size texture's clamp-to-edge sampler would clamp it.
fn slotAt(at: vec2f, size: vec2f, texel: vec2f) -> vec2f {
  return clamp(vec2f(at.x, 1. - at.y) * size, vec2f(.5), size - vec2f(.5)) * texel;
}
fn sampleAt(at: vec2f) -> vec4f {
  if (at.x < 0. || at.y < 0. || at.x > 1. || at.y > 1.) { return vec4f(0.); }
  return textureSampleLevel(sourceImage, smp, slotAt(at, params.dimensions, params.texel), 0.);
}
fn sampleOrig(at: vec2f) -> vec4f { return textureSampleLevel(originalImage, smp, slotAt(at, params.targetSize, params.texelOther), 0.); }
fn sampleMask(at: vec2f) -> vec4f { return textureSampleLevel(maskImage, smp, slotAt(at, params.targetSize, params.texelOther), 0.); }
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
