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
            let effects = core.dispatch(command);
            core.refresh();
            Task::batch(effects.into_iter().map(effect))
        }
        Message::FocusField(key) => operate(focus::focus(crate::inspector::input_id(key))).discard(),
        Message::Focusing(inner, id) => Task::batch([update(core, *inner), operate(focus::focus(id)).discard()]),
        Message::Idle => Task::none(),
        Message::Compose(composing) => {
            core.focus_mut().set_composing(composing);
            Task::none()
        }
        Message::Key(event) => match focus::navigate(core.focus_mut(), &event) {
            Some(id) => operate(focus::focus(id)).discard(),
            None => Task::none(),
        },
        Message::Snapshot(snapshot) => {
            let synced = focus::sync(core.focus_mut(), &snapshot);
            match synced.unfocus {
                Some(_) => operate(focus::unfocus()).discard(),
                None => Task::none(),
            }
        }
    }
}

/// One effect as a task. Notices, frame requests and the colour picker belong to the shell, the stage and the picker
/// chunks: until they land they have no task here.
#[cfg(feature = "engine")]
fn effect(effect: Effect) -> Task<Message> {
    match effect {
        Effect::Blur => operate(focus::unfocus()).discard(),
        Effect::Focus(request) => operate(focus::focus(match request {
            FocusRequest::Rename => crate::inspector::RENAME_ID,
            FocusRequest::TargetName => crate::inspector::TARGET_NAME_ID,
        }))
        .discard(),
        Effect::Notice(_) | Effect::NotAvailable(_) | Effect::RequestFrame | Effect::PickColor(_) | Effect::ScrubHint(_) => Task::none(),
    }
}
