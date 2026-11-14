// StykAnimate primitive shader. One instanced draw per pass covers every
// primitive kind (a software rasterizer draws runs of the simpler kinds with
// `fs_flat` and `fs_vector`, below): the vertex stage expands a record into a quad (or triangle),
// the fragment stage shades it analytically in world units. Nothing here
// depends on the zoom level except the anti-aliasing width, so panning and
// zooming only change the `View` uniform.

struct View {
    m: vec4<f32>,        // world -> screen: x' = m.x*x + m.z*y + t.x
    t: vec4<f32>,        //                  y' = m.y*x + m.w*y + t.y ; t.z = screen px per world unit; t.w = 1 for crisp edges
    inv: vec4<f32>,      // screen -> world (same layout)
    inv_t: vec4<f32>,
    dest: vec4<f32>,     // target width, height, page index, depth
    artboard: vec4<f32>, // screen-space artboard rect (x0, y0, x1, y1)
    canvas_clip: vec4<f32>, // explicit root Canvas clip, already converted by its owner
    background_bounds: vec4<f32>, // world x, y, width, height
    paint_quad0: vec4<f32>, // transformed fill rectangle corners 0, 1
    paint_quad1: vec4<f32>, // transformed fill rectangle corners 2, 3
    orient_quad0: vec4<f32>, // the artboard's corners on a rotated or mirrored view: (0,0), (1,0)
    orient_quad1: vec4<f32>, // then (1,1), (0,1)
    orient_flags: vec4<f32>, // x: the artboard is that quad; y: the frame pass clips to it
};

struct Prim {
    kind: u32,
    group: u32,
    color: u32,
    paint: u32,
    a: vec4<f32>,
    b: vec4<f32>,
    c: vec4<f32>,
};

// Per-render placement of an isolation group (effects::record): six texels.
// A group is drawn in a space of its own (the screen's, an effect layer's grid,
// the camera image's) at a place in the atlas, then composited into its parent.
struct Group {
    m: vec4<f32>,       // world -> this group's atlas pixels, linear part (a, b, c, d)
    t: vec2<f32>,       // and its translation
    page: f32,          // atlas layer, or -1 when the group is not drawn
    aa: f32,            // world units per atlas pixel
    clip: vec4<f32>,    // the group's atlas rectangle (x0, y0, x1, y1)
    p: vec4<f32>,       // this group's atlas pixels -> its parent's target, linear part
    pt: vec2<f32>,      // and its translation
    canvas: f32,        // 1 where the editor paints the layer with Canvas 2D (effects::plan)
    show: vec4<f32>,    // the part of the atlas rectangle its composite shows
};

@group(0) @binding(0) var<uniform> view: View;
// Tables read with textureLoad, so the same shader runs where storage buffers do
// not exist (WebGL2): gradient records, isolation group placements, polyline vertices.
@group(0) @binding(1) var paint_table: texture_2d<f32>;
@group(0) @binding(2) var group_table: texture_2d<f32>;
@group(0) @binding(3) var point_table: texture_2d<f32>;
@group(1) @binding(0) var sprites: texture_2d_array<f32>;
@group(1) @binding(1) var linear_sampler: sampler;
@group(2) @binding(0) var layers: texture_2d_array<f32>;
// The particle material atlas (styk-draw MATERIAL_*): coverage and shading, trilinear.
@group(1) @binding(2) var materials: texture_2d<f32>;
@group(1) @binding(3) var material_sampler: sampler;
// Lone glyphs (styk-draw K_GLYPH, glyphs.rs): where each instance is drawn from this frame
// (three texels each), and the atlas of their coverage masks, sampled bilinearly.
@group(0) @binding(4) var glyph_table: texture_2d<f32>;
@group(1) @binding(4) var glyph_masks: texture_2d_array<f32>;
// Where each page of the document's sprite layout lives in the sprite texture (images.rs), for drawing cels' tiles: a
// layer of `sprites`, -1 for a page that is not resident.
@group(1) @binding(5) var page_table: texture_2d<f32>;
// The soft copies of the document's pictures (pictures.rs): one texel to SOFT_SCALE of the atlas page's, four pages to a
// layer in a 2 by 2 square, and which pictures are in `sprites` (a hash table of [corner, page, layer + 1, 0]).
@group(1) @binding(6) var soft_sprites: texture_2d_array<f32>;
@group(1) @binding(7) var picture_table: texture_2d<u32>;

const TABLE_WIDTH: u32 = 1024u;
// Pages of the sprite layout a table has a row for (MAX_PAGES in images.rs).
const MAX_PAGES: u32 = 1024u;
const ATLAS_PAGE: f32 = 4096.0;
const SOFT_PAGE: f32 = 512.0;
// Entries of the picture table read at most to find a picture (PROBES in pictures.rs).
const PICTURE_PROBES: u32 = 16u;

fn sprite_layer(page: f32) -> i32 {
    let at = u32(max(page, 0.0));
    if (at >= MAX_PAGES) { return -1; }
    return i32(textureLoad(page_table, table_at(at), 0).r);
}

// The layer of `sprites` that holds the picture whose rectangle starts at `corner` (a uv) of `page`, or -1 when only its
// soft copy is in: the same hash and probes as pictures.rs.
fn picture_layer(page: f32, corner: vec2<f32>) -> i32 {
    let pg = u32(max(page, 0.0));
    let xy = (u32(round(corner.y * ATLAS_PAGE)) << 12u) | u32(round(corner.x * ATLAS_PAGE));
    var h = (pg * 0x9E3779B1u) ^ (xy * 0x85EBCA6Bu);
    h = h ^ (h >> 15u);
    let size = textureDimensions(picture_table);
    let mask = size.x * size.y - 1u;
    for (var i = 0u; i < PICTURE_PROBES; i = i + 1u) {
        let slot = (h + i) & mask;
        let e = textureLoad(picture_table, vec2<i32>(i32(slot % TABLE_WIDTH), i32(slot / TABLE_WIDTH)), 0);
        if (e.x == xy && e.y == pg) { return i32(e.z) - 1; }
        if (e.x == 0u) { return -1; }
    }
    return -1;
}

// The soft copy of a picture at `uv` of its page (inset by half a soft texel from its rectangle `rect`, so a
// neighbour's texels are not read).
fn soft_sample(page: f32, rect: vec4<f32>, raw: vec2<f32>) -> vec4<f32> {
    let centre = (rect.xy + rect.zw) * 0.5;
    let reach = max((rect.zw - rect.xy) * 0.5 - vec2<f32>(0.5 / SOFT_PAGE), vec2<f32>(0.0));
    let uv = clamp(raw, centre - reach, centre + reach);
    let pg = u32(max(page, 0.0));
    // A page the soft atlas has no room for draws nothing.
    if (pg >= MAX_PAGES) { return vec4<f32>(0.0); }
    let layer = min(i32(pg >> 2u), i32(textureNumLayers(soft_sprites)) - 1);
    let cell = vec2<f32>(f32(pg & 1u), f32((pg >> 1u) & 1u));
    return textureSampleLevel(soft_sprites, linear_sampler, (cell + uv) * 0.5, layer, 0.0);
}

fn table_at(i: u32) -> vec2<i32> {
    return vec2<i32>(i32(i % TABLE_WIDTH), i32(i / TABLE_WIDTH));
}

fn paint_row(i: u32) -> vec4<f32> {
    return textureLoad(paint_table, table_at(i), 0);
}

fn polyline_point(i: u32) -> vec2<f32> {
    return textureLoad(point_table, table_at(i), 0).xy;
}

// Row `k` of lone glyph `i`: texel axes to the world, then the origin and mask size, then
// the mask's place in the atlas (x, y, page) and 1 where it is drawn from its mask.
fn glyph_row(i: u32, k: u32) -> vec4<f32> {
    return textureLoad(glyph_table, table_at(i * 3u + k), 0);
}

fn group_at(g: u32) -> Group {
    let r0 = textureLoad(group_table, table_at(g * 6u), 0);
    let r1 = textureLoad(group_table, table_at(g * 6u + 1u), 0);
    let r2 = textureLoad(group_table, table_at(g * 6u + 2u), 0);
    let r3 = textureLoad(group_table, table_at(g * 6u + 3u), 0);
    let r4 = textureLoad(group_table, table_at(g * 6u + 4u), 0);
    let r5 = textureLoad(group_table, table_at(g * 6u + 5u), 0);
    return Group(r0, r1.xy, r1.z, r1.w, r2, r3, r4.xy, r4.z, r5);
}

fn affine(m: vec4<f32>, t: vec2<f32>, q: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(m.x * q.x + m.z * q.y + t.x, m.y * q.x + m.w * q.y + t.y);
}

fn affine_inverse(m: vec4<f32>, t: vec2<f32>, q: vec2<f32>) -> vec2<f32> {
    let d = q - t;
    return vec2<f32>(m.w * d.x - m.z * d.y, -m.y * d.x + m.x * d.y) / (m.x * m.w - m.y * m.z);
}

const K_CAPSULE: u32 = 1u;
const K_ARC: u32 = 2u;
const K_DISC: u32 = 3u;
const K_RING: u32 = 4u;
const K_TRI: u32 = 5u;
const K_IMAGE: u32 = 6u;
const K_COMPOSITE: u32 = 7u;
const K_FILL_VIEW: u32 = 8u;
const K_BG_IMAGE: u32 = 9u;
const K_BOX: u32 = 10u;
const K_POLYLINE: u32 = 11u;
const K_DEPTH_RESET: u32 = 12u;
const K_PARTICLE: u32 = 13u;
const K_BEAM: u32 = 14u;
const K_GLYPH: u32 = 15u;
const F_GLYPH_VECTOR: u32 = 32768u;
const MATERIAL_CELL: f32 = 256.0;
const MATERIAL_COLUMNS: f32 = 4.0;
const MATERIAL_ROWS: f32 = 4.0;
const MATERIAL_MAX_LOD: f32 = 3.0;
const TAU: f32 = 6.28318530718;
const F_CLOSED: u32 = 1024u;
const F_DEPTH: u32 = 8192u;
const DEPTH_FAR: f32 = 0.9999;
const F_SMOOTH: u32 = 256u;
const F_RING_FILL: u32 = 512u;
const F_TINT: u32 = 2048u;
const F_DRAWING: u32 = 4096u;
const NO_PAINT: u32 = 0xffffffffu;
const PI: f32 = 3.14159265358979;

struct VsIn {
    @builtin(vertex_index) vertex: u32,
    // One record per instance: (kind, group, colour, paint), then three vec4 of parameters.
    @location(0) head: vec4<u32>,
    @location(1) a: vec4<f32>,
    @location(2) b: vec4<f32>,
    @location(3) c: vec4<f32>,
};

