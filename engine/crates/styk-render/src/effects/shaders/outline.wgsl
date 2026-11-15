// OUTLINE (50): an outline from the distance to the artwork's edge (input 0 the seeds, input 1 the artwork, which is also the
// base). p: the width outside and inside (pixels), the feather (pixels: a ramp that wide centred on the outline's far edges,
// one for plain antialiasing), the opacity; q.x: the outline alone (the artwork knocked out); q.y: square joins (distance by
// the larger axis). s.w: strength.
//
// Each band's coverage of a pixel is the difference of two coverages: outside, the artwork grown by the width less the
// artwork itself; inside, the artwork less the artwork shrunk by the width. So a band thinner than a pixel covers that much of
// it, wherever the edge falls in the pixel, and the bands meet the artwork without a seam.

@fragment
fn fragment(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let at = pos.xy;
  let p = params.p;
  let ds = signedDistance(at, params.q.y > 0.);
  let d = ds.x;
  let front = sample1(mapped(1u, at));
  let b = brush(at);
  let opacity = p.w * b.a;
  var outer = 0.;
  if (p.x > 0.) { outer = max(clamp((p.x - d) / p.z + .5, 0., 1.) * ds.y - front.a, 0.); }
  var inner = 0.;
  if (p.y > 0.) { inner = max(front.a - clamp((-p.y - d) / p.z + .5, 0., 1.), 0.); }
  if (params.q.x > 0.) {
    let ring = clamp(outer + inner, 0., 1.) * opacity;
    return finish(strengthen(vec4f(b.rgb * ring, ring), front), at);
  }
  // Inside: the band's share of the artwork's own coverage takes the colour; outside: the band is added beside the artwork.
  let share = clamp(inner / max(front.a, .000001) * opacity, 0., 1.);
  let ring = outer * opacity;
  let pixel = vec4f(mix(front.rgb, b.rgb * front.a, vec3f(share)) + b.rgb * ring, front.a + ring);
  return finish(strengthen(pixel, front), at);
}
