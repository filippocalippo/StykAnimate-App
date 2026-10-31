//! Actual allocator receipts are independent of accounting formulas.
use super::*;
use crate::doc::*;
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::sync::Mutex;
use std::thread::{self, ThreadId};

#[derive(Clone, Copy, Debug)]
struct Receipt {
    id: u64,
    address: usize,
    bytes: usize,
    allocated: Option<ThreadId>,
    freed: Option<ThreadId>,
}
const EMPTY: Receipt = Receipt {
    id: 0,
    address: 0,
    bytes: 0,
    allocated: None,
    freed: None,
};
struct Ledger {
    receipts: [Receipt; 8192],
    used: usize,
    overflow: bool,
}
static LEDGER: Mutex<Ledger> = Mutex::new(Ledger {
    receipts: [EMPTY; 8192],
    used: 0,
    overflow: false,
});
static SERIAL: Mutex<()> = Mutex::new(());
thread_local! {
    static WATCH: Cell<Option<ThreadId>> = const { Cell::new(None) };
}
struct Observed;
#[global_allocator]
static ALLOCATOR: Observed = Observed;
fn allocate(address: usize, bytes: usize) {
    let _ = WATCH.try_with(|watch| {
        let Some(id) = watch.get() else { return };
        let mut ledger = LEDGER.lock().unwrap();
        if ledger.used == ledger.receipts.len() {
            ledger.overflow = true;
            return;
        }
        let index = ledger.used;
        ledger.receipts[index] = Receipt {
            id: index as u64 + 1,
            address,
            bytes,
            allocated: Some(id),
            freed: None,
        };
        ledger.used += 1;
    });
}
fn free(address: usize) {
    let _ = WATCH.try_with(|watch| {
        let Some(id) = watch.get() else { return };
        let mut ledger = LEDGER.lock().unwrap();
        let used = ledger.used;
        if let Some(receipt) = ledger.receipts[..used]
            .iter_mut()
            .rev()
            .find(|r| r.address == address && r.freed.is_none())
        {
            receipt.freed = Some(id);
        }
    });
}
unsafe impl GlobalAlloc for Observed {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() {
            allocate(pointer as usize, layout.size());
        }
        pointer
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        free(pointer as usize);
        unsafe { System.dealloc(pointer, layout) }
    }
    unsafe fn realloc(&self, pointer: *mut u8, old: Layout, bytes: usize) -> *mut u8 {
        let next = unsafe { System.realloc(pointer, old, bytes) };
        if !next.is_null() {
            free(pointer as usize);
            allocate(next as usize, bytes);
        }
        next
    }
}
fn watched<T>(make: impl FnOnce() -> T) -> T {
    let id = thread::current().id(); // Initialize the real ID before allocator observation.
    assert_eq!(WATCH.with(|watch| watch.replace(Some(id))), None);
    let result = make();
    WATCH.with(|watch| watch.set(None));
    result
}
fn reset() {
    let mut ledger = LEDGER.lock().unwrap();
    ledger.used = 0;
    ledger.overflow = false;
}
fn live() -> Vec<Receipt> {
    let ledger = LEDGER.lock().unwrap();
    assert!(!ledger.overflow, "bounded observation ledger overflow");
    ledger.receipts[..ledger.used]
        .iter()
        .copied()
        .filter(|r| r.freed.is_none())
        .collect()
}
fn fixture() -> Arc<Document> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/drawlist/painted-limbs.json");
    Arc::new(crate::open(&path).unwrap())
}
fn receipt_bytes(receipts: &[Receipt]) -> usize {
    receipts.iter().map(|r| r.bytes).sum()
}
fn descriptor(document: &Arc<Document>, frame: &Arc<Frame>) -> Descriptor {
    observe(
        SourceBaseline {
            document,
            glyphs: &[],
        },
        std::slice::from_ref(frame),
        &[],
        || true,
    )
    .unwrap()
}

