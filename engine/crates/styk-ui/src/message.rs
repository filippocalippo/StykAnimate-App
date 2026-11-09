//! The interface's messages and the one place they reach the core.
//!
//! A view sends a [`Message`]; [`update`] hands its command to [`Core::dispatch`], asks the core to refresh its view
//! models, and turns the core's effects into iced tasks. A message that only changes widget state (focus moving to a
//! field's input after a click on its label) becomes a task here without reaching the core.

#[cfg(feature = "engine")]
use iced::Task;
#[cfg(feature = "engine")]
use iced::advanced::widget::operate;
#[cfg(feature = "engine")]
use styk_core::app::Core;
use styk_core::commands::Command;
#[cfg(feature = "engine")]
use styk_core::commands::Effect;
#[cfg(feature = "engine")]
use styk_core::inspector::FocusRequest;
use styk_core::inspector::property::PropertyKey;
use styk_design::widgets::focus;

#[derive(Clone, Debug, PartialEq)]
pub enum Message {
    /// The core accepted the shared lifecycle barrier; the application can hand this to its shell owner.
    ShellReady(styk_core::shell::Event),
    PollDocuments,
    Dialog { id: u64, request: styk_core::commands::DialogRequest },
    QuitReady,
    SessionCheckpointFinished,
    Notice(styk_core::commands::Notice),
    /// A command for the core.
    Command(Command),
    /// Focus a number field's input (a click on its scrub label).
    FocusField(PropertyKey),
    /// A message, then focus on a target: a roving group that chose an item with an arrow key moves focus to it.
    Focusing(Box<Message>, styk_core::focus::FocusId),
    /// Nothing to do (a widget reports a change the core does not need, such as a field gaining focus it already knows).
    Idle,
    /// A key no widget took: the core's focus state may move focus (Tab, F6).
    Key(iced::Event),
    /// What a walk of the tree found of the focus targets, for the core's focus state.
    Snapshot(focus::Snapshot),
    /// An input method opened (true) or closed (false) a composition in the focused field: while one is open, Enter and
    /// Escape belong to the input method (`docs/native/text-input.md`).
    Compose(bool),
    /// A select's list should open (a press, or Space, Enter or Alt+Down on it). The window's overlay owner
    /// (`crate::overlays::Overlays`) opens the menu and, when an option is chosen, answers with that option's message.
    OpenSelect(Box<SelectRequest>),
    /// A menu row, key or press reached the overlay layer: the overlay owner decides.
    Overlay(styk_design::widgets::menu::Event),
    /// A stage message's action or close button, or the pointer on it.
    Toast(styk_design::widgets::toast::Event),
    /// A control with a tooltip: the pointer or keyboard focus reached it, or left it.
    Tooltip(styk_design::widgets::tooltip::TipEvent),
    OverlayEffect(styk_core::overlay::Effect),
    OverlayChoice { invoker: styk_core::focus::FocusId, index: usize },
    MessageDismissed(u64),
    ShortcutReleased(styk_core::shortcuts::Release),
    /// A command ran whose feature belongs to a later chunk: the window may say so.
    NotAvailable(styk_core::commands::CommandId),
}

/// A select asking for its list.
#[derive(Clone, Debug, PartialEq)]
pub struct SelectRequest {
    /// The select's focus target: focus returns to it when the list closes.
    pub invoker: styk_core::focus::FocusId,
    /// Where the select is, for placing the list.
    pub anchor: iced::Rectangle,
    /// A key asked (the ring shows in the list).
    pub keyboard: bool,
    /// Each option's words and whether it is disabled.
    pub options: Vec<(String, bool)>,
    pub chosen: Option<usize>,
    /// The message each option stands for, in the options' order.
    pub picks: Vec<Message>,
}

impl From<Command> for Message {
    fn from(command: Command) -> Message {
        Message::Command(command)
    }
}

