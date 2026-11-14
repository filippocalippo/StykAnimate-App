// A symmetric kernel along one axis (`kernels::discrete_gaussian`): seed.x bilinear samples at `taps` (texels along the axis
// p.xy) with `weights`. With p.z, the pass is the effect's result: mixed with its base (input 1) by the strength (s.w).

@fragment
fn fragment(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let c = mapped(0u, pos.xy);
  let axis = params.p.xy;
  var sum = vec4f(0.);
  let count = i32(params.seed.x);
  for (var i = 0; i < count; i++) {
    let k = u32(i);
    sum += sample0(c + axis * params.taps[k >> 2u][k & 3u]) * params.weights[k >> 2u][k & 3u];
  }
  if (params.p.z > 0.) { sum = strengthen(sum, sample1(mapped(1u, pos.xy))); }
  return finish(sum, pos.xy);
}