#[test]
fn actual_worker_tween_frame_allocations_match_the_private_observation() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    reset();
    let document = fixture();
    let prepared = crate::eval::Prepared::new(document.clone());
    let worker = thread::spawn(move || {
        let frame = watched(|| Arc::new(prepared.evaluate(1.25)));
        let receipts = live();
        assert!(!receipts.is_empty());
        let worker_id = thread::current().id();
        assert!(receipts.iter().all(|r| r.allocated == Some(worker_id)));
        let actual = receipt_bytes(&receipts);
        let observed = descriptor(&document, &frame);
        println!(
            "worker={worker_id:?} frame receipts={receipts:?} actual={actual} covered={}",
            observed.additional_covered_bytes
        );
        assert_eq!(
            observed.additional_covered_bytes, actual,
            "new tween object/number buffers and frame capacities survive evaluation"
        );
        watched(|| drop(frame));
        assert!(
            live().is_empty(),
            "all observed retained allocations were released on their worker"
        );
        let ledger = LEDGER.lock().unwrap();
        assert!(
            ledger.receipts[..ledger.used]
                .iter()
                .all(|r| r.freed == Some(worker_id))
        );
    });
    worker.join().unwrap();
}

#[test]
fn actual_style_owner_clones_figure_containers_and_palette() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    reset();
    let mut document = (*fixture()).clone();
    let mut base = (*document.figures[0]).clone();
    base.plan.index_of.clear(); // Empty map has no opaque backing allocation in this fixture.
    base.plan.index_of.shrink_to_fit();
    base.mesh_colors = Arc::from([[10, 20, 30], [40, 50, 60]]);
    base.segments[0].name = Some("actual owned segment name".into());
    base.polyfills.push(Polyfill {
        id: 1,
        joints: vec![0, 11, 22],
        rgb: [0; 3],
        alpha: 1.0,
        z: 0.0,
        surface: Some(Surface {
            basis: [0, 11, 22],
            back: false,
            flipped: false,
            depth: vec![11, 22],
            depth_test: true,
        }),
    });
    base.texts.push(TextAsset {
        index: 0,
        glyphs: vec![Arc::new(Glyph {
            path: vec![PathCmd::Move(0.0, 0.0)],
            bounds: None,
        })],
        placements: vec![(0, 1.0, 2.0)],
        width: 1.0,
        height: 2.0,
    });
    let base = Arc::new(base);
    document.figures[0] = base.clone();
    let document = Arc::new(document);
    let style = Arc::new(crate::style::ObjectStyle {
        mesh_colors: vec![(0, 0xff0033)],
        key: "source style".into(),
        ..Default::default()
    });
    let worker = thread::spawn(move || {
        let frame = watched(|| {
            let mut figure = crate::style::resolve(&base, &style); // Actual existing owner.
            figure.base = Some(base.clone());
            let mut object = (*document.keyframes[0].objects[0]).clone();
            object.figure_override = Some(Arc::new(figure));
            Arc::new(Frame {
                objects: vec![Arc::new(object)],
                draw_order: Vec::with_capacity(31),
                ..Default::default()
            })
        });
        let receipts = live();
        let actual = receipt_bytes(&receipts);
        let observed = descriptor(&document, &frame);
        println!(
            "worker={:?} style receipts={receipts:?} actual={actual} covered={}",
            thread::current().id(),
            observed.additional_covered_bytes
        );
        assert_eq!(
            observed.additional_covered_bytes, actual,
            "derived Figure owns cloned strings/nested vectors/palette but shares source paints/glyphs"
        );
        watched(|| drop(frame));
        assert!(live().is_empty());
    });
    worker.join().unwrap();
}