/// Runs a message: the core decides, the interface carries out the effects.
#[cfg(feature = "engine")]
pub fn update(core: &mut Core, message: Message) -> Task<Message> {
    match message {
        Message::Command(command) => {
            let mut effects = core.dispatch(command);
            // The views the command changed are brought in line; their effects (the recovery offer's message, a dialog that closed) go with it.
            effects.extend(core.refresh());
            run(effects)
        }
        Message::Notice(notice) => run(core.show_notice(notice)),
        Message::FocusField(key) => operate(focus::focus(crate::inspector::input_id(key))).discard(),
        Message::Focusing(inner, id) => Task::batch([update(core, *inner), operate(focus::focus(id)).discard()]),
        Message::Idle | Message::ShellReady(_) => Task::none(),
        Message::Compose(composing) => {
            core.focus_mut().set_composing(composing);
            Task::none()
        }
        Message::Key(event) => {
            let task = match focus::navigate(core.focus_mut(), &event) { Some(id) => operate(focus::focus(id)).discard(), None => Task::none() };
            // Escape that no widget took belongs to the top overlay (a dialog, a popover), and ends a tooltip.
            let escape = matches!(&event, iced::Event::Keyboard(iced::keyboard::Event::KeyPressed { key: iced::keyboard::Key::Named(iced::keyboard::key::Named::Escape), .. }));
            let overlay_event = if escape { styk_core::overlay::host::Event::Escape } else { styk_core::overlay::host::Event::FocusChanged };
            Task::batch([task, overlay(core, overlay_event)])
        },
        Message::OpenSelect(request) => {
            let choices = request.picks.iter().map(|m| if let Message::Command(c) = m { Some(c.clone()) } else { None }).collect::<Vec<_>>();
            core.bind_select(request.invoker, choices);
            let event = styk_core::overlay::host::Event::Select { invoker: request.invoker, anchor: styk_design::widgets::menu::rect_of(request.anchor), options: request.options, chosen: request.chosen, keyboard: request.keyboard, press: core.overlays().press_sequence() };
            overlay(core, event)
        }
        Message::Overlay(event) => {
            use styk_design::widgets::menu::Event as View;
            use styk_core::overlay::host::Event;
            let event = match event {
                View::Key(k) => Event::Key { key: k.key, ctrl: k.ctrl, meta: k.meta, alt: k.alt },
                View::Hover { menu, index } => Event::Hover { menu, index },
                View::Press { menu, index } => Event::Press { menu, index },
                View::Leave { menu, row } => Event::Leave { menu, row },
                View::Pointer { press, inside, x, y } => Event::Pointer { pressed: press, inside, anchor: core.overlays().anchor_at(f64::from(x), f64::from(y)), press: core.overlays().press_sequence() },
            };
            overlay(core, event)
        }
        Message::Toast(event) => {
            use styk_design::widgets::toast::Event as View;
            use styk_core::overlay::host::Event;
            overlay(core, match event { View::Hover(h) => Event::MessageHover(h), View::Dismiss(id) => Event::MessageDismiss(id), View::Action { id, index } => Event::MessageAction { id, index } })
        }
        Message::Tooltip(event) => {
            use styk_design::widgets::tooltip::TipEvent as View;
            use styk_core::overlay::host::Event;
            overlay(core, match event { View::Show { target, content, touch, keyboard } => Event::TooltipShow { target, content, touch, keyboard }, View::Hide => Event::TooltipHide })
        }
        Message::Dialog { .. } | Message::PollDocuments | Message::QuitReady | Message::SessionCheckpointFinished | Message::ShortcutReleased(_) | Message::OverlayEffect(_) | Message::OverlayChoice { .. } | Message::MessageDismissed(_) | Message::NotAvailable(_) => Task::none(),
        Message::Snapshot(mut snapshot) => {
            for (scope, targets) in &mut snapshot.scopes {
                if *scope != styk_core::focus::ScopeId::ROOT { continue; }
                if !targets.iter().any(|target| core.dock().panel_of(target.id).is_some()) { continue; }
                for target in targets {
                    let bounds = snapshot.bounds.iter().find(|(id, _)| *id == target.id).map(|(_, b)| styk_core::layout::Rect { x: f64::from(b.x), y: f64::from(b.y), w: f64::from(b.width), h: f64::from(b.height) });
                    target.area = core.dock().focus_area(target.id, bounds, target.area);
                }
            }
            let synced = focus::sync(core.focus_mut(), &snapshot);
            let effects = core.dispatch(Command::Overlay { now: core.overlays().now(), event: styk_core::overlay::host::Event::Bounds(snapshot.bounds.iter().map(|(id, b)| (*id, styk_design::widgets::menu::rect_of(*b))).collect()) });
            Task::batch([Task::batch(effects.into_iter().map(effect)), match synced.unfocus {
                Some(_) => operate(focus::unfocus()).discard(),
                None => Task::none(),
            }])
        }
    }
}

