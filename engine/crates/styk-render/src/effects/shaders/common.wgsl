// What every effect shader shares (docs/engine/vfx.md, "The filter core"): the pass's parameters (`recipe::Uniform`), its
// inputs, the full-target triangle and the sampling helpers. Each family's shader is this prelude followed by its own fragment
// stage, compiled the first time a frame needs it. Keep shaders small and free of long fixed loops: on WebGL2 the browser
// compiles a pipeline on the interface thread (FXC on Windows unrolls fixed loops and inlines every call).
//
// Each pipeline is one operation with its options fixed: the executor puts these constants before the prelude
// (`recipe::Variant`), so a pipeline compiles only its own code (what a constant turns off is dropped before compiling):
//   OP the operation; GRADIENT the brush is a gradient (else one colour); SMOOTH input 0 (and 3) is a halved image, read with
//   the cubic B-spline; ARTWORK a glow coloured by the artwork; PLACEMENT a glow's or shadow's (1 inner, 2 outer, 3 both);
//   MODE a blend (a glow's: normal, add, screen; a tint's: normal, multiply, screen, overlay, colour, add), or a noise's
//   channels (1, 3).
//
// Coordinates are texel positions with y down: texel m spans [m, m + 1), its centre at m + .5 (`@builtin(position)` gives the
// target's). Input k is read at `mapped(k, at)`, its image's own texel position; images sit in the corner of pooled textures,
// so reads clamp to the image's texels (`inputs[k]`: one over the texture's size, the image's size).

struct Params {
  targetSize: vec2f,
  level: f32,
  operation: i32,
  origin: vec2f,
  outputSize: vec2f,
  inputs: array<vec4f, 4>,
  maps: array<vec4f, 4>,
  p: vec4f,
  q: vec4f,
  r: vec4f,
  s: vec4f,
  taps: array<vec4f, 4>,
  weights: array<vec4f, 4>,
  seed: vec4u,
  paintType: i32,
  stopCount: i32,
  paintAngle: f32,
  dither: f32,
  stops: array<vec4f, 32>,
  stopOffsets: array<vec4f, 8>,
};

@group(0) @binding(0) var input0: texture_2d<f32>;
@group(0) @binding(1) var input1: texture_2d<f32>;
@group(0) @binding(2) var input2: texture_2d<f32>;
@group(0) @binding(3) var input3: texture_2d<f32>;
@group(0) @binding(4) var seeds: texture_2d<u32>;
@group(0) @binding(5) var smp: sampler;
@group(0) @binding(6) var<uniform> params: Params;

const PI: f32 = 3.141592653589793;

@vertex
fn vertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2. - 1., 0., 1.);
}

// Input k's texel position for the target's texel position `at`.
fn mapped(k: u32, at: vec2f) -> vec2f { let m = params.maps[k]; return at * m.xy + m.zw; }

// Bilinear reads at a texel position, clamped to the image's texels.
fn at0(t: vec2f) -> vec2f { let i = params.inputs[0]; return clamp(t, vec2f(.5), i.zw - vec2f(.5)) * i.xy; }
fn at1(t: vec2f) -> vec2f { let i = params.inputs[1]; return clamp(t, vec2f(.5), i.zw - vec2f(.5)) * i.xy; }
fn at2(t: vec2f) -> vec2f { let i = params.inputs[2]; return clamp(t, vec2f(.5), i.zw - vec2f(.5)) * i.xy; }
fn at3(t: vec2f) -> vec2f { let i = params.inputs[3]; return clamp(t, vec2f(.5), i.zw - vec2f(.5)) * i.xy; }
fn sample0(t: vec2f) -> vec4f { return textureSampleLevel(input0, smp, at0(t), 0.); }
fn sample1(t: vec2f) -> vec4f { return textureSampleLevel(input1, smp, at1(t), 0.); }
fn sample2(t: vec2f) -> vec4f { return textureSampleLevel(input2, smp, at2(t), 0.); }
fn sample3(t: vec2f) -> vec4f { return textureSampleLevel(input3, smp, at3(t), 0.); }

