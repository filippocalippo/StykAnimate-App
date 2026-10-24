// ---- Presentation: copy the rendered frame into the host's pass.

struct BlitOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@group(0) @binding(0) var frame_tex: texture_2d<f32>;
@group(0) @binding(1) var frame_sampler: sampler;

@vertex
fn vs_blit(@builtin(vertex_index) vi: u32) -> BlitOut {
    var out: BlitOut;
    let uv = vec2<f32>(f32((vi << 1u) & 2u), f32(vi & 2u));
    out.uv = uv;
    out.pos = vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
    return out;
}

@fragment
fn fs_blit(in: BlitOut) -> @location(0) vec4<f32> {
    return textureSampleLevel(frame_tex, frame_sampler, in.uv, 0.0);
}

fn srgb_to_linear(c: vec3<f32>) -> vec3<f32> {
    let lo = c / 12.92;
    let hi = pow((c + 0.055) / 1.055, vec3<f32>(2.4));
    return select(hi, lo, c <= vec3<f32>(0.04045));
}

@fragment
fn fs_blit_srgb(in: BlitOut) -> @location(0) vec4<f32> {
    let c = textureSampleLevel(frame_tex, frame_sampler, in.uv, 0.0);
    return vec4<f32>(srgb_to_linear(c.rgb), c.a);
}
