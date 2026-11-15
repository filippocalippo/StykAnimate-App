// The signed distance from a full-size target's pixel centre to the artwork's edge, from the jump flood's seeds (input 0, the
// `seeds` binding): positive outside (input 1's alpha below 1/2), negative inside, far (1e6) where no seed reached; by straight
// distance or (`square`) by the larger axis. `.y` is the nearest edge's strength (1, or less along a faint line). Shared by the
// spread and outline shaders.

fn signedDistance(at: vec2f, square: bool) -> vec2f {
  let s = textureLoad(seeds, vec2i(floor(at)), 0);
  let inside = sample1(mapped(1u, at)).a >= .5;
  var d = 1e6;
  var strength = 1.;
  if (s.w != 0u) {
    let v = vec2f(s.xy) / 8. - at;
    d = select(length(v), max(abs(v.x), abs(v.y)), square);
    strength = f32(s.z) / 65535.;
  }
  return vec2f(select(d, -d, inside), strength);
}
