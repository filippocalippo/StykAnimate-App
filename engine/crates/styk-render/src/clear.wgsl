// ---- A part of the frame cleared to transparency (`Renderer::redraw_within`): a triangle over the whole target, drawn under the
// part's scissor, writing every sample it covers as a clear would.

@vertex
fn vs_clear(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
    let uv = vec2<f32>(f32((vi << 1u) & 2u), f32(vi & 2u));
    return vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
}

@fragment
fn fs_clear() -> @location(0) vec4<f32> {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
}
