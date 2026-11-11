// Glyph masks (glyphs.rs): a glyph's triangles, already in clip space, filled with full
// coverage; four samples a texel, resolved into the mask's coverage.

@vertex
fn vs_mask(@location(0) p: vec2<f32>) -> @builtin(position) vec4<f32> {
    return vec4<f32>(p, 0.0, 1.0);
}

@fragment
fn fs_mask() -> @location(0) vec4<f32> {
    return vec4<f32>(1.0, 1.0, 1.0, 1.0);
}
