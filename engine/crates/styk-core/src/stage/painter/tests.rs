use super::*;
use styk_services::{FixedClock, ManualSpawner};

#[test]
fn prefetched_stage_frame_records_no_upload_when_drawn() {
    let engine = styk_engine::Engine::new(||0.,styk_engine::Budgets::for_device(None));
    engine.open(include_bytes!("../../../../styk-eval/tests/fixtures/drawlist/drawing-cel.json"),"json","stage prefetch").unwrap();
    let generation = engine.generation().unwrap();
    while engine.step() {}
    let mut builder = styk_engine::frame_builder::FrameBuilder::default();
    let next = builder.prepare(&generation,0.,&Default::default(),||0.,||false).unwrap();
    let gpu = styk_render::native_gpu::native_gpu(false,"stage prefetch",|a|wgpu::Limits::default().using_resolution(a.limits())).unwrap();
    let mut renderer = Renderer::new(&gpu.device,&gpu.queue,wgpu::TextureFormat::Rgba8Unorm);
    let mut pictures = pictures::Pictures::default();
    let current = styk_eval::drawlist::DrawList::default();
    load_pictures(&mut pictures,&mut renderer,&engine,&generation,&current);
    let cold = pictures.uploaded_bytes;
    pictures.begin();
    assert!(matches!(pictures.prefetch(&mut renderer,&generation,Some(&engine),&current,&next.list,
        PaintLimits { sprite_bytes:1,..PaintLimits::default() }), Err(PaintError::Budget { .. })));
    assert_eq!(pictures.uploaded_bytes,cold,"refused speculation cannot upload partial pixels");
    for _ in 0..1000 {
        if pictures.prefetch(&mut renderer,&generation,Some(&engine),&current,&next.list,PaintLimits::default()).unwrap() { break; }
        renderer.queue().submit([]); engine.step();
    }
    assert!(pictures.uploaded_bytes>cold,"future pixels must be uploaded before that frame is drawn");
    let warm = pictures.uploaded_bytes;
    load_pictures(&mut pictures,&mut renderer,&engine,&generation,&next.list);
    assert_eq!(pictures.uploaded_bytes,warm,"no upload in the prefetched frame");
}

#[test]
fn pose_only_revision_keeps_picture_payloads_and_uploads_warm() {
    use styk_engine::{
        Budgets, Engine,
        document::{OpenOptions, OpenSource},
        frame_builder::{FrameBuilder, Options},
    };
    let engine = Engine::new(|| 0.0, Budgets::for_device(None));
    let opened = engine
        .open_document(
            OpenSource::Json {
                bytes: include_bytes!(
                    "../../../../styk-eval/tests/fixtures/drawlist/drawing-cel.json"
                ),
                name: "warm cel",
            },
            OpenOptions::default(),
            &|| false,
        )
        .unwrap();
    engine.activate(&opened.typed, &opened.tree, 1).unwrap();
    let first = engine.generation().unwrap();
    let gpu = styk_render::native_gpu::native_gpu(true, "warm picture regression", |a| {
        wgpu::Limits::default().using_resolution(a.limits())
    })
    .unwrap();
    let mut renderer = Renderer::new(&gpu.device, &gpu.queue, wgpu::TextureFormat::Rgba8Unorm);
    let mut pictures = pictures::Pictures::default();
    let mut builder = FrameBuilder::default();
    let before = builder
        .prepare(&first, 0.0, &Options::default(), || 0.0, || false)
        .unwrap();
    load_pictures(&mut pictures, &mut renderer, &engine, &first, &before.list);
    assert!(pictures.uploaded_bytes > 0);
    let warm = pictures.uploaded_bytes;
    let decoded = engine.pictures_decoded();
    let mut tree = opened.tree.clone();
    let object = &mut tree
        .make_obj()
        .unwrap()
        .get_mut("keyframes")
        .unwrap()
        .make_arr()
        .unwrap()[0]
        .make_obj()
        .unwrap()
        .get_mut("objects")
        .unwrap()
        .make_arr()
        .unwrap()[0];
    let x = object
        .get("root_x")
        .and_then(styk_doc::Value::as_f64)
        .unwrap();
    object
        .make_obj()
        .unwrap()
        .set("root_x", styk_doc::Value::Num(x + 17.0));
    engine
        .publish_tree(opened.lineage(), tree.clone(), 2)
        .unwrap()
        .unwrap();
    let next = engine.generation().unwrap();
    assert_eq!(
        first.assets.id(),
        next.assets.id(),
        "a pose edit retains the asset's own identity"
    );
    let after = builder
        .prepare(&next, 0.0, &Options::default(), || 0.0, || false)
        .unwrap();
    assert!(
        before.list.prims != after.list.prims,
        "the pose actually changed"
    );
    load_pictures(&mut pictures, &mut renderer, &engine, &next, &after.list);
    assert_eq!(
        engine.pictures_decoded(),
        decoded,
        "pose edits must not execute decoders"
    );
    assert_eq!(
        pictures.uploaded_bytes, warm,
        "unchanged cel payloads must not be decoded and uploaded again"
    );
    // A changed payload reuses atlas coordinates but gets a new placement.
    // It cannot inherit the old cel's ready status, and must decode/upload again.
    let png = styk_drawing::png::encode_rgba_png(&[255, 0, 0, 255].repeat(64 * 64), 64, 64);
    let blob = styk_drawing::codec::assemble_tile_blob(&[styk_drawing::codec::EncodedTile {
        tx: 0,
        ty: 0,
        png: png.into(),
    }])
    .unwrap();
    let asset = &mut tree
        .make_obj()
        .unwrap()
        .get_mut("figure_types")
        .unwrap()
        .make_arr()
        .unwrap()[0]
        .make_obj()
        .unwrap()
        .get_mut("image_assets")
        .unwrap()
        .make_arr()
        .unwrap()[0];
    asset.make_obj().unwrap().set(
        "styk_tiles",
        styk_doc::Value::Blob(Arc::new(styk_doc::Blob {
            prefix: Arc::from("data:application/x-styk-tiles;base64,"),
            bytes: blob.into(),
        })),
    );
    engine
        .publish_tree(opened.lineage(), tree, 3)
        .unwrap()
        .unwrap();
    let changed = engine.generation().unwrap();
    assert_ne!(next.assets.id(), changed.assets.id());
    let frame = builder
        .prepare(&changed, 0.0, &Options::default(), || 0.0, || false)
        .unwrap();
    pictures.begin();
    assert!(
        !pictures
            .prepare(
                &mut renderer,
                &changed,
                Some(&engine),
                &frame.list,
                PaintLimits::default()
            )
            .unwrap(),
        "changed payload is not ready in old texels"
    );
    load_pictures(&mut pictures, &mut renderer, &engine, &changed, &frame.list);
    assert!(pictures.uploaded_bytes > warm);
    assert!(engine.pictures_decoded() > decoded);
    engine.stop();
}

