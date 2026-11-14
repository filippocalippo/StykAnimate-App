// LINE (60): one pass of a directional (p.x 1), zoom (2) or radial (3) blur: the average of p.y transforms of input 0, evenly
// spaced by p.z in the family's parameter and centred on none (pixels along q.zw; the scale's logarithm about the centre q.xy;
// the angle about it). Passes compose: their transforms add up (`kernels::line`). With p.w, the pass is the effect's result:
// mixed with its base (input 1) by the strength (s.w).

@fragment
fn fragment(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let p = params.p;
  let q = params.q;
  let g = globalAt(pos.xy) - q.xy;
  let count = i32(p.y);
  let first = -(p.y - 1.) * .5 * p.z;
  var sum = vec4f(0.);
  for (var i = 0; i < count; i++) {
    let t = first + f32(i) * p.z;
    var at = g + q.zw * t;
    if (p.x == 2.) { at = g * exp(t); }
    if (p.x == 3.) { let c = cos(t); let s = sin(t); at = vec2f(c * g.x - s * g.y, s * g.x + c * g.y); }
    sum += sample0(at + q.xy - params.origin);
  }
  sum /= p.y;
  if (p.w > 0.) { sum = strengthen(sum, sample1(mapped(1u, pos.xy))); }
  return finish(sum, pos.xy);
}
