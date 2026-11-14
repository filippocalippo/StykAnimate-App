// DISSOLVE (85): input 0 eaten away where a field is below the progress p.x, with an edge of colour (the brush) p.w wide and a
// softness p.z; the field is value noise of size p.y (seed seed.x), turned (q.x, 0–1) into a wipe along the direction whose
// cosine and sine are q.yz, its edge still noisy. Mixed with the base (input 1) by the strength (s.w).

@fragment
fn fragment(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let at = pos.xy;
  let p = params.p;
  let q = params.q;
  let c = sample0(mapped(0u, at));
  let base = sample1(mapped(1u, at));
  var n = noiseAt(globalAt(at) / p.y, params.seed.x, 1.);
  if (q.x > 0.) {
    // Where along the direction the pixel lies, 0 to 1 across the domain from corner to corner.
    let xy = globalAt(at) / params.outputSize - vec2f(.5);
    let along = clamp(dot(xy, q.yz) / max(abs(q.y) + abs(q.z), .000001) + .5, 0., 1.);
    n = mix(n, along * .8 + n * .2, q.x);
  }
  var keep: f32;
  if (p.x <= 0.) { keep = 1.; } else if (p.x >= 1.) { keep = 0.; } else { keep = smoothstep(p.x - p.z, p.x + p.z, n); }
  let edge = (1. - smoothstep(p.x, p.x + p.w + p.z, n)) * keep;
  let b = brush(at);
  let out = vec4f(mix(c.rgb, b.rgb * c.a, vec3f(edge * b.a)) * keep, c.a * keep);
  return finish(strengthen(out, base), at);
}
