use super::*;
fn p(k: &str) -> PanelId {
    PanelId::new(k)
}
fn apply(l: &mut Layout, o: Operation) {
    l.apply(o, Workspace::Animate).unwrap();
}
#[test]
fn transactional_moves_overlay_and_last_stage() {
    let mut l = essentials(Workspace::Animate);
    l.validate(Workspace::Animate).unwrap();
    let original = l.clone();
    assert!(
        l.apply(Operation::Close(p("stage")), Workspace::Animate)
            .is_err()
    );
    assert_eq!(original, l);
    apply(
        &mut l,
        Operation::Move(p("tools"), Zone::Tab { group: 2, index: 1 }),
    );
    apply(
        &mut l,
        Operation::Move(
            p("tools"),
            Zone::Float {
                rect: Rect {
                    x: 10.,
                    y: 20.,
                    w: 320.,
                    h: 400.,
                },
            },
        ),
    );
    apply(
        &mut l,
        Operation::Move(p("tools"), Zone::StageTools { side: Side::Right }),
    );
    apply(
        &mut l,
        Operation::Move(
            p("stage"),
            Zone::Float {
                rect: Rect {
                    x: 10.,
                    y: 20.,
                    w: 600.,
                    h: 400.,
                },
            },
        ),
    );
    l.validate(Workspace::Animate).unwrap();
    assert_eq!(l.panels().len(), original.panels().len());
}
#[test]
fn middle_tab_returns_and_close_reopens() {
    let mut l = essentials(Workspace::Animate);
    apply(
        &mut l,
        Operation::Move(
            p("vfx"),
            Zone::Float {
                rect: Rect {
                    x: 20.,
                    y: 20.,
                    w: 320.,
                    h: 400.,
                },
            },
        ),
    );
    let id = l.floats[0].id;
    apply(&mut l, Operation::DockBack(id));
    assert_eq!(
        l.group_mut(2).unwrap().tabs,
        vec![p("properties"), p("vfx"), p("library")]
    );
    apply(&mut l, Operation::Close(p("vfx")));
    apply(&mut l, Operation::Reopen(p("vfx")));
    assert_eq!(l.group_mut(2).unwrap().tabs[1], p("vfx"));
}
#[test]
fn group_split_between_reorder_activate_resize_and_reset() {
    let mut l = essentials(Workspace::Animate);
    apply(
        &mut l,
        Operation::Move(p("library"), Zone::Between { split: 4, index: 1 }),
    );
    let id = l
        .groups()
        .iter()
        .find(|g| g.tabs.contains(&p("library")))
        .unwrap()
        .id;
    apply(
        &mut l,
        Operation::MoveGroup(id, Zone::Tab { group: 2, index: 0 }),
    );
    apply(&mut l, Operation::Reorder(2, 0, 2));
    apply(&mut l, Operation::Activate(2, 1));
    apply(
        &mut l,
        Operation::Resize {
            split: 4,
            index: 0,
            first: Sz::Flex(2.),
            second: Sz::Px(280.),
        },
    );
    apply(&mut l, Operation::ResetDivider { split: 4, index: 0 });
    apply(&mut l, Operation::NewStage);
    apply(&mut l, Operation::NewStage);
    apply(&mut l, Operation::NewStage);
    assert!(l.apply(Operation::NewStage, Workspace::Animate).is_err());
    apply(&mut l, Operation::Reset);
    assert_eq!(l, essentials(Workspace::Animate));
}
#[test]
fn tiers_folds_visibility_and_fitting_are_transient() {
    for (w, t) in [
        (1367., Tier::Wide),
        (1366., Tier::Regular),
        (1180., Tier::Narrow),
        (800., Tier::Compact),
        (660., Tier::Minimal),
    ] {
        assert_eq!(tier(w), t);
    }
    let l = essentials(Workspace::Animate);
    let copy = l.clone();
    for (w, h) in [
        (1440., 900.),
        (1180., 700.),
        (800., 600.),
        (660., 568.),
        (100., 100.),
    ] {
        let s = solve(&l, &Env::new(w, h));
        assert!(s.visible.contains(&p("stage")));
        for r in s.groups.values() {
            assert!(r.x >= 0. && r.y >= 0. && r.x + r.w <= w + 0.001 && r.y + r.h <= h + 0.001);
        }
        assert_eq!(s, solve(&l, &Env::new(w, h)));
    }
    assert_eq!(l, copy);
    let s = solve(&l, &Env::new(800., 700.));
    assert!(!s.visible.contains(&p("properties")));
    let mut e = Env::new(808., 700.);
    e.previous = s.fit;
    assert!(solve(&l, &e).fit.folded.contains_key(&2));
    e.window.w = 830.;
    assert!(!solve(&l, &e).fit.folded.contains_key(&2));
}
#[test]
fn preview_equals_committed_geometry_and_tools_target_wins() {
    let l = essentials(Workspace::Animate);
    let e = Env::new(1440., 900.);
    let z = Zone::Split {
        group: 1,
        side: Side::Left,
    };
    let (next, r) = preview(&l, &p("library"), z.clone(), &e, Workspace::Animate).unwrap();
    let mut actual = l.clone();
    apply(&mut actual, Operation::Move(p("library"), z));
    assert_eq!(next, actual);
    let gid = actual
        .groups()
        .iter()
        .find(|g| g.tabs.contains(&p("library")))
        .unwrap()
        .id;
    assert_eq!(r, solve(&actual, &e).groups[&gid]);
    let s = solve(&l, &e);
    let r = s.groups[&1];
    assert_eq!(
        drop_zone(&l, &p("tools"), &s, &e, r.x + 20., r.y + 100.),
        Zone::StageTools { side: Side::Left }
    );
}
#[test]
fn float_restore_is_non_destructive_across_monitor_setups() {
    let mut f = Frames {
        monitor: 2,
        relative: Rect {
            x: 0.1,
            y: 0.2,
            w: 0.3,
            h: 0.4,
        },
        by_setup: Default::default(),
    };
    f.remember(
        10,
        Rect {
            x: 2100.,
            y: 100.,
            w: 500.,
            h: 600.,
        },
    )
    .unwrap();
    let copy = f.clone();
    let mut e = Env::new(1440., 900.);
    e.setup = 10;
    e.screens = vec![
        Screen {
            key: 1,
            work: Rect {
                x: 0.,
                y: 0.,
                w: 1920.,
                h: 1080.,
            },
            scale: 1.,
            primary: true,
        },
        Screen {
            key: 2,
            work: Rect {
                x: 1920.,
                y: 0.,
                w: 1920.,
                h: 1080.,
            },
            scale: 2.,
            primary: false,
        },
    ];
    assert_eq!(fit_float(&f, &e).x, 2100.);
    e.setup = 11;
    e.screens.pop();
    assert!(fit_float(&f, &e).x < 1920.);
    assert_eq!(f, copy);
    for key in 0..12 {
        f.remember(
            key,
            Rect {
                x: 0.,
                y: 0.,
                w: 300.,
                h: 300.,
            },
        )
        .unwrap();
    }
    assert_eq!(f.by_setup.len(), 8);
}
#[test]
fn history_focus_and_monitor_arrangements_are_independent() {
    let l = essentials(Workspace::Animate);
    let mut state = LayoutState::new(l.clone());
    state.focus();
    for _ in 0..25 {
        let mut next = state.current.clone();
        next.layers_width += 1.;
        state.commit(next, Workspace::Animate).unwrap();
    }
    assert_eq!(state.history.len(), 20);
    state.focus();
    assert_eq!(state.current, l);
    state.switch_setup(1, 2);
    let mut next = state.current.clone();
    apply(&mut next, Operation::Collapse(2, true));
    state.commit(next.clone(), Workspace::Animate).unwrap();
    state.switch_setup(2, 1);
    assert_eq!(state.current, l);
    state.switch_setup(1, 2);
    assert_eq!(state.current, next);
    assert!(!state.undo());
}
#[test]
fn persistence_round_trip_unknown_fields_and_future_version() {
    let mut l = essentials(Workspace::Animate);
    l.unknown
        .insert("future".into(), styk_doc::Value::from("opaque"));
    apply(
        &mut l,
        Operation::Move(
            p("library"),
            Zone::Float {
                rect: Rect {
                    x: 1.,
                    y: 2.,
                    w: 320.,
                    h: 400.,
                },
            },
        ),
    );
    let bytes = store::encode(&l).unwrap();
    assert_eq!(store::decode(&bytes, Workspace::Animate).unwrap(), l);
    assert_eq!(
        store::decode(br#"{"version":4}"#, Workspace::Animate),
        Err(LayoutError::FutureVersion)
    );
    let repaired = store::repair(&styk_doc::Value::Null, Workspace::Animate);
    repaired.0.validate(Workspace::Animate).unwrap();
    assert_eq!(repaired.1.len(), 1);
}
#[test]
fn migration_distinguishes_build_and_draw_and_converts_float_units() {
    let v=styk_doc::json::parse(br#"{"modes":{"rig":{"preset":"build"},"draw":{"preset":"draw"},"animate":{"panels":[{"id":"vfx","dock":"float","rect":{"x":10,"y":20,"w":300,"h":400}},{"id":"future","dock":"left"}]}},"shared":{"sizes":{"right":350,"bottom":280}}}"#).unwrap();
    let g = store::MigrationGeometry {
        window: Size { w: 1440., h: 900. },
        stage: Rect {
            x: 40.,
            y: 60.,
            w: 1000.,
            h: 600.,
        },
        client_x: 100.,
        client_y: 200.,
        scale: 1.5,
        setup: 99,
    };
    let r = store::import_v2(&v, &g);
    assert!(r.warnings.is_empty(), "{:?}", r.warnings);
    assert!(r.layouts["rig"].closed.contains(&p("timeline")));
    assert!(!r.layouts["draw"].closed.contains(&p("timeline")));
    assert_eq!(r.layouts["animate"].floats[0].frames.by_setup[0].1.x, 175.);
    assert!(
        r.layouts["animate"]
            .unknown
            .contains_key("legacy-panel:future")
    );
}
#[test]
fn save_debounce_orders_and_retries() {
    let mut q = store::SaveQueue::default();
    q.changed(0, vec![1]).unwrap();
    q.changed(100, vec![2]).unwrap();
    assert_eq!(q.take_due(299), None);
    assert_eq!(q.take_due(300), Some(vec![2]));
    q.changed(400, vec![3]).unwrap();
    assert_eq!(q.take_due(600), None);
    q.complete(false, 700);
    assert_eq!(q.take_due(700), Some(vec![3]));
    q.complete(false, 800);
    assert_eq!(q.take_due(1000), Some(vec![3]));
}
#[test]
fn generated_operation_sequences_preserve_validity_and_round_trip() {
    let mut seed = 17u64;
    for _ in 0..10_000 {
        let mut l = essentials(Workspace::Animate);
        for _ in 0..50 {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            let p = p([
                "properties",
                "vfx",
                "library",
                "tools",
                "layers",
                "timeline",
                "stage",
            ][(seed >> 32) as usize % 7]);
            let groups = l.groups();
            let group = groups[(seed >> 40) as usize % groups.len()].id;
            let op = match seed % 8 {
                0 => Operation::Close(p.clone()),
                1 => Operation::Reopen(p.clone()),
                2 => Operation::Move(p.clone(), Zone::Tab { group, index: 0 }),
                3 => Operation::Move(
                    p.clone(),
                    Zone::Split {
                        group,
                        side: Side::Left,
                    },
                ),
                4 => Operation::Move(p.clone(), Zone::WindowEdge { side: Side::Bottom }),
                5 => Operation::Collapse(group, true),
                6 => Operation::Move(
                    p.clone(),
                    Zone::Float {
                        rect: Rect {
                            x: 20.,
                            y: 20.,
                            w: 300.,
                            h: 400.,
                        },
                    },
                ),
                _ => Operation::Move(p.clone(), Zone::StageTools { side: Side::Left }),
            };
            let old = l.clone();
            let result = l.apply(op, Workspace::Animate);
            if result.is_err() {
                assert_eq!(old, l)
            }
            l.validate(Workspace::Animate).unwrap();
            let a: std::collections::BTreeSet<_> = l.panels().into_iter().collect();
            let b: std::collections::BTreeSet<_> = old.panels().into_iter().collect();
            assert_eq!(a, b);
            let e = Env::new(700. + (seed % 800) as f64, 600.);
            let solution = solve(&l, &e);
            assert_eq!(solution, solve(&l, &e));
            let mut main_groups = vec![];
            if let Some(n) = &l.main {
                n.groups(&mut main_groups);
            }
            let rects: Vec<_> = main_groups
                .iter()
                .filter_map(|g| solution.groups.get(&g.id))
                .collect();
            for (i, a) in rects.iter().enumerate() {
                assert!(
                    a.x >= 0.
                        && a.y >= 0.
                        && a.w >= 0.
                        && a.h >= 0.
                        && a.x + a.w <= e.window.w + 0.001
                        && a.y + a.h <= e.window.h + 0.001
                );
                for b in &rects[i + 1..] {
                    let overlap = (a.x + a.w).min(b.x + b.w) - a.x.max(b.x) > 0.001
                        && (a.y + a.h).min(b.y + b.h) - a.y.max(b.y) > 0.001;
                    assert!(!overlap, "overlapping main groups");
                }
            }
        }
        let bytes = store::encode(&l).unwrap();
        assert_eq!(l, store::decode(&bytes, Workspace::Animate).unwrap());
    }
}

#[test]
fn reference_essentials_geometry_at_1440_900() {
    // Read-only source solver probe: src/shell/layout-solver.mjs, default Animate/Draw.
    let s = solve(&essentials(Workspace::Animate), &Env::new(1440., 900.));
    assert_eq!(
        s.groups[&1],
        Rect {
            x: 8.,
            y: 60.,
            w: 1096.,
            h: 562.
        }
    );
    assert_eq!(
        s.groups[&2],
        Rect {
            x: 1112.,
            y: 60.,
            w: 320.,
            h: 562.
        }
    );
    assert_eq!(
        s.groups[&3],
        Rect {
            x: 8.,
            y: 628.,
            w: 1424.,
            h: 264.
        }
    );
    assert_eq!(
        s.stages[&p("stage")],
        Rect {
            x: 8.,
            y: 104.,
            w: 1096.,
            h: 518.
        }
    );
}
#[test]
fn file_merge_tombstones_unknown_keys_and_roundtrip() {
    use store::{Entry, LayoutFile, Stamp};
    let mut a = LayoutFile::default();
    let mut b = LayoutFile::default();
    a.user.insert(
        "one".into(),
        Entry {
            stamp: Stamp {
                millis: 1,
                writer: "a".into(),
            },
            value: store::to_value(&essentials(Workspace::Animate)),
        },
    );
    b.user.insert(
        "two".into(),
        Entry {
            stamp: Stamp {
                millis: 2,
                writer: "b".into(),
            },
            value: store::to_value(&essentials(Workspace::Draw)),
        },
    );
    b.unknown
        .insert("future".into(), styk_doc::Value::from("keep"));
    let merged = a.merge(&b, 3);
    assert_eq!(merged.user.len(), 2);
    assert_eq!(
        LayoutFile::decode(&merged.encode().unwrap()).unwrap(),
        merged
    );
    b.tombstones.insert(
        "one".into(),
        Stamp {
            millis: 4,
            writer: "b".into(),
        },
    );
    let merged = merged.merge(&b, 4);
    assert!(!merged.user.contains_key("one"));
    assert!(merged.user.contains_key("two"));
}
#[test]
fn single_group_returns_to_its_original_anchor_and_allocation() {
    let mut l = essentials(Workspace::Animate);
    apply(
        &mut l,
        Operation::Move(
            p("library"),
            Zone::Split {
                group: 1,
                side: Side::Left,
            },
        ),
    );
    let gid = l
        .groups()
        .iter()
        .find(|g| g.tabs.contains(&p("library")))
        .unwrap()
        .id;
    apply(
        &mut l,
        Operation::Move(
            p("library"),
            Zone::Float {
                rect: Rect {
                    x: 50.,
                    y: 50.,
                    w: 320.,
                    h: 400.,
                },
            },
        ),
    );
    let fid = l.floats[0].id;
    apply(&mut l, Operation::DockBack(fid));
    assert_eq!(
        l.groups()
            .iter()
            .find(|g| g.tabs.contains(&p("library")))
            .unwrap()
            .id,
        gid
    );
}

#[test]
#[ignore = "release-only solver measurement; run through the machine queue"]
fn solver_measurement_40_groups() {
    let mut l = essentials(Workspace::Animate);
    let mut kids = vec![Kid {
        node: l.main.take().unwrap(),
        size: Sz::Flex(1.),
    }];
    for i in 0..37 {
        kids.push(Kid {
            node: tabs(100 + i, &[&format!("future-{i}")]),
            size: Sz::Flex(1.),
        });
    }
    l.main = Some(Node::Split {
        id: 200,
        axis: Axis::Horizontal,
        kids,
    });
    l.validate(Workspace::Animate).unwrap();
    let e = Env::new(4000., 2160.);
    let mut samples = vec![];
    for _ in 0..1000 {
        let start = std::time::Instant::now();
        std::hint::black_box(solve(std::hint::black_box(&l), std::hint::black_box(&e)));
        samples.push(start.elapsed().as_nanos());
    }
    samples.sort_unstable();
    println!(
        "layout.solve 40 groups: p50={} ns p99={} ns max={} ns",
        samples[500], samples[990], samples[999]
    );
    assert!(samples[500] <= 200_000, "design p50 0.2 ms");
    assert!(samples[990] <= 500_000, "design p99 0.5 ms");
}

#[test]
fn builtins_are_valid_and_preserve_every_panel() {
    for w in [Workspace::Animate, Workspace::Draw, Workspace::Rig] {
        for p in [
            Preset::Essentials,
            Preset::Animator,
            Preset::Drawing,
            Preset::LargeTimeline,
            Preset::Review,
        ] {
            if let Ok(l) = preset(w, p, 900.) {
                l.validate(w).unwrap();
                assert_eq!(l.panels().len(), 8);
                let s = solve(&l, &Env::new(1440., 900.));
                assert!(s.visible.contains(&PanelId::new("stage")));
            }
        }
    }
}

#[test]
fn drag_cancellation_leaves_the_owner_byte_equal() {
    let l = essentials(Workspace::Animate);
    let bytes = store::encode(&l).unwrap();
    let mut drag = DragSession::new(&l, p("library")).unwrap();
    drag.moved(&Env::new(1440., 900.), 40., 300., Workspace::Animate)
        .unwrap();
    assert!(drag.preview.is_some());
    drag.cancel();
    assert_eq!(store::encode(&l).unwrap(), bytes);
}

#[derive(Default)]
struct MemoryStorage(std::sync::Mutex<Option<Vec<u8>>>);
impl styk_services::storage::Storage for MemoryStorage {
    fn load<'a>(
        &'a self,
        _: &'a str,
        max: usize,
    ) -> styk_services::files::FileFuture<'a, Option<std::sync::Arc<[u8]>>> {
        Box::pin(async move {
            let guard = self.0.lock().unwrap();
            if guard.as_ref().is_some_and(|b| b.len() > max) {
                return Err(styk_services::files::FileError::TooLarge);
            }
            Ok(guard.as_ref().map(|b| std::sync::Arc::from(b.as_slice())))
        })
    }
    fn update<'a>(
        &'a self,
        _: &'a str,
        max: usize,
        update: styk_services::storage::Update,
    ) -> styk_services::files::FileFuture<'a, ()> {
        Box::pin(async move {
            let mut guard = self.0.lock().unwrap();
            let next = update(guard.as_deref()).map_err(styk_services::files::FileError::Io)?;
            if next.len() > max {
                return Err(styk_services::files::FileError::TooLarge);
            }
            *guard = Some(next);
            Ok(())
        })
    }
}
fn ready<F: std::future::Future>(f: F) -> F::Output {
    let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
    match std::pin::pin!(f).poll(&mut cx) {
        std::task::Poll::Ready(v) => v,
        _ => panic!("fake storage must complete immediately"),
    }
}
#[test]
fn storage_transaction_merges_writers_and_preserves_a_newer_file() {
    let storage = MemoryStorage::default();
    let mut a = store::LayoutFile::default();
    let mut b = a.clone();
    let l = essentials(Workspace::Animate);
    a.save_user(
        "a",
        "First",
        &[Workspace::Animate],
        &l,
        store::Stamp {
            millis: 1,
            writer: "a".into(),
        },
    )
    .unwrap();
    b.save_user(
        "b",
        "Second",
        &[Workspace::Animate],
        &l,
        store::Stamp {
            millis: 2,
            writer: "b".into(),
        },
    )
    .unwrap();
    ready(a.save(&storage, 3)).unwrap();
    ready(b.save(&storage, 3)).unwrap();
    let bytes = storage.0.lock().unwrap().clone().unwrap();
    assert_eq!(store::LayoutFile::decode(&bytes).unwrap().user.len(), 2);
    *storage.0.lock().unwrap() = Some(br#"{"version":4}"#.to_vec());
    assert!(ready(a.save(&storage, 3)).is_err());
    assert_eq!(
        storage.0.lock().unwrap().as_deref(),
        Some(br#"{"version":4}"#.as_slice())
    );
}

#[test]
fn resize_neighbours_clamps_and_keeps_the_stage_usable() {
    let mut l = essentials(Workspace::Animate);
    let e = Env::new(1440., 900.);
    let s = solve(&l, &e);
    l.resize_divider(&s, 4, 0, 10000., Workspace::Animate)
        .unwrap();
    let s = solve(&l, &e);
    assert!(s.groups[&2].w >= 256.);
    assert!(s.groups[&1].w >= 360.);
    let old = l.clone();
    assert!(
        l.resize_divider(&s, 4, 0, f64::NAN, Workspace::Animate)
            .is_err()
    );
    assert_eq!(old, l);
}

#[test]
fn named_layout_export_and_monitor_state_round_trip() {
    let l = essentials(Workspace::Animate);
    let bytes = store::export_named("My layout", &l).unwrap();
    let (name, restored, warnings) = store::import_named(&bytes, Workspace::Animate).unwrap();
    assert_eq!(name, "My layout");
    assert_eq!(restored, l);
    assert!(warnings.is_empty());
    let mut s = LayoutState::new(l);
    s.switch_setup(1, 2);
    let mut next = s.current.clone();
    apply(&mut next, Operation::Collapse(2, true));
    s.commit(next, Workspace::Animate).unwrap();
    s.switch_setup(2, 1);
    let v = store::state_to_value(&s);
    let restored = store::state_from_value(&v, Workspace::Animate).unwrap();
    assert_eq!(restored.current, s.current);
    assert_eq!(restored.setups, s.setups);
    assert!(restored.history.is_empty());
}
#[test]
fn import_numeric_groups_stacks_and_preserves_active_order() {
    let v=styk_doc::json::parse(br#"{"modes":{"animate":{"panels":[{"id":"library","dock":"right","group":1,"order":2},{"id":"vfx","dock":"right","group":0,"order":1},{"id":"properties","dock":"right","group":0,"order":0,"active":true}],"weights":{"right":[3,1]}}}}"#).unwrap();
    let g = store::MigrationGeometry {
        window: Size { w: 1440., h: 900. },
        stage: Rect {
            x: 8.,
            y: 60.,
            w: 1096.,
            h: 562.,
        },
        client_x: 0.,
        client_y: 0.,
        scale: 1.,
        setup: 1,
    };
    let r = store::import_v2(&v, &g);
    assert!(r.warnings.is_empty(), "{:?}", r.warnings);
    let l = &r.layouts["animate"];
    let inspector = l
        .groups()
        .into_iter()
        .find(|g| g.tabs.contains(&p("properties")))
        .unwrap();
    assert_eq!(inspector.tabs, vec![p("properties"), p("vfx")]);
    assert_eq!(inspector.tabs[inspector.active], p("properties"));
    let library = l
        .groups()
        .into_iter()
        .find(|g| g.tabs.contains(&p("library")))
        .unwrap();
    assert_ne!(inspector.id, library.id);
    let s = solve(l, &Env::new(1440., 900.));
    assert_eq!(s.groups[&inspector.id].x, s.groups[&library.id].x);
    assert!(s.groups[&library.id].y > s.groups[&inspector.id].y);
}