struct VsOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) world: vec2<f32>,
    @location(1) uv: vec2<f32>,
    @location(2) @interpolate(flat) aa: f32,
    @location(3) @interpolate(flat) clip: vec4<f32>,
    @location(4) @interpolate(flat) head: vec4<u32>,
    @location(5) @interpolate(flat) a: vec4<f32>,
    @location(6) @interpolate(flat) b: vec4<f32>,
    @location(7) @interpolate(flat) c: vec4<f32>,
    // Canvas 2D drawing sampling: positive blends its parent, negative enlarges with Mitchell.
    @location(8) @interpolate(flat) sampling: f32,
};

fn to_screen(p: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(view.m.x * p.x + view.m.z * p.y + view.t.x, view.m.y * p.x + view.m.w * p.y + view.t.y);
}

fn to_world(s: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(view.inv.x * s.x + view.inv.z * s.y + view.inv_t.x, view.inv.y * s.x + view.inv.w * s.y + view.inv_t.y);
}

// World -> this pass's target: the screen for the frame, the group's atlas space otherwise.
fn to_target(world: vec2<f32>, g: u32, gr: Group) -> vec2<f32> {
    if (g == 0u) { return to_screen(world); }
    return affine(gr.m, gr.t, world);
}

// Screen pixels to clip space. WGSL lets a compiler reassociate this, and the rasteriser snaps the result to 1/256 pixel before
// it decides which samples a triangle covers, so a different rounding moves the edges of thin triangles by a sample: DX12's
// compiler (FXC) folded `t / size * 2 - 1` into `t * (2 / size) - 1`. The division is a statement of its own here, which keeps
// Direct3D 12 and Vulkan equal on this machine. Nothing in the language guarantees it: tests/clip_position.rs holds both
// backends to the same coverage.
fn clip_pos(t: vec2<f32>) -> vec4<f32> {
    let q = t / view.dest.xy;
    return vec4<f32>(fma(q.x, 2.0, -1.0), fma(q.y, -2.0, 1.0), 0.0, 1.0);
}

fn corner(v: u32) -> vec2<f32> {
    // Two triangles: (0,0) (1,0) (0,1) / (0,1) (1,0) (1,1)
    var c = array<vec2<f32>, 6>(vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(0.0, 1.0), vec2(0.0, 1.0), vec2(1.0, 0.0), vec2(1.0, 1.0));
    return c[v];
}

fn in_sweep(angle: f32, start: f32, sweep: f32) -> bool {
    var d = angle - start;
    if (sweep >= 0.0) {
        d = d - floor(d / (2.0 * PI)) * 2.0 * PI;
        return d <= sweep;
    }
    d = start - angle;
    d = d - floor(d / (2.0 * PI)) * 2.0 * PI;
    return d <= -sweep;
}

// Hashing and value noise of generated effects (the same as styk-raster's and the batch's).
fn pcg(v: u32) -> u32 {
    let s = v * 747796405u + 2891336453u;
    let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
    return (w >> 22u) ^ w;
}

fn hash2(x: i32, y: i32) -> f32 {
    return f32(pcg((bitcast<u32>(x) * 73856093u) ^ (bitcast<u32>(y) * 19349663u))) * (1.0 / 4294967296.0);
}

fn vnoise(v: vec2<f32>) -> f32 {
    let i = floor(v);
    let f = v - i;
    let u = f * f * (3.0 - 2.0 * f);
    let ix = i32(i.x);
    let iy = i32(i.y);
    return mix(mix(hash2(ix, iy), hash2(ix + 1, iy), u.x), mix(hash2(ix, iy + 1), hash2(ix + 1, iy + 1), u.x), u.y);
}

fn smooth01(a: f32, b: f32, x: f32) -> f32 {
    let t = clamp((x - a) / (b - a), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
}

struct Shaped {
    local: vec2<f32>,
    uv: vec2<f32>,
    prm: vec4<f32>,
};

// ---------------------------------------------------------------------------------------------
// Generated effects (docs/engine/vfx.md): particles, trails, beams. styk-raster/src/generators.rs
// carries out the same arithmetic on the processor. A record's colour is premultiplied with less
// alpha than colour where it emits light (`lit`): one blend draws paint and light alike.
// ---------------------------------------------------------------------------------------------

const P_DISC: u32 = 0u;
const P_STREAK: u32 = 1u;
const P_RING: u32 = 2u;
const P_ROCK: u32 = 3u;
const P_SEGMENT: u32 = 4u;
const P_MATERIAL: u32 = 5u;
const P_SQUARE: u32 = 6u;
const P_RHOMBUS: u32 = 7u;
const P_STAR: u32 = 8u;
const P_SPARKLE: u32 = 9u;
const P_SPARK: u32 = 10u;
const P_SHARD: u32 = 11u;
const P_DROP: u32 = 12u;
const P_HEART: u32 = 13u;
const P_BURST: u32 = 14u;
const P_CLOUD: u32 = 15u;
const P_FLAKE: u32 = 16u;
const P_PETAL: u32 = 17u;
const P_BOLT: u32 = 18u;
const P_FLAME: u32 = 19u;
const P_SPLAT: u32 = 20u;
const P_BOKEH: u32 = 21u;
const P_TOON_STAR: u32 = 22u;

fn particle_shape_of(kind: u32) -> u32 {
    return (kind >> 16u) & 255u;
}

// A shape's random number `k` from its seed, 0–1.
fn shape_hash(seed: u32, k: u32) -> f32 {
    return f32(pcg(seed * 2654435761u + k * 40503u)) * (1.0 / 4294967296.0);
}

fn rem_e(x: f32, m: f32) -> f32 {
    return x - floor(x / m) * m;
}

fn sd_seg(p: vec2<f32>, a: vec2<f32>, b: vec2<f32>) -> f32 {
    let pa = p - a;
    let ba = b - a;
    let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-12), 0.0, 1.0);
    return length(pa - ba * h);
}

fn sd_box2(p: vec2<f32>, b: vec2<f32>) -> f32 {
    let d = abs(p) - b;
    return length(max(d, vec2<f32>(0.0))) + min(max(d.x, d.y), 0.0);
}

fn sd_rhombus(p0: vec2<f32>, b: vec2<f32>) -> f32 {
    let p = abs(p0);
    let nd = (b.x - 2.0 * p.x) * b.x - (b.y - 2.0 * p.y) * b.y;
    let h = clamp(nd / dot(b, b), -1.0, 1.0);
    let q = p - 0.5 * b * vec2<f32>(1.0 - h, 1.0 + h);
    let s = p.x * b.y + p.y * b.x - b.x * b.y;
    return length(q) * select(1.0, -1.0, s < 0.0);
}

fn sd_star(p: vec2<f32>, r: f32, n: f32, m: f32) -> f32 {
    let an = PI / n;
    let en = PI / m;
    let acs = vec2<f32>(cos(an), sin(an));
    let ecs = vec2<f32>(cos(en), sin(en));
    let a = atan2(p.x, -p.y);
    let bn = rem_e(a, 2.0 * an) - an;
    let l = length(p);
    var q = vec2<f32>(l * cos(bn), l * abs(sin(bn)));
    q = q - r * acs;
    q = q + ecs * clamp(-dot(q, ecs), 0.0, r * acs.y / ecs.y);
    return length(q) * select(1.0, -1.0, q.x < 0.0);
}

fn sd_uneven_capsule(p0: vec2<f32>, r1: f32, r2: f32, h: f32) -> f32 {
    let p = vec2<f32>(abs(p0.x), p0.y);
    let b = (r1 - r2) / h;
    let a = sqrt(max(1.0 - b * b, 0.0));
    let k = -b * p.x + a * p.y;
    if (k < 0.0) { return length(p) - r1; }
    if (k > a * h) { return length(p - vec2<f32>(0.0, h)) - r2; }
    return a * p.x + b * p.y - r1;
}

fn sd_heart(p0: vec2<f32>) -> f32 {
    let p = vec2<f32>(abs(p0.x), p0.y);
    if (p.y + p.x > 1.0) { return length(p - vec2<f32>(0.25, 0.75)) - 0.35355339; }
    let a = length(p - vec2<f32>(0.0, 1.0));
    let s = 0.5 * max(p.x + p.y, 0.0);
    let b = length(p - vec2<f32>(s, s));
    return min(a, b) * select(1.0, -1.0, p.x - p.y < 0.0);
}

fn sd_vesica(p0: vec2<f32>, r: f32, d: f32) -> f32 {
    let p = abs(p0);
    let b = sqrt(max(r * r - d * d, 0.0));
    if ((p.y - b) * d > p.x * b) { return length(p - vec2<f32>(0.0, b)); }
    return length(p + vec2<f32>(d, 0.0)) - r;
}

fn sd_triangle(p: vec2<f32>, p0: vec2<f32>, p1: vec2<f32>, p2: vec2<f32>) -> f32 {
    let e0 = p1 - p0;
    let e1 = p2 - p1;
    let e2 = p0 - p2;
    let v0 = p - p0;
    let v1 = p - p1;
    let v2 = p - p2;
    let pq0 = v0 - e0 * clamp(dot(v0, e0) / max(dot(e0, e0), 1e-12), 0.0, 1.0);
    let pq1 = v1 - e1 * clamp(dot(v1, e1) / max(dot(e1, e1), 1e-12), 0.0, 1.0);
    let pq2 = v2 - e2 * clamp(dot(v2, e2) / max(dot(e2, e2), 1e-12), 0.0, 1.0);
    let s = sign(e0.x * e2.y - e0.y * e2.x);
    let d = min(min(dot(pq0, pq0), dot(pq1, pq1)), dot(pq2, pq2));
    let sg = min(min(s * (v0.x * e0.y - v0.y * e0.x), s * (v1.x * e1.y - v1.y * e1.x)), s * (v2.x * e2.y - v2.y * e2.x));
    return -sqrt(d) * sign(sg);
}

fn rock_radius(a: f32, seed: u32, n: u32, lo: f32) -> f32 {
    let t = rem_e(a / TAU, 1.0) * f32(n);
    let i = u32(floor(t)) % n;
    let f = t - floor(t);
    return mix(mix(lo, 1.0, shape_hash(seed, i)), mix(lo, 1.0, shape_hash(seed, (i + 1u) % n)), f);
}

fn smin(a: f32, b: f32, k: f32) -> f32 {
    let h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
    return mix(b, a, h) - k * h * (1.0 - h);
}

