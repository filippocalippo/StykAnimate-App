// Displacements: directional, zoom and radial blur (operation 16), RGB split (18), wave (19),
// shockwave (20), CRT (24) and turbulence (27).

@fragment
fn fragment(@builtin(position) fragPos: vec4f) -> @location(0) vec4f {
  let uv = vec2f(fragPos.x / params.targetSize.x, 1. - fragPos.y / params.targetSize.y);
  let operation = params.operation;
  let p = params.p;
  let q = params.q;
  let xy = globalPixel(uv);
  if (operation == 16) {
    let delta = xy - q.xy * params.outputSize;
    var dir = select(normalize(delta + vec2f(.00001)), vec2f(cos(p.z), sin(p.z)), p.y == 1.);
    if (p.y == 3.) { dir = vec2f(-dir.y, dir.x); }
    var sum = vec4f(0.);
    for (var i = 0; i < 33; i++) { let t = f32(i) / 32. - .5; sum += sampleGlobal(xy + dir * p.x * t * 2.); }
    return sum / 33.;
  }
  if (operation == 18) {
    let delta = vec2f(cos(p.y), sin(p.y)) * p.x;
    let red = sampleGlobal(xy + delta * q.x);
    let green = sampleGlobal(xy + delta * q.y);
    let blue = sampleGlobal(xy + delta * q.z);
    let alpha = max(red.a, max(green.a, blue.a));
    return vec4f(red.r, green.g, blue.b, alpha);
  }
  if (operation == 19) {
    let axis = vec2f(cos(p.z), sin(p.z));
    let wave = sin(dot(xy, axis) * 2. * PI / p.y + p.w);
    return sampleGlobal(xy + vec2f(-axis.y, axis.x) * wave * p.x);
  }
  if (operation == 20) {
    let delta = xy - q.xy * params.outputSize;
    let distance = length(delta);
    let ring = (distance - p.x) / p.y;
    let strength = sin(ring * PI) * pow(max(0., 1. - abs(ring)), p.w) * p.z;
    return sampleGlobal(xy + delta / max(.0001, distance) * strength);
  }
  if (operation == 24) {
    let pos = xy / params.outputSize * 2. - vec2f(1.);
    let warped = (pos * (1. + p.z * dot(pos, pos)) * .5 + vec2f(.5)) * params.outputSize;
    var s = sampleGlobal(warped);
    if (any(warped < vec2f(0.)) || any(warped >= params.outputSize)) { s = vec4f(0.); }
    if (p.w > 0.) {
      s.r = sampleGlobal(warped + vec2f(p.w, 0.)).r;
      s.b = sampleGlobal(warped - vec2f(p.w, 0.)).b;
      s = vec4f(min(s.rgb, vec3f(s.a)), s.a);
    }
    let line = (.5 + .5 * cos((xy.y + q.x) * 2. * PI / p.y)) * p.x;
    let b = brush(uv);
    return vec4f(mix(s.rgb, b.rgb * s.a, vec3f(line * b.a)), s.a);
  }
  // 27: turbulence.
  var at = xy / p.y + vec2f(p.z * .73, p.z * 1.17);
  var offset = vec2f(0.);
  var weight = 1.;
  var total = 0.;
  for (var i = 0; i < 4; i++) {
    if (f32(i) >= q.x) { break; }
    offset += vec2f(noiseAt(at, p.w + f32(i) * 37., 1.), noiseAt(at + vec2f(19.1, 7.7), p.w + 131. + f32(i) * 37., 1.)) * weight;
    total += weight;
    weight *= .5;
    at *= 2.;
  }
  return sampleGlobal(xy + (offset / total * 2. - vec2f(1.)) * p.x);
}