#[test]
fn sampled_paint_frame_effects_and_encoded_layers_share_one_owner() {
    use crate::drawlist::{EffectLayer, GlyphInstance, GlyphMask, LayerKind};
    use crate::vfx::frame::{Attached, Generator, ObjectVfx};
    use crate::vfx::{Effect, FrameVfx, Kind, ParamValue, Params, StackKey, Stacks, Target};
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    reset();
    let mut source = (*fixture()).clone();
    let a = source.figures[0].segments[1].paint.clone().unwrap();
    let mut second = (*a).clone();
    second.stops[0].rgb = [10, 20, 30];
    let b = Arc::new(second);
    Arc::make_mut(&mut source.figures[0]).segments[0].paint = Some(b.clone());
    let document = Arc::new(source);
    let id = document.keyframes[0].frame_id.clone().unwrap();
    let worker = thread::spawn(move || {
        let (frame, list) = watched(|| {
            let color =
                crate::vfx::paint::interpolate(&ParamValue::Paint(a), &ParamValue::Paint(b), 0.375);
            assert!(matches!(color, ParamValue::Paint(_)));
            let mut params = Params::defaults(Kind::Tint);
            params.set(Kind::Tint.param("color").unwrap(), &color);
            let effect = Arc::new(Effect {
                id,
                enabled: true,
                params,
            });
            let shared_slice: Arc<[Arc<Effect>]> = Arc::from([effect.clone(), effect.clone()]);
            let pose = Arc::new(Stacks {
                entries: vec![(StackKey::Figure, shared_slice)],
            });
            let frame = Arc::new(Frame {
                pose_vfx: Some(pose),
                vfx: Some(Arc::new(FrameVfx {
                    scene: vec![effect.clone()],
                    objects: vec![Some(ObjectVfx {
                        figure: vec![effect.clone()],
                        attached: Some(Attached {
                            stack: vec![effect.clone()],
                            members: vec![0, 1],
                        }),
                        segments: vec![(11, vec![effect.clone()])],
                    })],
                    roots: vec![0],
                    generators: vec![Generator {
                        clip: 0,
                        index: 0,
                        target: Target::Scene,
                        effect: effect.clone(),
                        alpha: 1.0,
                        start: 0.0,
                    }],
                    warnings: vec!["actual retained warning".into()],
                })),
                ..Default::default()
            });
            let effects = Arc::new(vec![effect.clone(), effect]);
            let triangles: Arc<[[f32; 2]]> = Arc::from(vec![[1.0, 2.0]; 1024]);
            let mask = GlyphMask {
                bounds: [0.0; 4],
                origin: [0.0; 2],
                angle: 0.0,
                scale: [1.0; 2],
                offset: [0.0; 2],
            };
            let list = Arc::new(DrawList {
                layers: vec![
                    EffectLayer {
                        effects: Some(effects.clone()),
                        kind: LayerKind::Raster { bounds: [0.0; 4] },
                    },
                    EffectLayer {
                        effects: Some(effects),
                        kind: LayerKind::Raster { bounds: [0.0; 4] },
                    },
                ],
                glyphs: vec![
                    GlyphInstance {
                        mask,
                        triangles: triangles.clone(),
                    },
                    GlyphInstance { mask, triangles },
                ],
                points: Vec::with_capacity(127),
                passes: Vec::with_capacity(17),
                ..Default::default()
            });
            (frame, list)
        });
        let receipts = live();
        let actual = receipt_bytes(&receipts);
        let observed = observe(
            SourceBaseline {
                document: &document,
                glyphs: &[],
            },
            &[frame.clone(), frame.clone()],
            &[list.clone(), list.clone()],
            || true,
        )
        .unwrap();
        println!(
            "worker={:?} sampled/encoded receipts={receipts:?} actual={actual} covered={}",
            thread::current().id(),
            observed.additional_covered_bytes()
        );
        assert_eq!(
            observed.additional_covered_bytes(),
            actual,
            "one actual sampled Paint/effect and glyph allocation across repeated frame/list heads"
        );
        watched(|| {
            drop(frame);
            drop(list);
        });
        assert!(live().is_empty());
    });
    worker.join().unwrap();
}

#[test]
fn actual_text_encoder_excludes_the_strong_source_glyph_baseline() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    reset();
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/drawlist/outlined-text.json");
    let mut source = crate::open(&path).unwrap();
    for figure in &mut source.figures {
        Arc::make_mut(figure).outline = None;
    }
    let document = Arc::new(source);
    let worker = thread::spawn(move || {
        let prepared = crate::eval::Prepared::new(document.clone());
        let assets = crate::assets::Assets::build(&document);
        let glyphs: Vec<_> = assets
            .glyphs
            .values()
            .map(|(_, triangles)| triangles.clone())
            .collect();
        let frame = prepared.evaluate(0.0);
        let scene = crate::geometry::build(&document, &frame);
        let list = watched(|| Arc::new(crate::drawlist::encode(&document, &assets, &scene)));
        assert_eq!(list.glyphs.len(), 3);
        assert!(
            list.glyphs
                .iter()
                .all(|g| glyphs.iter().any(|s| Arc::ptr_eq(s, &g.triangles)))
        );
        let receipts = live();
        let actual = receipt_bytes(&receipts);
        let counts: Vec<_> = glyphs.iter().map(Arc::strong_count).collect();
        let observed = observe(
            SourceBaseline {
                document: &document,
                glyphs: &glyphs,
            },
            &[],
            std::slice::from_ref(&list),
            || true,
        )
        .unwrap();
        assert_eq!(
            observed.additional_covered_bytes(),
            actual,
            "actual encoder only allocates its owned containers here"
        );
        assert!(observed.uncovered().contains(Uncovered::MUTABLE_ASSETS));
        assert_eq!(
            counts,
            glyphs.iter().map(Arc::strong_count).collect::<Vec<_>>(),
            "descriptor retains no source or ready payload"
        );
        println!(
            "worker={:?} actual text encoder receipts={receipts:?} new={actual} sourceCovered={}",
            thread::current().id(),
            observed.source_covered_bytes()
        );
        watched(|| drop(list));
        assert!(
            live().is_empty(),
            "source glyphs remain strongly held and were not allocated in this observation scope"
        );
    });
    worker.join().unwrap();
}