fn shape_distance(shape: u32, q: vec2<f32>, seed: u32) -> f32 {
    if (shape == P_SQUARE) { return sd_box2(q, vec2<f32>(1.0, 1.0)); }
    if (shape == P_RHOMBUS) { return sd_rhombus(q, vec2<f32>(0.72, 1.0)); }
    if (shape == P_STAR) { return sd_star(q, 1.0, 5.0, 2.6); }
    if (shape == P_SPARKLE) { return sd_star(q, 1.0, 4.0, 2.08); }
    if (shape == P_SPARK) { return sd_rhombus(q, vec2<f32>(0.2, 1.0)); }
    if (shape == P_SHARD) {
        let j1 = (shape_hash(seed, 1u) - 0.5) * 0.35;
        let j2 = (shape_hash(seed, 2u) - 0.5) * 0.35;
        let j3 = (shape_hash(seed, 3u) - 0.5) * 0.35;
        let j4 = (shape_hash(seed, 4u) - 0.5) * 0.35;
        let j5 = (shape_hash(seed, 5u) - 0.5) * 0.35;
        return sd_triangle(q, vec2<f32>(j1, -1.0), vec2<f32>(0.62 + j2, 0.75 + j3), vec2<f32>(-0.55 + j4, 0.6 + j5));
    }
    if (shape == P_ROCK) { return (length(q) - rock_radius(atan2(q.x, q.y), seed, 7u, 0.68)) * 0.9; }
    if (shape == P_DROP) { return sd_uneven_capsule(vec2<f32>(q.x, q.y + 0.4), 0.58, 0.04, 1.4); }
    if (shape == P_HEART) { return sd_heart(vec2<f32>(q.x * 0.82, -q.y * 0.82 + 0.6)) / 0.82; }
    if (shape == P_BURST) {
        let n = 11.0;
        let a = atan2(q.x, -q.y) + PI;
        let k = u32(floor(a / TAU * n));
        return sd_star(q, mix(0.78, 1.0, shape_hash(seed, k)), n, 2.25);
    }
    if (shape == P_CLOUD) {
        var d = 1e9;
        d = smin(d, length(q - vec2<f32>(-0.48, 0.18)) - 0.42, 0.12);
        d = smin(d, length(q - vec2<f32>(-0.05, -0.18)) - 0.55, 0.12);
        d = smin(d, length(q - vec2<f32>(0.45, 0.08)) - 0.44, 0.12);
        d = smin(d, length(q - vec2<f32>(-0.2, 0.36)) - 0.38, 0.12);
        d = smin(d, length(q - vec2<f32>(0.25, 0.38)) - 0.36, 0.12);
        return max(d, q.y - 0.62);
    }
    if (shape == P_FLAKE) {
        let sector = PI / 3.0;
        let a = rem_e(atan2(q.x, -q.y), sector) - sector / 2.0;
        let r = length(q);
        let f = vec2<f32>(r * abs(sin(a)), r * cos(a));
        let arm = sd_seg(f, vec2<f32>(0.0, 0.0), vec2<f32>(0.0, 0.95)) - 0.09;
        let side = sd_seg(f, vec2<f32>(0.0, 0.5), vec2<f32>(0.3, 0.75)) - 0.06;
        return min(min(arm, side), length(q) - 0.2);
    }
    if (shape == P_PETAL) { return sd_vesica(q, 1.0, 0.62); }
    if (shape == P_BOLT) {
        var d = sd_seg(q, vec2<f32>(-0.05, -1.0), vec2<f32>(0.32, -0.18)) - 0.2;
        d = min(d, sd_seg(q, vec2<f32>(0.32, -0.18), vec2<f32>(-0.12, -0.02)) - 0.14);
        d = min(d, sd_seg(q, vec2<f32>(-0.12, -0.02), vec2<f32>(0.18, 1.0)) - 0.08);
        return d;
    }
    if (shape == P_FLAME) {
        let lean = 0.22 * (shape_hash(seed, 1u) - 0.5) * 2.0;
        let wx = q.x + lean * (1.0 - q.y) * (1.0 - q.y) * 0.25;
        let body = sd_uneven_capsule(vec2<f32>(wx, -(q.y - 0.42)), 0.55, 0.02, 1.35);
        let side = sd_uneven_capsule(vec2<f32>(wx + 0.32, -(q.y - 0.35)), 0.24, 0.01, 0.75);
        return smin(body, side, 0.1);
    }
    if (shape == P_SPLAT) {
        let a = atan2(q.x, q.y);
        let r = 0.68 + 0.14 * sin(a * 3.0 + shape_hash(seed, 1u) * 6.0) + 0.09 * sin(a * 7.0 + shape_hash(seed, 2u) * 6.0);
        let k0 = shape_hash(seed, 3u) * TAU;
        let k1 = shape_hash(seed, 4u) * TAU;
        let d1 = length(q - 0.9 * vec2<f32>(cos(k0), sin(k0))) - 0.12;
        let d2 = length(q - 0.85 * vec2<f32>(cos(k1), sin(k1))) - 0.09;
        return min(min(length(q) - r, d1), d2);
    }
    if (shape == P_TOON_STAR) { return sd_star(q, 0.86, 5.0, 3.3) - 0.12; }
    return length(q) - 1.0;
}

fn edge_cov(d: f32, soft: f32, px: f32) -> f32 {
    if (soft <= 0.001) { return clamp(0.5 - d / px, 0.0, 1.0); }
    return smooth01(px * 0.5, -soft, d);
}

// Premultiplied colour of a paint layer: `rgb` at coverage `k`, emitting `e` of its light.
fn lit(rgb: vec3<f32>, k: f32, e: f32) -> vec4<f32> {
    return vec4<f32>(rgb * k, k * (1.0 - e));
}

fn over(top: vec4<f32>, under: vec4<f32>) -> vec4<f32> {
    return top + under * (1.0 - top.a);
}

// A fill with an ink line `line - k` around it.
fn with_outline(rgb: vec3<f32>, k: f32, line: f32, e: f32, alpha: f32, ink: vec4<f32>) -> vec4<f32> {
    let fill = lit(rgb, k * alpha, e);
    let band = max(line - min(k, 1.0), 0.0) * ink.a * alpha;
    return vec4<f32>(fill.rgb + ink.rgb * band, fill.a + band);
}

// One corner `q` (-1..1) of a generated-effect record, in its draw's local units; `px` is the
// target's pixel in those units.
fn particle_corner(p: Prim, kind: u32, q: vec2<f32>, px: f32, shape_row: vec4<f32>) -> Shaped {
    var o: Shaped;
    if (kind == K_BEAM) {
        let a = p.a.xy;
        let d = p.a.zw - a;
        let len = max(length(d), 1.0);
        let dn = d / len;
        let nn = vec2<f32>(-dn.y, dn.x);
        let halo = p.b.x * 3.0 + 8.0 + px;
        let lx = mix(-halo, len + halo, q.x * 0.5 + 0.5);
        let ly = q.y * halo;
        o.local = a + dn * lx + nn * ly;
        o.uv = vec2<f32>(lx, ly);
        o.prm = vec4<f32>(len, p.b.x, p.b.y, p.b.z);
        return o;
    }
    let shape = particle_shape_of(p.kind);
    let softness = shape_row.x;
    if (shape == P_SEGMENT) {
        let p0 = p.a.xy;
        let p1 = p.a.zw;
        let d = p1 - p0;
        let l = length(d);
        var dn = vec2<f32>(1.0, 0.0);
        if (l > 1e-4) { dn = d / l; }
        let hl = 0.5 * l;
        let e = max(p.b.x, p.b.y) * (1.0 + softness * 3.0) + px;
        let local = vec2<f32>(q.x * (hl + e), q.y * e);
        o.local = (p0 + p1) * 0.5 + dn * local.x + vec2<f32>(-dn.y, dn.x) * local.y;
        o.uv = local;
        o.prm = vec4<f32>(hl, px, 0.0, 0.0);
        return o;
    }
    let centre = p.a.xy;
    let sz = p.a.z;
    let cr = vec2<f32>(cos(p.a.w), sin(p.a.w));
    let vel = p.b.xy;
    if (shape == P_STREAK) {
        let sp = length(vel);
        var d = vec2<f32>(1.0, 0.0);
        if (sp > 1e-4) { d = vel / sp; }
        let hl = 0.5 * sp * shape_row.y;
        let rr = max(sz, px * 0.5);
        let local = vec2<f32>(q.x * (hl + rr + px), q.y * (rr + px));
        o.local = centre - d * hl + d * local.x + vec2<f32>(-d.y, d.x) * local.y;
        o.uv = local;
        o.prm = vec4<f32>(hl, rr, softness, px);
        return o;
    }
    let hx = max(sz, px * 0.5);
    let hy = hx * shape_row.z + 0.5 * length(vel) * shape_row.y;
    let ow = shape_row.w;
    var grow = 0.0;
    if (shape == P_RING) { grow = hx * softness * 2.0; }
    let pad = px + ow + grow;
    let e = vec2<f32>(q.x * (hx + pad), q.y * (hy + pad));
    o.local = centre + vec2<f32>(e.x * cr.x - e.y * cr.y, e.x * cr.y + e.y * cr.x);
    o.uv = vec2<f32>(e.x / hx, e.y / hy);
    var lod = 0.0;
    if (shape == P_MATERIAL) { lod = clamp(log2(MATERIAL_CELL * px / (2.0 * max(hx, hy))), 0.0, MATERIAL_MAX_LOD); }
    o.prm = vec4<f32>(px / min(hx, hy), ow / hx, lod, 0.0);
    return o;
}

// A material's density and light at `uv` (0–1 in its cell), trilinearly, never leaving the cell.
fn material_sample(cell: u32, uv: vec2<f32>, lod: f32) -> vec2<f32> {
    let m = f32(cell >> 4u);
    let v = f32(cell & 15u);
    let l0 = floor(lod);
    let l1 = min(l0 + 1.0, MATERIAL_MAX_LOD);
    let s0 = material_level(m, v, uv, l0);
    let s1 = material_level(m, v, uv, l1);
    return mix(s0, s1, lod - l0);
}

fn material_level(m: f32, v: f32, uv: vec2<f32>, level: f32) -> vec2<f32> {
    // Texel centres of this cell at this level: half a texel in from its sides.
    let cell = MATERIAL_CELL / exp2(level);
    let half = 0.5 / cell;
    let c = clamp(uv, vec2<f32>(half), vec2<f32>(1.0 - half));
    let at = vec2<f32>((v + c.x) / MATERIAL_COLUMNS, (m + c.y) / MATERIAL_ROWS);
    return textureSampleLevel(materials, material_sampler, at, level).rg;
}