struct Unavailable;
impl frames::FrameDocument for Unavailable {
    fn snapshot(&self, _: u64, _: u64) -> Option<Arc<styk_engine::Generation>> {
        None
    }
}

#[test]
fn a_failure_cancelled_before_handoff_never_reaches_the_interface() {
    let source: Arc<dyn frames::FrameDocument> = Arc::new(Unavailable);
    let spawner = ManualSpawner::new();
    let mut frames = frames::Frames::new(
        1,
        0,
        0,
        &source,
        frames::Config::default(),
        &spawner,
        Arc::new(FixedClock::new()),
        Arc::new(|| {}),
    )
    .unwrap();
    frames
        .request(
            frames::Consumer::Stage,
            0.0,
            Arc::new(frames::Inputs::default()),
        )
        .unwrap();
    let frame = frames.stage_ticket().unwrap();
    let ticket = Ticket {
        key: PaintKey {
            prepared: frame.key().clone(),
            view: super::super::Presentation {
                size: [1, 1],
                density: 1.0,
                zoom: 1.0,
                pan: [0.0; 2],
                rotation: 0.0,
                flip: false,
                quality: 1.0,
                samples: 4,
            },
        },
        frame,
        navigation: Arc::new(std::sync::atomic::AtomicU64::new(1)),
        serial: 1,
    };
    let shared = Arc::new(Shared {
        request: Slot::new(),
        ready: Slot::new(),
        returned: Slot::new(),
        shutdown_frame: Slot::new(),
        closed: AtomicBool::new(false),
        exited: AtomicBool::new(false),
        changed: Condvar::new(),
        idle: Mutex::new(()),
        wake: Arc::new(|| {}),
    });
    let mut painter = Painter {
        shared: shared.clone(),
        shown: None,
        requested: Some(ticket.identity()),
        status: PaintStatus::Pending,
    };
    publish(&shared, ticket, Err(PaintError::Decode));
    frames.cancel(frames::Consumer::Stage).unwrap();
    assert_eq!(painter.update(), PaintStatus::Pending);
    assert!(painter.texture().is_none());
    painter.close();
    frames.close();
    while spawner.run_next() {}
}

fn load_pictures(
    pictures: &mut pictures::Pictures,
    renderer: &mut Renderer,
    engine: &styk_engine::Engine,
    generation: &Arc<styk_engine::Generation>,
    list: &styk_eval::drawlist::DrawList,
) {
    pictures.begin();
    for _ in 0..1000 {
        if pictures
            .prepare(
                renderer,
                generation,
                Some(engine),
                list,
                PaintLimits::default(),
            )
            .unwrap()
        {
            while engine.step() {}
            return;
        }
        renderer.queue().submit([]);
        engine.step();
    }
    panic!("bounded picture service did not settle");
}
