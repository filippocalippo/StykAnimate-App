// OUTLINE (50): an outline from the distance to the artwork's edge (input 0 the seeds, input 1 the artwork, which is also the
// base). p: the width outside and inside (pixels), the feather (pixels: a ramp that wide centred on the outline's far edges,
// one for plain antialiasing), the opacity; q.x: the outline alone (the artwork knocked out); q.y: square joins (distance by
// the larger axis). s.w: strength. The outline is drawn under the artwork outside it and over it inside it.

@fragment
fn fragment(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let at = pos.xy;
  let p = params.p;
  let ds = signedDistance(at, params.q.y > 0.);
  let d = ds.x;
  let front = sample1(mapped(1u, at));
  let b = brush(at);
  let opacity = p.w * b.a;
  // The outer band's coverage (everything up to its far edge, the artwork included) and the inner band's (everything beyond
  // its far edge inside, the outside included).
  let outer = select(0., clamp((p.x - d) / p.z + .5, 0., 1.) * ds.y, p.x > 0.);
  let inner = select(0., clamp((p.y + d) / p.z + .5, 0., 1.), p.y > 0.);
  if (params.q.x > 0.) {
    let ring = clamp(max(outer - front.a, 0.) + inner * front.a, 0., 1.) * opacity;
    return finish(strengthen(vec4f(b.rgb * ring, ring), front), at);
  }
  var pixel = front;
  if (p.y > 0.) {
    pixel = vec4f(mix(front.rgb, b.rgb * front.a, vec3f(clamp(inner * opacity, 0., 1.))), front.a);
  }
  if (p.x > 0.) {
    let ring = outer * opacity;
    pixel = pixel + vec4f(b.rgb * ring, ring) * (1. - pixel.a);
  }
  return finish(strengthen(pixel, front), at);
}
