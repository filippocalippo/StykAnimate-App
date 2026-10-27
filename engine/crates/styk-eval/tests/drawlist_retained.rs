//! Physical requested allocations, independently observed at the actual owners.
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;
use styk_eval::drawlist::{
    self, DrawList, EffectLayer, GlyphInstance, GlyphMask, LayerKind, Pass, Prim,
};
use styk_eval::vfx::{Effect, Kind, Params};

struct Observed;
thread_local! {
    static WATCH: Cell<bool> = const { Cell::new(false) };
    static LIVE: Cell<i128> = const { Cell::new(0) };
}
fn change(bytes: i128) {
    let _ = WATCH.try_with(|watch| {
        if watch.get() {
            let _ = LIVE.try_with(|live| live.set(live.get() + bytes));
        }
    });
}
unsafe impl GlobalAlloc for Observed {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() {
            change(layout.size() as i128);
        }
        pointer
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        change(-(layout.size() as i128));
        unsafe { System.dealloc(pointer, layout) }
    }
    unsafe fn realloc(&self, pointer: *mut u8, old: Layout, bytes: usize) -> *mut u8 {
        let next = unsafe { System.realloc(pointer, old, bytes) };
        if !next.is_null() {
            change(bytes as i128 - old.size() as i128);
        }
        next
    }
}
#[global_allocator]
static ALLOCATOR: Observed = Observed;

fn allocations(make: impl FnOnce() -> Arc<DrawList>) -> (Arc<DrawList>, usize) {
    LIVE.with(|live| live.set(0));
    WATCH.with(|watch| watch.set(true));
    let list = make();
    WATCH.with(|watch| watch.set(false));
    let bytes = LIVE.with(Cell::get);
    assert!(bytes > 0, "actual fixture must allocate retained buffers");
    (list, usize::try_from(bytes).unwrap())
}

fn charge(list: &DrawList) -> usize {
    drawlist::retained_bytes_checked(list).expect("typed retained encoder output")
}

fn mask() -> GlyphMask {
    GlyphMask {
        bounds: [0.0, 0.0, 1.0, 1.0],
        origin: [0.0; 2],
        angle: 0.0,
        scale: [1.0; 2],
        offset: [0.0; 2],
    }
}

#[test]
fn spare_capacity_and_pass_storage_match_actual_retained_allocations() {
    let (list, bytes) = allocations(|| {
        Arc::new(DrawList {
            prims: Vec::<Prim>::with_capacity(1024),
            points: Vec::with_capacity(512),
            paints: Vec::with_capacity(128),
            groups: Vec::with_capacity(31),
            layers: Vec::with_capacity(32),
            glyphs: Vec::with_capacity(16),
            passes: vec![Pass {
                depth: 0,
                start: 0,
                end: 0,
            }],
            ..Default::default()
        })
    });
    assert_eq!(
        charge(&list),
        bytes,
        "empty retained capacity and pass buffers exist even with no primitives"
    );
}

#[test]
fn shared_glyph_slices_are_charged_once_per_actual_allocation() {
    for distinct in [false, true] {
        let (list, bytes) = allocations(|| {
            let triangles: Arc<[[f32; 2]]> = Arc::from(vec![[1.0, 2.0]; 65_536]);
            let second = if distinct {
                Arc::from(vec![[1.0, 2.0]; 65_536])
            } else {
                triangles.clone()
            };
            Arc::new(DrawList {
                glyphs: vec![
                    GlyphInstance {
                        mask: mask(),
                        triangles,
                    },
                    GlyphInstance {
                        mask: mask(),
                        triangles: second,
                    },
                ],
                ..Default::default()
            })
        });
        assert_eq!(
            charge(&list),
            bytes,
            "distinct={distinct}: shared triangle payloads outlive their source cache"
        );
    }
}

