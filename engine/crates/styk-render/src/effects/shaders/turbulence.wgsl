// TURBULENCE (88): input 0 displaced by up to p.x pixels by p.w octaves of value noise of size p.y (seed seed.x) that evolves
// along p.z (the evolution, its speed folded in). Mixed with the base (input 1) by the strength (s.w).

fn hash4(n0: vec4u) -> vec4u {
  var n = n0;
  n ^= n >> vec4u(16u);
  n *= vec4u(0x7feb352du);
  n ^= n >> vec4u(15u);
  n *= vec4u(0x846ca68bu);
  n ^= n >> vec4u(16u);
  return n;
}
// `hashPoint` for four fields: lanes x, y at lattice point `ia`, z, w at `ib`.
fn corner4(ia: vec2f, ib: vec2f, seeds: vec4u) -> vec4f {
  let a = bitcast<vec2u>(vec2i(ia));
  let b = bitcast<vec2u>(vec2i(ib));
  let at = vec2u(a.x * 1973u + a.y * 9277u, b.x * 1973u + b.y * 9277u).xxyy;
  return vec4f(hash4(at + seeds * 26699u) & vec4u(65535u)) / 65535.;
}
// `noiseAt` (smooth) for four fields at once, lanes x, y at `a` and z, w at `b`: one vector pass instead of four (on WebGL2
// the browser compiles the shader in about two thirds of the time).
fn noise4(a: vec2f, b: vec2f, seeds: vec4u) -> vec4f {
  let ia = floor(a);
  let ib = floor(b);
  var fa = fract(a);
  var fb = fract(b);
  fa = fa * fa * (3. - 2. * fa);
  fb = fb * fb * (3. - 2. * fb);
  let fx = vec4f(fa.x, fa.x, fb.x, fb.x);
  let fy = vec4f(fa.y, fa.y, fb.y, fb.y);
  let x = vec2f(1., 0.);
  let y = vec2f(0., 1.);
  return mix(mix(corner4(ia, ib, seeds), corner4(ia + x, ib + x, seeds), fx), mix(corner4(ia + y, ib + y, seeds), corner4(ia + 1., ib + 1., seeds), fx), fy);
}

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
  // `noiseAtTime` of the two fields (the second 131 seeds on, at a shifted place): the whole evolution's field and the next one's
  // in each pair of lanes, blended smoothly.
  let zi = floor(p.z);
  let zf = p.z - zi;
  let t = zf * zf * (3. - 2. * zf);
  let z = vec4u(bitcast<u32>(i32(zi)) * 7919u) + vec4u(0u, 7919u, 131u, 131u + 7919u);
  for (var i = 0u; i < octaves; i++) {
    let v = noise4(xy, xy + vec2f(19.1, 7.7), vec4u(params.seed.x + i * 37u) + z);
    offset += mix(v.xz, v.yw, t) * weight;
    total += weight;
    weight *= .5;
    xy *= 2.;
  }
  let moved = g + (offset / max(total, .000001) * 2. - vec2f(1.)) * p.x;
  let out = sample0(moved - params.origin);
  return finish(strengthen(out, sample1(mapped(1u, at))), at);
}
