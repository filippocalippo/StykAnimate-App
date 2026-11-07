// The ink pad: the cel's tiles from an atlas, and the wet ink as soft discs, in one pass. Colours are straight in the
// atlas and premultiplied on output, as the toolkit's own pipelines blend.

struct Uniforms {
    size: vec2<f32>,     // the pad, physical pixels
    pan: vec2<f32>,      // cel pixel at the pad's top-left
    zoom: f32,           // physical pixels per cel pixel
    atlas_w: f32,        // one atlas page's size in texels
    atlas_h: f32,
    srgb: f32,           // 1 when the target converts sRGB on write
    color: vec4<f32>,    // the wet ink's colour
    wet: vec4<f32>,      // hardness, opacity
    paper: vec4<f32>,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var atlas_tex: texture_2d_array<f32>;
@group(0) @binding(2) var atlas_smp: sampler;

const CORNERS = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0),
    vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0),
);

fn to_clip(cel: vec2<f32>) -> vec4<f32> {
    let local = (cel - u.pan) * u.zoom;
    return vec4<f32>(local.x / u.size.x * 2.0 - 1.0, 1.0 - local.y / u.size.y * 2.0, 0.0, 1.0);
}

fn srgb_to_linear(c: vec3<f32>) -> vec3<f32> {
    let lo = c / 12.92;
    let hi = pow((c + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4));
    return select(hi, lo, c <= vec3<f32>(0.04045));
}

fn output(rgb: vec3<f32>, a: f32) -> vec4<f32> {
    var c = rgb;
    if (u.srgb > 0.5) {
        c = srgb_to_linear(c);
    }
    return vec4<f32>(c * a, a);
}

struct TileIn {
    @builtin(vertex_index) vertex: u32,
    @location(0) origin: vec2<f32>,
    @location(1) size: vec2<f32>,
    @location(2) texel: vec2<f32>,
    @location(3) solid: f32,
    @location(4) page: f32,
};

struct TileOut {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) solid: f32,
    @location(2) @interpolate(flat) page: i32,
};

@vertex
fn tile_vs(in: TileIn) -> TileOut {
    let c = CORNERS[in.vertex];
    var out: TileOut;
    out.position = to_clip(in.origin + c * in.size);
    out.uv = (in.texel + c * 64.0) / vec2<f32>(u.atlas_w, u.atlas_h);
    out.solid = in.solid;
    out.page = i32(in.page);
    return out;
}

@fragment
fn tile_fs(in: TileOut) -> @location(0) vec4<f32> {
    let texel = textureSampleLevel(atlas_tex, atlas_smp, in.uv, in.page, 0.0);
    if (in.solid > 0.5) {
        return output(u.paper.rgb, u.paper.a);
    }
    return output(texel.rgb, texel.a);
}

struct WetIn {
    @builtin(vertex_index) vertex: u32,
    @location(0) center: vec2<f32>,
    @location(1) radius: f32,
    @location(2) opacity: f32,
};

struct WetOut {
    @builtin(position) position: vec4<f32>,
    @location(0) offset: vec2<f32>,
    @location(1) radius: f32,
    @location(2) opacity: f32,
};

@vertex
fn wet_vs(in: WetIn) -> WetOut {
    let c = CORNERS[in.vertex] * 2.0 - vec2<f32>(1.0, 1.0);
    let reach = in.radius + 2.0 / u.zoom;
    var out: WetOut;
    out.position = to_clip(in.center + c * reach);
    out.offset = c * reach;
    out.radius = in.radius;
    out.opacity = in.opacity;
    return out;
}

@fragment
fn wet_fs(in: WetOut) -> @location(0) vec4<f32> {
    let d = length(in.offset);
    // The edge: one pixel of anti-aliasing, widened by the brush's softness (the wet canvas blurs by (1 - hardness) * r / 2).
    let soft = max(1.0 / u.zoom, (1.0 - u.wet.x) * in.radius * 0.5);
    let coverage = clamp((in.radius + soft * 0.5 - d) / soft, 0.0, 1.0);
    return output(u.color.rgb, coverage * in.opacity * u.wet.y);
}