#[test]
fn typed_stack_containers_share_resolved_effect_payloads() {
    for same_container in [true, false] {
        let (list, bytes) = allocations(|| {
            let effect = Arc::new(Effect {
                id: Arc::from("x"),
                enabled: true,
                params: Params::defaults(Kind::Blur),
            });
            let first = Arc::new(vec![effect.clone(), effect]);
            let second = if same_container {
                first.clone()
            } else {
                Arc::new((*first).clone())
            };
            let layer = |effects: Arc<Vec<Arc<Effect>>>| EffectLayer {
                effects: Some(effects),
                kind: LayerKind::Raster {
                    bounds: [0.0, 0.0, 1.0, 1.0],
                },
            };
            Arc::new(DrawList {
                layers: vec![layer(first), layer(second)],
                ..Default::default()
            })
        });
        assert_eq!(
            charge(&list),
            bytes,
            "same_container={same_container}: actual stack/id allocation deduplication"
        );
    }
}

#[test]
fn distinct_effects_share_or_separately_own_their_actual_paint_buffers() {
    use styk_eval::doc::{Paint, PaintKind, PaintStop};
    use styk_eval::vfx::ParamValue;
    for distinct_paint in [false, true] {
        let (list, bytes) = allocations(|| {
            let mut stops = Vec::with_capacity(64);
            stops.push(PaintStop {
                offset: 0.0,
                rgb: [20, 30, 40],
                opacity: 0.0,
            });
            let paint = Arc::new(Paint {
                kind: PaintKind::Linear,
                angle: 0.0,
                stops,
            });
            let mut params = Params::defaults(Kind::Tint);
            let color = Kind::Tint.param("color").unwrap();
            assert!(params.set(color, &ParamValue::Paint(paint.clone())));
            let first = Arc::new(Effect {
                id: Arc::from("shared-id"),
                enabled: true,
                params,
            });
            let mut second = (*first).clone();
            if distinct_paint {
                second
                    .params
                    .set(color, &ParamValue::Paint(Arc::new((*paint).clone())));
            }
            let stack = Arc::new(vec![first, Arc::new(second)]);
            Arc::new(DrawList {
                layers: vec![EffectLayer {
                    effects: Some(stack),
                    kind: LayerKind::Raster { bounds: [0.0; 4] },
                }],
                ..Default::default()
            })
        });
        assert_eq!(
            charge(&list),
            bytes,
            "distinct_paint={distinct_paint}: actual shared id/paint/stops allocation"
        );
    }
}

#[test]
fn actual_encoder_retained_vectors_are_covered_after_scene_disposal() {
    let path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/drawlist/painted-limbs.json");
    let prepared = styk_eval::prepare(styk_eval::open(&path).unwrap());
    let assets = styk_eval::assets::Assets::build(&prepared.doc);
    let scene = styk_eval::geometry::build(&prepared.doc, &prepared.evaluate(0.0));
    assert!(
        scene.objects.len() < 8,
        "fixture encodes on this observed worker"
    );
    let (list, bytes) = allocations(|| Arc::new(drawlist::encode(&prepared.doc, &assets, &scene)));
    drop(scene);
    assert!(
        !list.prims.is_empty() && !list.passes.is_empty(),
        "actual encoder fixture"
    );
    assert_eq!(
        charge(&list),
        bytes,
        "actual encoder allocation lifetime is independent from Scene"
    );
}

