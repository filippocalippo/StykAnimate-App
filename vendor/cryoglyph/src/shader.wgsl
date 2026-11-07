//@dual:begin
enable dual_source_blending;
//@dual:end

struct VertexInput {
    @builtin(vertex_index) vertex_idx: u32,
    @location(0) pos: vec2<i32>,
    @location(1) dim: u32,
    @location(2) uv: u32,
    @location(3) color: u32,
    @location(4) content_type_with_srgb: u32,
    @location(5) depth: f32,
}

struct VertexOutput {
    @invariant @builtin(position) position: vec4<f32>,
    @location(0) color: vec4<f32>,
    @location(1) uv: vec2<f32>,
    @location(2) @interpolate(flat) content_type: u32,
};

// flags: bit 0, the subpixels run blue, green, red; bit 1, coverage is adjusted for the text colour (contrast, gamma).
struct Params {
    screen_resolution: vec2<u32>,
    contrast: f32,
    gamma: f32,
    flags: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
};

@group(0) @binding(0)
var color_atlas_texture: texture_2d<f32>;

@group(0) @binding(1)
var mask_atlas_texture: texture_2d<f32>;

@group(0) @binding(2)
var atlas_sampler: sampler;

@group(1) @binding(0)
var<uniform> params: Params;

fn srgb_to_linear(c: f32) -> f32 {
    if c <= 0.04045 {
        return c / 12.92;
    } else {
        return pow((c + 0.055) / 1.055, 2.4);
    }
}

@vertex
fn vs_main(in_vert: VertexInput) -> VertexOutput {
    var pos = in_vert.pos;
    let width = in_vert.dim & 0xffffu;
    let height = (in_vert.dim & 0xffff0000u) >> 16u;
    let color = in_vert.color;
    var uv = vec2<u32>(in_vert.uv & 0xffffu, (in_vert.uv & 0xffff0000u) >> 16u);
    let v = in_vert.vertex_idx;

    let corner_position = vec2<u32>(
        in_vert.vertex_idx & 1u,
        (in_vert.vertex_idx >> 1u) & 1u,
    );

    let corner_offset = vec2<u32>(width, height) * corner_position;

    let content_type = in_vert.content_type_with_srgb & 0xffffu;
    let srgb = (in_vert.content_type_with_srgb & 0xffff0000u) >> 16u;

    // Subpixel coverage is stored three texels per pixel, so its texture coordinates move three times as fast.
    if content_type == 2u {
        uv = uv + vec2<u32>(corner_offset.x * 3u, corner_offset.y);
    } else {
        uv = uv + corner_offset;
    }
    pos = pos + vec2<i32>(corner_offset);

    var vert_output: VertexOutput;

    vert_output.position = vec4<f32>(
        2.0 * vec2<f32>(pos) / vec2<f32>(params.screen_resolution) - 1.0,
        in_vert.depth,
        1.0,
    );

    vert_output.position.y *= -1.0;

    switch srgb {
        case 0u: {
            vert_output.color = vec4<f32>(
                f32((color & 0x00ff0000u) >> 16u) / 255.0,
                f32((color & 0x0000ff00u) >> 8u) / 255.0,
                f32(color & 0x000000ffu) / 255.0,
                f32((color & 0xff000000u) >> 24u) / 255.0,
            );
        }
        case 1u: {
            vert_output.color = vec4<f32>(
                srgb_to_linear(f32((color & 0x00ff0000u) >> 16u) / 255.0),
                srgb_to_linear(f32((color & 0x0000ff00u) >> 8u) / 255.0),
                srgb_to_linear(f32(color & 0x000000ffu) / 255.0),
                f32((color & 0xff000000u) >> 24u) / 255.0,
            );
        }
        default: {}
    }

    var dim: vec2<u32> = vec2(0u);
    switch content_type {
        case 0u: {
            dim = textureDimensions(color_atlas_texture);
            break;
        }
        case 1u: {
            dim = textureDimensions(mask_atlas_texture);
            break;
        }
        default: {}
    }

    vert_output.content_type = content_type;

    if content_type == 2u {
        // Whole texels: the fragment shader fetches the three subpixels of its pixel itself.
        vert_output.uv = vec2<f32>(uv);
    } else {
        vert_output.uv = vec2<f32>(uv) / vec2<f32>(dim);
    }

    return vert_output;
}