// A generated-effect particle's premultiplied colour; `rows` are the draw's rows 2 to 5.
fn particle_color(p: Prim, uv: vec2<f32>, prm: vec4<f32>, shade_amount: f32, shape_row: vec4<f32>, ink: vec4<f32>, erosion: vec4<f32>, rim: vec4<f32>) -> vec4<f32> {
    let shape = particle_shape_of(p.kind);
    let rgb = p.c.rgb;
    let alpha = p.c.a;
    let e = p.b.z;
    let softness = shape_row.x;
    var cov = 0.0;
    if (shape == P_SEGMENT) {
        let hl = prm.x;
        let px = prm.y;
        let t = clamp((uv.x + hl) / max(2.0 * hl, 1e-4), 0.0, 1.0);
        let r = max(mix(p.b.x, p.b.y, t), px * 0.35);
        let caps = p.kind >> 24u;
        let along = abs(uv.x) - hl;
        var d = abs(uv.y);
        var open = true;
        if (along > 0.0) {
            let capped = select((caps & 2u) != 0u, (caps & 1u) != 0u, uv.x < 0.0);
            if (capped) { d = length(vec2<f32>(along, uv.y)); } else { open = false; }
        }
        if (!open) { discard; }
        let core = clamp(0.5 - (d - r) / px, 0.0, 1.0);
        var glow = 0.0;
        if (softness > 0.0) { glow = exp(-max(d - r, 0.0) / (r * softness * 1.2 + px)) * 0.6 * (1.0 - smooth01(r + r * softness * 1.8, r + r * softness * 3.0 + px, d)); }
        let k = max(core, glow) * mix(alpha, p.b.w, t);
        var ek = e;
        if (core < glow) { ek = max(e, 0.85); }
        if (k <= 0.0) { discard; }
        return lit(rgb, k, ek);
    }
    if (shape == P_STREAK) {
        let hl = prm.x;
        let t = clamp(uv.x / max(hl, 1e-3) * 0.5 + 0.5, 0.0, 1.0);
        let w = select(1.0, mix(0.3, 1.0, t), hl > 0.5);
        let d = length(vec2<f32>(max(abs(uv.x) - hl, 0.0), uv.y / w)) / prm.y;
        let tail = select(1.0, t * t * (3.0 - 2.0 * t) * 0.9 + 0.1, hl > 0.5);
        let aa = min(prm.w / prm.y * 1.5, 1.0);
        cov = pow(max(1.0 - d, 1e-5), max(prm.z, 0.05)) * (1.0 - smooth01(1.0 - aa, 1.0, d)) * tail;
    } else if (shape == P_MATERIAL) {
        let tex = material_sample(p.color & 0xffffu, uv * 0.5 + vec2<f32>(0.5), prm.z);
        let f = tex.x;
        let th = p.b.w;
        let w = max(erosion.x, prm.x * 1.2);
        let k = smooth01(th, th + w, f);
        var line = k;
        if (shape_row.w > 0.0) { line = smooth01(th - prm.y * 0.5, th - prm.y * 0.5 + w * 0.5, f); }
        if (line <= 0.0) { discard; }
        var col = rgb * mix(1.0, 0.45 + 1.1 * tex.y, shade_amount);
        if (erosion.z > 0.0) {
            let r = (1.0 - smooth01(th, th + max(erosion.y, w), f)) * erosion.z;
            col = mix(col, rim.rgb, r);
        }
        return with_outline(col, k, line, e, alpha, ink);
    } else if (shape == P_DISC || shape == P_RING || shape == P_BOKEH) {
        let r = length(uv);
        let px = prm.x;
        if (shape == P_RING) {
            let hw = max(softness, 0.02);
            let band = clamp(0.5 - (abs(r - 1.0) - hw) / px, 0.0, 1.0);
            cov = band * mix(0.55, 1.0, smooth01(1.0 - hw, 1.0, r)) + 0.12 * (1.0 - smooth01(0.0, 1.0, r)) * select(0.0, 1.0, r <= 1.0);
        } else if (shape == P_BOKEH) {
            cov = edge_cov(r - 1.0, 0.0, px) * mix(0.5, 1.0, smooth01(0.62, 0.96, r));
        } else if (softness < 0.15) {
            cov = edge_cov(r - 1.0, 0.0, px);
        } else {
            cov = pow(max(1.0 - r, 0.0), softness) * (1.0 - smooth01(1.0 - px, 1.0, r));
        }
        if (shape_row.w > 0.0) {
            let line = edge_cov(r - 1.0 - prm.y, 0.0, px);
            let o = with_outline(rgb, cov, line, e, alpha, ink);
            if (o.a <= 0.0 && max(o.r, max(o.g, o.b)) <= 0.0) { discard; }
            return o;
        }
    } else {
        let d = shape_distance(shape, uv, p.color & 0xffffu);
        let px = prm.x;
        cov = edge_cov(d, softness, px);
        if (shape_row.w > 0.0) {
            let line = edge_cov(d - prm.y, 0.0, px);
            let o = with_outline(rgb, cov, line, e, alpha, ink);
            if (o.a <= 0.0 && max(o.r, max(o.g, o.b)) <= 0.0) { discard; }
            return o;
        }
        if (shape == P_SPARK || shape == P_SPARKLE) {
            let core = (1.0 - smooth01(0.0, 0.45, length(uv))) * 0.6;
            let k = cov * alpha;
            if (k <= 0.0) { discard; }
            return lit(mix(rgb, vec3<f32>(1.0), core), k, e);
        }
    }
    let k = cov * alpha;
    if (k <= 0.0) { discard; }
    return lit(rgb, k, e);
}

// A beam's premultiplied colour; `aa` is the pixel in local units; rows 2 to 6 of its draw are its
// core, body and glow colours (each with how much light it emits), [head swell, ink colour] and the
// rim colour its body turns to toward its edge.
fn beam_color(p: Prim, uv: vec2<f32>, prm: vec4<f32>, aa: f32) -> vec4<f32> {
    let l = prm.x;
    let w = prm.y;
    if (w <= 0.05) { discard; }
    let t = p.b.w;
    let x = uv.x;
    let style = u32(p.c.y);
    let opacity = p.c.x;
    let seed = prm.w;
    let core_c = paint_row(p.paint + 2u);
    let body_c = paint_row(p.paint + 3u);
    let glow_c = paint_row(p.paint + 4u);
    let extra = paint_row(p.paint + 5u);
    let wob = (vnoise(vec2<f32>(x * 0.018 - t * 0.55, seed)) - 0.5) * 2.0 * prm.z * w * smooth01(0.0, 80.0, x);
    let y = uv.y - wob;
    let head = smooth01(l - w * 2.5, l - w * 0.4, x) * extra.x;
    let ww = w * mix(0.55, 1.0, smooth01(0.0, 60.0, x)) * (1.0 + 0.35 * head);
    let d = length(vec2<f32>(max(max(-x, x - l), 0.0), abs(y)));
    if (style == 2u) {
        let ink = 1.0 - smooth01(ww + p.c.w - aa, ww + p.c.w + aa, d);
        let body = 1.0 - smooth01(ww - aa, ww + aa, d);
        let core = 1.0 - smooth01(ww * 0.45 - aa, ww * 0.45 + aa, d);
        let col = mix(body_c.rgb, core_c.rgb, core);
        let a = body * opacity;
        let band = max(ink - body, 0.0) * opacity;
        let o = vec4<f32>(col * a + extra.yzw * band, a + band);
        if (o.a <= 0.0) { discard; }
        return o;
    }
    let flow = 0.8 + 0.45 * vnoise(vec2<f32>(x * 0.045 - t * 1.6, y / max(ww, 1.0) * 1.3 + seed));
    var core_w = 0.2;
    var body_w = 0.68;
    var glow_w = 0.9;
    var bright = flow;
    if (style == 1u) { core_w = 0.18; body_w = 0.42; glow_w = 0.7; bright = 1.0; }
    let core = 1.0 - smooth01(ww * core_w - aa, ww * (core_w + 0.1) + aa, d);
    let body = 1.0 - smooth01(ww * body_w - aa, ww * body_w + aa * 2.0, d);
    // The glow fades out before the quad's side (w · 3 + 8 from the axis).
    let halo = w * 3.0 + 8.0;
    let glow = exp(-max(d - ww * body_w * 0.8, 0.0) / (ww * glow_w + 1.0)) * 0.55 * (1.0 - smooth01(halo * 0.6, halo, d));
    var out = lit(glow_c.rgb, glow * opacity, glow_c.a);
    // The body turns to its rim colour over its outer half: a deeper tone of the hue gives a light
    // beam an edge that reads on a light page.
    let rim_c = paint_row(p.paint + 6u);
    let edge = smooth01(ww * body_w * 0.4, ww * body_w, d);
    out = over(lit(mix(body_c.rgb, rim_c.rgb, edge), body * opacity * min(bright, 1.0), mix(body_c.a, rim_c.a, edge)), out);
    if (p.c.z > 0.5) {
        let period = max(24.0, w * 3.2);
        let inside = step(0.0, x) * step(x, l);
        for (var s = 0u; s < 2u; s = s + 1u) {
            let phase = x / period * TAU - t * 0.35 + f32(s) * PI;
            let sy = sin(phase) * ww * 0.95;
            let depth = 0.55 + 0.45 * cos(phase);
            let strand = exp(-abs(y - sy) / (ww * 0.1 + 0.6)) * depth * inside;
            out = over(lit(core_c.rgb, min(strand * opacity, 1.0), core_c.a), out);
        }
    }
    out = over(lit(min(core_c.rgb * bright, vec3<f32>(1.0)), core * opacity, core_c.a), out);
    if (out.a <= 0.0 && max(out.r, max(out.g, out.b)) <= 0.0) { discard; }
    return out;
}

// What every vertex entry point starts with: the record's attributes for the fragment stage and the placement of its
// group (`gr`, zero for the root). False where the group is not drawn on this page: `out` is then off screen.
fn vertex_start(in: VsIn, out: ptr<function, VsOut>, gr: ptr<function, Group>) -> bool {
    (*out).head = in.head;
    (*out).a = in.a;
    (*out).b = in.b;
    (*out).c = in.c;
    (*out).uv = vec2<f32>(0.0, 0.0);
    (*out).sampling = 0.0;
    let g = in.head.y;
    (*out).clip = vec4<f32>(-1e9, -1e9, 1e9, 1e9);
    // World units per target pixel.
    var aa = 1.0 / max(view.t.z, 1e-12);
    if (g != 0u) {
        *gr = group_at(g);
        if ((*gr).page != view.dest.z) {
            (*out).pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
            return false;
        }
        aa = (*gr).aa;
        (*out).clip = (*gr).clip;
    }
    (*out).aa = aa;
    return true;
}

fn vertex_prim(in: VsIn) -> Prim {
    return Prim(in.head.x, in.head.y, in.head.z, in.head.w, in.a, in.b, in.c);
}