// The cubic B-spline along one axis at texel position u: two bilinear sample positions and their weights.
fn splineAxis(u: f32) -> vec4f {
  let t = u - .5;
  let i = floor(t);
  let f = t - i;
  let f2 = f * f;
  let f3 = f2 * f;
  let w0 = (1. - f) * (1. - f) * (1. - f) / 6.;
  let w1 = (4. - 6. * f2 + 3. * f3) / 6.;
  let w2 = (1. + 3. * f + 3. * f2 - 3. * f3) / 6.;
  let w3 = f3 / 6.;
  let g0 = w0 + w1;
  let g1 = w2 + w3;
  return vec4f(i - .5 + w1 / g0, i + 1.5 + w3 / g1, g0, g1);
}
// A smooth read of input 0 (a halved image read at full size): the cubic B-spline, four bilinear samples.
fn spline0(t: vec2f) -> vec4f {
  let x = splineAxis(t.x);
  let y = splineAxis(t.y);
  return (sample0(vec2f(x.x, y.x)) * x.z + sample0(vec2f(x.y, y.x)) * x.w) * y.z + (sample0(vec2f(x.x, y.y)) * x.z + sample0(vec2f(x.y, y.y)) * x.w) * y.w;
}
fn spline3(t: vec2f) -> vec4f {
  let x = splineAxis(t.x);
  let y = splineAxis(t.y);
  return (sample3(vec2f(x.x, y.x)) * x.z + sample3(vec2f(x.y, y.x)) * x.w) * y.z + (sample3(vec2f(x.x, y.y)) * x.z + sample3(vec2f(x.y, y.y)) * x.w) * y.w;
}
// Input 0 at a level-0 target's texel position: smooth when it is a halved image, else bilinear.
fn read0(at: vec2f) -> vec4f {
  if (SMOOTH) { return spline0(mapped(0u, at)); }
  return sample0(mapped(0u, at));
}
fn read3(at: vec2f) -> vec4f {
  if (SMOOTH) { return spline3(mapped(3u, at)); }
  return sample3(mapped(3u, at));
}

// The global position (level-0 pixels) of a full-size target's texel position.
fn globalAt(at: vec2f) -> vec2f { return params.origin + at; }

// A colour written to eight bits is dithered by less than half a level, the same amount on every channel (premultiplied
// colour stays valid): soft gradients show no bands. Exact 0 and 1 stay exact.
fn finish(c: vec4f, at: vec2f) -> vec4f {
  if (params.dither == 0.) { return c; }
  let n = fract(52.9829189 * fract(dot(floor(at), vec2f(.06711056, .00583715))));
  // Rounded here to whole levels, which the eight-bit write keeps exactly: GPUs round their own conversion differently (one
  // measured rounds 0.06 of a level low, which a wide, faint glow adds up to a twentieth of its light). The dither is strictly
  // within half a level: 0 and 1 stay exact.
  return floor(c * 255. + .5 + (n - .5) * .998) / 255.;
}

// The effect's result over its base by the effect's strength (s.w).
fn strengthen(result: vec4f, base: vec4f) -> vec4f { return mix(base, result, params.s.w); }

// The four lanes of a vector as weights picking lane `i % 4`: a vector read by a loop's counter would make FXC (WebGL2 on
// Windows) unroll the whole loop to resolve the lane; a dot product keeps it a loop.
fn lane(i: u32) -> vec4f { let k = i & 3u; return vec4f(f32(k == 0u), f32(k == 1u), f32(k == 2u), f32(k == 3u)); }
fn stopOffset(i: i32) -> f32 { return dot(params.stopOffsets[u32(i) >> 2u], lane(u32(i))); }
// The brush at a full-size target's texel position: a solid colour or a gradient over the effect's domain.
fn brush(at: vec2f) -> vec4f {
  if (!GRADIENT) { return params.stops[0]; }
  var pos = globalAt(at) / params.outputSize - vec2f(.5);
  let cs = cos(params.paintAngle);
  let sn = sin(params.paintAngle);
  pos = mat2x2f(cs, -sn, sn, cs) * pos;
  var t = pos.x + .5;
  if (params.paintType == 2) { t = length(pos) * 2.; }
  if (params.paintType == 3) { t = fract(atan2(pos.y, pos.x) / (2. * PI) + 1.); }
  if (params.paintType == 4) { t = (abs(pos.x) + abs(pos.y)) * 2.; }
  // Walking the stops: each segment before `t` takes its end's colour whole, the one holding `t` its share, those after none
  // (no return inside the loop: a compiler can keep it a loop).
  var colour = params.stops[0];
  var previous = stopOffset(0);
  for (var i = 1; i < params.stopCount; i++) {
    let next = stopOffset(i);
    colour = mix(colour, params.stops[u32(i)], clamp((t - previous) / max(.00001, next - previous), 0., 1.));
    previous = next;
  }
  return colour;
}

// How much of a pixel shows: its alpha, or its brightest channel where light makes it brighter than its coverage (a generated
// effect's glow over transparency: colour beyond its coverage, docs/engine/vfx.md "Light and paint"; exports read it alike).
fn cover(c: vec4f) -> f32 { return max(c.a, max(c.r, max(c.g, c.b))); }

// Unpremultiplied colour: the pixel's colour over what of it shows (`cover`), so light keeps its colour through a colour filter,
// which then multiplies the result by `cover` again. Paint (colour within its coverage) is divided by its alpha as ever.
fn straight(c: vec4f) -> vec3f { let w = cover(c); if (w > .000001) { return c.rgb / w; } return vec3f(0.); }
