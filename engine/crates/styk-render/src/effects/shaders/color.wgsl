// Per-pixel colour operations of input 0, mixed with the base (input 1) by the strength (s.w).
//   TINT (70): towards the brush by p.x, blended by p.y (0 normal, 1 multiply, 2 screen, 3 overlay, 4 colour: the brush's hue
//     and saturation with the artwork's light and dark, 5 add).
//   GRADE (71): exposure, contrast, saturation, temperature (p); tint, shadows, highlights, gamma (q); hue turned by the angle
//     whose cosine and sine are r.xy.
//   VIGNETTE (72): amount, softness, radius (p.xyz); centre, aspect, roundness (q).
//   SWEEP (73): position, angle (radians), width, softness (p); intensity (q.x).

fn luminance(c: vec3f) -> f32 { return dot(c, vec3f(.3, .59, .11)); }

// The W3C compositing spec's SetLum and ClipColor: `c` with the luminance `l`.
fn withLuminance(c: vec3f, l: f32) -> vec3f {
  var v = c + vec3f(l - luminance(c));
  let m = luminance(v);
  let low = min(v.r, min(v.g, v.b));
  let high = max(v.r, max(v.g, v.b));
  if (low < 0.) { v = vec3f(m) + (v - vec3f(m)) * m / max(m - low, .000001); }
  if (high > 1.) { v = vec3f(m) + (v - vec3f(m)) * (1. - m) / max(high - m, .000001); }
  return v;
}

fn blended(rgb: vec3f, b: vec3f, mode: i32) -> vec3f {
  if (mode == 1) { return rgb * b; }
  if (mode == 2) { return vec3f(1.) - (vec3f(1.) - rgb) * (vec3f(1.) - b); }
  if (mode == 3) { return select(vec3f(1.) - 2. * (vec3f(1.) - rgb) * (vec3f(1.) - b), 2. * rgb * b, rgb < vec3f(.5)); }
  if (mode == 4) { return withLuminance(b, luminance(rgb)); }
  if (mode == 5) { return min(rgb + b, vec3f(1.)); }
  return b;
}

@fragment
fn fragment(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let at = pos.xy;
  let operation = params.operation;
  let p = params.p;
  let q = params.q;
  let c = sample0(mapped(0u, at));
  let base = sample1(mapped(1u, at));
  var rgb = straight(c);
  var out = c;
  if (operation == 70) {
    let b = brush(at);
    out = vec4f(mix(rgb, blended(rgb, b.rgb, i32(p.y)), vec3f(p.x * b.a)) * c.a, c.a);
  } else if (operation == 71) {
    rgb *= exp2(p.x);
    rgb = (rgb - vec3f(.5)) * p.y + vec3f(.5);
    let l = dot(rgb, vec3f(.2126, .7152, .0722));
    rgb = mix(vec3f(l), rgb, p.z);
    // Hue turned about the grey axis, keeping luminance (the CSS hue-rotate matrix).
    let k = params.r.x;
    let n = params.r.y;
    rgb = vec3f(
      dot(rgb, vec3f(.213 + k * .787 - n * .213, .715 - k * .715 - n * .715, .072 - k * .072 + n * .928)),
      dot(rgb, vec3f(.213 - k * .213 + n * .143, .715 + k * .285 + n * .14, .072 - k * .072 - n * .283)),
      dot(rgb, vec3f(.213 - k * .213 - n * .787, .715 - k * .715 + n * .715, .072 + k * .928 + n * .072)));
    rgb += vec3f(p.w * .12, q.x * .12, -p.w * .12);
    rgb += vec3f(q.y * pow(1. - clamp(l, 0., 1.), 2.) * .4 + q.z * pow(clamp(l, 0., 1.), 2.) * .4);
    rgb = pow(max(rgb, vec3f(0.)), vec3f(1. / q.w));
    out = vec4f(clamp(rgb, vec3f(0.), vec3f(1.)) * c.a, c.a);
  } else if (operation == 72) {
    var xy = (globalAt(at) / params.outputSize - q.xy) * 2.;
    xy.x /= q.z;
    let distance = mix(max(abs(xy.x), abs(xy.y)), length(xy) / 1.41421356237, q.w) / p.z;
    let dark = smoothstep(1. - p.y, 1., distance) * p.x;
    let b = brush(at);
    out = vec4f(mix(c.rgb, b.rgb * c.a, vec3f(dark * b.a)), c.a);
  } else if (operation == 73) {
    let xy = globalAt(at) / params.outputSize - vec2f(.5);
    let position = dot(xy, vec2f(cos(p.y), sin(p.y))) + .5;
    let distance = abs(position - p.x) * 2. / p.z;
    let light = 1. - smoothstep(1. - p.w, 1., distance);
    let b = brush(at);
    out = vec4f(clamp(c.rgb + b.rgb * b.a * light * q.x * c.a, vec3f(0.), vec3f(c.a)), c.a);
  }
  return finish(strengthen(out, base), at);
}
