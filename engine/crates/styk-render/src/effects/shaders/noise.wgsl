// Noise added to input 0's colour, mixed with the base (input 1) by the strength (s.w). p: amount, size (pixels), contrast,
// softness; q.x colour grain.
//   GRAIN (80): one value per cell of the size, re-rolled with the seed seed.x (the saved seed, its phase and speed folded in).
//   CLOUDS (81): four octaves of smooth value noise, each turned, evolving smoothly along q.y (the phase and speed); seed.y the
//     saved seed.

fn clouds(pos: vec2f, z: f32, seed: u32) -> f32 {
  var total = 0.;
  var weight = 1.;
  var sum = 0.;
  var at = pos;
  // Four octaves, each turned by about 37 degrees and twice as fine.
  let turn = mat2x2f(.8, .6, -.6, .8);
  for (var i = 0u; i < 4u; i++) {
    total += noiseAtTime(at, z * (1. + f32(i) * .5), seed + i * 1013u, 1.) * weight;
    sum += weight;
    weight *= .5;
    at = turn * at * 2.;
  }
  // Four octaves average towards the middle: spread back to the range one octave has.
  return clamp((total / sum - .5) * 1.6 + .5, 0., 1.);
}

@fragment
fn fragment(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let at = pos.xy;
  let p = params.p;
  let q = params.q;
  let c = sample0(mapped(0u, at));
  let base = sample1(mapped(1u, at));
  let rgb = straight(c);
  let xy = globalAt(at) / p.y;
  var grain: vec3f;
  if (params.operation == 81) {
    let seed = params.seed.y;
    let n = clouds(xy, q.y, seed) - .5;
    grain = vec3f(n);
    if (q.x > 0.) { grain = vec3f(n, clouds(xy, q.y, seed + 131u) - .5, clouds(xy, q.y, seed + 719u) - .5); }
  } else {
    let seed = params.seed.x;
    let n = noiseAt(xy, seed, p.w) - .5;
    grain = vec3f(n);
    if (q.x > 0.) { grain = vec3f(n, noiseAt(xy, seed + 131u, p.w) - .5, noiseAt(xy, seed + 719u, p.w) - .5); }
  }
  let out = vec4f(clamp(rgb + grain * p.x * p.z, vec3f(0.), vec3f(1.)) * c.a, c.a);
  return finish(strengthen(out, base), at);
}