#[test]
fn sampled_paint_effects_remain_charged_after_actual_scene_disposal() {
    use styk_eval::doc::{Paint, PaintKind, PaintStop};
    use styk_eval::vfx::{FrameVfx, ParamValue};
    let path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/drawlist/painted-limbs.json");
    let prepared = styk_eval::prepare(styk_eval::open(&path).unwrap());
    let assets = styk_eval::assets::Assets::build(&prepared.doc);
    let scene = styk_eval::geometry::build(&prepared.doc, &prepared.evaluate(0.0));
    let paint = |rgb| {
        ParamValue::Paint(Arc::new(Paint {
            kind: PaintKind::Linear,
            angle: 0.0,
            stops: vec![
                PaintStop {
                    offset: 0.0,
                    rgb,
                    opacity: 0.0,
                },
                PaintStop {
                    offset: 1.0,
                    rgb,
                    opacity: 0.0,
                },
            ],
        }))
    };
    let (a, b) = (paint([0, 0, 0]), paint([255, 255, 255]));
    let (list, bytes) = allocations(|| {
        let sampled = styk_eval::vfx::paint::interpolate(&a, &b, 0.375);
        let ParamValue::Paint(value) = &sampled else {
            panic!("actual sampled gradient")
        };
        let (ParamValue::Paint(source_a), ParamValue::Paint(source_b)) = (&a, &b) else {
            unreachable!()
        };
        assert!(!Arc::ptr_eq(value, source_a) && !Arc::ptr_eq(value, source_b));
        let mut params = Params::defaults(Kind::Tint);
        assert!(params.set(Kind::Tint.param("color").unwrap(), &sampled));
        let effect = Arc::new(Effect {
            id: Arc::from("sampled"),
            enabled: true,
            params,
        });
        let mut candidate = scene.clone();
        candidate.vfx = Some(Arc::new(FrameVfx {
            scene: vec![effect.clone(), effect],
            ..Default::default()
        }));
        Arc::new(drawlist::encode(&prepared.doc, &assets, &candidate))
    });
    drop(scene);
    drop(assets);
    drop(prepared);
    assert!(
        list.layers
            .iter()
            .any(|layer| !drawlist::layer_effects(layer).is_empty())
    );
    assert_eq!(
        charge(&list),
        bytes,
        "the encoder keeps newly sampled effects/paints after temporary Scene destruction"
    );
}

#[test]
fn actual_text_encoder_accounts_shared_source_slices_without_retaining_them() {
    let path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/drawlist/outlined-text.json");
    let mut doc = styk_eval::open(&path).unwrap();
    for figure in &mut doc.figures {
        Arc::make_mut(figure).outline = None;
    }
    let prepared = styk_eval::prepare(doc);
    let assets = styk_eval::assets::Assets::build(&prepared.doc);
    let scene = styk_eval::geometry::build(&prepared.doc, &prepared.evaluate(0.0));
    let (list, encoded_bytes) =
        allocations(|| Arc::new(drawlist::encode(&prepared.doc, &assets, &scene)));
    assert_eq!(list.glyphs.len(), 3, "existing actual lone-glyph fixture");
    let mut unique = HashSet::new();
    let slice_bytes: usize = list
        .glyphs
        .iter()
        .filter(|glyph| unique.insert(Arc::as_ptr(&glyph.triangles) as *const ()))
        .map(|glyph| {
            Layout::new::<[usize; 2]>()
                .extend(Layout::for_value(&*glyph.triangles))
                .unwrap()
                .0
                .pad_to_align()
                .size()
        })
        .sum();
    assert_eq!(
        unique.len(),
        3,
        "the fixture's three source glyph definitions own distinct triangle allocations"
    );
    drop(scene);
    drop(assets);
    drop(prepared);
    let before: Vec<_> = list
        .glyphs
        .iter()
        .map(|glyph| Arc::strong_count(&glyph.triangles))
        .collect();
    assert_eq!(
        charge(&list),
        encoded_bytes + slice_bytes,
        "source-shared triangles are conservatively charged once too"
    );
    assert_eq!(
        before,
        list.glyphs
            .iter()
            .map(|glyph| Arc::strong_count(&glyph.triangles))
            .collect::<Vec<_>>(),
        "accounting borrows immutable payloads"
    );
}

#[test]
fn unknown_effect_payload_refuses_without_mutating_the_list() {
    let payload = Arc::new(String::from("opaque caller metadata"));
    let list = DrawList {
        layers: vec![
            EffectLayer {
                effects: None,
                kind: LayerKind::Raster { bounds: [0.0; 4] },
            },
            EffectLayer {
                effects: Some(payload.clone()),
                kind: LayerKind::Raster { bounds: [0.0; 4] },
            },
        ],
        ..Default::default()
    };
    let before = Arc::strong_count(&payload);
    assert_eq!(
        drawlist::retained_bytes_checked(&list),
        Err(drawlist::RetainedBytesError::UnknownEffects { layer: 1 })
    );
    assert_eq!(Arc::strong_count(&payload), before);
    assert_eq!(list.layers.len(), 2);
}

