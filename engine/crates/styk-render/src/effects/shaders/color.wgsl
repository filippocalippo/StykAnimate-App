// Per-pixel colour operations (operations 1, 2, 9, 10, 13, 17, 21, 23 and 26).

@fragment
fn fragment(@builtin(position) fragPos: vec4f) -> @location(0) vec4f {
  let uv = vec2f(fragPos.x / params.targetSize.x, 1. - fragPos.y / params.targetSize.y);
  let operation = params.operation;
  let p = params.p;
  let q = params.q;
  let c = sampleAt(uv);
  var rgb = vec3f(0.);
  if (c.a > .000001) { rgb = c.rgb / c.a; }
  if (operation == 1) { let b = brush(uv); return vec4f(mix(rgb, b.rgb, p.x * b.a) * c.a, c.a); }
  if (operation == 2) {
    rgb *= exp2(p.x);
    rgb = (rgb - vec3f(.5)) * p.y + vec3f(.5);
    let l = dot(rgb, vec3f(.2126, .7152, .0722));
    rgb = mix(vec3f(l), rgb, p.z);
    rgb += vec3f(p.w * .12, q.x * .12, -p.w * .12);
    rgb += vec3f(q.y * pow(1. - clamp(l, 0., 1.), 2.) * .4 + q.z * pow(clamp(l, 0., 1.), 2.) * .4);
    rgb = pow(max(rgb, vec3f(0.)), vec3f(1. / q.w));
    return vec4f(clamp(rgb, vec3f(0.), vec3f(1.)) * c.a, c.a);
  }
  if (operation == 9) {
    let xy = globalPixel(uv) / p.y;
    let seed = p.z + p.w;
    let smoothness = max(q.z, q.w);
    let n = noiseAt(xy, seed, smoothness) - .5;
    var grain = vec3f(n);
    if (q.x > 0.) { grain = vec3f(n, noiseAt(xy, seed + 131., smoothness) - .5, noiseAt(xy, seed + 719., smoothness) - .5); }
    return vec4f(clamp(rgb + grain * p.x * q.y, vec3f(0.), vec3f(1.)) * c.a, c.a);
  }
  if (operation == 10) {
    var xy = (globalPixel(uv) / params.outputSize - q.xy) * 2.;
    xy.x /= q.z;
    let distance = mix(max(abs(xy.x), abs(xy.y)), length(xy) / 1.41421356237, q.w) / p.z;
    let dark = smoothstep(1. - p.y, 1., distance) * p.x;
    let b = brush(uv);
    return vec4f(mix(c.rgb, b.rgb * c.a, vec3f(dark * b.a)), c.a);
  }
  if (operation == 13) { return vec4f(1. - c.a); }
  if (operation == 17) {
    let n = noiseAt(globalPixel(uv) / p.y, p.w, 1.);
    var keep: f32;
    if (p.x <= 0.) { keep = 1.; } else if (p.x >= 1.) { keep = 0.; } else { keep = smoothstep(p.x - p.z, p.x + p.z, n); }
    let edge = (1. - smoothstep(p.x, p.x + q.x + p.z, n)) * keep;
    let b = brush(uv);
    return vec4f(mix(c.rgb, b.rgb * c.a, vec3f(edge * b.a)) * keep, c.a * keep);
  }
  if (operation == 21) { let l = max(rgb.r, max(rgb.g, rgb.b)); let mask = smoothstep(p.x - p.y, p.x + p.y, l); return c * mask; }
  if (operation == 23) {
    let xy = globalPixel(uv) / params.outputSize - vec2f(.5);
    let position = dot(xy, vec2f(cos(p.y), sin(p.y))) + .5;
    let distance = abs(position - p.x) * 2. / p.z;
    let light = 1. - smoothstep(1. - p.w, 1., distance);
    let b = brush(uv);
    return vec4f(clamp(c.rgb + b.rgb * b.a * light * q.x * c.a, vec3f(0.), vec3f(c.a)), c.a);
  }
  if (operation == 26) { return mix(sampleOrig(uv), c, p.x); }
  return c;
}
