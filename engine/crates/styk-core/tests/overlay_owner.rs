#![cfg(feature = "engine")]
use styk_core::{app::Core, commands::{Command, CommandId, Effect}, focus::{FocusArea, FocusId, FocusTarget, ScopeId, TargetKind}, overlay::{host::{Event, message_button_id}, menu::{Anchor, Entry, Item}, placement::Rect, messages::{Message, Tone, Action}}};
fn send(core: &mut Core, event: Event, now: u64) -> Vec<Effect> { core.dispatch(Command::Overlay { event, now }) }
#[test]
fn dispatch_owns_menu_commands_focus_choices_and_deadlines() {
    let mut core = Core::default();
    core.focus_mut().register(ScopeId::ROOT, vec![FocusTarget::new(7, FocusArea::Panels, TargetKind::Control)]);
    core.focus_mut().focus(FocusId(7));
    let effects = send(&mut core, Event::OpenMenu { entries: vec![Entry::Item(Item::new(CommandId::Menu, "Menu"))], anchor: Anchor::Root(Rect::default()), invoker: Some(FocusId(7)), keyboard: true }, 0);
    assert!(effects.contains(&Effect::Overlay(styk_core::overlay::Effect::ReleaseHeldKeys)));
    assert_eq!(core.overlay_deadline(), Some(16));
    let effects = send(&mut core, Event::Key { key: "Enter".into(), ctrl: false, meta: false, alt: false }, 10);
    assert!(effects.contains(&Effect::NotAvailable(CommandId::Menu)));
    assert_eq!(core.focus().focused(), Some(FocusId(7)));
    assert_eq!(core.overlay_deadline(), None);
    core.bind_select(FocusId(7), vec![Some(Command::Run(CommandId::Menu))]);
    send(&mut core, Event::Select { invoker: FocusId(7), anchor: Rect::default(), options: vec![("A".into(), false)], chosen: None, keyboard: true, press: 1 }, 20);
    let effects = send(&mut core, Event::Key { key: "Enter".into(), ctrl: false, meta: false, alt: false }, 30);
    assert!(effects.contains(&Effect::OverlayChoice { invoker: FocusId(7), index: 0 }));
    assert!(effects.contains(&Effect::NotAvailable(CommandId::Menu)));
}
#[test]
fn focus_owner_pauses_expiry_after_real_tab_navigation() {
    let mut core = Core::default();
    let target = message_button_id(1, 0);
    core.focus_mut().register(ScopeId::ROOT, vec![FocusTarget::new(7, FocusArea::Panels, TargetKind::Control), FocusTarget::new(target.0, FocusArea::Panels, TargetKind::Control)]);
    core.focus_mut().focus(FocusId(7));
    send(&mut core, Event::ShowMessage(Message::new(1, "m", Tone::Info, false, vec![Action { command: CommandId::Menu, label: "Menu".into(), dismiss: true }])), 0);
    assert_eq!(core.focus_mut().tab(true), Some(target));
    send(&mut core, Event::FocusChanged, 100);
    send(&mut core, Event::Tick, 9000);
    assert_eq!(core.overlays().messages().current().map(|m| m.id), Some(1));
    assert_eq!(core.overlay_deadline(), None);
    let effects = send(&mut core, Event::MessageAction { id: 1, index: 0 }, 9000);
    assert!(effects.contains(&Effect::MessageDismissed(1)));
    assert!(effects.contains(&Effect::NotAvailable(CommandId::Menu)));
}

#[test]
fn opening_a_menu_releases_the_shortcut_owners_held_key() {
    use styk_core::{shortcuts::{Input, Press, Scope}, text_entry::Chord, focus::FocusState};
    let mut core = Core::default();
    let press = core.shortcuts_mut().press(&FocusState::new(), &Chord::new("ArrowLeft", false, false, false), &[Scope::Canvas], Input::default(), |_| true);
    assert!(matches!(press, Press::Run(_)));
    assert_eq!(core.shortcuts_mut().held().len(), 1);
    let effects = send(&mut core, Event::OpenMenu { entries: vec![Entry::Item(Item::new(CommandId::Menu, "Menu"))], anchor: Anchor::Root(Rect::default()), invoker: None, keyboard: true }, 0);
    assert!(core.shortcuts_mut().held().is_empty());
    assert!(effects.iter().any(|effect| matches!(effect, Effect::ShortcutReleased(release) if release.cancelled)));
}
