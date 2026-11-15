// ---- The camera rectangle cleared to the view's clear colour before the camera image is composited over it in the workspace
// (docs/engine/vfx.md, "The camera image"): where the scene's effects leave the image transparent, the canvas's backdrop shows,
// never the unfiltered scene drawn under it. Two triangles over the rectangle's corners (target pixels, `corners`), writing every
// sample they cover.

struct Knockout {
    // The corners in clip space: (x0, y0, x1, y1) and (x2, y2, x3, y3), in order round the rectangle.
    corners: array<vec4<f32>, 2>,
    color: vec4<f32>,
};

@group(0) @binding(0) var<uniform> knockout: Knockout;

@vertex
fn vs_knockout(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
    var order = array<u32, 6>(0u, 1u, 2u, 0u, 2u, 3u);
    var corners = array<vec2<f32>, 4>(knockout.corners[0].xy, knockout.corners[0].zw, knockout.corners[1].xy, knockout.corners[1].zw);
    return vec4<f32>(corners[order[vi]], 0.0, 1.0);
}

@fragment
fn fs_knockout() -> @location(0) vec4<f32> {
    return knockout.color;
}