#[test]
fn cancellation_and_unknown_payload_preserve_gaps_and_sources() {
    let source = fixture();
    let prepared = crate::eval::Prepared::new(source.clone());
    let frame = Arc::new(prepared.evaluate(1.25));
    let before = format!("{:?}{:?}", source.figures, source.keyframes);
    let source_count = Arc::strong_count(&source);
    let frame_count = Arc::strong_count(&frame);
    let baseline = SourceBaseline {
        document: &source,
        glyphs: &[],
    };
    let mut calls = 0;
    let failure = match observe(baseline, std::slice::from_ref(&frame), &[], || {
        calls += 1;
        calls < 14
    }) {
        Err(error) => error,
        Ok(_) => panic!("must cancel the actual traversal"),
    };
    assert_eq!(failure.reason, Reason::Cancelled);
    assert!(failure.uncovered.contains(Uncovered::SOURCE_OWNERS));
    assert!(
        failure.uncovered.contains(Uncovered::MAP_TABLES),
        "encountered opaque FigurePlan map remains marked at refusal"
    );
    assert_eq!(
        before,
        format!("{:?}{:?}", source.figures, source.keyframes)
    );
    assert_eq!(
        (source_count, frame_count),
        (Arc::strong_count(&source), Arc::strong_count(&frame))
    );
    let list = Arc::new(DrawList {
        layers: vec![crate::drawlist::EffectLayer {
            effects: Some(Arc::new(vec![99_u32])),
            kind: crate::drawlist::LayerKind::Raster { bounds: [0.0; 4] },
        }],
        ..Default::default()
    });
    let failure = match observe(
        SourceBaseline {
            document: &source,
            glyphs: &[],
        },
        &[],
        &[list],
        || true,
    ) {
        Err(error) => error,
        Ok(_) => panic!("opaque Any is not a typed VFX allocation"),
    };
    assert_eq!(
        failure.reason,
        Reason::Accounting(RetainedBytesError::UnknownEffects { layer: 0 })
    );
    assert!(failure.uncovered.contains(Uncovered::MAP_TABLES));
    assert_eq!(
        before,
        format!("{:?}{:?}", source.figures, source.keyframes)
    );
}