/// The tasks of the effects the core answered with: the application hands the ones it takes from the core outside a message
/// (the documents host's effects, `Core::document_effect`) here too.
#[cfg(feature = "engine")]
pub fn run(effects: Vec<Effect>) -> Task<Message> {
    Task::batch(effects.into_iter().map(effect))
}

/// One effect as a task. Notices, frame requests and the colour picker belong to the shell, the stage and the picker
/// chunks: until they land they have no task here.
#[cfg(feature = "engine")]
pub fn effect(effect: Effect) -> Task<Message> {
    match effect {
        Effect::Dialog { id, request } => Task::done(Message::Dialog { id, request }),
        Effect::ShellReady(event) => Task::done(Message::ShellReady(event)),
        Effect::RequestFrame | Effect::PollDocuments => Task::done(Message::PollDocuments),
        Effect::QuitReady => Task::done(Message::QuitReady),
        Effect::SessionCheckpointFinished => Task::done(Message::SessionCheckpointFinished),
        Effect::Overlay(styk_core::overlay::Effect::Focus(id)) => match id { Some(id) => operate(focus::focus(id)).discard(), None => operate(focus::unfocus()).discard() },
        Effect::Overlay(effect) => Task::done(Message::OverlayEffect(effect)),
        Effect::OverlayChoice { invoker, index } => Task::done(Message::OverlayChoice { invoker, index }),
        Effect::ShortcutReleased(release) => Task::done(Message::ShortcutReleased(release)),
        Effect::MessageDismissed(id) => Task::done(Message::MessageDismissed(id)),
        Effect::Blur => operate(focus::unfocus()).discard(),
        Effect::FocusTarget(id) => operate(focus::focus(id)).discard(),
        Effect::Focus(request) => operate(focus::focus(match request {
            FocusRequest::Rename => crate::inspector::RENAME_ID,
            FocusRequest::TargetName => crate::inspector::TARGET_NAME_ID,
        }))
        .discard(),
        Effect::NotAvailable(id) => Task::done(Message::NotAvailable(id)),
        Effect::Notice(notice) => Task::done(Message::Notice(notice)),
        Effect::SettingsChanged(_) | Effect::PickColor(_) | Effect::ScrubHint(_) => Task::none(),
    }
}

#[cfg(feature = "engine")]
fn overlay(core: &mut Core, event: styk_core::overlay::host::Event) -> Task<Message> {
    let now = core.overlays().now();
    update(core, Message::Command(Command::Overlay { event, now }))
}

/// What the window does with a raw input the overlays care about, before the band sees it: a key no widget took while a
/// dialog or popover is open (Tab stays inside it, Escape asks its guard), and a button release, which ends the press the
/// overlays number (an opener pressed again is a new press). `None` leaves the event to the band.
#[cfg(feature = "engine")]
pub fn raw_at(core: &mut Core, event: &iced::Event, ignored: bool, now: u64) -> Option<Task<Message>> {
    match event {
        iced::Event::Keyboard(iced::keyboard::Event::KeyPressed { .. }) if ignored && core.overlays().top().is_some() => Some(update_at(core, Message::Key(event.clone()), now)),
        iced::Event::Mouse(iced::mouse::Event::ButtonReleased(_)) => {
            let release = Message::Overlay(styk_design::widgets::menu::Event::Pointer { press: false, inside: false, x: 0.0, y: 0.0 });
            Some(update_at(core, release, now))
        }
        _ => None,
    }
}

