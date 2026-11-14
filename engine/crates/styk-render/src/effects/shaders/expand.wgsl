// Halved images enlarged smoothly (the cubic B-spline).
//   SPLINE (20): a blur's halved result read at full size, mixed with its base (input 1) by the strength (s.w).
//   ACCUMULATE (21): the bloom's levels, the coarser one (input 0) enlarged into this one (input 1): p.x · coarser + p.y · this.

@fragment
fn fragment(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let coarser = spline0(mapped(0u, pos.xy));
  let fine = sample1(mapped(1u, pos.xy));
  if (params.operation == 21) { return finish(coarser * params.p.x + fine * params.p.y, pos.xy); }
  return finish(strengthen(coarser, fine), pos.xy);
}