// A vertex at `world`, carried into this pass's target.
fn placed(out: ptr<function, VsOut>, world: vec2<f32>, g: u32, gr: Group) {
    (*out).world = world;
    (*out).pos = clip_pos(to_target(world, g, gr));
}

// The corner `c` of a segment's or a box's quad, along it and across it with the anti-aliasing margin.
fn segment_corner(p: Prim, aa: f32, margin: f32, c: vec2<f32>) -> vec2<f32> {
    let p0 = p.a.xy;
    let p1 = p.a.zw;
    let hw = max(p.b.x, aa * 0.5);
    var d = p1 - p0;
    let len = length(d);
    if (len > 1e-12) { d = d / len; } else { d = vec2<f32>(1.0, 0.0); }
    let n = vec2<f32>(-d.y, d.x);
    let e = hw + margin;
    let along = mix(-e, len + e, c.x);
    let across = mix(-e, e, c.y);
    return p0 + d * along + n * across;
}

// The corner `c` of the box around an arc's swept part.
fn arc_corner(p: Prim, aa: f32, margin: f32, c: vec2<f32>) -> vec2<f32> {
    let center = p.a.xy;
    let r = p.a.z;
    let hw = max(p.a.w, aa * 0.5);
    let start = p.b.x;
    let sweep = p.b.y;
    var lo = center + r * vec2<f32>(cos(start), sin(start));
    var hi = lo;
    let e2 = center + r * vec2<f32>(cos(start + sweep), sin(start + sweep));
    lo = min(lo, e2);
    hi = max(hi, e2);
    for (var k = 0; k < 4; k = k + 1) {
        let a = f32(k) * PI * 0.5;
        if (in_sweep(a, start, sweep)) {
            let q = center + r * vec2<f32>(cos(a), sin(a));
            lo = min(lo, q);
            hi = max(hi, q);
        }
    }
    let e = hw + margin;
    return mix(lo - vec2<f32>(e), hi + vec2<f32>(e), c);
}

fn polyline_corner(p: Prim, aa: f32, margin: f32, c: vec2<f32>) -> vec2<f32> {
    let e = max(p.b.x, aa * 0.5) + margin;
    return mix(p.a.xy - vec2<f32>(e), p.a.zw + vec2<f32>(e), c);
}

fn disc_corner(p: Prim, margin: f32, c: vec2<f32>) -> vec2<f32> {
    let e = p.a.z + margin;
    return p.a.xy + mix(vec2<f32>(-e), vec2<f32>(e), c);
}

fn ring_corner(p: Prim, aa: f32, margin: f32, c: vec2<f32>) -> vec2<f32> {
    let e = p.a.z + max(p.a.w, aa * 0.5) + margin;
    return p.a.xy + mix(vec2<f32>(-e), vec2<f32>(e), c);
}

// A lone glyph's own triangles draw only where the view gives it no mask.
fn triangle_hidden(p: Prim) -> bool {
    return (p.kind & F_GLYPH_VECTOR) != 0u && glyph_row(bitcast<u32>(p.b.z), 2u).w > 0.5;
}

fn triangle_corner(p: Prim, vi: u32) -> vec2<f32> {
    if (vi == 0u) { return p.a.xy; } else if (vi == 1u) { return p.a.zw; }
    return p.b.xy;
}

// The artboard on screen; a group's whole layer (the camera image's background): K_FILL_VIEW, K_BG_IMAGE.
fn view_fill(out: ptr<function, VsOut>, kind: u32, g: u32, gr: Group, c: vec2<f32>) {
    if (g == 0u) {
        var s = mix(view.artboard.xy, view.artboard.zw, c);
        if (view.orient_flags.x > 0.5) {
            s = mix(mix(view.orient_quad0.xy, view.orient_quad0.zw, c.x), mix(view.orient_quad1.zw, view.orient_quad1.xy, c.x), c.y);
        }
        if (view.inv_t.z > 0.5) {
            if (kind == K_BG_IMAGE || view.inv_t.w > 0.5) {
                // One full-sample paint with independent coverage and clip
                // masks; native artboard MSAA must not clip it a second time.
                s = c * view.dest.xy;
            } else {
                // Keep the complete rotated paint quad and its ordinary
                // native coverage; no geometric-area approximation.
                s = mix(mix(view.paint_quad0.xy, view.paint_quad0.zw, c.x), mix(view.paint_quad1.zw, view.paint_quad1.xy, c.x), c.y);
            }
        }
        (*out).world = to_world(s);
        (*out).pos = clip_pos(s);
    } else {
        let s = mix(gr.clip.xy, gr.clip.zw, c);
        (*out).world = affine_inverse(gr.m, gr.t, s);
        (*out).pos = clip_pos(s);
    }
}

// A picture or a drawing tile (K_IMAGE).
fn image_vertex(out: ptr<function, VsOut>, p: Prim, g: u32, gr: Group, c: vec2<f32>) {
    let aa = (*out).aa;
    if ((p.kind & F_DRAWING) != 0u) {
        // A drawing tile of display level b.w: the view shows one level per cel,
        // floor(-log2(target pixels per cel pixel)) clamped to 0..8 (docs/engine/drawing.md).
        let level = p.b.w;
        let tile_pixels = length(p.a.zw) / (64.0 * aa);
        // The equivalent interval test preserves exact power-of-two boundaries:
        // GPU log2(0.5) can round below 1 and show the preceding level.
        let shown = (level == 0.0 || tile_pixels <= 1.0) && (level == 8.0 || tile_pixels > 0.5);
        if (!shown) {
            (*out).pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
            return;
        }
        // In a layer the editor paints with Canvas 2D, it draws this level scaled by what
        // remains (between 1 and 1/2) with 'high' smoothing, which Chromium samples from the
        // level's own reductions, trilinearly, at a level of detail of log2(1 / scale) - 1/2
        // (measured): past 2^-1/2, up to half of the next level is blended in.
        if ((g == 0u && view.inv_t.z > 0.5) || (g != 0u && gr.canvas > 0.5)) {
            // Exactly 1× remains bilinear, including fractional translations; any
            // enlargement uses Mitchell (the editor's imageSmoothingQuality 'high').
            if (tile_pixels > 1.0) {
                (*out).sampling = -1.0;
            } else if (p.paint != NO_PAINT) {
                (*out).sampling = clamp(-log2(max(tile_pixels, 1e-30)) - 0.5, 0.0, 0.5);
            }
        }
    }
    (*out).uv = c;
    placed(out, p.a.xy + p.a.zw * c.x + p.b.xy * c.y, g, gr);
}

// An isolated group's composite: the child's shown rectangle, carried into this target by the child's own map.
fn composite_vertex(out: ptr<function, VsOut>, p: Prim, c: vec2<f32>) {
    let child = group_at(bitcast<u32>(p.b.x));
    if (child.page < 0.0) {
        (*out).pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
        return;
    }
    let a = mix(child.show.xy, child.show.zw, c);
    (*out).uv = a;
    (*out).pos = clip_pos(affine(child.p, child.pt, a));
}

// Every kind. The simpler vertex entry points below hold the kinds of their fragment entry points (`shading.rs`): a
// software rasterizer runs every branch of this one for each vertex, which was a third of a frame of 3,200 segments.
@vertex
fn vs_main(in: VsIn) -> VsOut {
    var out: VsOut;
    var gr: Group;
    if (!vertex_start(in, &out, &gr)) { return out; }
    let vi = in.vertex;
    let p = vertex_prim(in);
    let kind = p.kind & 255u;
    let g = p.group;
    let aa = out.aa;
    let margin = aa * 1.5;
    let c = corner(vi);
    var world = vec2<f32>(0.0, 0.0);
    if (kind == K_CAPSULE || kind == K_BOX) {
        world = segment_corner(p, aa, margin, c);
    } else if (kind == K_ARC) {
        world = arc_corner(p, aa, margin, c);
    } else if (kind == K_POLYLINE) {
        world = polyline_corner(p, aa, margin, c);
    } else if (kind == K_DISC) {
        world = disc_corner(p, margin, c);
    } else if (kind == K_RING) {
        world = ring_corner(p, aa, margin, c);
    } else if (kind == K_TRI) {
        if (triangle_hidden(p)) {
            out.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
            return out;
        }
        world = triangle_corner(p, vi);
        if ((p.kind & F_DEPTH) != 0u) {
            // A face of a depth run: its corner's window depth, mapped over the run's depth
            // range in this shader as the editor's mesh raster maps it (styk-draw `F_DEPTH`).
            var d = p.c.x;
            if (vi == 0u) { d = p.b.z; } else if (vi == 1u) { d = p.b.w; }
            out.world = world;
            out.pos = clip_pos(to_target(world, g, gr));
            out.pos.z = 0.9995 - 0.999 * (d - p.c.y) / p.c.z;
            return out;
        }
    } else if (kind == K_DEPTH_RESET) {
        // The run's rectangle at the far depth, before its faces are drawn.
        world = mix(p.a.xy - vec2<f32>(margin), p.a.zw + vec2<f32>(margin), c);
        out.world = world;
        out.pos = clip_pos(to_target(world, g, gr));
        out.pos.z = DEPTH_FAR;
        return out;
    } else if (kind == K_IMAGE) {
        image_vertex(&out, p, g, gr, c);
        return out;
    } else if (kind == K_GLYPH) {
        // A lone glyph's mask: its texels placed in the world by this frame's table, as the
        // editor's glyph quad places its texture (`glyphTextureShape`).
        let i = bitcast<u32>(p.b.x);
        let r0 = glyph_row(i, 0u);
        let r1 = glyph_row(i, 1u);
        let r2 = glyph_row(i, 2u);
        if (r2.w < 0.5) {
            out.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
            return out;
        }
        let texel = c * r1.zw;
        world = vec2<f32>(r0.x * texel.x + r0.z * texel.y + r1.x, r0.y * texel.x + r0.w * texel.y + r1.y);
        out.uv = texel;
        // The fragment stage reads the mask's place where other kinds carry `a` and `b`.
        out.a = r2;
        out.b = vec4<f32>(r1.zw, 0.0, 0.0);
    } else if (kind == K_COMPOSITE) {
        composite_vertex(&out, p, c);
        return out;
    } else if (kind == K_FILL_VIEW || kind == K_BG_IMAGE) {
        view_fill(&out, kind, g, gr, c);
        return out;
    }
    placed(&out, world, g, gr);
    return out;
}