/// Only a keyboard event adapter: binding selection, exact modifiers and input gates belong to Shortcuts.
#[cfg(feature = "engine")]
pub fn dock_shortcut_at(core: &mut Core, event: &iced::Event, ignored: bool, now: u64) -> Option<Task<Message>> {
    use iced::keyboard::{Event, Key, key::{Named, Physical}};
    let iced::Event::Keyboard(Event::KeyPressed { key, physical_key, modifiers, repeat, .. }) = event else { return None };
    let code = match physical_key {
        Physical::Code(code) => format!("{code:?}"),
        // Synthetic/headless inputs have no hardware code. The spelling is adapted, never matched to a command here.
        Physical::Unidentified(_) => match key.as_ref() {
            Key::Named(Named::F6) => "F6".into(),
            Key::Character(c) if c.len() == 1 && c.as_bytes()[0].is_ascii_alphabetic() => format!("Key{}", c.to_uppercase()),
            Key::Character(c) if c.len() == 1 && c.as_bytes()[0].is_ascii_digit() => format!("Digit{c}"),
            _ => return None,
        },
    };
    let chord = styk_core::text_entry::Chord { key: code, ctrl: modifiers.control(), alt: modifiers.alt(), shift: modifiers.shift(), meta: modifiers.logo(), alt_graph: false };
    let timed = core.dispatch(Command::Overlay { event: styk_core::overlay::host::Event::Time, now });
    let effects = core.dock_shortcut(&chord, styk_core::shortcuts::Input { repeat: *repeat, prevented: !ignored, blocked_by_overlay: core.overlays().top().is_some(), ..Default::default() })?;
    Some(Task::batch(timed.into_iter().chain(effects).map(effect)))
}

/// Runtime entry: inject the application clock before routing an input. No view reads a clock.
#[cfg(feature = "engine")]
pub fn update_at(core: &mut Core, message: Message, now: u64) -> Task<Message> {
    let effects = core.dispatch(Command::Overlay { event: styk_core::overlay::host::Event::Time, now });
    Task::batch([Task::batch(effects.into_iter().map(effect)), update(core, message)])
}

/// Translate toolkit input only. Shortcut precedence, scopes and field/IME gates belong to Core's shared resolver.
#[cfg(feature = "engine")]
pub fn editor_key(event: &iced::Event, ignored: bool) -> Option<Message> {
    use iced::keyboard::{Event, Key, key::Physical};
    let key_name = |physical: &Physical, logical: &Key| match physical {
        Physical::Code(code) => format!("{code:?}"),
        Physical::Unidentified(_) => match logical { Key::Named(name) => format!("{name:?}"), Key::Character(c) if c.len() == 1 => format!("Key{}", c.to_uppercase()), _ => String::new() },
    };
    match event {
        iced::Event::Keyboard(Event::KeyPressed { key, physical_key, modifiers, repeat, .. }) => {
            let mut chord = styk_core::text_entry::Chord::new(&key_name(physical_key, key), modifiers.control(), modifiers.alt(), modifiers.shift());
            chord.meta = modifiers.logo();
            // Windows AltGr is reported as Ctrl+Alt on the physical right Alt key; the text widget retains its input.
            chord.alt_graph = matches!(key, Key::Named(iced::keyboard::key::Named::AltGraph));
            Some(Command::KeyPressed { chord, repeat: *repeat, prevented: !ignored }.into())
        }
        iced::Event::Keyboard(Event::KeyReleased { key, physical_key, .. }) => Some(Command::KeyReleased { key: key_name(physical_key, key), cancelled: false }.into()),
        iced::Event::Window(iced::window::Event::Unfocused) => Some(Command::Blur.into()),
        _ => None,
    }
}
