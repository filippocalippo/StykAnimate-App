// Pixelate: cells of p.xy pixels on the global grid moved by p.zw; the layer's first cell is q.xy (cell indices).
//   CELLS (95): one texel a cell, the average of what the cell covers: input 0 is the layer halved to level 2^r.x pixels a
//     texel (offset q.zw, `kernels::level_offset`), each of its texels weighed by the part of it inside the cell.
//   SHOW (96): each pixel its cell's average (input 0 the cells), mixed with the base (input 1) by the strength (s.w).

@fragment
fn fragment(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let p = params.p;
  let q = params.q;
  if (params.operation == 96) {
    let at = pos.xy;
    let cell = vec2i(floor((globalAt(at) - p.zw) / p.xy) - q.xy);
    let size = vec2i(params.inputs[0].zw);
    let average = textureLoad(input0, clamp(cell, vec2i(0), size - vec2i(1)), 0);
    return finish(strengthen(average, sample1(mapped(1u, at))), at);
  }
  // The cell, in the halved image's texel positions.
  let index = floor(pos.xy) + q.xy;
  let texelSize = params.r.x;
  let low = (p.zw + index * p.xy - params.origin + q.zw) / texelSize;
  let high = low + p.xy / texelSize;
  let first = vec2i(floor(low));
  let last = vec2i(ceil(high)) - vec2i(1);
  let size = vec2i(params.inputs[0].zw);
  var sum = vec4f(0.);
  for (var y = first.y; y <= last.y; y++) {
    let wy = min(high.y, f32(y + 1)) - max(low.y, f32(y));
    for (var x = first.x; x <= last.x; x++) {
      if (x < 0 || y < 0 || x >= size.x || y >= size.y) { continue; }
      let wx = min(high.x, f32(x + 1)) - max(low.x, f32(x));
      sum += textureLoad(input0, vec2i(x, y), 0) * (wx * wy);
    }
  }
  return finish(sum / ((high.x - low.x) * (high.y - low.y)), pos.xy);
}
