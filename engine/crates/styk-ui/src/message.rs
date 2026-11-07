//! The interface's messages and the one place they reach the core.
//!
//! A view sends a [`Message`]; [`update`] hands its command to [`Core::dispatch`], asks the core to refresh its view
//! models, and turns the core's effects into iced tasks. A message that only changes widget state (focus moving to a
//! field's input after a click on its label) becomes a task here without reaching the core.

use iced::Task;
use iced::advanced::widget::operate;
use styk_core::app::Core;
use styk_core::commands::{Command, Effect};
use styk_core::inspector::property::PropertyKey;
use styk_design::widgets::focus;

#[derive(Clone, Debug, PartialEq)]
pub enum Message {
    /// A command for the core.
    Command(Command),
    /// Focus a number field's input (a click on its scrub label).
    FocusField(PropertyKey),
    /// Nothing to do (a widget reports a change the core does not need, such as a field gaining focus it already knows).
    Idle,
}

impl From<Command> for Message {
    fn from(command: Command) -> Message {
        Message::Command(command)
    }
}

/// Runs a message: the core decides, the interface carries out the effects.
pub fn update(core: &mut Core, message: Message) -> Task<Message> {
    match message {
        Message::Command(command) => {
            let effects = core.dispatch(command);
            core.refresh();
            Task::batch(effects.into_iter().map(effect))
        }
        Message::FocusField(key) => operate(focus::focus(crate::inspector::input_id(key))).discard(),
        Message::Idle => Task::none(),
    }
}

/// One effect as a task. Notices, frame requests and the colour picker belong to the shell, the stage and the picker
/// chunks: until they land they have no task here.
fn effect(effect: Effect) -> Task<Message> {
    match effect {
        Effect::Blur => operate(focus::unfocus()).discard(),
        Effect::Notice(_) | Effect::NotAvailable(_) | Effect::RequestFrame | Effect::PickColor(_) | Effect::ScrubHint(_) => Task::none(),
    }
}