#[test]
fn actual_loader_shares_raw_blob_images_but_allocates_typed_numbers() {
    use styk_doc::{Blob, Nums, Value};
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    reset();
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/drawlist/painted-limbs.json");
    let mut raw = styk_doc::json::parse(&std::fs::read(path).unwrap()).unwrap();
    let bytes: Arc<[u8]> = Arc::from([10_u8, 20, 30, 40]);
    let mut asset =
        styk_doc::json::parse(br#"{"asset_index":0,"anchor_start":[0,0],"anchor_end":[1,0]}"#)
            .unwrap();
    asset.make_obj().unwrap().set(
        "data_base64",
        Value::Blob(Arc::new(Blob {
            prefix: Arc::from(""),
            bytes: bytes.clone(),
        })),
    );
    raw.make_obj()
        .unwrap()
        .get_mut("figure_types")
        .unwrap()
        .make_arr()
        .unwrap()[0]
        .make_obj()
        .unwrap()
        .set("image_assets", Value::array(vec![asset]));
    let raw_frame = raw.get("keyframes").unwrap().as_arr().unwrap()[0].clone();
    let packed = raw_frame.get("objects").unwrap().as_arr().unwrap()[0]
        .get("angles")
        .unwrap();
    let raw_numbers = match packed {
        Value::Nums(nums) => match &**nums {
            Nums::F32(v) => v.as_ptr() as usize,
            Nums::F64(v) => v.as_ptr() as usize,
        },
        _ => panic!("actual store packs the numeric array"),
    };
    let mut before = Vec::new();
    styk_doc::json::write(&raw, &mut before);
    let mut loader = crate::load::Loader::new();
    let document = Arc::new(loader.document(&raw, "blob sharing observation").unwrap());
    assert_eq!(document.images.len(), 1);
    assert!(
        Arc::ptr_eq(&document.images[0].bytes, &bytes),
        "typed image preserves the raw Blob's actual allocation"
    );
    assert_ne!(
        document.keyframes[0].objects[0].angles.as_ptr() as usize,
        raw_numbers
    );
    let worker = thread::spawn(move || {
        let frame = watched(|| Arc::new(loader.edit_frame(&raw_frame, None, &document).unwrap()));
        let receipts = live();
        let pointer = frame.objects[0].angles.as_ptr() as usize;
        let number_receipt = receipts
            .iter()
            .find(|r| r.address <= pointer && pointer < r.address + r.bytes)
            .unwrap();
        assert_ne!(pointer, raw_numbers);
        assert_ne!(
            pointer,
            document.keyframes[0].objects[0].angles.as_ptr() as usize,
            "re-reading raw packed numbers creates a new typed allocation rather than borrowing either source view"
        );
        let observed = descriptor(&document, &frame);
        assert_eq!(
            observed.additional_covered_bytes(),
            receipt_bytes(&receipts)
        );
        println!(
            "worker={:?} typed number allocation ID={} receipt={number_receipt:?}; raw blob shared=true frameCovered={}",
            thread::current().id(),
            number_receipt.id,
            observed.additional_covered_bytes()
        );
        let mut after = Vec::new();
        styk_doc::json::write(&raw, &mut after);
        assert_eq!(before, after);
        watched(|| drop(frame));
        assert!(live().is_empty());
    });
    worker.join().unwrap();
}

#[test]
fn spare_frame_capacities_and_playback_buffers_are_actual_allocations() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    reset();
    let document = fixture();
    let id = document.keyframes[0].frame_id.clone().unwrap();
    let worker = thread::spawn(move || {
        let frame = watched(|| {
            let mut origins = Vec::with_capacity(31);
            origins.push(Some((FrameRef::Source(id), 0)));
            let mut restarts = Vec::with_capacity(17);
            restarts.push((1.25, 0.5));
            let playback = Arc::new(MovieclipPlayback {
                start: 0.0,
                end: Some(7.0),
                offset: 0.0,
                speed: 1.0,
                mode: MovieclipMode::Loop,
                presence: true,
                restarts,
            });
            let mut continuations = Vec::with_capacity(19);
            continuations.push((1, playback.clone()));
            continuations.push((2, playback));
            Arc::new(Frame {
                objects: Vec::with_capacity(63),
                draw_order: Vec::with_capacity(127),
                export_vfx: Vec::with_capacity(47),
                origins,
                continuations,
                ..Default::default()
            })
        });
        let actual = receipt_bytes(&live());
        let observed = descriptor(&document, &frame);
        assert_eq!(
            observed.additional_covered_bytes(),
            actual,
            "unused frame capacities and shared restart ownership remain physically retained"
        );
        watched(|| drop(frame));
        assert!(live().is_empty());
    });
    worker.join().unwrap();
}

