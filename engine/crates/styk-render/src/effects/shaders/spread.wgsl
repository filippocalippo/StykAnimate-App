// SPREAD (45): a glow's or shadow's mask spread by p.x pixels from the artwork's edge (input 0 the seeds, input 1 the artwork):
// alpha the artwork grown by the spread, red the artwork shrunk by it and inverted (an inner glow's mask), both antialiased.

@fragment
fn fragment(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let ds = signedDistance(pos.xy, false);
  let d = ds.x;
  let spread = params.p.x;
  let outer = clamp(spread + .5 - d, 0., 1.) * ds.y;
  let inner = clamp(spread + .5 + d, 0., 1.);
  return finish(vec4f(inner, 0., 0., outer), pos.xy);
}
