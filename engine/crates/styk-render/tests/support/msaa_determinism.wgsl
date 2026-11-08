// Independent of prim.wgsl: three shapes repeated on a grid, no buffers or textures.
// The thin opaque triangle leaves partly covered pixels under two translucent quads.
struct Out {
    @builtin(position) position: vec4<f32>,
    @location(0) @interpolate(flat) alpha: f32,
};

@vertex
fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> Out {
    let kind = instance % 3u;
    let cell = instance / 3u;
    let origin = vec2<f32>(f32(cell % 32u) * 60.0, f32(cell / 32u) * 30.0);
    var position: vec2<f32>;
    var alpha = 0.535;
    if (kind == 0u) {
        let points = array<vec2<f32>, 6>(
            vec2<f32>(1.1, 20.2), vec2<f32>(58.1, 22.1), vec2<f32>(1.1, 24.2),
            vec2<f32>(1.1, 24.2), vec2<f32>(1.1, 24.2), vec2<f32>(1.1, 24.2));
        position = points[vertex];
        alpha = 1.0;
    } else {
        let corners = array<vec2<f32>, 6>(
            vec2<f32>(0, 0), vec2<f32>(1, 0), vec2<f32>(1, 1),
            vec2<f32>(0, 0), vec2<f32>(1, 1), vec2<f32>(0, 1));
        let lo = select(vec2<f32>(20.0, 0.0), vec2<f32>(0.0, 0.0), kind == 2u);
        let hi = select(vec2<f32>(59.0, 28.0), vec2<f32>(40.0, 28.0), kind == 2u);
        position = mix(lo, hi, corners[vertex]);
    }
    let q = (position + origin) / vec2<f32>(1920, 1080);
    return Out(vec4<f32>(fma(q.x, 2.0, -1.0), fma(q.y, -2.0, 1.0), 0.0, 1.0), alpha);
}

@fragment
fn fs(input: Out) -> @location(0) vec4<f32> {
    return vec4<f32>(input.alpha);
}
