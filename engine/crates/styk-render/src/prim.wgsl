// StykAnimate primitive shader. One instanced draw per pass covers every
// primitive kind: the vertex stage expands a record into a quad (or triangle),
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

const TABLE_WIDTH: u32 = 1024u;

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
const MATERIAL_CELL: f32 = 128.0;
const MATERIAL_COLUMNS: f32 = 8.0;
const MATERIAL_ROWS: f32 = 17.0;
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

fn clip_pos(t: vec2<f32>) -> vec4<f32> {
    return vec4<f32>(t.x / view.dest.x * 2.0 - 1.0, 1.0 - t.y / view.dest.y * 2.0, 0.0, 1.0);
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

// Hashing and value noise of generated effects, bit-compatible with the editor's.
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

// One corner `q` (-1..1) of a generated-effect record, in its draw's local units; `px` is the
// target's pixel in those units, `r2` the draw's constants (softness, stretch, aspect, row).
fn particle_corner(p: Prim, kind: u32, q: vec2<f32>, px: f32, r2: vec4<f32>) -> Shaped {
    var o: Shaped;
    if (kind == K_BEAM) {
        let a = p.a.xy;
        let d = p.a.zw - a;
        let len = max(length(d), 1.0);
        let dn = d / len;
        let nn = vec2<f32>(-dn.y, dn.x);
        let w = p.b.x;
        let halo = w * 3.5 + 8.0;
        let lx = mix(-halo, len + halo, q.x * 0.5 + 0.5);
        let ly = q.y * halo;
        o.local = a + dn * lx + nn * ly;
        o.uv = vec2<f32>(lx, ly);
        o.prm = vec4<f32>(len, w, p.b.y, p.b.z);
        return o;
    }
    let shape = (p.kind >> 16u) & 7u;
    let softness = r2.x;
    if (shape == 5u) {
        // A lightning arc segment: a capsule with a glow margin.
        let p0 = p.a.xy;
        let p1 = p.a.zw;
        let r = p.b.x;
        let d = p1 - p0;
        let l = length(d);
        var dn = vec2<f32>(1.0, 0.0);
        if (l > 1e-4) { dn = d / l; }
        let hl = 0.5 * l;
        let e = r + r * 4.0;
        let local = vec2<f32>(q.x * (hl + e), q.y * e);
        o.local = (p0 + p1) * 0.5 + dn * local.x + vec2<f32>(-dn.y, dn.x) * local.y;
        o.uv = local;
        o.prm = vec4<f32>(hl, r, px, 0.0);
        return o;
    }
    let centre = p.a.xy;
    let sz = p.a.z;
    let rot = p.a.w;
    let vel = p.b.xy;
    let cr = vec2<f32>(cos(rot), sin(rot));
    if (shape == 1u) {
        let sp = length(vel);
        var d = vec2<f32>(1.0, 0.0);
        if (sp > 1e-4) { d = vel / sp; }
        let hl = 0.5 * sp * r2.y;
        let rr = max(sz, px * 0.5);
        let local = vec2<f32>(q.x * (hl + rr + px), q.y * (rr + px));
        o.local = centre - d * hl + d * local.x + vec2<f32>(-d.y, d.x) * local.y;
        o.uv = local;
        o.prm = vec4<f32>(hl, rr, softness, px);
        return o;
    }
    if (shape == 3u) {
        let e = q * (sz * 1.3 + px);
        o.local = centre + vec2<f32>(e.x * cr.x - e.y * cr.y, e.x * cr.y + e.y * cr.x);
        o.uv = q * (1.3 + px / max(sz, 1e-3));
        o.prm = vec4<f32>(p.b.z, px / max(sz, 1e-3), 0.0, 0.0);
        return o;
    }
    if (shape == 6u) {
        // A textured sprite: one atlas cell, scaled along its up axis by aspect and speed.
        let hx = max(sz, px * 0.5);
        let hy = hx * r2.z + 0.5 * length(vel) * r2.y;
        let e = vec2<f32>(q.x * hx, q.y * hy);
        o.local = centre + vec2<f32>(e.x * cr.x - e.y * cr.y, e.x * cr.y + e.y * cr.x);
        let cell = vec2<f32>(f32(p.color & 255u), f32(p.color >> 8u));
        o.uv = vec2<f32>((cell.x + q.x * 0.5 + 0.5) / MATERIAL_COLUMNS, (cell.y + q.y * 0.5 + 0.5) / MATERIAL_ROWS);
        let shade = paint_row(p.paint + 1u).w;
        // Level of detail from the cell's size on screen.
        o.prm = vec4<f32>(shade, clamp(log2(MATERIAL_CELL * px / (2.0 * max(hx, hy))), 0.0, MATERIAL_MAX_LOD), 0.0, 0.0);
        return o;
    }
    if (shape == 7u) {
        let rr = max(sz, px * 0.5);
        let e = q * (rr + px);
        o.local = centre + vec2<f32>(e.x * cr.x - e.y * cr.y, e.x * cr.y + e.y * cr.x);
        o.uv = q * (1.0 + px / rr);
        o.prm = vec4<f32>(px / rr, 0.0, 0.0, 0.0);
        return o;
    }
    // Discs and rings; soft discs may be flattened into ellipses, such as glows on the ground.
    var grow = 1.0;
    if (shape == 2u) { grow = 1.0 + softness * 2.0; }
    let rr = max(sz, px * 0.5);
    var squash = 1.0;
    if (shape == 0u) { squash = r2.z; }
    o.local = centre + q * (rr * grow + px) * vec2<f32>(1.0, squash);
    o.uv = q * (grow + px / rr);
    o.prm = vec4<f32>(softness, px / rr, 0.0, 0.0);
    return o;
}

@vertex
fn vs_main(in: VsIn) -> VsOut {
    var out: VsOut;
    let vi = in.vertex;
    let p = Prim(in.head.x, in.head.y, in.head.z, in.head.w, in.a, in.b, in.c);
    let kind = p.kind & 255u;
    out.head = in.head;
    out.a = in.a;
    out.b = in.b;
    out.c = in.c;
    out.uv = vec2<f32>(0.0, 0.0);
    out.sampling = 0.0;
    let g = p.group;
    out.clip = vec4<f32>(-1e9, -1e9, 1e9, 1e9);
    // World units per target pixel.
    var aa = 1.0 / max(view.t.z, 1e-12);
    var gr: Group;
    if (g != 0u) {
        gr = group_at(g);
        if (gr.page != view.dest.z) {
            out.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
            return out;
        }
        aa = gr.aa;
        out.clip = gr.clip;
    }
    out.aa = aa;
    let margin = aa * 1.5;
    let c = corner(vi);
    var world = vec2<f32>(0.0, 0.0);
    if (kind == K_CAPSULE || kind == K_BOX) {
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
        world = p0 + d * along + n * across;
    } else if (kind == K_ARC) {
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
        world = mix(lo - vec2<f32>(e), hi + vec2<f32>(e), c);
    } else if (kind == K_POLYLINE) {
        let e = max(p.b.x, aa * 0.5) + margin;
        world = mix(p.a.xy - vec2<f32>(e), p.a.zw + vec2<f32>(e), c);
    } else if (kind == K_DISC) {
        let e = p.a.z + margin;
        world = p.a.xy + mix(vec2<f32>(-e), vec2<f32>(e), c);
    } else if (kind == K_RING) {
        let e = p.a.z + max(p.a.w, aa * 0.5) + margin;
        world = p.a.xy + mix(vec2<f32>(-e), vec2<f32>(e), c);
    } else if (kind == K_TRI) {
        // A lone glyph's own triangles draw only where the view gives it no mask.
        if ((p.kind & F_GLYPH_VECTOR) != 0u && glyph_row(bitcast<u32>(p.b.z), 2u).w > 0.5) {
            out.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
            return out;
        }
        if (vi == 0u) { world = p.a.xy; } else if (vi == 1u) { world = p.a.zw; } else { world = p.b.xy; }
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
        if ((p.kind & F_DRAWING) != 0u) {
            // A drawing tile of display level b.w: the view shows one level per cel,
            // floor(-log2(target pixels per cel pixel)) clamped to 0..8 (docs/engine/drawing.md).
            let level = p.b.w;
            let tile_pixels = length(p.a.zw) / (64.0 * aa);
            // The equivalent interval test preserves exact power-of-two boundaries:
            // GPU log2(0.5) can round below 1 and show the preceding level.
            let shown = (level == 0.0 || tile_pixels <= 1.0) && (level == 8.0 || tile_pixels > 0.5);
            if (!shown) {
                out.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
                return out;
            }
            // In a layer the editor paints with Canvas 2D, it draws this level scaled by what
            // remains (between 1 and 1/2) with 'high' smoothing, which Chromium samples from the
            // level's own reductions, trilinearly, at a level of detail of log2(1 / scale) - 1/2
            // (measured): past 2^-1/2, up to half of the next level is blended in.
            if ((g == 0u && view.inv_t.z > 0.5) || (g != 0u && gr.canvas > 0.5)) {
                // Exactly 1× remains bilinear, including fractional translations; any
                // enlargement uses Mitchell (the editor's imageSmoothingQuality 'high').
                if (tile_pixels > 1.0) {
                    out.sampling = -1.0;
                } else if (p.paint != NO_PAINT) {
                    out.sampling = clamp(-log2(max(tile_pixels, 1e-30)) - 0.5, 0.0, 0.5);
                }
            }
        }
        world = p.a.xy + p.a.zw * c.x + p.b.xy * c.y;
        out.uv = c;
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
    } else if (kind == K_PARTICLE || kind == K_BEAM) {
        // Generated effects: expanded in their draw's local units exactly as the editor's
        // vertex shader does (`vs` in vfx-generator-gpu.mjs), then placed by the draw's transform.
        let r0 = paint_row(p.paint);
        let r1 = paint_row(p.paint + 1u);
        let r2 = paint_row(p.paint + 2u);
        let px = aa / max(r1.z, 1e-12);
        let q = c * 2.0 - vec2<f32>(1.0);
        let shaped = particle_corner(p, kind, q, px, r2);
        out.uv = shaped.uv;
        // The fragment stage reads the record's per-instance values (`prm` in
        // vfx-generator-gpu.mjs) where other kinds carry their `a` field.
        out.a = shaped.prm;
        world = affine(r0, r1.xy, shaped.local);
        out.world = world;
        out.pos = clip_pos(to_target(world, g, gr));
        return out;
    } else if (kind == K_COMPOSITE) {
        // The child's shown rectangle, carried into this target by the child's own map.
        let child = group_at(bitcast<u32>(p.b.x));
        if (child.page < 0.0) {
            out.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
            return out;
        }
        let a = mix(child.show.xy, child.show.zw, c);
        out.uv = a;
        out.pos = clip_pos(affine(child.p, child.pt, a));
        return out;
    } else if (kind == K_FILL_VIEW || kind == K_BG_IMAGE) {
        // The artboard on screen; a group's whole layer (the camera image's background).
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
            out.world = to_world(s);
            out.pos = clip_pos(s);
        } else {
            let s = mix(gr.clip.xy, gr.clip.zw, c);
            out.world = affine_inverse(gr.m, gr.t, s);
            out.pos = clip_pos(s);
        }
        return out;
    }
    out.world = world;
    out.pos = clip_pos(to_target(world, g, gr));
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

// A generated-effect particle's premultiplied colour (`fs` in vfx-generator-gpu.mjs).
fn particle_color(p: Prim, uv: vec2<f32>, prm: vec4<f32>) -> vec4<f32> {
    let shape = (p.kind >> 16u) & 7u;
    var cov = 0.0;
    if (shape == 0u) {
        cov = soft(length(uv), prm.x, min(prm.y * 1.5, 1.0));
    } else if (shape == 1u) {
        // A tapered streak: full width and brightness at the head, thinning and fading toward the tail.
        let hl = prm.x;
        let t = clamp(uv.x / max(hl, 1e-3) * 0.5 + 0.5, 0.0, 1.0);
        let w = select(1.0, mix(0.3, 1.0, t), hl > 0.5);
        let d = length(vec2<f32>(max(abs(uv.x) - hl, 0.0), uv.y / w)) / prm.y;
        let tail = select(1.0, t * t * (3.0 - 2.0 * t) * 0.9 + 0.1, hl > 0.5);
        cov = soft(d, prm.z, min(prm.w / prm.y * 1.5, 1.0)) * tail;
    } else if (shape == 2u) {
        let d = length(uv);
        let rd = abs(d - 1.0) / max(prm.x, 0.01);
        cov = pow(max(1.0 - rd, 0.0), 1.6) + 0.18 * (1.0 - smooth01(0.0, 1.0, d)) * step(d, 1.0);
    } else if (shape == 3u) {
        let q = abs(uv);
        let d = max(q.x, q.y * (0.55 + 0.6 * prm.x) + q.x * 0.25);
        cov = 1.0 - smooth01(1.0 - min(prm.y * 1.5, 1.0), 1.0, d);
    } else if (shape == 5u) {
        let d = length(vec2<f32>(max(abs(uv.x) - prm.x, 0.0), uv.y));
        let r = prm.y;
        cov = min(clamp(1.0 - (d - r) / prm.z, 0.0, 1.0) + exp(-d / (r * 2.5)) * 0.55, 1.0);
    } else if (shape == 6u) {
        let tex = textureSampleLevel(materials, material_sampler, uv, prm.y);
        if (tex.g <= 0.002) { discard; }
        let rgb = shade_rgb(p.c.rgb, mix(0.5, clamp(tex.r / tex.g, 0.0, 1.0), prm.x));
        let k = tex.g * p.c.a;
        return vec4<f32>(rgb * k, k);
    } else if (shape == 7u) {
        let q = max(abs(uv.x), abs(uv.y));
        let aa = min(prm.x * 1.5, 1.0);
        cov = 1.0 - smooth01(1.0 - aa, 1.0, q);
    }
    let k = cov * p.c.a;
    if (k <= 0.0) { discard; }
    return vec4<f32>(p.c.rgb * k, k);
}

// A beam's premultiplied colour (`beamColor` in vfx-generator-gpu.mjs); `aa` is the pixel in local units.
fn beam_color(p: Prim, uv: vec2<f32>, prm: vec4<f32>, aa: f32) -> vec4<f32> {
    let len = prm.x;
    let w = prm.y;
    if (w <= 0.05) { discard; }
    let t = p.b.w;
    let x = uv.x;
    let style = u32(p.c.y);
    let opacity = p.c.x;
    let c0 = paint_row(p.paint + 3u);
    let c1 = paint_row(p.paint + 4u);
    let wob = (vnoise(vec2<f32>(x * 0.018 - t * 0.55, prm.w)) - 0.5) * 2.0 * prm.z * w * smooth01(0.0, 80.0, x);
    let y = uv.y - wob;
    let ww = w * mix(0.55, 1.0, smooth01(0.0, 70.0, x));
    let d = length(vec2<f32>(max(max(-x, x - len), 0.0), abs(y)));
    if (style == 2u) {
        // Cartoon: a flat body with a lighter core band and crisp edges.
        let body = 1.0 - smooth01(ww - aa, ww + aa, d);
        let core = 1.0 - smooth01(ww * 0.45 - aa, ww * 0.45 + aa, d);
        let a = body * opacity;
        return vec4<f32>(mix(c1.rgb, c0.rgb, core) * a, a);
    }
    var core: f32;
    var body: f32;
    var glow: f32;
    let pulse = 0.8 + 0.4 * vnoise(vec2<f32>(x * 0.035 - t * 1.7, 3.0 + prm.w));
    if (style == 1u) {
        // Laser: a hard, steady core with a tight glow.
        core = 1.0 - smooth01(ww * 0.2 - aa, ww * 0.2 + aa, d);
        body = 1.0 - smooth01(ww * 0.5 - aa, ww * 0.5 + aa, d);
        glow = exp(-d / (ww * 1.1 + 1.0)) * 0.5;
    } else {
        core = 1.0 - smooth01(ww * 0.26, ww * 0.42, d);
        body = 1.0 - smooth01(ww * 0.45, ww, d);
        glow = exp(-d / (ww * 0.9 + 1.0)) * 0.45;
    }
    var rgb = c0.rgb * core + c1.rgb * (body * 0.8 + glow) * select(pulse, 1.0, style == 1u);
    var a = core + body * 0.7 + glow * 0.5;
    if (style == 3u) {
        // Spiral: two strands winding around the beam.
        let period = max(24.0, w * 3.2);
        let inside = step(0.0, x) * step(x, len);
        for (var s = 0u; s < 2u; s = s + 1u) {
            let phase = x / period * TAU - t * 0.35 + f32(s) * 3.14159265;
            let sy = sin(phase) * ww * 0.95;
            let depth = 0.55 + 0.45 * cos(phase);
            let strand = exp(-abs(y - sy) / (ww * 0.1 + 0.6)) * depth * inside;
            rgb = rgb + c0.rgb * strand;
            a = a + strand * 0.8;
        }
    }
    let alpha = clamp(a, 0.0, 1.0) * opacity;
    if (alpha <= 0.0) { discard; }
    return vec4<f32>(min(vec3<f32>(1.0), rgb) * alpha, alpha);
}

fn shade_primitive(in: VsOut) -> vec4<f32> {
    let pos = in.pos.xy;
    if (pos.x < in.clip.x || pos.y < in.clip.y || pos.x > in.clip.z || pos.y > in.clip.w) {
        discard;
    }
    let p = Prim(in.head.x, in.head.y, in.head.z, in.head.w, in.a, in.b, in.c);
    let kind = p.kind & 255u;
    if (kind == K_PARTICLE) {
        return particle_color(p, in.uv, in.a);
    }
    if (kind == K_BEAM) {
        return beam_color(p, in.uv, in.a, in.aa / max(paint_row(p.paint + 1u).z, 1e-12));
    }
    let w = in.world;
    let aa = in.aa;
    var base = unpack(p.color);
    // A drawing tile's `paint` names its parent tile, not a paint (styk-draw F_DRAWING).
    if (p.paint != NO_PAINT && (p.kind & F_DRAWING) == 0u) {
        base = paint_at(p.paint, w);
    }
    if (kind == K_CAPSULE || kind == K_BOX || kind == K_ARC || kind == K_POLYLINE) {
        var hw = p.b.x;
        if (kind == K_ARC) { hw = p.a.w; }
        // Hairlines keep a one-pixel footprint and fade with their width (crisp: solid).
        var fade = 1.0;
        if (hw < aa * 0.5) {
            fade = select(max(hw, 0.0) * 2.0 / aa, select(0.0, 1.0, hw > 0.0), crisp());
            hw = aa * 0.5;
        }
        var d = 0.0;
        if (kind == K_CAPSULE) {
            d = sd_segment(w, p.a.xy, p.a.zw) - hw;
        } else if (kind == K_BOX) {
            d = sd_box(w, p.a.xy, p.a.zw, hw);
        } else if (kind == K_POLYLINE) {
            let start = bitcast<u32>(p.b.y);
            let count = bitcast<u32>(p.b.z);
            var best = 1e30;
            for (var k = 0u; k + 1u < count; k = k + 1u) {
                best = min(best, sd_segment(w, polyline_point(start + k), polyline_point(start + k + 1u)));
            }
            if ((p.kind & F_CLOSED) != 0u && count > 2u) {
                best = min(best, sd_segment(w, polyline_point(start + count - 1u), polyline_point(start)));
            }
            d = best - hw;
        } else {
            d = sd_arc(w, p.a.xy, p.a.z, p.b.x, p.b.y) - hw;
        }
        let cov = coverage(d, aa) * fade;
        if (cov <= 0.0) { discard; }
        return premul(base) * cov;
    }
    if (kind == K_DISC) {
        let cov = coverage(length(w - p.a.xy) - p.a.z, aa);
        if (cov <= 0.0) { discard; }
        return premul(base) * cov;
    }
    if (kind == K_RING) {
        let dist = length(w - p.a.xy);
        var hw = p.a.w;
        var fade = 1.0;
        if (hw < aa * 0.5) {
            fade = select(max(hw, 0.0) * 2.0 / aa, select(0.0, 1.0, hw > 0.0), crisp());
            hw = aa * 0.5;
        }
        let ring = coverage(abs(dist - p.a.z) - hw, aa) * fade;
        var out = premul(base) * ring;
        if ((p.kind & F_RING_FILL) != 0u) {
            let fill = premul(unpack(bitcast<u32>(p.b.x))) * coverage(dist - p.a.z, aa);
            out = out + fill * (1.0 - out.a);
        }
        if (out.a <= 0.0) { discard; }
        return out;
    }
    if (kind == K_TRI) {
        return premul(base);
    }
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
        let rect = p.c;
        let size = vec2<f32>(textureDimensions(sprites).xy);
        let texel = 1.0 / size;
        let raw = mix(rect.xy, rect.zw, in.uv);
        var tex: vec4<f32>;
        if ((p.kind & F_DRAWING) != 0u && crisp()) {
            // Crisp edges: the nearest texel of the tile, unfiltered.
            let nearest = vec2<i32>(round(rect.xy * size)) + vec2<i32>(clamp(floor(in.uv * 64.0), vec2<f32>(0.0), vec2<f32>(63.0)));
            tex = premul(textureLoad(sprites, nearest, i32(p.b.z), 0));
        } else if ((p.kind & F_DRAWING) != 0u) {
            // Premultiply each straight-alpha texel before filtering. Canvas enlargement
            // uses Mitchell; other sampling is bilinear, optionally blended with a parent.
            let t = in.uv * 64.0 - vec2<f32>(0.5);
            let cell = floor(t);
            let f = t - cell;
            let start = vec2<i32>(round(rect.xy * size));
            let origin = start + vec2<i32>(cell);
            let layer = i32(p.b.z);
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
                let up = tile_bilinear(vec2<i32>(parent.yz) + vec2<i32>(cp), i32(parent.x), tp - cp);
                tex = mix(tex, up, in.sampling);
            }
        } else if ((p.kind & F_SMOOTH) != 0u && !crisp()) {
            tex = textureSampleLevel(sprites, linear_sampler, raw, i32(p.b.z), 0.0);
        } else {
            let q = clamp(raw, rect.xy + texel * 0.5, rect.zw - texel * 0.5);
            tex = textureSampleLevel(sprites, linear_sampler, texel_centre(q, size), i32(p.b.z), 0.0);
        }
        if ((p.kind & F_TINT) != 0u) {
            // An onion skin's sprite: its coverage in the tint colour.
            return vec4<f32>(base.rgb * tex.a, tex.a) * base.a;
        }
        return tex * base.a;
    }
    if (kind == K_BG_IMAGE) {
        let rect = p.c;
        let size = vec2<f32>(textureDimensions(sprites).xy);
        let texel = 1.0 / size;
        let uv = clamp(w / p.a.xy, vec2<f32>(0.0), vec2<f32>(1.0));
        let q = clamp(mix(rect.xy, rect.zw, uv), rect.xy + texel * 0.5, rect.zw - texel * 0.5);
        return textureSampleLevel(sprites, linear_sampler, texel_centre(q, size), i32(p.a.z), 0.0) * base.a;
    }
    if (kind == K_COMPOSITE) {
        // Bilinear, clamped to the child's own rectangle as an exact texture's edge would be
        // (crisp edges: the nearest texel; a layer on the screen's grid is copied either way).
        let child = group_at(bitcast<u32>(p.b.x));
        let size = vec2<f32>(textureDimensions(layers).xy);
        var uv = clamp(in.uv, child.clip.xy + vec2<f32>(0.5), child.clip.zw - vec2<f32>(0.5));
        if (crisp()) { uv = floor(uv) + vec2<f32>(0.5); }
        let tex = textureSampleLevel(layers, linear_sampler, uv / size, i32(child.page), 0.0);
        return tex * base.a;
    }
    if (kind == K_FILL_VIEW) {
        return premul(base);
    }
    return vec4<f32>(0.0);
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

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    // The scene of a rotated view stays on the artboard (backgrounds are the artboard's quad already).
    if (view.orient_flags.y > 0.5 && in.head.y == 0u) {
        let drawn = in.head.x & 255u;
        if (drawn != K_FILL_VIEW && drawn != K_BG_IMAGE && !inside_orient_artboard(in.pos.xy)) { discard; }
    }
    let src = shade_primitive(in);
    if (view.inv_t.z < 0.5 || in.head.y != 0u) { return src; }
    let kind = in.head.x & 255u;
    var alpha = canvas_clip_alpha(in.pos.xy);
    if (kind == K_FILL_VIEW && view.inv_t.w > 0.5) {
        alpha = floor((alpha * canvas_fill_alpha(in.pos.xy) + 127.0) / 255.0);
    } else if (kind == K_BG_IMAGE) {
        let p = Prim(in.head.x, in.head.y, in.head.z, in.head.w, in.a, in.b, in.c);
        let bounds = canvas_image_bounds(p);
        let w = to_world(in.pos.xy);
        if (any(w < bounds.xy) || any(w >= bounds.xy + bounds.zw)) { return vec4<f32>(0.0); }
    }
    // The pinned Canvas byte-mask blitter uses alpha+1 with a right shift.
    let paint = floor(clamp(src, vec4<f32>(0.0), vec4<f32>(1.0)) * 255.0 + vec4<f32>(0.5));
    return floor(paint * (alpha + 1.0) / 256.0) / 255.0;
}
