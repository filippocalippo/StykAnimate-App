// The artboard's display-only backing under the stage's picture (today's `#artboard`, `01-style.css`): a checkerboard of
// 8 px cells (`repeating-conic-gradient(#ddd 0% 25%, #fff 0% 50%) 0 0 / 16px 16px`) that scene transparency shows, inside a
// 1 px ring and a soft 2 px drop (`box-shadow: 0 0 0 1px S, 0 2px 5px S`). Drawn in the widget's pass before the picture.

struct Backing {
    // The artboard in widget pixels: x, y, width, height (whole device pixels).
    rect: vec4<f32>,
    // The shadow colour, straight alpha, in sRGB.
    shadow: vec4<f32>,
    // The widget's origin in the target (x, y), the checker cell in device pixels, 1 when the target is sRGB.
    place: vec4<f32>,
    // The ring width, the drop's offset and its blur radius in device pixels.
    edge: vec4<f32>,
}

@group(0) @binding(0) var<uniform> backing: Backing;

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
    // One triangle over the whole viewport (the widget's bounds).
    let corner = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
    return vec4<f32>(corner * 2.0 - 1.0, 0.0, 1.0);
}

fn to_target(c: vec3<f32>) -> vec3<f32> {
    if backing.place.w > 0.5 {
        let low = c / 12.92;
        let high = pow((c + 0.055) / 1.055, vec3<f32>(2.4));
        return select(high, low, c <= vec3<f32>(0.04045));
    }
    return c;
}

fn box_distance(p: vec2<f32>, centre: vec2<f32>, half_size: vec2<f32>) -> f32 {
    let q = abs(p - centre) - half_size;
    return length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0);
}

@fragment
fn fs_main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let p = position.xy - backing.place.xy;
    let half_size = backing.rect.zw * 0.5;
    let centre = backing.rect.xy + half_size;
    let d = box_distance(p, centre, half_size);
    if d < 0.0 {
        let cell = floor((p - backing.rect.xy) / backing.place.z);
        let odd = (i32(cell.x) + i32(cell.y)) & 1;
        let level = select(1.0, 221.0 / 255.0, odd == 1);
        return vec4<f32>(to_target(vec3<f32>(level)), 1.0);
    }
    let ring = backing.shadow.a * (1.0 - step(backing.edge.x, d));
    let blur = max(backing.edge.z, 0.001);
    let drop_d = box_distance(p, centre + vec2<f32>(0.0, backing.edge.y), half_size);
    let drop = backing.shadow.a * (1.0 - smoothstep(-blur * 0.5, blur * 0.5, drop_d));
    let alpha = 1.0 - (1.0 - ring) * (1.0 - drop);
    return vec4<f32>(to_target(backing.shadow.rgb) * alpha, alpha);
}