// Triangles (not of a depth run) and the view's fill.
@vertex
fn vs_flat(in: VsIn) -> VsOut {
    var out: VsOut;
    var gr: Group;
    if (!vertex_start(in, &out, &gr)) { return out; }
    let p = vertex_prim(in);
    if ((p.kind & 255u) == K_FILL_VIEW) {
        view_fill(&out, K_FILL_VIEW, p.group, gr, corner(in.vertex));
        return out;
    }
    if (triangle_hidden(p)) {
        out.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
        return out;
    }
    placed(&out, triangle_corner(p, in.vertex), p.group, gr);
    return out;
}

// Segments, discs, rings and triangles not hidden (`triangle_hidden`): the kinds of `fs_stroke` but the view's fill.
fn stroke_corner(p: Prim, kind: u32, aa: f32, margin: f32, c: vec2<f32>, vi: u32) -> vec2<f32> {
    if (kind == K_CAPSULE) { return segment_corner(p, aa, margin, c); }
    if (kind == K_DISC) { return disc_corner(p, margin, c); }
    if (kind == K_RING) { return ring_corner(p, aa, margin, c); }
    return triangle_corner(p, vi);
}

// Those, boxes, arcs and polylines: the kinds of `fs_vector` but the view's fill.
fn vector_corner(p: Prim, kind: u32, aa: f32, margin: f32, c: vec2<f32>, vi: u32) -> vec2<f32> {
    if (kind == K_BOX) { return segment_corner(p, aa, margin, c); }
    if (kind == K_ARC) { return arc_corner(p, aa, margin, c); }
    if (kind == K_POLYLINE) { return polyline_corner(p, aa, margin, c); }
    return stroke_corner(p, kind, aa, margin, c, vi);
}

@vertex
fn vs_stroke(in: VsIn) -> VsOut {
    var out: VsOut;
    var gr: Group;
    if (!vertex_start(in, &out, &gr)) { return out; }
    let p = vertex_prim(in);
    let kind = p.kind & 255u;
    let c = corner(in.vertex);
    if (kind == K_FILL_VIEW) {
        view_fill(&out, K_FILL_VIEW, p.group, gr, c);
        return out;
    }
    if (kind == K_TRI && triangle_hidden(p)) {
        out.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
        return out;
    }
    placed(&out, stroke_corner(p, kind, out.aa, out.aa * 1.5, c, in.vertex), p.group, gr);
    return out;
}

@vertex
fn vs_vector(in: VsIn) -> VsOut {
    var out: VsOut;
    var gr: Group;
    if (!vertex_start(in, &out, &gr)) { return out; }
    let p = vertex_prim(in);
    let kind = p.kind & 255u;
    let c = corner(in.vertex);
    if (kind == K_FILL_VIEW) {
        view_fill(&out, K_FILL_VIEW, p.group, gr, c);
        return out;
    }
    if (kind == K_TRI && triangle_hidden(p)) {
        out.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
        return out;
    }
    placed(&out, vector_corner(p, kind, out.aa, out.aa * 1.5, c, in.vertex), p.group, gr);
    return out;
}

@vertex
fn vs_image(in: VsIn) -> VsOut {
    var out: VsOut;
    var gr: Group;
    if (!vertex_start(in, &out, &gr)) { return out; }
    let p = vertex_prim(in);
    image_vertex(&out, p, p.group, gr, corner(in.vertex));
    return out;
}

@vertex
fn vs_composite(in: VsIn) -> VsOut {
    var out: VsOut;
    var gr: Group;
    if (!vertex_start(in, &out, &gr)) { return out; }
    composite_vertex(&out, vertex_prim(in), corner(in.vertex));
    return out;
}

// Crisp edges (Edges::Crisp, exports without smoothing): a pixel is in or out at its centre.
fn crisp() -> bool {
    return view.t.w > 0.5;
}

fn coverage(d: f32, aa: f32) -> f32 {
    if (crisp()) { return select(0.0, 1.0, d <= 0.0); }
    return clamp(0.5 - d / aa, 0.0, 1.0);
}

fn unpack(c: u32) -> vec4<f32> {
    return unpack4x8unorm(c);
}

// Straight-alpha colour of a paint record at a world position.
fn paint_at(offset: u32, w: vec2<f32>) -> vec4<f32> {
    let head = paint_row(offset);
    let g = paint_row(offset + 1u);
    let kind = u32(head.x);
    let count = u32(head.y);
    var t = 0.0;
    if (kind == 0u) {
        let d = g.zw - g.xy;
        t = dot(w - g.xy, d) / max(dot(d, d), 1e-12);
    } else if (kind == 1u) {
        t = length(w - g.xy) / max(g.z, 1e-12);
    } else if (kind == 2u) {
        let v = w - g.xy;
        let a = atan2(v.y, v.x) - g.z;
        t = fract(a / (2.0 * PI));
    } else if (kind == 3u) {
        let uv = (w - g.xy) / max(g.w, 1e-12);
        let cs = cos(g.z);
        let sn = sin(g.z);
        t = abs(uv.x * cs + uv.y * sn) + abs(-uv.x * sn + uv.y * cs);
    } else {
        t = (length(w - g.xy) - g.z) / max(g.w - g.z, 1e-12);
    }
    t = clamp(t, 0.0, 1.0);
    let base = offset + 3u;
    var prev_offset = paint_row(base).x;
    var prev = paint_row(base + 1u);
    if (t <= prev_offset) { return prev; }
    for (var i = 1u; i < count; i = i + 1u) {
        let o = paint_row(base + i * 2u).x;
        let col = paint_row(base + i * 2u + 1u);
        if (t < o) {
            let f = (t - prev_offset) / max(o - prev_offset, 1e-12);
            return mix(prev, col, f);
        }
        prev_offset = o;
        prev = col;
    }
    return prev;
}

// Bilinear filtering of a drawing tile's straight-alpha texels, premultiplied first:
// `origin` is the top-left texel of the 2×2 footprint, `f` the position within it.
fn tile_bilinear(origin: vec2<i32>, layer: i32, f: vec2<f32>) -> vec4<f32> {
    let t00 = premul(textureLoad(sprites, origin, layer, 0));
    let t10 = premul(textureLoad(sprites, origin + vec2<i32>(1, 0), layer, 0));
    let t01 = premul(textureLoad(sprites, origin + vec2<i32>(0, 1), layer, 0));
    let t11 = premul(textureLoad(sprites, origin + vec2<i32>(1, 1), layer, 0));
    return mix(mix(t00, t10, f.x), mix(t01, t11, f.x), f.y);
}

// Mitchell-Netravali B=C=1/3, evaluated in the same order as styk-raster::shade.
fn mitchell_weight(t: f32) -> f32 {
    let x = abs(t);
    if (x < 1.0) { return ((7.0 / 6.0 * x - 2.0) * x) * x + 8.0 / 9.0; }
    if (x < 2.0) { return ((-7.0 / 18.0 * x + 2.0) * x - 10.0 / 3.0) * x + 16.0 / 9.0; }
    return 0.0;
}

fn tile_mitchell(start: vec2<i32>, layer: i32, t: vec2<f32>) -> vec4<f32> {
    let cell = floor(t);
    let f = t - cell;
    let wx = vec4<f32>(mitchell_weight(f.x + 1.0), mitchell_weight(f.x), mitchell_weight(1.0 - f.x), mitchell_weight(2.0 - f.x));
    let wy = vec4<f32>(mitchell_weight(f.y + 1.0), mitchell_weight(f.y), mitchell_weight(1.0 - f.y), mitchell_weight(2.0 - f.y));
    var sum = vec4<f32>(0.0);
    for (var j = 0; j < 4; j = j + 1) {
        var row = vec4<f32>(0.0);
        for (var i = 0; i < 4; i = i + 1) {
            // Two real neighbour texels on each side, never a neighboring atlas slot.
            let q = clamp(start + vec2<i32>(cell) + vec2<i32>(i - 1, j - 1), start - vec2<i32>(2), start + vec2<i32>(65));
            row = row + premul(textureLoad(sprites, q, layer, 0)) * wx[i];
        }
        sum = sum + row * wy[j];
    }
    // Cubic weights have negative lobes: Canvas clamps the filtered premultiplied colour
    // before opacity/blending, so neither negative coverage nor RGB above alpha survives.
    let alpha = clamp(sum.a, 0.0, 1.0);
    return vec4<f32>(clamp(sum.rgb, vec3<f32>(0.0), vec3<f32>(alpha)), alpha);
}

// Nearest-neighbour sampling through the linear sampler: at a texel's centre the
// filter returns that texel alone. WebGL2 binds one sampler per texture, so the
// sprite atlas cannot have a second, nearest one.
fn texel_centre(uv: vec2<f32>, size: vec2<f32>) -> vec2<f32> {
    return (floor(uv * size) + vec2<f32>(0.5)) / size;
}

fn premul(c: vec4<f32>) -> vec4<f32> {
    return vec4<f32>(c.rgb * c.a, c.a);
}

fn sd_segment(p: vec2<f32>, a: vec2<f32>, b: vec2<f32>) -> f32 {
    let pa = p - a;
    let ba = b - a;
    let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-20), 0.0, 1.0);
    return length(pa - ba * h);
}

fn sd_box(p: vec2<f32>, a: vec2<f32>, b: vec2<f32>, hw: f32) -> f32 {
    var d = b - a;
    let len = length(d);
    if (len > 1e-12) { d = d / len; } else { d = vec2<f32>(1.0, 0.0); }
    let n = vec2<f32>(-d.y, d.x);
    let q = p - (a + b) * 0.5;
    let local = abs(vec2<f32>(dot(q, d), dot(q, n))) - vec2<f32>(len * 0.5 + hw, hw);
    return length(max(local, vec2<f32>(0.0))) + min(max(local.x, local.y), 0.0);
}

fn sd_arc(p: vec2<f32>, center: vec2<f32>, r: f32, start: f32, sweep: f32) -> f32 {
    let v = p - center;
    let a = atan2(v.y, v.x);
    if (in_sweep(a, start, sweep) || abs(sweep) >= 2.0 * PI - 1e-6) {
        return abs(length(v) - r);
    }
    let e0 = center + r * vec2<f32>(cos(start), sin(start));
    let e1 = center + r * vec2<f32>(cos(start + sweep), sin(start + sweep));
    return min(length(p - e0), length(p - e1));
}

fn soft(d: f32, s: f32, aa: f32) -> f32 {
    let edge = 1.0 - smooth01(1.0 - aa, 1.0, d);
    return pow(max(1.0 - d, 1e-5), s) * edge;
}

// Material shading: 0.5 keeps the colour, lower darkens, higher lightens.
fn shade_rgb(c: vec3<f32>, s: f32) -> vec3<f32> {
    if (s < 0.5) { return c * (0.25 + 1.5 * s); }
    return mix(c, vec3<f32>(1.0), (s - 0.5) * 1.4);
}

