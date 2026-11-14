// Glow, shadow and bloom over the artwork, at full size.
//   LIGHT (30): input 0 the blurred mask (a halved image read smoothly), input 1 the front (the artwork, a glow's core tinted),
//     input 2 the base (the effect's input), input 3 the artwork's blurred colours (a glow coloured by the artwork, q.z).
//     p: intensity, falloff, placement (1 inner, 2 outer, 3 both), blend (0 normal, 1 add, 2 screen); q.xy: the shadow's offset
//     (pixels); q.w: the mask's inner part is its red channel (a spread), else one less its alpha. s.w: strength.
//   BLOOM (31): input 0 the bloom's sum (level 1, read smoothly), input 1 the artwork; p.x the intensity, p.y one over the sum's
//     weight. s.w: strength.

@fragment
fn fragment(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let at = pos.xy;
  let p = params.p;
  let b = brush(at);
  if (params.operation == 31) {
    let front = sample1(mapped(1u, at));
    let c = read0(at) * p.y;
    let top = max(front.a, c.a);
    return finish(strengthen(vec4f(min(front.rgb + c.rgb * b.rgb * b.a * p.x, vec3f(top)), top), front), at);
  }
  let q = params.q;
  let front = sample1(mapped(1u, at));
  let base = sample2(mapped(2u, at));
  let m = read0(at - q.xy);
  var glow = b.rgb;
  var reach = b.a;
  if (q.z > 0.) {
    glow = clamp(straight(read3(at - q.xy)), vec3f(0.), vec3f(1.));
    reach = 1.;
  }
  let modes = i32(p.z);
  var pixel = front;
  if ((modes & 1) != 0) {
    let inner = select(1. - m.a, m.r, q.w > 0.);
    let a = clamp(pow(max(inner, 0.), p.y) * p.x * reach, 0., 1.);
    var rgb = mix(front.rgb, glow * front.a, vec3f(a));
    if (p.w == 1.) { rgb = min(front.rgb + glow * front.a * a, vec3f(front.a)); }
    if (p.w == 2.) { rgb = front.rgb + glow * a * (front.a - front.rgb); }
    pixel = vec4f(rgb, front.a);
  }
  if ((modes & 2) != 0) {
    let a = clamp(pow(max(m.a, 0.), p.y) * p.x * reach, 0., 1.);
    let under = vec4f(glow * a, a);
    let top = max(pixel.a, a);
    if (p.w == 1.) {
      pixel = vec4f(min(pixel.rgb + under.rgb, vec3f(top)), top);
    } else if (p.w == 2.) {
      pixel = vec4f(pixel.rgb + under.rgb - pixel.rgb * under.rgb, top);
    } else {
      pixel = pixel + under * (1. - pixel.a);
    }
  }
  return finish(strengthen(pixel, base), at);
}
