// Noise added to input 0's colour, mixed with the base (input 1) by the strength (s.w). p: amount, size (pixels), contrast,
// softness; MODE (and seed.w) the channels: 1, or 3 for colour grain.
//   GRAIN (80): one value per cell of the size, re-rolled with the seed seed.x (the saved seed, its phase and speed folded in).
//   CLOUDS (81): four octaves of smooth value noise, each turned, evolving smoothly along q.y (the phase and speed); seed.y the
//     saved seed.

fn clouds(pos: vec2f, z: f32, seed: u32) -> f32 {
  var total = 0.;
  var weight = 1.;
  var sum = 0.;
  var at = pos;
  // Four octaves (seed.z, a uniform: the loop stays a loop), each turned by about 37 degrees and twice as fine.
  let turn = mat2x2f(.8, .6, -.6, .8);
  for (var i = 0u; i < params.seed.z; i++) {
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
  // One value for every channel, or (colour grain: seed.w channels, a uniform) one each, seeds 131 and 719 apart. (No
  // indexing of a vector by the loop's counter: FXC would have to unroll the loop for it.) The one-channel pipeline has no loop.
  var grain = vec3f(0.);
  if (MODE != 3) {
    if (OP == 81) { grain = vec3f(clouds(xy, q.y, params.seed.y) - .5); } else { grain = vec3f(noiseAt(xy, params.seed.x, p.w) - .5); }
  } else {
    for (var k = 0u; k < params.seed.w; k++) {
      let offset = select(select(0u, 131u, k == 1u), 719u, k == 2u);
      var n: f32;
      if (OP == 81) { n = clouds(xy, q.y, params.seed.y + offset) - .5; } else { n = noiseAt(xy, params.seed.x + offset, p.w) - .5; }
      grain = select(grain, vec3f(n), vec3<bool>(k == 0u, k == 1u, k == 2u));
    }
  }
  let out = vec4f(clamp(rgb + grain * p.x * p.z, vec3f(0.), vec3f(1.)) * cover(c), c.a);
  return finish(strengthen(out, base), at);
}
