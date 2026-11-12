use super::*;

/// A renderer on this machine's adapter, or `None` where there is none (a Linux runner).
fn renderer() -> Option<Renderer> {
    let gpu = native_gpu::native_gpu(false, "lifetime reuse", |a| wgpu::Limits::default().using_resolution(a.limits())).ok()?;
    let mut renderer = Renderer::new(&gpu.device, &gpu.queue, wgpu::TextureFormat::Rgba8Unorm);
    renderer.set_exact_sizes(true);
    Some(renderer)
}
fn scene(count: u32) -> Arc<DrawList> {
    use styk_draw::*;
    let mut list = DrawList::default();
    list.groups.push(Group { parent:0, depth:0, opacity:1., bounds:[0.,0.,64.,64.], layer:NO_LAYER });
    for g in 1..=count {
        list.groups.push(Group { parent:0, depth:1, opacity:0.5, bounds:[0.,0.,64.,64.], layer:NO_LAYER });
        list.prims.push(Prim { kind:K_COMPOSITE, group:0, color:0x80ffffff, paint:NO_PAINT,
            a:[0.;4], b:[f32::from_bits(g),0.,0.,0.], c:[0.;4] });
    }
    list.passes.push(Pass { depth:0, start:0, end:count });
    for g in 1..=count {
        list.prims.push(Prim { kind:K_TRI, group:g, color:0xff204080, paint:NO_PAINT,
            a:[0.,0.,63.,0.], b:[0.,63.,0.,0.], c:[0.;4] });
    }
    Arc::new(list)
}
fn draw(r: &mut Renderer, list: &Arc<DrawList>) {
    r.set_list(list);
    let mut encoder = r.device.create_command_encoder(&Default::default());
    r.render(&mut encoder, &ViewParams { matrix:[1.,0.,0.,1.,0.,0.], artboard:[0.,0.,64.,64.],
        clip_to_artboard:false, clear:[0.;4], zoom:1., pan:[0.;2], stretch:1., camera_view:false,
        camera_limit:CAMERA_PREVIEW_LIMIT }, [64,64]);
    r.queue.submit([encoder.finish()]);
    r.device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
}
fn no_owners(device: &wgpu::Device, names: &[&str]) {
    device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
    let report = device.generate_allocator_report().unwrap();
    assert!(!report.allocations.iter().any(|a| names.contains(&a.name.as_str())), "owners survived close: {names:?}");
}
#[test]
fn isolation_and_msaa_reuse_across_quiet_frames_and_release_at_close() {
    let Some(mut r) = renderer() else { eprintln!("skipped: no graphics adapter"); return; };
    let device = r.device.clone();
    draw(&mut r, &scene(8));
    let layers = r.layers[1].texture.clone();
    let msaa = r.msaa_layer.as_ref().unwrap().0.clone();
    for count in [8,1,0,8,8] {
        draw(&mut r, &scene(count));
        assert_eq!(r.layers[1].texture, layers, "isolation capacity must survive smaller/empty frames");
        assert_eq!(r.msaa_layer.as_ref().map(|t| &t.0), Some(&msaa), "MSAA must survive unused frames");
    }
    drop((layers,msaa,r));
    no_owners(&device, &["styk layers","styk msaa"]);
}
#[test]
fn primitives_reuse_capacity_and_release_at_close() {
    let Some(mut r) = renderer() else { eprintln!("skipped: no graphics adapter"); return; };
    let device = r.device.clone();
    let mut large = (*scene(1)).clone();
    large.prims = vec![large.prims[1]; 2000];
    r.set_list(&Arc::new(large.clone()));
    let capacity = r.prims.clone();
    for list in [scene(0),scene(1),Arc::new(large)] {
        r.set_list(&list);
        assert_eq!(r.prims, capacity, "primitive capacity must not shrink during the document lifetime");
    }
    drop((capacity,r));
    no_owners(&device, &["styk prims"]);
}
/// Rectangles in a row, one colour each: the list a drag step changes a few of.
fn rectangles(colors: &[u32]) -> Arc<DrawList> {
    use styk_draw::*;
    let mut list = DrawList::default();
    list.groups.push(Group { parent:0, depth:0, opacity:1., bounds:[0.,0.,64.,64.], layer:NO_LAYER });
    for (n, &color) in colors.iter().enumerate() {
        let (x0, x1) = (n as f32 * 8., n as f32 * 8. + 8.);
        list.prims.push(Prim { kind:K_TRI, group:0, color, paint:NO_PAINT, a:[x0,0.,x1,0.], b:[x1,64.,0.,0.], c:[0.;4] });
        list.prims.push(Prim { kind:K_TRI, group:0, color, paint:NO_PAINT, a:[x0,0.,x1,64.], b:[x0,64.,0.,0.], c:[0.;4] });
    }
    list.passes.push(Pass { depth:0, start:0, end:list.prims.len() as u32 });
    Arc::new(list)
}
fn pixels(r: &mut Renderer, list: &Arc<DrawList>) -> Vec<u8> {
    draw(r, list);
    present::read_frame(&r.device, &r.queue, r.frame_texture().expect("a frame")).2
}
#[test]
fn a_list_noted_as_changed_in_ranges_draws_as_the_list_set_whole() {
    let Some(mut r) = renderer() else { eprintln!("skipped: no graphics adapter"); return; };
    let before = rectangles(&[0xff0000ff, 0xff00ff00, 0xffff0000, 0xff00ffff, 0xffffff00, 0xffff00ff, 0xff808080, 0xff404040]);
    let after = rectangles(&[0xff0000ff, 0xff00ff00, 0xff102030, 0xff00ffff, 0xffffff00, 0xff302010, 0xff808080, 0xff404040]);
    let whole = pixels(&mut renderer().unwrap(), &after);
    pixels(&mut r, &before);
    // The rectangles that changed, as their primitives: written alone, the frame is the list's.
    r.note_changes(&after, &before, vec![(4, 6), (10, 12)]);
    assert_eq!(pixels(&mut r, &after), whole, "the ranges written over the list held draw the new list");
    // Only the ranges are written: a range left out keeps the list held's primitives (what the note promises is what is drawn).
    let again = rectangles(&[0xff0000ff, 0xff00ff00, 0xff102030, 0xff00ffff, 0xffffff00, 0xff302010, 0xff808080, 0xff111111]);
    r.note_changes(&again, &after, Vec::new());
    assert_eq!(pixels(&mut r, &again), whole, "nothing outside the ranges is written");
    // A note about another list than the one held is not taken: the list is written whole.
    let other = rectangles(&[0xff111111; 8]);
    r.note_changes(&other, &before, vec![(0, 2)]);
    assert_eq!(pixels(&mut r, &other), pixels(&mut renderer().unwrap(), &other), "a list noted against another is set whole");
}