// A fragment outside the clip of the group it is drawn in is not drawn.
fn discard_outside_clip(in: VsOut) {
    let pos = in.pos.xy;
    if (pos.x < in.clip.x || pos.y < in.clip.y || pos.x > in.clip.z || pos.y > in.clip.w) {
        discard;
    }
}

fn is_vector(kind: u32) -> bool {
    return kind == K_CAPSULE || kind == K_BOX || kind == K_ARC || kind == K_POLYLINE || kind == K_DISC || kind == K_RING || kind == K_TRI || kind == K_FILL_VIEW;
}

fn shade_primitive(in: VsOut) -> vec4<f32> {
    discard_outside_clip(in);
    let p = Prim(in.head.x, in.head.y, in.head.z, in.head.w, in.a, in.b, in.c);
    let kind = p.kind & 255u;
    let w = in.world;
    let aa = in.aa;
    var base = unpack(p.color);
    // A drawing tile's `paint` names its parent tile, not a paint (styk-draw F_DRAWING).
    if (p.paint != NO_PAINT && (p.kind & F_DRAWING) == 0u) {
        base = paint_at(p.paint, w);
    }
    if (is_vector(kind)) {
        return shade_vector(p, kind, w, aa, base);
    }
    return shade_sampled(in, p, kind, base);
}

// Hairlines keep a one-pixel footprint and fade with their width (crisp: solid): the half width drawn, and the fade.
fn hairline(width: f32, aa: f32) -> vec2<f32> {
    var hw = width;
    var fade = 1.0;
    if (hw < aa * 0.5) {
        fade = select(max(hw, 0.0) * 2.0 / aa, select(0.0, 1.0, hw > 0.0), crisp());
        hw = aa * 0.5;
    }
    return vec2<f32>(hw, fade);
}

// A stroke at signed distance `d` from its edge, in `base` (straight alpha), premultiplied.
fn stroked(base: vec4<f32>, d: f32, aa: f32, fade: f32) -> vec4<f32> {
    let cov = coverage(d, aa) * fade;
    if (cov <= 0.0) { discard; }
    return premul(base) * cov;
}

// The shapes covered by their distance (segments, boxes, arcs, polylines, discs, rings) and the
// flat ones (triangles, the view's fill), in `base` (straight alpha), premultiplied.
fn shade_vector(p: Prim, kind: u32, w: vec2<f32>, aa: f32, base: vec4<f32>) -> vec4<f32> {
    if (kind == K_BOX) {
        let h = hairline(p.b.x, aa);
        return stroked(base, sd_box(w, p.a.xy, p.a.zw, h.x), aa, h.y);
    }
    if (kind == K_POLYLINE) {
        let h = hairline(p.b.x, aa);
        let start = bitcast<u32>(p.b.y);
        let count = bitcast<u32>(p.b.z);
        var best = 1e30;
        for (var k = 0u; k + 1u < count; k = k + 1u) {
            best = min(best, sd_segment(w, polyline_point(start + k), polyline_point(start + k + 1u)));
        }
        if ((p.kind & F_CLOSED) != 0u && count > 2u) {
            best = min(best, sd_segment(w, polyline_point(start + count - 1u), polyline_point(start)));
        }
        return stroked(base, best - h.x, aa, h.y);
    }
    if (kind == K_ARC) {
        let h = hairline(p.a.w, aa);
        return stroked(base, sd_arc(w, p.a.xy, p.a.z, p.b.x, p.b.y) - h.x, aa, h.y);
    }
    return shade_stroke(p, kind, w, aa, base);
}

// What stick figures are drawn with: segments, discs and rings, and the flat kinds (triangles, the view's fill).
fn shade_stroke(p: Prim, kind: u32, w: vec2<f32>, aa: f32, base: vec4<f32>) -> vec4<f32> {
    if (kind == K_CAPSULE) {
        let h = hairline(p.b.x, aa);
        return stroked(base, sd_segment(w, p.a.xy, p.a.zw) - h.x, aa, h.y);
    }
    if (kind == K_DISC) {
        let cov = coverage(length(w - p.a.xy) - p.a.z, aa);
        if (cov <= 0.0) { discard; }
        return premul(base) * cov;
    }
    if (kind == K_RING) {
        let dist = length(w - p.a.xy);
        let h = hairline(p.a.w, aa);
        let ring = coverage(abs(dist - p.a.z) - h.x, aa) * h.y;
        var out = premul(base) * ring;
        if ((p.kind & F_RING_FILL) != 0u) {
            let fill = premul(unpack(bitcast<u32>(p.b.x))) * coverage(dist - p.a.z, aa);
            out = out + fill * (1.0 - out.a);
        }
        if (out.a <= 0.0) { discard; }
        return out;
    }
    // K_TRI and K_FILL_VIEW.
    return premul(base);
}

// What samples a texture: lone glyphs, pictures and drawing tiles, the background picture, composites.
fn shade_sampled(in: VsOut, p: Prim, kind: u32, base: vec4<f32>) -> vec4<f32> {
    let w = in.world;
    if (kind == K_GLYPH) {
        // The mask sampled bilinearly, clamped to its own texels as an exact texture's edge
        // would be, in the text's colour and opacity (the editor's glyph shader).
        let size = vec2<f32>(textureDimensions(glyph_masks).xy);
        let t = clamp(in.uv, vec2<f32>(0.5), in.b.xy - vec2<f32>(0.5)) + in.a.xy;
        let alpha = textureSampleLevel(glyph_masks, linear_sampler, t / size, i32(in.a.z), 0.0).r * base.a;
        if (alpha <= 0.0) { discard; }
        return vec4<f32>(base.rgb * alpha, alpha);
    }
    if (kind == K_IMAGE) {
        return shade_image(in, p, base);
    }
    if (kind == K_BG_IMAGE) {
        let rect = p.c;
        let size = vec2<f32>(textureDimensions(sprites).xy);
        let texel = 1.0 / size;
        let uv = clamp(w / p.a.xy, vec2<f32>(0.0), vec2<f32>(1.0));
        let layer = picture_layer(p.a.z, rect.xy);
        if (layer < 0) {
            return soft_sample(p.a.z, rect, mix(rect.xy, rect.zw, uv)) * base.a;
        }
        let q = clamp(mix(rect.xy, rect.zw, uv), rect.xy + texel * 0.5, rect.zw - texel * 0.5);
        return textureSampleLevel(sprites, linear_sampler, texel_centre(q, size), layer, 0.0) * base.a;
    }
    if (kind == K_COMPOSITE) {
        return shade_composite(in, p, base);
    }
    return vec4<f32>(0.0);
}

// A picture of the document or a drawing tile (K_IMAGE), in `base`'s opacity (an onion skin's sprite: its tint).
fn shade_image(in: VsOut, p: Prim, base: vec4<f32>) -> vec4<f32> {
    let rect = p.c;
    let size = vec2<f32>(textureDimensions(sprites).xy);
    let texel = 1.0 / size;
    let raw = mix(rect.xy, rect.zw, in.uv);
    var tex: vec4<f32>;
    if ((p.kind & F_DRAWING) != 0u && crisp()) {
        // Crisp edges: the nearest texel of the tile, unfiltered.
        let nearest = vec2<i32>(round(rect.xy * size)) + vec2<i32>(clamp(floor(in.uv * 64.0), vec2<f32>(0.0), vec2<f32>(63.0)));
        tex = premul(textureLoad(sprites, nearest, sprite_layer(p.b.z), 0));
    } else if ((p.kind & F_DRAWING) != 0u) {
        // Premultiply each straight-alpha texel before filtering. Canvas enlargement
        // uses Mitchell; other sampling is bilinear, optionally blended with a parent.
        let t = in.uv * 64.0 - vec2<f32>(0.5);
        let cell = floor(t);
        let f = t - cell;
        let start = vec2<i32>(round(rect.xy * size));
        let origin = start + vec2<i32>(cell);
        let layer = sprite_layer(p.b.z);
        if (in.sampling < 0.0) {
            tex = tile_mitchell(start, layer, t);
        } else {
            tex = tile_bilinear(origin, layer, f);
        }
        if (in.sampling > 0.0) {
            // The parent tile: this tile is the quarter `q` of it, at half its texel density.
            let parent = paint_row(p.paint);
            let q = u32(parent.w);
            let tp = in.uv * 32.0 + vec2<f32>(f32(q & 1u), f32(q >> 1u)) * 32.0 - vec2<f32>(0.5);
            let cp = floor(tp);
            let up = tile_bilinear(vec2<i32>(parent.yz) + vec2<i32>(cp), sprite_layer(parent.x), tp - cp);
            tex = mix(tex, up, in.sampling);
        }
    } else {
        // A picture of the document: from the sprite texture, or its soft copy while that is not in.
        let layer = picture_layer(p.b.z, rect.xy);
        if (layer < 0) {
            tex = soft_sample(p.b.z, rect, raw);
        } else if ((p.kind & F_SMOOTH) != 0u && !crisp()) {
            tex = textureSampleLevel(sprites, linear_sampler, raw, layer, 0.0);
        } else {
            let q = clamp(raw, rect.xy + texel * 0.5, rect.zw - texel * 0.5);
            tex = textureSampleLevel(sprites, linear_sampler, texel_centre(q, size), layer, 0.0);
        }
    }
    if ((p.kind & F_TINT) != 0u) {
        // An onion skin's sprite: its coverage in the tint colour.
        return vec4<f32>(base.rgb * tex.a, tex.a) * base.a;
    }
    return tex * base.a;
}

// An isolated group's layer composited into its parent (K_COMPOSITE), in `base`'s opacity.
fn shade_composite(in: VsOut, p: Prim, base: vec4<f32>) -> vec4<f32> {
    // Bilinear, clamped to the child's own rectangle as an exact texture's edge would be
    // (crisp edges: the nearest texel; a layer on the screen's grid is copied either way).
    let child = group_at(bitcast<u32>(p.b.x));
    let size = vec2<f32>(textureDimensions(layers).xy);
    var uv = clamp(in.uv, child.clip.xy + vec2<f32>(0.5), child.clip.zw - vec2<f32>(0.5));
    if (crisp()) { uv = floor(uv) + vec2<f32>(0.5); }
    let tex = textureSampleLevel(layers, linear_sampler, uv / size, i32(child.page), 0.0);
    return tex * base.a;
}

// The explicit Canvas policy is applied only at the root owning paint or
// completed isolated composite. Child pass uniforms leave this policy off.
fn canvas_clip_alpha(pos: vec2<f32>) -> f32 {
    let p = floor(pos);
    let size = clamp(min(view.canvas_clip.zw, p + vec2<f32>(1.0)) - max(view.canvas_clip.xy, p), vec2<f32>(0.0), vec2<f32>(1.0));
    return floor(size.x * size.y * 255.0 + 0.5);
}

