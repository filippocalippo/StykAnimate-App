// Box blur passes along an axis (operations 3 and 4).

@fragment
fn fragment(@builtin(position) fragPos: vec4f) -> @location(0) vec4f {
  let uv = vec2f(fragPos.x / params.targetSize.x, 1. - fragPos.y / params.targetSize.y);
  let delta = select(vec2f(0., 1. / params.dimensions.y), vec2f(1. / params.dimensions.x, 0.), params.operation == 3);
  var sum = vec4f(0.);
  let radius = clamp(i32(params.p.x), 0, 128);
  for (var i = -radius; i <= radius; i++) { sum += sampleAt(uv + delta * f32(i)); }
  return sum / f32(radius * 2 + 1);
}
