use super::*;
fn p(k: &str) -> PanelId {
    PanelId::new(k)
}
fn apply(l: &mut Layout, o: Operation) {
    l.apply(o, Workspace::Animate).unwrap();
}

#[test]
fn solver_places_the_tool_rail_on_the_visible_stage_and_removes_it_with_the_overlay() {
    for (w, h, compact) in [(1560., 1000., false), (1440., 900., false), (800., 800., true), (801., 800., false), (1440., 568., true), (1440., 569., false)] {
        let mut l = default_layout(Workspace::Animate, h).unwrap();
        for side in [Side::Left, Side::Right] {
            apply(&mut l, Operation::Move(p("tools"), Zone::StageTools { side }));
            let solution = solve(&l, &Env::new(w, h));
            let rail = solution.tool_rail.expect("the solver supplies the tools overlay rectangle");
            let stage = solution.stages[&p("stage")];
            assert_eq!((rail.w, rail.h), if compact { (44., 187.) } else { (52., 220.) });
            assert_eq!(if side == Side::Left { rail.x - stage.x } else { stage.x + stage.w - rail.x - rail.w }, 12.);
            assert_eq!(rail.y, (stage.y + (stage.h - rail.h) / 2.).round());
        }
        apply(&mut l, Operation::Move(p("tools"), Zone::Tab { group: 2, index: 0 }));
        assert_eq!(solve(&l, &Env::new(w, h)).tool_rail, None, "docked Tools has no stage overlay");
    }
    let mut l = default_layout(Workspace::Animate, 1000.).unwrap();
    let env = Env::new(1560., 1000.);
    assert_eq!(solve(&l, &env).tool_rail, Some(Rect { x: 20., y: 295., w: 52., h: 220. }), "today's measured placement");
    apply(&mut l, Operation::Move(p("vfx"), Zone::Tab { group: 1, index: 1 }));
    apply(&mut l, Operation::Activate(1, 1));
    assert_eq!(solve(&l, &env).tool_rail, None, "an inactive stage tab has no overlay");
    apply(&mut l, Operation::Activate(1, 0));
    assert!(solve(&l, &env).tool_rail.is_some(), "the overlay returns when the stage becomes visible");
    apply(&mut l, Operation::NewStage);
    let solution = solve(&l, &env);
    assert_eq!(solution.stages.len(), 2);
    assert_eq!(solution.tool_rail.unwrap().x, solution.stages[&p("stage")].x + 12., "the primary visible stage owns the rail");
    apply(&mut l, Operation::Activate(1, 1));
    let solution = solve(&l, &env);
    assert_eq!(solution.stages.len(), 1);
    assert_eq!(solution.tool_rail.unwrap().x, solution.stages[&PanelId { kind: "stage".into(), n: 1 }].x + 12., "a secondary visible stage can own the rail");
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
    let mut successes = [0usize; 20];
    let mut directions = [0usize; 4];
    let mut workspaces = [0usize; 3];
    let mut hosts = [0usize; 3];
    fn split_ids(n: &Node, out: &mut Vec<(u32, usize)>) {
        if let Node::Split { id, kids, .. } = n {
            for i in 0..kids.len() - 1 {
                out.push((*id, i));
            }
            for k in kids {
                split_ids(&k.node, out);
            }
        }
    }
    for sequence in 0..2400 {
        let wi = sequence % 3;
        let w = [Workspace::Animate, Workspace::Draw, Workspace::Rig][wi];
        let hi = (sequence / 3) % 3;
        let mut l = essentials(w);
        let mut e = Env::new(
            700. + (sequence % 800) as f64,
            560. + (sequence % 440) as f64,
        );
        e.float_host = [FloatHost::Os, FloatHost::InWindow, FloatHost::Sheet][hi];
        e.screens.push(Screen {
            key: 1,
            work: Rect {
                x: 0.,
                y: 0.,
                w: 3840.,
                h: 2160.,
            },
            scale: if sequence % 2 == 0 { 1. } else { 2. },
            primary: true,
        });
        // Every sequence exercises the review's behavioural failures, not just tree validity.
        l.apply(Operation::Activate(2, sequence % 3), w).unwrap();
        l.apply(Operation::Reorder(2, 0, 2), w).unwrap();
        let original = l.groups().into_iter().find(|g| g.id == 2).unwrap().clone();
        l.apply(Operation::MoveGroup(2, review_float()), w).unwrap();
        let gid = l.floats[0].root.id();
        let fid = l.floats[0].id;
        l.apply(Operation::Collapse(gid, true), w).unwrap();
        let saved = file_cycle(store::to_value(&l));
        l = store::from_value(&saved, w).unwrap();
        let fit = solve(&l, &e);
        assert!(!fit.visible.contains(&original.tabs[original.active]));
        l.apply(Operation::Collapse(gid, false), w).unwrap();
        l.apply(Operation::DockBack(fid), w).unwrap();
        let group = l.groups().into_iter().find(|g| g.id == 2).unwrap();
        assert_eq!(group.tabs, original.tabs);
        assert_eq!(group.active, original.active);
        for step in 0..48 {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            let panels = l.panels();
            let panel = panels[(seed >> 32) as usize % panels.len()].clone();
            let groups = l.groups();
            let group = groups[(seed >> 40) as usize % groups.len()];
            let id = group.id;
            let len = group.tabs.len();
            let di = (seed >> 48) as usize % 4;
            let side = [Side::Left, Side::Right, Side::Top, Side::Bottom][di];
            let mut splits = vec![];
            for n in l.main.iter().chain(l.floats.iter().map(|f| &f.root)) {
                split_ids(n, &mut splits);
            }
            let (split, index) = splits
                .get((seed >> 24) as usize % splits.len().max(1))
                .copied()
                .unwrap_or((0, 0));
            let kind = (step + sequence) % 20;
            let op = match kind {
                0 => Operation::Close(panel),
                1 => Operation::Reopen(l.closed.first().cloned().unwrap_or(panel)),
                2 => Operation::Move(
                    panel,
                    Zone::Tab {
                        group: id,
                        index: len / 2,
                    },
                ),
                3 => Operation::Move(panel, Zone::Split { group: id, side }),
                4 => Operation::Move(panel, Zone::WindowEdge { side }),
                5 => Operation::Collapse(id, !group.collapsed),
                6 => Operation::Move(panel, review_float()),
                7 => Operation::Move(
                    p("tools"),
                    Zone::StageTools {
                        side: if di.is_multiple_of(2) {
                            Side::Left
                        } else {
                            Side::Right
                        },
                    },
                ),
                8 => Operation::MoveGroup(id, review_float()),
                9 => Operation::DockBack(l.floats.first().map_or(0, |f| f.id)),
                10 => Operation::Move(panel, Zone::Between { split, index }),
                11 => Operation::Resize {
                    split,
                    index,
                    first: Sz::Flex(1. + di as f64),
                    second: Sz::Px(200. + di as f64 * 40.),
                },
                12 => Operation::ResetDivider { split, index },
                13 => Operation::Activate(id, (seed >> 8) as usize % len),
                14 => Operation::Reorder(id, 0, len - 1),
                15 => Operation::NewStage,
                16 => Operation::Move(
                    p("layers"),
                    Zone::Tab {
                        group: id,
                        index: 0,
                    },
                ),
                17 => Operation::JoinLayers,
                18 => Operation::Reset,
                _ => Operation::MoveGroup(
                    id,
                    Zone::Tab {
                        group: groups[0].id,
                        index: 0,
                    },
                ),
            };
            let old = l.clone();
            if l.apply(op, w).is_err() {
                assert_eq!(old, l);
            } else {
                successes[kind] += 1;
                workspaces[wi] += 1;
                hosts[hi] += 1;
                if kind == 3 || kind == 4 {
                    directions[di] += 1;
                }
            }
            l.validate(w).unwrap();
            if kind != 15 && kind != 18 {
                let a: std::collections::BTreeSet<_> = l.panels().into_iter().collect();
                let b: std::collections::BTreeSet<_> = old.panels().into_iter().collect();
                assert_eq!(a, b);
            }
            let solution = solve(&l, &e);
            assert_eq!(solution, solve(&l, &e));
            for group in l.groups() {
                if group.collapsed {
                    assert!(!solution.visible.contains(&group.tabs[group.active]));
                }
                let host = solution.hosts[&group.id];
                let bound = host.map_or(
                    Rect {
                        x: 0.,
                        y: 0.,
                        w: e.window.w,
                        h: e.window.h,
                    },
                    |id| solution.float_contents[&id],
                );
                for r in [
                    solution.groups.get(&group.id),
                    solution.headers.get(&group.id),
                    solution.strips.get(&group.id),
                    solution.sheets.get(&group.id),
                ]
                .into_iter()
                .flatten()
                {
                    assert!(
                        r.x >= 0.
                            && r.y >= 0.
                            && r.w >= 0.
                            && r.h >= 0.
                            && r.x + r.w <= bound.w + 0.001
                            && r.y + r.h <= bound.h + 0.001,
                        "out of host bounds {r:?} {bound:?}"
                    );
                }
            }
            let rects: Vec<_> = solution
                .groups
                .iter()
                .chain(&solution.strips)
                .chain(&solution.sheets)
                .collect();
            for (i, (id, a)) in rects.iter().enumerate() {
                for (other, b) in &rects[i + 1..] {
                    if solution.hosts[id] != solution.hosts[other] {
                        continue;
                    }
                    assert!(
                        !((a.x + a.w).min(b.x + b.w) - a.x.max(b.x) > 0.001
                            && (a.y + a.h).min(b.y + b.h) - a.y.max(b.y) > 0.001),
                        "overlapping host groups"
                    );
                }
            }
            if step % 8 == 7 {
                let saved = file_cycle(store::to_value(&l));
                assert_eq!(l, store::from_value(&saved, w).unwrap());
            }
        }
    }
    println!(
        "operation successes={successes:?}; directions={directions:?}; workspaces={workspaces:?}; hosts={hosts:?}"
    );
    // Fixed coverage obligations, not performance thresholds: every operation and direction must run often.
    assert!(successes.iter().all(|n| *n >= 100));
    assert!(directions.iter().all(|n| *n >= 100));
    assert!(workspaces.iter().all(|n| *n >= 100));
    assert!(hosts.iter().all(|n| *n >= 100));
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

use styk_services::storage::fake::MemoryStorage;

#[test]
fn save_queue_retry_doubles_caps_and_resets() {
    let mut queue = store::SaveQueue::default();
    queue.changed(0, vec![1]).unwrap();
    assert_eq!(queue.take_due(200), Some(vec![1]));
    let mut now = 200;
    for delay in [200, 400, 800, 1600, 3200, 6400, 10_000, 10_000] {
        queue.complete(false, now);
        assert_eq!(queue.take_due(now + delay - 1), None, "retry delay {delay}");
        now += delay;
        assert_eq!(queue.take_due(now), Some(vec![1]));
    }
    queue.complete(true, now);
    queue.changed(now, vec![2]).unwrap();
    now += 200;
    assert_eq!(queue.take_due(now), Some(vec![2]));
    queue.complete(false, now);
    assert_eq!(queue.take_due(now + 199), None);
    assert_eq!(queue.take_due(now + 200), Some(vec![2]));
    queue.complete(false, now + 200);
    queue.changed(now + 201, vec![3]).unwrap();
    assert_eq!(queue.take_due(now + 400), None);
    assert_eq!(queue.take_due(now + 401), Some(vec![3]));
    // An edit during an older write resets the backoff, even if that write fails.
    queue.changed(now + 402, vec![4]).unwrap();
    queue.complete(false, now + 403);
    assert_eq!(queue.take_due(now + 602), Some(vec![4]));
    queue.complete(false, now + 602);
    assert_eq!(queue.take_due(now + 801), None);
    assert_eq!(queue.take_due(now + 802), Some(vec![4]));
}

#[test]
fn save_queue_retry_saturates_deadlines_and_refused_edits_keep_pending_work() {
    let mut queue = store::SaveQueue::default();
    queue.changed(u64::MAX - 100, vec![1]).unwrap();
    assert_eq!(queue.take_due(u64::MAX - 1), None);
    assert_eq!(queue.take_due(u64::MAX), Some(vec![1]));
    queue.complete(false, u64::MAX);
    assert!(queue.changed(0, vec![0; store::MAX_BYTES + 1]).is_err());
    assert_eq!(queue.take_due(u64::MAX), Some(vec![1]));
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
    ready(a.save(&storage, 3, &styk_services::Cancel::new())).unwrap();
    ready(b.save(&storage, 3, &styk_services::Cancel::new())).unwrap();
    let bytes = storage.get("layouts.json").unwrap();
    assert_eq!(store::LayoutFile::decode(&bytes).unwrap().user.len(), 2);
    storage.put("layouts.json", br#"{"version":4}"#.to_vec());
    assert!(ready(a.save(&storage, 3, &styk_services::Cancel::new())).is_err());
    assert_eq!(
        storage.get("layouts.json").as_deref(),
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

fn future_payload() -> styk_doc::Value {
    styk_doc::json::parse(br#"{"z":[null,true,false,1.2345678901234567,{"nested":{"keep":"\\u0000 and unicode \u03bb","empty":[]}}],"a":{"future-node":{"id":4294967295,"tabs":"opaque"}}}"#).unwrap()
}
fn wire_mut<'a>(value: &'a mut styk_doc::Value, path: &[&str]) -> &'a mut styk_doc::Value {
    if path.is_empty() {
        return value;
    }
    let child = match value {
        styk_doc::Value::Obj(o) => std::sync::Arc::make_mut(o).get_mut(path[0]).unwrap(),
        styk_doc::Value::Arr(a) => {
            &mut std::sync::Arc::make_mut(a)[path[0].parse::<usize>().unwrap()]
        }
        _ => panic!("invalid test path"),
    };
    wire_mut(child, &path[1..])
}
fn add_future(value: &mut styk_doc::Value, path: &[&str]) {
    let styk_doc::Value::Obj(o) = wire_mut(value, path) else {
        panic!("expected record")
    };
    std::sync::Arc::make_mut(o).set("future", future_payload());
}
fn assert_future_bytes(value: &mut styk_doc::Value, path: &[&str]) {
    let actual = wire_mut(value, path)
        .get("future")
        .expect("unknown field was discarded");
    let mut expected_bytes = vec![];
    let mut actual_bytes = vec![];
    styk_doc::json::write(&future_payload(), &mut expected_bytes);
    styk_doc::json::write(actual, &mut actual_bytes);
    assert_eq!(
        actual_bytes, expected_bytes,
        "opaque values must remain byte-equal through the JSON codec"
    );
}
fn file_cycle(value: styk_doc::Value) -> styk_doc::Value {
    let mut file = store::LayoutFile::default();
    file.workspaces.insert(
        "animate".into(),
        store::Entry {
            stamp: store::Stamp {
                millis: 1,
                writer: "test".into(),
            },
            value,
        },
    );
    store::LayoutFile::decode(&file.encode().unwrap())
        .unwrap()
        .workspaces
        .remove("animate")
        .unwrap()
        .value
}
fn unknown_record_cycle(path: &[&str], op: Operation) {
    let mut original = essentials(Workspace::Animate);
    apply(
        &mut original,
        Operation::Move(
            p("library"),
            Zone::Float {
                rect: Rect {
                    x: 20.,
                    y: 30.,
                    w: 320.,
                    h: 400.,
                },
            },
        ),
    );
    let mut wire = store::to_value(&original);
    add_future(&mut wire, path);
    let mut loaded = store::from_value(&file_cycle(wire), Workspace::Animate).unwrap();
    let mut saved = file_cycle(store::to_value(&loaded));
    assert_future_bytes(&mut saved, path);
    let before = loaded.clone();
    apply(&mut loaded, op);
    assert_ne!(loaded, before, "the edit must change the annotated record");
    let mut saved = file_cycle(store::to_value(&loaded));
    assert_future_bytes(&mut saved, path);
    let reloaded = store::from_value(&saved, Workspace::Animate).unwrap();
    assert_eq!(loaded, reloaded);
}
#[test]
fn unknown_fields_split_survive_file_and_resize() {
    unknown_record_cycle(
        &["main"],
        Operation::Resize {
            split: 5,
            index: 0,
            first: Sz::Flex(2.),
            second: Sz::Px(280.),
        },
    );
}
#[test]
fn unknown_fields_tabs_survive_file_and_activation() {
    unknown_record_cycle(
        &["main", "kids", "0", "node", "kids", "1", "node"],
        Operation::Activate(2, 1),
    );
}
#[test]
fn unknown_fields_float_survive_file_and_frame_edit() {
    let mut l = essentials(Workspace::Animate);
    apply(
        &mut l,
        Operation::Move(
            p("library"),
            Zone::Float {
                rect: Rect {
                    x: 20.,
                    y: 30.,
                    w: 320.,
                    h: 400.,
                },
            },
        ),
    );
    let mut wire = store::to_value(&l);
    add_future(&mut wire, &["floats", "0"]);
    let mut l = store::from_value(&file_cycle(wire), Workspace::Animate).unwrap();
    let mut saved = file_cycle(store::to_value(&l));
    assert_future_bytes(&mut saved, &["floats", "0"]);
    let mut e = Env::new(1440., 900.);
    e.setup = 42;
    e.screens.push(Screen {
        key: 1,
        work: Rect {
            x: 0.,
            y: 0.,
            w: 1920.,
            h: 1080.,
        },
        scale: 1.,
        primary: true,
    });
    l.place_float(
        l.floats[0].id,
        Rect {
            x: 100.,
            y: 120.,
            w: 400.,
            h: 500.,
        },
        &e,
        Workspace::Animate,
    )
    .unwrap();
    let mut saved = file_cycle(store::to_value(&l));
    assert_future_bytes(&mut saved, &["floats", "0"]);
}
#[test]
fn unknown_fields_nested_node_survive_file_and_reorder() {
    let mut l = essentials(Workspace::Animate);
    apply(
        &mut l,
        Operation::Move(
            p("library"),
            Zone::Split {
                group: 2,
                side: Side::Bottom,
            },
        ),
    );
    let path = &[
        "main", "kids", "0", "node", "kids", "1", "node", "kids", "0", "node",
    ];
    let mut wire = store::to_value(&l);
    add_future(&mut wire, path);
    let mut loaded = store::from_value(&file_cycle(wire), Workspace::Animate).unwrap();
    let mut saved = file_cycle(store::to_value(&loaded));
    assert_future_bytes(&mut saved, path);
    apply(&mut loaded, Operation::Reorder(2, 0, 1));
    let mut saved = file_cycle(store::to_value(&loaded));
    assert_future_bytes(&mut saved, path);
}

#[test]
fn unknown_fields_all_nested_records_survive_typed_file_and_geometry_edits() {
    let mut l = essentials(Workspace::Animate);
    apply(
        &mut l,
        Operation::Move(
            p("library"),
            Zone::Float {
                rect: Rect {
                    x: 20.,
                    y: 30.,
                    w: 320.,
                    h: 400.,
                },
            },
        ),
    );
    apply(&mut l, Operation::Close(p("vfx")));
    let paths: &[&[&str]] = &[
        &["main"],
        &["main", "kids", "0"],
        &["main", "kids", "0", "size"],
        &["main", "kids", "0", "node"],
        &[
            "main", "kids", "0", "node", "kids", "1", "node", "tabs", "0",
        ],
        &["floats", "0"],
        &["floats", "0", "root"],
        &["floats", "0", "root", "tabs", "0"],
        &["floats", "0", "relative"],
        &["floats", "0", "setups", "0"],
        &["floats", "0", "setups", "0", "rect"],
        &["returns", "0"],
        &["returns", "0", "panel"],
        &["returns", "0", "hint"],
        &["returns", "0", "hint", "size"],
        &["closed", "0"],
        &["dormant", "0"],
    ];
    let mut value = store::to_value(&l);
    for path in paths {
        add_future(&mut value, path);
    }
    let mut l = store::from_value(&file_cycle(value), Workspace::Animate).unwrap();
    apply(
        &mut l,
        Operation::Resize {
            split: 4,
            index: 0,
            first: Sz::Flex(2.),
            second: Sz::Px(340.),
        },
    );
    let mut e = Env::new(1440., 900.);
    e.screens.push(Screen {
        key: 1,
        work: Rect {
            x: 0.,
            y: 0.,
            w: 1920.,
            h: 1080.,
        },
        scale: 1.,
        primary: true,
    });
    let id = l.floats[0].id;
    l.place_float(
        id,
        Rect {
            x: 100.,
            y: 120.,
            w: 400.,
            h: 500.,
        },
        &e,
        Workspace::Animate,
    )
    .unwrap();
    let mut saved = file_cycle(store::to_value(&l));
    for path in paths {
        assert_future_bytes(&mut saved, path);
    }
    let mut reloaded = store::from_value(&saved, Workspace::Animate).unwrap();
    assert_eq!(l, reloaded);
    apply(&mut reloaded, Operation::Reopen(p("vfx")));
    let mut saved = file_cycle(store::to_value(&reloaded));
    assert_future_bytes(
        &mut saved,
        &[
            "main", "kids", "0", "node", "kids", "1", "node", "tabs", "1",
        ],
    );
}
#[test]
fn unknown_fields_follow_node_ids_when_a_sibling_is_inserted_and_normalized() {
    let mut l = essentials(Workspace::Animate);
    let mut wire = store::to_value(&l);
    add_future(
        &mut wire,
        &["main", "kids", "0", "node", "kids", "1", "node"],
    );
    l = store::from_value(&file_cycle(wire), Workspace::Animate).unwrap();
    apply(
        &mut l,
        Operation::Move(p("library"), Zone::Between { split: 4, index: 0 }),
    );
    let mut saved = file_cycle(store::to_value(&l));
    assert_future_bytes(
        &mut saved,
        &["main", "kids", "0", "node", "kids", "2", "node"],
    );
    assert!(
        wire_mut(
            &mut saved,
            &["main", "kids", "0", "node", "kids", "0", "node"]
        )
        .get("future")
        .is_none()
    );
    // Moving another panel invokes normalization without changing the annotated group's identity.
    apply(
        &mut l,
        Operation::Move(p("library"), Zone::Tab { group: 2, index: 0 }),
    );
    let mut saved = file_cycle(store::to_value(&l));
    assert_future_bytes(
        &mut saved,
        &["main", "kids", "0", "node", "kids", "1", "node"],
    );
}
#[test]
fn unknown_fields_deleted_owners_do_not_contaminate_reused_slots() {
    let mut l = essentials(Workspace::Animate);
    apply(
        &mut l,
        Operation::Move(
            p("library"),
            Zone::Float {
                rect: Rect {
                    x: 20.,
                    y: 30.,
                    w: 320.,
                    h: 400.,
                },
            },
        ),
    );
    let mut wire = store::to_value(&l);
    add_future(&mut wire, &["floats", "0"]);
    add_future(&mut wire, &["floats", "0", "root"]);
    let mut l = store::from_value(&file_cycle(wire), Workspace::Animate).unwrap();
    // One operation removes the old host before allocating its replacement.
    let mut replaced = l.clone();
    apply(
        &mut replaced,
        Operation::Move(
            p("library"),
            Zone::Float {
                rect: Rect {
                    x: 50.,
                    y: 60.,
                    w: 320.,
                    h: 400.,
                },
            },
        ),
    );
    let mut saved = file_cycle(store::to_value(&replaced));
    assert!(
        wire_mut(&mut saved, &["floats", "0"])
            .get("future")
            .is_none()
    );
    assert!(
        wire_mut(&mut saved, &["floats", "0", "root"])
            .get("future")
            .is_none()
    );
    let id = l.floats[0].id;
    apply(&mut l, Operation::DockBack(id));
    apply(
        &mut l,
        Operation::Move(
            p("vfx"),
            Zone::Float {
                rect: Rect {
                    x: 20.,
                    y: 30.,
                    w: 320.,
                    h: 400.,
                },
            },
        ),
    );
    let mut saved = file_cycle(store::to_value(&l));
    assert!(
        wire_mut(&mut saved, &["floats", "0"])
            .get("future")
            .is_none()
    );
    assert!(
        wire_mut(&mut saved, &["floats", "0", "root"])
            .get("future")
            .is_none()
    );
    assert_eq!(l, store::from_value(&saved, Workspace::Animate).unwrap());
}

fn review_roundtrip(l: &Layout) -> Layout {
    store::from_value(&file_cycle(store::to_value(l)), Workspace::Animate).unwrap()
}
fn review_float() -> Zone {
    Zone::Float {
        rect: Rect {
            x: 100.,
            y: 100.,
            w: 640.,
            h: 480.,
        },
    }
}
#[test]
fn review_group_return_order_and_activation() {
    let mut l = essentials(Workspace::Animate);
    apply(&mut l, Operation::Activate(2, 1));
    let original = l.groups().into_iter().find(|g| g.id == 2).unwrap().clone();
    apply(&mut l, Operation::MoveGroup(2, review_float()));
    l = review_roundtrip(&l);
    assert!(
        solve(&l, &Env::new(1440., 900.))
            .visible
            .contains(&p("vfx"))
    );
    let id = l.floats[0].id;
    apply(&mut l, Operation::DockBack(id));
    l = review_roundtrip(&l);
    let g = l.groups().into_iter().find(|g| g.id == 2).unwrap();
    assert_eq!(g.tabs, original.tabs);
    assert_eq!(g.active, original.active);
    assert!(
        solve(&l, &Env::new(1440., 900.))
            .visible
            .contains(&p("vfx"))
    );
}
#[test]
fn review_workspace_extension_after_edit_solve_save() {
    let mut wire = store::state_to_value(&LayoutState::new(essentials(Workspace::Animate)));
    add_future(&mut wire, &[]);
    let mut state = store::state_from_value(&file_cycle(wire), Workspace::Animate).unwrap();
    let mut next = state.current.clone();
    apply(&mut next, Operation::Activate(2, 1));
    state.commit(next, Workspace::Animate).unwrap();
    assert!(
        solve(&state.current, &Env::new(1440., 900.))
            .visible
            .contains(&p("vfx"))
    );
    assert_future_bytes(&mut file_cycle(store::state_to_value(&state)), &[]);
}
#[test]
fn review_presented_panel_extensions_survive_save_and_return() {
    for kind in ["tools", "layers"] {
        let mut l = essentials(Workspace::Animate);
        apply(
            &mut l,
            Operation::Move(p(kind), Zone::Tab { group: 2, index: 0 }),
        );
        let mut wire = store::to_value(&l);
        let path = &[
            "main", "kids", "0", "node", "kids", "1", "node", "tabs", "0",
        ];
        add_future(&mut wire, path);
        l = store::from_value(&file_cycle(wire), Workspace::Animate).unwrap();
        let op = if kind == "tools" {
            Operation::Move(p(kind), Zone::StageTools { side: Side::Right })
        } else {
            Operation::JoinLayers
        };
        apply(&mut l, op);
        assert!(solve(&l, &Env::new(1440., 900.)).visible.contains(&p(kind)));
        l = review_roundtrip(&l);
        apply(
            &mut l,
            Operation::Move(p(kind), Zone::Tab { group: 2, index: 0 }),
        );
        assert!(solve(&l, &Env::new(1440., 900.)).visible.contains(&p(kind)));
        assert_future_bytes(&mut file_cycle(store::to_value(&l)), path);
    }
}
#[test]
fn review_float_collapse_hides_body_and_preserves_frame() {
    let mut l = essentials(Workspace::Animate);
    apply(&mut l, Operation::MoveGroup(2, review_float()));
    let gid = l.floats[0].root.id();
    let frames = l.floats[0].frames.clone();
    apply(&mut l, Operation::Collapse(gid, true));
    l = review_roundtrip(&l);
    let s = solve(&l, &Env::new(1440., 900.));
    assert!(!s.visible.contains(&p("properties")));
    assert!(s.headers[&gid].h <= 44.);
    assert_eq!(s.floats[&l.floats[0].id].h, 44.);
    assert_eq!(l.floats[0].frames, frames);
    apply(&mut l, Operation::Collapse(gid, false));
    let s = solve(&review_roundtrip(&l), &Env::new(1440., 900.));
    assert!(s.visible.contains(&p("properties")));
    assert_eq!(s.floats[&l.floats[0].id].h, 480.);
}
#[test]
fn review_float_host_local_logical_geometry_at_two_scales() {
    for scale in [1., 2.] {
        let mut l = essentials(Workspace::Animate);
        apply(
            &mut l,
            Operation::MoveGroup(
                2,
                Zone::Float {
                    rect: Rect {
                        x: 2000.,
                        y: 100.,
                        w: 640. * scale,
                        h: 480. * scale,
                    },
                },
            ),
        );
        l = review_roundtrip(&l);
        let mut e = Env::new(1440., 900.);
        e.screens.push(Screen {
            key: 7,
            work: Rect {
                x: 1920.,
                y: 0.,
                w: 2560.,
                h: 1440.,
            },
            scale,
            primary: true,
        });
        let s = solve(&l, &e);
        let gid = l.floats[0].root.id();
        assert_eq!(
            s.groups[&gid],
            Rect {
                x: 0.,
                y: 0.,
                w: 640.,
                h: 480.
            }
        );
        assert_eq!(s.headers[&gid].h, 40.);
        assert_eq!(s.floats[&l.floats[0].id].x, 2000.);
        assert!(
            !matches!(drop_zone(&l,&p("tools"),&s,&e,320.,20.),Zone::Tab{group,..} if group==gid)
        );
        e.hit_host = Some(l.floats[0].id);
        assert!(
            matches!(drop_zone(&l,&p("tools"),&s,&e,320.,20.),Zone::Tab{group,..} if group==gid)
        );
    }
}
#[test]
fn review_fold_hysteresis_survives_intermediate_sizes() {
    let l = review_roundtrip(&essentials(Workspace::Animate));
    for (sizes, vertical, id) in [
        (vec![800., 808., 810., 816.], false, 2),
        (vec![568., 576., 578., 584.], true, 3),
    ] {
        let mut previous = FitState::default();
        for (i, size) in sizes.into_iter().enumerate() {
            let mut e = if vertical {
                Env::new(1440., size)
            } else {
                Env::new(size, 900.)
            };
            e.previous = previous;
            let s = solve(&l, &e);
            assert_eq!(
                s.fit.folded.contains_key(&id),
                i < 3,
                "axis {vertical} size {size}"
            );
            previous = s.fit;
        }
    }
}
#[test]
fn review_migration_left_width_and_stack_weights() {
    let v=styk_doc::json::parse(br#"{"modes":{"animate":{"panels":[{"id":"library","dock":"left","group":0},{"id":"vfx","dock":"left","group":1}],"weights":{"left":[2,3]}}},"shared":{"sizes":{"left":400,"right":280,"bottom":264}}}"#).unwrap();
    let geo = store::MigrationGeometry {
        window: Size { w: 1800., h: 1000. },
        stage: Rect {
            x: 0.,
            y: 0.,
            w: 1000.,
            h: 700.,
        },
        client_x: 0.,
        client_y: 0.,
        scale: 1.,
        setup: 0,
    };
    let imported = store::import_v2(&v, &geo);
    let l = review_roundtrip(&imported.layouts["animate"]);
    let s = solve(&l, &Env::new(1800., 1000.));
    let gid = |kind| {
        l.groups()
            .into_iter()
            .find(|g| g.tabs.contains(&p(kind)))
            .unwrap()
            .id
    };
    assert_eq!(s.groups[&gid("library")].w, 400.);
    assert_eq!(s.groups[&gid("vfx")].w, 400.);
    assert_eq!(s.groups[&gid("properties")].w, 280.);
    fn weights(n: &Node) -> bool {
        match n {
            Node::Split {
                axis: Axis::Vertical,
                kids,
                ..
            } if kids.len() == 2
                && matches!(kids[0].size, Sz::Flex(2.))
                && matches!(kids[1].size, Sz::Flex(3.)) =>
            {
                true
            }
            Node::Split { kids, .. } => kids.iter().any(|k| weights(&k.node)),
            _ => false,
        }
    }
    assert!(weights(l.main.as_ref().unwrap()));
}

#[test]
fn review_storage_cancel_before_commit_preserves_existing_save() {
    let storage = MemoryStorage::default();
    let mut file = store::LayoutFile::default();
    let mut l = essentials(Workspace::Animate);
    apply(&mut l, Operation::Activate(2, 1));
    assert!(
        solve(&l, &Env::new(1440., 900.))
            .visible
            .contains(&p("vfx"))
    );
    file.save_user(
        "a",
        "test",
        &[Workspace::Animate],
        &l,
        store::Stamp {
            millis: 1,
            writer: "test".into(),
        },
    )
    .unwrap();
    ready(file.save(&storage, 1, &styk_services::Cancel::new())).unwrap();
    let before = storage.get("layouts.json");
    let cancel = styk_services::Cancel::new();
    cancel.cancel();
    assert!(ready(file.save(&storage, 2, &cancel)).is_err());
    assert_eq!(storage.get("layouts.json"), before);
}
#[test]
fn review_shortfall_work_is_bounded_by_nodes_and_depth() {
    let mut l = essentials(Workspace::Animate);
    let mut kids = vec![Kid {
        node: l.main.take().unwrap(),
        size: Sz::Flex(1.),
    }];
    for i in 0..1024 {
        kids.push(Kid {
            node: tabs(100 + i, &[&format!("future-{i}")]),
            size: Sz::Flex(1.),
        });
    }
    l.main = Some(Node::Split {
        id: 3000,
        axis: Axis::Horizontal,
        kids,
    });
    apply(&mut l, Operation::Activate(2, 1));
    l = review_roundtrip(&l);
    super::solve::WORK.with(|c| c.set(0));
    let solution = solve(&l, &Env::new(900., 900.));
    assert!(solution.fit.folded.len() >= 1024);
    let visits = super::solve::WORK.with(|c| c.get());
    assert!(
        visits <= 3 * 129 * 1030,
        "{visits} summary visits exceeded three updates per ancestor at the codec's 128-level depth bound"
    );
}

fn shortfall_layout(extra: u32) -> Layout {
    let mut l = essentials(Workspace::Animate);
    let mut kids = vec![Kid {
        node: l.main.take().unwrap(),
        size: Sz::Flex(1.),
    }];
    for i in 0..extra {
        kids.push(Kid {
            node: tabs(100 + i, &[&format!("future-{i}")]),
            size: Sz::Flex(1.),
        });
    }
    l.main = Some(Node::Split {
        id: 100 + extra,
        axis: Axis::Horizontal,
        kids,
    });
    apply(&mut l, Operation::Activate(2, 1));
    l
}
#[test]
#[ignore = "release shortfall measurement through the machine queue"]
fn solver_measurement_shortfall() {
    // No group-count cap is introduced. Find the largest member of this wide-tree family that
    // fits the existing 256 KiB persistence bound, as well as the design's 40-group budget case.
    fn file_bytes(l: &Layout) -> Result<Vec<u8>, LayoutError> {
        let mut file = store::LayoutFile::default();
        file.workspaces.insert(
            "animate".into(),
            store::Entry {
                stamp: store::Stamp {
                    millis: 1,
                    writer: "test".into(),
                },
                value: store::to_value(l),
            },
        );
        file.encode()
    }
    let mut low = 37;
    let mut high = 10000;
    while low + 1 < high {
        let mid = (low + high) / 2;
        if file_bytes(&shortfall_layout(mid)).is_ok() {
            low = mid;
        } else {
            high = mid;
        }
    }
    for extra in [37, low] {
        let l = review_roundtrip(&shortfall_layout(extra));
        let e = Env::new(801., 600.);
        let result = solve(&l, &e);
        assert!(result.fit.folded.len() >= extra as usize);
        let bytes = file_bytes(&l).unwrap();
        let mut samples = vec![];
        for _ in 0..1000 {
            let start = std::time::Instant::now();
            std::hint::black_box(solve(std::hint::black_box(&l), std::hint::black_box(&e)));
            samples.push(start.elapsed().as_nanos());
        }
        samples.sort_unstable();
        println!(
            "layout.shortfall groups={} bytes={} folded={} p50={} ns p99={} ns max={} ns",
            extra + 3,
            bytes.len(),
            result.fit.folded.len(),
            samples[500],
            samples[990],
            samples[999]
        );
        if extra == 37 {
            assert!(samples[500] <= 200_000, "design p50 0.2 ms");
            assert!(samples[990] <= 500_000, "design p99 0.5 ms");
        }
    }
}

#[test]
fn review_storage_failures_and_dropped_save_clean_staging() {
    use std::{
        future::Future,
        task::{Context, Waker},
    };
    use styk_services::storage::fake::Failure;
    let storage = MemoryStorage::default();
    let mut file = store::LayoutFile::default();
    let mut l = essentials(Workspace::Animate);
    apply(&mut l, Operation::Activate(2, 1));
    assert!(
        solve(&l, &Env::new(1440., 900.))
            .visible
            .contains(&p("vfx"))
    );
    file.save_user(
        "a",
        "old",
        &[Workspace::Animate],
        &l,
        store::Stamp {
            millis: 1,
            writer: "test".into(),
        },
    )
    .unwrap();
    ready(file.save(&storage, 1, &styk_services::Cancel::new())).unwrap();
    let before = storage.get("layouts.json").unwrap();
    apply(&mut l, Operation::Reorder(2, 0, 2));
    file.save_user(
        "a",
        "new",
        &[Workspace::Animate],
        &l,
        store::Stamp {
            millis: 2,
            writer: "test".into(),
        },
    )
    .unwrap();
    for failure in [
        Failure::Stage,
        Failure::CancelBeforeCommit,
        Failure::PauseBeforeCommit,
    ] {
        storage.fail(failure);
        let cancel = styk_services::Cancel::new();
        let mut save = Box::pin(file.save(&storage, 2, &cancel));
        let result = save.as_mut().poll(&mut Context::from_waker(Waker::noop()));
        if failure == Failure::PauseBeforeCommit {
            assert!(result.is_pending());
            assert!(storage.staged());
        } else {
            assert!(matches!(result, std::task::Poll::Ready(Err(_))));
        }
        drop(save);
        assert!(!storage.staged());
        assert_eq!(storage.get("layouts.json").unwrap(), before);
    }
    storage.fail(Failure::None);
    ready(file.save(&storage, 2, &styk_services::Cancel::new())).unwrap();
    assert_ne!(storage.get("layouts.json").unwrap(), before);
}
