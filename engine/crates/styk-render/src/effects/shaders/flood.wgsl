// The jump flood of an artwork's edge (`recipe::Recorder::flood`): seeds hold, per pixel, the nearest point found on the edge, in
// the layer's texel positions in eighths of a pixel (x, y), its strength (z, 0–65535) and whether there is one (w).
//   SEED (40): from input 1's alpha. The edge is where the alpha crosses 1/2: a pixel on one side of it next to a pixel on the
//     other is on the edge, its point where the 1/2 contour of a straight edge through it with that coverage passes, along the
//     alpha's gradient (Gustavson and Strand's anti-aliased distance), so distances are exact to a fraction of a pixel. A faint
//     line that never reaches 1/2 (a thin stroke seen small) is on the edge along its ridge, with the strength of its coverage
//     (twice its alpha), so it keeps a faint outline instead of none.
//   JUMP (41): the nearest of the seeds p.x pixels away in the eight directions and here, by straight distance or (p.y) by the
//     larger axis.

fn alphaAt(q: vec2i) -> f32 {
  let size = vec2i(params.inputs[1].zw);
  if (q.x < 0 || q.y < 0 || q.x >= size.x || q.y >= size.y) { return 0.; }
  return textureLoad(input1, q, 0).a;
}

// The distance from a pixel's centre to the 1/2 contour of a straight edge through it of normal `g` and coverage `a` (positive
// outside), after Gustavson and Strand.
fn edgeDistance(g: vec2f, a: f32) -> f32 {
  if (g.x == 0. || g.y == 0.) { return .5 - a; }
  var gx = abs(g.x);
  var gy = abs(g.y);
  if (gx < gy) { let t = gx; gx = gy; gy = t; }
  let a1 = .5 * gy / gx;
  if (a < a1) { return .5 * (gx + gy) - sqrt(2. * gx * gy * a); }
  if (a < 1. - a1) { return (.5 - a) * gx; }
  return -.5 * (gx + gy) + sqrt(2. * gx * gy * (1. - a));
}

fn packed(e: vec2f, strength: f32) -> vec4u {
  let at = vec2u(clamp(round(e * 8.), vec2f(0.), vec2f(65535.)));
  return vec4u(at, u32(round(clamp(strength, 0., 1.) * 65535.)), 1u);
}

fn seed(pos: vec2f) -> vec4u {
  let p = vec2i(floor(pos));
  let a = alphaAt(p);
  let l = alphaAt(p + vec2i(-1, 0));
  let r = alphaAt(p + vec2i(1, 0));
  let u = alphaAt(p + vec2i(0, -1));
  let d = alphaAt(p + vec2i(0, 1));
  let ul = alphaAt(p + vec2i(-1, -1));
  let ur = alphaAt(p + vec2i(1, -1));
  let dl = alphaAt(p + vec2i(-1, 1));
  let dr = alphaAt(p + vec2i(1, 1));
  let inside = a >= .5;
  let across = (l >= .5) != inside || (r >= .5) != inside || (u >= .5) != inside || (d >= .5) != inside;
  if (across) {
    // The alpha's gradient (Sobel), towards the artwork.
    let g = vec2f((ur + 2. * r + dr) - (ul + 2. * l + dl), (dl + 2. * d + dr) - (ul + 2. * u + ur));
    let length_g = length(g);
    var n = vec2f(0.);
    if (length_g > .000001) { n = g / length_g; }
    return packed(pos + n * edgeDistance(n, a), 1.);
  }
  let ridge = a > 0. && !inside && a >= max(max(max(l, r), max(u, d)), max(max(ul, ur), max(dl, dr)));
  if (ridge) { return packed(pos, a * 2.); }
  return vec4u(0u);
}

fn metric(d: vec2f) -> f32 {
  if (params.p.y > 0.) { return max(abs(d.x), abs(d.y)); }
  return dot(d, d);
}

fn jump(pos: vec2f) -> vec4u {
  let p = vec2i(floor(pos));
  let k = i32(params.p.x);
  let size = vec2i(params.inputs[0].zw);
  var best = vec4u(0u);
  var nearest = 1e30;
  for (var n = 0; n < 9; n++) {
    let q = p + vec2i(n % 3 - 1, n / 3 - 1) * k;
    if (q.x < 0 || q.y < 0 || q.x >= size.x || q.y >= size.y) { continue; }
    let s = textureLoad(seeds, q, 0);
    if (s.w == 0u) { continue; }
    let d = metric(vec2f(s.xy) / 8. - pos);
    if (d < nearest) {
      nearest = d;
      best = s;
    }
  }
  return best;
}

@fragment
fn fragment(@builtin(position) pos: vec4f) -> @location(0) vec4u {
  if (params.operation == 40) { return seed(pos.xy); }
  return jump(pos.xy);
}