// Skia's coverage adjustment (SkMaskGamma): the glyph's coverage is bent according to the text colour's luminance so that
// the blend of the text on its opposite looks as heavy as the font's own weight, with the contrast the platform asks
// for. `src` is a channel (or the luminance) of the text colour, quantized to three bits as Skia does.
fn quantize(c: f32) -> f32 {
    let v = u32(round(clamp(c, 0.0, 1.0) * 255.0)) >> 5u;
    let q = (v << 5u) | (v << 2u) | (v >> 1u);
    return f32(q) / 255.0;
}

fn adjust(coverage: f32, channel: f32) -> f32 {
    if (params.flags & 2u) == 0u {
        return coverage;
    }
    let src = quantize(channel);
    let dst = 1.0 - src;
    if abs(src - dst) < (1.0 / 256.0) {
        return coverage;
    }
    let lin_src = pow(src, params.gamma);
    let lin_dst = pow(dst, params.gamma);
    let contrast = params.contrast * lin_dst;
    let srca = coverage + (1.0 - coverage) * contrast * coverage;
    let dsta = 1.0 - srca;
    let lin_out = lin_src * srca + dsta * lin_dst;
    let out = pow(lin_out, 1.0 / params.gamma);
    return clamp((out - dst) / (src - dst), 0.0, 1.0);
}

fn luminance(color: vec3<f32>) -> f32 {
    let linear = vec3<f32>(pow(color.r, params.gamma), pow(color.g, params.gamma), pow(color.b, params.gamma));
    return pow(dot(linear, vec3<f32>(0.2126, 0.7152, 0.0722)), 1.0 / params.gamma);
}

//@dual:begin
struct FragmentOutput {
    @location(0) @blend_src(0) color: vec4<f32>,
    @location(0) @blend_src(1) coverage: vec4<f32>,
}

fn output(color: vec3<f32>, coverage: vec3<f32>, alpha: f32) -> FragmentOutput {
    var result: FragmentOutput;
    result.color = vec4<f32>(color, alpha);
    result.coverage = vec4<f32>(coverage, alpha);
    return result;
}
//@dual:end
//@single:begin
struct FragmentOutput {
    @location(0) color: vec4<f32>,
}

fn output(color: vec3<f32>, coverage: vec3<f32>, alpha: f32) -> FragmentOutput {
    var result: FragmentOutput;
    result.color = vec4<f32>(color, alpha);
    return result;
}
//@single:end

@fragment
fn fs_main(in_frag: VertexOutput) -> FragmentOutput {
    switch in_frag.content_type {
        case 0u: {
            let texel = textureSampleLevel(color_atlas_texture, atlas_sampler, in_frag.uv, 0.0);
            return output(texel.rgb, vec3<f32>(texel.a), texel.a);
        }
        case 1u: {
            let coverage = textureSampleLevel(mask_atlas_texture, atlas_sampler, in_frag.uv, 0.0).x;
            let alpha = in_frag.color.a * adjust(coverage, luminance(in_frag.color.rgb));
            return output(in_frag.color.rgb, vec3<f32>(alpha), alpha);
        }
        //@dual:begin
        case 2u: {
            let texel = vec2<i32>(i32(floor(in_frag.uv.x)) - 1, i32(floor(in_frag.uv.y)));
            var coverage = vec3<f32>(
                textureLoad(mask_atlas_texture, texel, 0).x,
                textureLoad(mask_atlas_texture, texel + vec2<i32>(1, 0), 0).x,
                textureLoad(mask_atlas_texture, texel + vec2<i32>(2, 0), 0).x,
            );
            // swash's subpixel mask is blue first (its channel 0 samples the glyph 0.3 pixels to the right of the pixel's centre,
            // where a red subpixel of an RGB display is on the left): an RGB display takes the channels reversed.
            if (params.flags & 1u) == 0u {
                coverage = coverage.bgr;
            }
            let adjusted = vec3<f32>(
                adjust(coverage.r, in_frag.color.r),
                adjust(coverage.g, in_frag.color.g),
                adjust(coverage.b, in_frag.color.b),
            ) * in_frag.color.a;
            return output(in_frag.color.rgb, adjusted, (adjusted.r + adjusted.g + adjusted.b) / 3.0);
        }
        //@dual:end
        default: {
            return output(vec3<f32>(0.0), vec3<f32>(0.0), 0.0);
        }
    }
}