#[test]
fn actual_new_style_payload_is_covered_with_explicit_opaque_map_gap() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    reset();
    let mut source = (*fixture()).clone();
    let figure = Arc::make_mut(&mut source.figures[0]);
    figure.plan.index_of.clear();
    figure.plan.index_of.shrink_to_fit();
    figure.mesh_colors = Arc::from([[10, 20, 30], [40, 50, 60]]);
    let document = Arc::new(source);
    let raw = styk_doc::json::parse(br#"{"segments":{"11":{"paint":{"type":"linear","stops":[{"offset":0,"color":[20,30,40],"opacity":0},{"offset":1,"color":[90,80,70],"opacity":0}]}}},"meshColors":{"0":16711935},"outlineWidth":4}"#).unwrap();
    let worker = thread::spawn(move || {
        let frame = watched(|| {
            let style = crate::style::parse(Some(&raw), None).unwrap(); // Actual existing parser/owner.
            assert!(style.segments.capacity() > 0);
            let mut derived = crate::style::resolve(&document.figures[0], &style);
            derived.base = Some(document.figures[0].clone());
            let mut object = (*document.keyframes[0].objects[0]).clone();
            object.style = Some(style);
            object.figure_override = Some(Arc::new(derived));
            object.spatial = Some(Arc::new(SpatialPose {
                camera: None,
                shape: Some(std::collections::BTreeMap::from([(
                    11,
                    SpatialShape {
                        width: 0.5,
                        taper: 0.25,
                    },
                )])),
            }));
            Arc::new(Frame {
                objects: vec![Arc::new(object)],
                ..Default::default()
            })
        });
        let actual = receipt_bytes(&live());
        let observed = descriptor(&document, &frame);
        assert!(observed.uncovered().contains(Uncovered::MAP_TABLES));
        assert!(observed.uncovered().contains(Uncovered::SPATIAL_TABLES));
        assert!(
            observed.additional_covered_bytes() > 0 && observed.additional_covered_bytes() < actual,
            "covered style key/palette/paint/figure buffers exclude actual opaque HashMap/BTree backing allocations"
        );
        println!(
            "worker={:?} new style actual={actual} partialCovered={} uncovered={:?}; no map layout estimate",
            thread::current().id(),
            observed.additional_covered_bytes(),
            observed.uncovered()
        );
        watched(|| drop(frame));
        assert!(live().is_empty());
    });
    worker.join().unwrap();
}

#[test]
#[ignore = "loaded worker diagnostic, not baseline-0/engine-1 or an idle-machine measurement"]
fn dense_typed_worker_observation_cost() {
    let document = fixture();
    let worker = thread::spawn(move || {
        let objects = (0..4096)
            .map(|uid| {
                let mut object = (*document.keyframes[0].objects[0]).clone();
                object.uid = uid;
                object.angles = Arc::from(&*object.angles);
                Arc::new(object)
            })
            .collect();
        let frame = Arc::new(Frame {
            objects,
            draw_order: (0..4096).collect(),
            ..Default::default()
        });
        let mut times = Vec::new();
        for _ in 0..21 {
            let start = std::time::Instant::now();
            let observed = descriptor(&document, &frame);
            std::hint::black_box(observed.additional_covered_bytes());
            times.push(start.elapsed().as_nanos());
        }
        times.sort_unstable();
        println!(
            "loaded worker diagnostic ThreadId={:?}: distinct typed objects=4096, median={} ns p95={} ns; partial graph only, no global cap/admission",
            thread::current().id(),
            times[10],
            times[19]
        );
    });
    worker.join().unwrap();
}

#[test]
fn actual_flat_style_parser_buffers_are_completely_covered() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    reset();
    let mut source = (*fixture()).clone();
    let figure = Arc::make_mut(&mut source.figures[0]);
    figure.plan.index_of.clear();
    figure.plan.index_of.shrink_to_fit();
    figure.mesh_colors = Arc::from([[10, 20, 30], [40, 50, 60]]);
    let document = Arc::new(source);
    let raw = styk_doc::json::parse(br#"{"meshColors":{"0":16711935},"outlineWidth":4}"#).unwrap();
    let worker = thread::spawn(move || {
        let frame = watched(|| {
            let style = crate::style::parse(Some(&raw), None).unwrap();
            assert_eq!(style.segments.capacity(), 0);
            assert_eq!(style.polygons.capacity(), 0);
            let mut derived = crate::style::resolve(&document.figures[0], &style);
            derived.base = Some(document.figures[0].clone());
            let mut object = (*document.keyframes[0].objects[0]).clone();
            object.style = Some(style);
            object.figure_override = Some(Arc::new(derived));
            object.color_transition = Some(Arc::new(ColorTransition {
                from: 1,
                to: 2,
                t: 0.375,
            }));
            Arc::new(Frame {
                objects: vec![Arc::new(object)],
                ..Default::default()
            })
        });
        let receipts = live();
        let actual = receipt_bytes(&receipts);
        let observed = descriptor(&document, &frame);
        assert_eq!(
            observed.additional_covered_bytes(),
            actual,
            "actual flat style parser/resolver owns key capacity, palette and scalar color transition"
        );
        println!(
            "worker={:?} flat style receipts={receipts:?} actual={actual} covered={}",
            thread::current().id(),
            observed.additional_covered_bytes()
        );
        watched(|| drop(frame));
        assert!(live().is_empty());
    });
    worker.join().unwrap();
}
