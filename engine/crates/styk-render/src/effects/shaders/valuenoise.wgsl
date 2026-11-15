// Value noise on the integer lattice, the editor's hash (shared by the noise, dissolve and turbulence shaders). Seeds are exact
// 32-bit integers.

fn hashValue(n0: u32) -> u32 { var n = n0; n ^= n >> 16u; n *= 0x7feb352du; n ^= n >> 15u; n *= 0x846ca68bu; n ^= n >> 16u; return n; }
fn hashPoint(i: vec2f, seed: u32) -> f32 {
  let vi = vec2i(i);
  let v = vec2u(bitcast<u32>(vi.x), bitcast<u32>(vi.y));
  return f32(hashValue(v.x * 1973u + v.y * 9277u + seed * 26699u) & 65535u) / 65535.;
}
// Value noise at `pos` (lattice units), smoothed by `smoothness` (0 the nearest cell's value, 1 smoothstep).
fn noiseAt(pos: vec2f, seed: u32, smoothness: f32) -> f32 {
  let i = floor(pos);
  var f = fract(pos);
  f = mix(vec2f(0.), f * f * (3. - 2. * f), vec2f(smoothness));
  return mix(mix(hashPoint(i, seed), hashPoint(i + vec2f(1., 0.), seed), f.x), mix(hashPoint(i + vec2f(0., 1.), seed), hashPoint(i + vec2f(1.), seed), f.x), f.y);
}
// Value noise that evolves along `z`: the fields of consecutive whole `z` blended smoothly. At a whole `z` of 0 it is
// `noiseAt` itself, so a pattern that does not move is the one it always was.
fn noiseAtTime(pos: vec2f, z: f32, seed: u32, smoothness: f32) -> f32 {
  let zi = floor(z);
  let zf = z - zi;
  let s = seed + bitcast<u32>(i32(zi)) * 7919u;
  let a = noiseAt(pos, s, smoothness);
  if (zf == 0.) { return a; }
  return mix(a, noiseAt(pos, s + 7919u, smoothness), zf * zf * (3. - 2. * zf));
}
