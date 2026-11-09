#![cfg(feature = "devtools")]
use styk_core::{
    app::Core,
    commands::{Command, CommandId, Effect},
    dev_extension::{Event, Panel, Value},
};
#[test]
fn typed_payloads_pass_dispatch_unchanged() {
    let mut core = Core::default();
    for event in [
        Event::Set {
            name: "capture.cap_mb".into(),
            value: Value::Integer(32),
        },
        Event::Reset("capture.cap_mb".into()),
        Event::ChannelSet {
            name: "capture.cap_mb".into(),
            value: Value::Integer(64),
        },
        Event::LoadProfile("small".into()),
        Event::SaveProfile("small".into()),
        Event::Poll,
        Event::Input(None),
        Event::Tick(250),
    ] {
        assert_eq!(
            core.dispatch(Command::Developer(event.clone())),
            vec![Effect::Developer(event)]
        );
    }
}
#[test]
fn panels_use_dock_history_and_overlay_is_not_a_panel() {
    let mut core = Core::default();
    let before = core.dock().layout().clone();
    core.dispatch(Command::Run(CommandId::DevProfiler));
    assert!(
        core.dock()
            .layout()
            .groups()
            .iter()
            .any(|g| g.tabs.iter().any(|p| p.kind == Panel::Profiler.id()))
    );
    core.dispatch(Command::Run(CommandId::LayoutUndo));
    // Revealing an already active tab must not create another history entry.
    assert_eq!(core.dock().layout(), &before);
    assert_eq!(
        core.dispatch(Command::Run(CommandId::DevOverlay)),
        vec![Effect::Developer(Event::ToggleOverlay)]
    );
    assert_eq!(core.dock().layout(), &before);
    assert!(styk_core::layout::spec("dev.overlay").is_none());
}
#[test]
fn developer_catalogue_and_registry_are_complete() {
    let ids: Vec<_> = CommandId::ALL
        .iter()
        .filter(|id| id.id().starts_with("dev."))
        .collect();
    assert_eq!(ids.len(), 13);
    for id in ids {
        assert!(styk_core::dev_extension::catalogue(id.info().label).is_some());
        assert_eq!(CommandId::from_id(id.id()), Some(*id));
    }
    let launch = styk_core::Launch::parse([
        "--param",
        "capture.cap_mb=64",
        "--params",
        "first.json",
        "--param=capture.cap_mb=32",
        "--params=second.json",
    ])
    .unwrap();
    assert_eq!(launch.param, ["capture.cap_mb=64", "capture.cap_mb=32"]);
    assert_eq!(launch.params.len(), 2);
}
