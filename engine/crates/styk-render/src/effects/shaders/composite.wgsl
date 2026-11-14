// Glow, shadow, outline and bloom over the saved artwork (operations 7, 15, 22 and 25).

@fragment
fn fragment(@builtin(position) fragPos: vec4f) -> @location(0) vec4f {
  let uv = vec2f(fragPos.x / params.targetSize.x, 1. - fragPos.y / params.targetSize.y);
  let operation = params.operation;
  let p = params.p;
  let q = params.q;
  let c = sampleAt(uv);
  let front = sampleOrig(uv);
  let b = brush(uv);
  if (operation == 7) {
    let a = clamp(pow(sampleAt(uv - vec2f(q.x, -q.y) / params.dimensions).a, p.y) * p.x * b.a, 0., 1.);
    if (p.z > 0.) {
      var frgb = mix(front.rgb, b.rgb * front.a, vec3f(a));
      if (p.w == 1.) { frgb = min(front.rgb + b.rgb * front.a * a, vec3f(front.a)); }
      if (p.w == 2.) { frgb = front.rgb + b.rgb * a * (front.a - front.rgb); }
      return vec4f(frgb, front.a);
    }
    let under = vec4f(b.rgb * a, a);
    var pixel = front + under * (1. - front.a);
    if (p.w == 1.) { pixel = vec4f(min(front.rgb + under.rgb, vec3f(max(front.a, a))), max(front.a, a)); }
    if (p.w == 2.) { pixel = vec4f(front.rgb + under.rgb - front.rgb * under.rgb, max(front.a, a)); }
    return pixel;
  }
  if (operation == 15) {
    var a = select(max(0., c.a - front.a), c.a * front.a, p.y > 0.);
    a *= p.x * b.a;
    if (p.z > 0.) { return vec4f(b.rgb * a, a); }
    if (p.y > 0.) { return vec4f(mix(front.rgb, b.rgb * front.a, vec3f(clamp(c.a * p.x * b.a, 0., 1.))), front.a); }
    return front + vec4f(b.rgb * a, a) * (1. - front.a);
  }
  if (operation == 22) {
    return vec4f(min(front.rgb + c.rgb * b.rgb * b.a * p.x, vec3f(max(front.a, c.a))), max(front.a, c.a));
  }
  // 25: the centred outline's outer ring under its inner ring.
  let inner = sampleMask(uv);
  let outer = max(0., c.a - front.a) * p.x * b.a;
  let ring = inner + vec4f(b.rgb * outer, outer) * (1. - inner.a);
  if (p.y > 0.) { return ring; }
  return ring + front * (1. - ring.a);
}