#[test]
#[ignore = "loaded-machine worker diagnostic, not an idle engine benchmark"]
fn dense_encoded_worker_accounting_diagnostic() {
    fn measure(label: &str, list: &Arc<DrawList>) {
        let expected = charge(list);
        let logical = list.bytes();
        let mut samples = Vec::new();
        for _ in 0..25 {
            let started = std::time::Instant::now();
            for _ in 0..1000 {
                assert_eq!(
                    std::hint::black_box(charge(std::hint::black_box(list))),
                    expected
                );
            }
            samples.push(started.elapsed().as_nanos() / 1000);
        }
        samples.sort_unstable();
        println!(
            "DENSE_ACCOUNTING {{\"label\":\"{}\",\"primitives\":{},\"passes\":{},\"glyphs\":{},\"layers\":{},\"logicalBytes\":{},\"retainedBytes\":{},\"samples\":25,\"callsPerSample\":1000,\"medianNs\":{},\"p95Ns\":{}}}",
            label,
            list.prims.len(),
            list.passes.len(),
            list.glyphs.len(),
            list.layers.len(),
            logical,
            expected,
            samples[12],
            samples[23]
        );
    }
    std::thread::Builder::new()
        .name("drawlist-accounting-diagnostic".into())
        .spawn(|| {
            let path = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/drawlist/painted-limbs.json");
            let prepared = styk_eval::prepare(styk_eval::open(&path).unwrap());
            let assets = styk_eval::assets::Assets::build(&prepared.doc);
            let mut scene = styk_eval::geometry::build(&prepared.doc, &prepared.evaluate(0.0));
            let item = scene.items[0].clone();
            scene.items = vec![item; 65_536];
            let list = Arc::new(drawlist::encode(&prepared.doc, &assets, &scene));
            assert!(list.prims.len() >= 65_536);
            measure("dense-primitives", &list);
            drop(list);
            drop(scene);
            drop(assets);
            drop(prepared);

            let path = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/drawlist/outlined-text.json");
            let mut doc = styk_eval::open(&path).unwrap();
            for figure in &mut doc.figures {
                Arc::make_mut(figure).outline = None;
            }
            let prepared = styk_eval::prepare(doc);
            let assets = styk_eval::assets::Assets::build(&prepared.doc);
            let scene = styk_eval::geometry::build(&prepared.doc, &prepared.evaluate(0.0));
            let mut encoded = drawlist::encode(&prepared.doc, &assets, &scene);
            assert_eq!(encoded.glyphs.len(), 3, "actual lone-glyph fixture");
            // Repeat actual encoder-built references without inventing object
            // runs: each retained slice still comes from the real text encoder.
            let glyphs = encoded.glyphs.clone();
            encoded.glyphs = glyphs.into_iter().cycle().take(2048).collect();
            let list = Arc::new(encoded);
            assert_eq!(
                list.glyphs.len(),
                2048,
                "actual encoded glyph reference workload"
            );
            measure("dense-shared-glyphs", &list);

            // Retain many references to an actual encoder-built typed stack; this
            // isolates linear layer-reference accounting from filter/GPU work.
            let mut vfx = scene;
            let effect = Arc::new(Effect {
                id: Arc::from("diagnostic"),
                enabled: true,
                params: Params::defaults(Kind::Tint),
            });
            vfx.vfx = Some(Arc::new(styk_eval::vfx::FrameVfx {
                scene: vec![effect],
                ..Default::default()
            }));
            let mut filtered = drawlist::encode(&prepared.doc, &assets, &vfx);
            let layer = filtered
                .layers
                .iter()
                .find(|layer| !drawlist::layer_effects(layer).is_empty())
                .unwrap()
                .clone();
            filtered.layers = vec![layer; 4096];
            measure("dense-shared-layer-references", &Arc::new(filtered));
        })
        .unwrap()
        .join()
        .unwrap();
}
