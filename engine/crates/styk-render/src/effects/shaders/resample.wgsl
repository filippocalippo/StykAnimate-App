// Pixelate (operation 8) and the blur's downsample (11) and upsample (12).

@fragment
fn fragment(@builtin(position) fragPos: vec4f) -> @location(0) vec4f {
  let p = params.p;
  if (params.operation == 11) { let xy = (vec2f(fragPos.x, fragPos.y) * p.x - p.yz) / params.dimensions; return sampleAt(vec2f(xy.x, 1. - xy.y)); }
  if (params.operation == 12) { let xy = (vec2f(fragPos.x, fragPos.y) + p.yz) / p.x / params.dimensions; return sampleAt(vec2f(xy.x, 1. - xy.y)); }
  let uv = vec2f(fragPos.x / params.targetSize.x, 1. - fragPos.y / params.targetSize.y);
  let q = params.q;
  let xy = globalPixel(uv);
  let size = p.xy;
  let cell = clamp((floor((xy - q.xy) / size) + vec2f(.5)) * size + q.xy, vec2f(.5), params.outputSize - vec2f(.5));
  return sampleGlobal(cell);
}
