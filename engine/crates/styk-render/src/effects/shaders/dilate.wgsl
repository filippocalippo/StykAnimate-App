// Alpha dilation along an axis (operations 5 and 6) or in sixteen directions (14).

@fragment
fn fragment(@builtin(position) fragPos: vec4f) -> @location(0) vec4f {
  let uv = vec2f(fragPos.x / params.targetSize.x, 1. - fragPos.y / params.targetSize.y);
  let p = params.p;
  if (params.operation == 14) {
    var a = sampleAt(uv).a;
    for (var i = 0; i < 16; i++) {
      let angle = f32(i) * PI / 8.;
      a = max(a, sampleAt(uv + vec2f(cos(angle), sin(angle)) * p.x / params.dimensions).a);
    }
    return vec4f(a);
  }
  let delta = select(vec2f(0., 1. / params.dimensions.y), vec2f(1. / params.dimensions.x, 0.), params.operation == 5);
  var alpha = 0.;
  let radius = clamp(i32(p.x), 0, 128);
  for (var i = -radius; i <= radius; i++) { alpha = max(alpha, sampleAt(uv + delta * f32(i)).a); }
  return vec4f(alpha);
}