fn canvas_fill_alpha(pos: vec2<f32>) -> f32 {
    let low = floor(min(view.paint_quad0.xy, view.paint_quad1.xy) * 256.0 + vec2<f32>(0.5));
    let high = floor(max(view.paint_quad0.xy, view.paint_quad1.xy) * 256.0 + vec2<f32>(0.5));
    let p = floor(pos) * 256.0;
    let size = clamp(min(high, p + vec2<f32>(256.0)) - max(low, p), vec2<f32>(0.0), vec2<f32>(256.0));
    if (size.x == 0.0 || size.y == 0.0) { return 0.0; }
    let thin = floor(low / 256.0) == floor((high - vec2<f32>(1.0)) / 256.0);
    if (thin.y) { return floor((size.y - 1.0) * size.x / 256.0); }
    if (size.x == 256.0) { return select(size.y - select(0.0, 1.0, thin.y), 255.0, size.y == 256.0); }
    if (size.y == 256.0) { return size.x - select(0.0, 1.0, thin.x); }
    return floor((size.y - select(0.0, 1.0, thin.y)) * size.x / 256.0);
}

fn canvas_image_bounds(p: Prim) -> vec4<f32> {
    let b = view.background_bounds;
    if (all(b.xy >= vec2<f32>(0.0)) && all(b.xy + b.zw <= p.a.xy)) { return vec4<f32>(0.0, 0.0, p.a.xy); }
    let source = (p.c.zw - p.c.xy) * vec2<f32>(textureDimensions(sprites).xy);
    let density = min(min(source.x / p.a.x, source.y / p.a.y), min(min(16382.0 / b.z, 16382.0 / b.w), sqrt(31.0 * 1024.0 * 1024.0 / (b.z * b.w))));
    let low = floor(b.xy * density);
    return vec4<f32>(low / density, max(vec2<f32>(1.0), ceil((b.xy + b.zw) * density) - low) / density);
}

// Whether a screen position is inside the artboard of a rotated or mirrored view.
fn inside_orient_artboard(p: vec2<f32>) -> bool {
    let a = view.orient_quad0.xy;
    let b = view.orient_quad0.zw;
    let c = view.orient_quad1.xy;
    let d = view.orient_quad1.zw;
    let e0 = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    let e1 = (c.x - b.x) * (p.y - b.y) - (c.y - b.y) * (p.x - b.x);
    let e2 = (d.x - c.x) * (p.y - c.y) - (d.y - c.y) * (p.x - c.x);
    let e3 = (a.x - d.x) * (p.y - d.y) - (a.y - d.y) * (p.x - d.x);
    return (e0 >= 0.0 && e1 >= 0.0 && e2 >= 0.0 && e3 >= 0.0) || (e0 <= 0.0 && e1 <= 0.0 && e2 <= 0.0 && e3 <= 0.0);
}

// The scene of a rotated view stays on the artboard (backgrounds are the artboard's quad already).
fn discard_outside_orient_artboard(in: VsOut) {
    if (view.orient_flags.y > 0.5 && in.head.y == 0u) {
        let drawn = in.head.x & 255u;
        if (drawn != K_FILL_VIEW && drawn != K_BG_IMAGE && !inside_orient_artboard(in.pos.xy)) { discard; }
    }
}

// The Canvas byte mask of a root paint other than the background picture: the clip's coverage, and the view fill's own.
fn canvas_alpha(pos: vec2<f32>, kind: u32) -> f32 {
    var alpha = canvas_clip_alpha(pos);
    if (kind == K_FILL_VIEW && view.inv_t.w > 0.5) {
        alpha = floor((alpha * canvas_fill_alpha(pos) + 127.0) / 255.0);
    }
    return alpha;
}

// The pinned Canvas byte-mask blitter uses alpha+1 with a right shift.
fn canvas_masked(src: vec4<f32>, alpha: f32) -> vec4<f32> {
    let paint = floor(clamp(src, vec4<f32>(0.0), vec4<f32>(1.0)) * 255.0 + vec4<f32>(0.5));
    return floor(paint * (alpha + 1.0) / 256.0) / 255.0;
}

// Entry points over the same functions. A fragment runs the code of every kind its shader holds where a software
// rasterizer (SwiftShader, without a graphics card) executes both sides of a branch, so a run of records that are all of
// the simpler kinds draws with a shader holding only theirs (`shading.rs`): `fs_flat` for flat colour (triangles, the view's
// fill), `fs_stroke` for those and segments, discs and rings, `fs_vector` for those and the other shapes covered by distance,
// `fs_image` for pictures and drawing tiles, `fs_composite` for isolated groups' layers, `fs_main` for everything. Each
// simpler one has a `_plain` form for an upright view with the native painter (the stage's), which leaves out the turned
// artboard's clip and the Canvas painter's masks: both are off there, but a software rasterizer would run their code too.
// Their pixels are the same (tests/shading.rs).

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    discard_outside_orient_artboard(in);
    let src = shade_primitive(in);
    if (view.inv_t.z < 0.5 || in.head.y != 0u) { return src; }
    let kind = in.head.x & 255u;
    if (kind == K_BG_IMAGE) {
        let p = Prim(in.head.x, in.head.y, in.head.z, in.head.w, in.a, in.b, in.c);
        let bounds = canvas_image_bounds(p);
        let w = to_world(in.pos.xy);
        if (any(w < bounds.xy) || any(w >= bounds.xy + bounds.zw)) { return vec4<f32>(0.0); }
    }
    return canvas_masked(src, canvas_alpha(in.pos.xy, kind));
}

// Generated effects (styk-draw `K_PARTICLE`, `K_BEAM`) draw with an entry point pair of their own (`Renderer::generated_pipeline`),
// compiled only once a list has them: a frame without generated effects never runs or compiles their shading. A record is
// expanded in its draw's local units, then placed by the draw's transform; the fragment stage reads the record's
// per-instance values (`particle_corner`'s `prm`) where other kinds carry their `a` field.
@vertex
fn vs_particle(in: VsIn) -> VsOut {
    var out: VsOut;
    var gr: Group;
    if (!vertex_start(in, &out, &gr)) { return out; }
    let p = vertex_prim(in);
    let r0 = paint_row(p.paint);
    let r1 = paint_row(p.paint + 1u);
    let px = out.aa / max(r1.z, 1e-12);
    let q = corner(in.vertex) * 2.0 - vec2<f32>(1.0);
    let shaped = particle_corner(p, p.kind & 255u, q, px, paint_row(p.paint + 2u));
    out.uv = shaped.uv;
    out.a = shaped.prm;
    let world = affine(r0, r1.xy, shaped.local);
    out.world = world;
    out.pos = clip_pos(to_target(world, p.group, gr));
    return out;
}

@fragment
fn fs_particle(in: VsOut) -> @location(0) vec4<f32> {
    discard_outside_orient_artboard(in);
    discard_outside_clip(in);
    let p = prim_of(in);
    var src: vec4<f32>;
    if ((p.kind & 255u) == K_BEAM) {
        src = beam_color(p, in.uv, in.a, in.aa / max(paint_row(p.paint + 1u).z, 1e-12));
    } else {
        src = particle_color(p, in.uv, in.a, paint_row(p.paint + 1u).w, paint_row(p.paint + 2u), paint_row(p.paint + 3u), paint_row(p.paint + 4u), paint_row(p.paint + 5u));
    }
    return painted(in, src);
}

// A root paint of the Canvas painter (the camera monitor's) is masked by its clip; everything else is as shaded.
fn painted(in: VsOut, src: vec4<f32>) -> vec4<f32> {
    if (view.inv_t.z < 0.5 || in.head.y != 0u) { return src; }
    return canvas_masked(src, canvas_alpha(in.pos.xy, in.head.x & 255u));
}

fn prim_of(in: VsOut) -> Prim {
    return Prim(in.head.x, in.head.y, in.head.z, in.head.w, in.a, in.b, in.c);
}

// Triangles and the view's fill in their own colour (no paint record).
fn flat_color(in: VsOut) -> vec4<f32> {
    discard_outside_clip(in);
    return premul(unpack(in.head.z));
}

// Segments, discs, rings and the flat kinds, in their own colour.
fn stroke_color(in: VsOut) -> vec4<f32> {
    discard_outside_clip(in);
    let p = prim_of(in);
    return shade_stroke(p, p.kind & 255u, in.world, in.aa, unpack(p.color));
}

// Segments, boxes, arcs, polylines, discs, rings, triangles and the view's fill, in their own colour.
fn vector_color(in: VsOut) -> vec4<f32> {
    discard_outside_clip(in);
    let p = prim_of(in);
    return shade_vector(p, p.kind & 255u, in.world, in.aa, unpack(p.color));
}

// Pictures and drawing tiles (K_IMAGE without a paint record: a drawing tile's `paint` names its parent tile).
fn image_color(in: VsOut) -> vec4<f32> {
    discard_outside_clip(in);
    let p = prim_of(in);
    return shade_image(in, p, unpack(p.color));
}

// Isolated groups' layers composited into their parents (K_COMPOSITE without a paint record).
fn composite_color(in: VsOut) -> vec4<f32> {
    discard_outside_clip(in);
    let p = prim_of(in);
    return shade_composite(in, p, unpack(p.color));
}

@fragment
fn fs_flat(in: VsOut) -> @location(0) vec4<f32> { discard_outside_orient_artboard(in); return painted(in, flat_color(in)); }
@fragment
fn fs_stroke(in: VsOut) -> @location(0) vec4<f32> { discard_outside_orient_artboard(in); return painted(in, stroke_color(in)); }
@fragment
fn fs_vector(in: VsOut) -> @location(0) vec4<f32> { discard_outside_orient_artboard(in); return painted(in, vector_color(in)); }
@fragment
fn fs_image(in: VsOut) -> @location(0) vec4<f32> { discard_outside_orient_artboard(in); return painted(in, image_color(in)); }
@fragment
fn fs_composite(in: VsOut) -> @location(0) vec4<f32> { discard_outside_orient_artboard(in); return painted(in, composite_color(in)); }

@fragment
fn fs_flat_plain(in: VsOut) -> @location(0) vec4<f32> { return flat_color(in); }
@fragment
fn fs_stroke_plain(in: VsOut) -> @location(0) vec4<f32> { return stroke_color(in); }
@fragment
fn fs_vector_plain(in: VsOut) -> @location(0) vec4<f32> { return vector_color(in); }
@fragment
fn fs_image_plain(in: VsOut) -> @location(0) vec4<f32> { return image_color(in); }
@fragment
fn fs_composite_plain(in: VsOut) -> @location(0) vec4<f32> { return composite_color(in); }
