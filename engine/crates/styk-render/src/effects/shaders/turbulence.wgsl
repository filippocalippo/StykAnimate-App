// TURBULENCE (88): input 0 displaced by up to p.x pixels by p.w octaves of value noise of size p.y (seed seed.x) that evolves
// along p.z (the evolution, its speed folded in). Mixed with the base (input 1) by the strength (s.w).

@fragment
fn fragment(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let at = pos.xy;
  let p = params.p;
  let g = globalAt(at);
  var xy = g / p.y;
  var offset = vec2f(0.);
  var weight = 1.;
  var total = 0.;
  let octaves = u32(p.w);
  for (var i = 0u; i < octaves; i++) {
    let seed = params.seed.x + i * 37u;
    offset += vec2f(noiseAtTime(xy, p.z, seed, 1.), noiseAtTime(xy + vec2f(19.1, 7.7), p.z, seed + 131u, 1.)) * weight;
    total += weight;
    weight *= .5;
    xy *= 2.;
  }
  let moved = g + (offset / max(total, .000001) * 2. - vec2f(1.)) * p.x;
  let out = sample0(moved - params.origin);
  return finish(strengthen(out, sample1(mapped(1u, at))), at);
}
