// Displacements of input 0, mixed with the base (input 1) by the strength (s.w). Positions are global pixels.
//   SPLIT (90): red, green and blue moved by p.x pixels along the angle p.y, times q.xyz.
//   WAVE (91): moved across the angle p.z by p.x · sin(along · 2π / p.y + p.w).
//   SHOCK (92): a ring of radius p.x, thickness p.y, strength p.z and falloff p.w about the centre q.xy (of the domain).
//   CRT (93): curved by p.z, colour fringes of p.w pixels, scanlines of amount p.x every p.y pixels moved by q.x, coloured by
//     the brush.

fn atGlobal(g: vec2f) -> vec4f {
  // Outside the image it is transparent.
  let t = g - params.origin;
  let size = params.inputs[0].zw;
  if (t.x < 0. || t.y < 0. || t.x > size.x || t.y > size.y) { return vec4f(0.); }
  return sample0(t);
}

@fragment
fn fragment(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let at = pos.xy;
  let p = params.p;
  let q = params.q;
  let xy = globalAt(at);
  var out: vec4f;
  if (OP == 90) {
    let delta = vec2f(cos(p.y), sin(p.y)) * p.x;
    let red = atGlobal(xy + delta * q.x);
    let green = atGlobal(xy + delta * q.y);
    let blue = atGlobal(xy + delta * q.z);
    out = vec4f(red.r, green.g, blue.b, max(red.a, max(green.a, blue.a)));
  } else if (OP == 91) {
    let axis = vec2f(cos(p.z), sin(p.z));
    let wave = sin(dot(xy, axis) * 2. * PI / p.y + p.w);
    out = atGlobal(xy + vec2f(-axis.y, axis.x) * wave * p.x);
  } else if (OP == 92) {
    let delta = xy - q.xy * params.outputSize;
    let distance = length(delta);
    let ring = (distance - p.x) / p.y;
    let strength = sin(ring * PI) * pow(max(0., 1. - abs(ring)), p.w) * p.z;
    out = atGlobal(xy + delta / max(.0001, distance) * strength);
  } else {
    let curve = xy / params.outputSize * 2. - vec2f(1.);
    let warped = (curve * (1. + p.z * dot(curve, curve)) * .5 + vec2f(.5)) * params.outputSize;
    var s = atGlobal(warped);
    if (any(warped < vec2f(0.)) || any(warped >= params.outputSize)) { s = vec4f(0.); }
    if (p.w > 0.) {
      s.r = atGlobal(warped + vec2f(p.w, 0.)).r;
      s.b = atGlobal(warped - vec2f(p.w, 0.)).b;
      s = vec4f(min(s.rgb, vec3f(s.a)), s.a);
    }
    let line = (.5 + .5 * cos((xy.y + q.x) * 2. * PI / p.y)) * p.x;
    let b = brush(at);
    out = vec4f(mix(s.rgb, b.rgb * s.a, vec3f(line * b.a)), s.a);
  }
  return finish(strengthen(out, sample1(mapped(1u, at))), at);
}
