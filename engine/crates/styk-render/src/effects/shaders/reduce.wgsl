// Halving an image on the global grid (`recipe::Recorder::reduce`). The target texel's centre is at input 0's texel position
// `mapped(0, at)`, the shared corner of the four texels it covers.
//   TENT (1): the tent [1 3 3 1] / 8 on each axis, four bilinear samples: every source pixel counts, nothing aliases much.
//   BOX (2): the average of the four texels (pixelate), one bilinear sample.
//   BRIGHT (3): TENT of what is brighter than p.x, with a soft knee of p.y (the bloom's first level).

fn bright(c: vec4f) -> vec4f {
  let rgb = straight(c);
  let l = max(rgb.r, max(rgb.g, rgb.b));
  return c * smoothstep(params.p.x - params.p.y, params.p.x + params.p.y, l);
}

@fragment
fn fragment(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let c = mapped(0u, pos.xy);
  if (OP == 2) { return finish(sample0(c), pos.xy); }
  let a = sample0(c + vec2f(-.75, -.75));
  let b = sample0(c + vec2f(.75, -.75));
  let d = sample0(c + vec2f(-.75, .75));
  let e = sample0(c + vec2f(.75, .75));
  if (OP == 3) { return finish((bright(a) + bright(b) + bright(d) + bright(e)) * .25, pos.xy); }
  return finish((a + b + d + e) * .25, pos.xy);
}
