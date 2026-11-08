//! The recovery views: the chooser and the close prompt as dialogs (`docs/native/recovery.md`, "The views").
//!
//! The start-up offer is the stage's message (`styk_design::widgets::toast`, drawn by the overlay layer from the host's
//! message slot); this draws the two dialogs the overlay stack holds. A view shows a model the core built
//! (`styk_core::recovery::model`) and sends [`Event`]s through the owner's wires; it decides nothing: which copy is
//! selected, whether the buttons are busy, whether Retry shows and what an error says are the core's.

use iced::widget::{Column, container};
use iced::{Length, Size, Widget as _};
use std::rc::Rc;
use styk_core::focus::FocusArea;
use styk_core::i18n::{Label, Presentation};
use styk_core::recovery::model::{Chooser, Choice, Closing, Event, ids, words};
use styk_design::typography::TextStyle;
use styk_design::widgets::button::{Button, Variant};
use styk_design::widgets::control::words as text;
use styk_design::widgets::dialog::{Dialog, DialogSize, modal};
use styk_design::widgets::layer::Placed;
use styk_design::widgets::select::{Choice as Option_, Open, Select};
use styk_design::{Palette, tokens};

/// How a view's controls reach the owner: a message for what they say, and for a select asking for its list.
pub struct Wires<'a, Message> {
    /// The message that carries a recovery event.
    pub send: Rc<dyn Fn(Event) -> Message + 'a>,
    /// The message a press on the select sends: the owner opens the list at the field's rectangle.
    pub open: Rc<dyn Fn(Open) -> Message + 'a>,
}

impl<Message> Clone for Wires<'_, Message> {
    fn clone(&self) -> Self {
        Wires { send: self.send.clone(), open: self.open.clone() }
    }
}

/// The select's options and the message each arrow-key step sends (`Select::on_step`): the neighbouring copy.
fn options(presentation: &Presentation, model: &Chooser) -> Vec<Option_> {
    model.rows.iter().map(|row| Option_ { label: row.text(&presentation.label(&row.name)), disabled: false }).collect()
}

/// The options of the chooser's select as the owner needs them to open its list: the words of each row.
pub fn select_options(presentation: &Presentation, model: &Chooser) -> Vec<(String, bool)> {
    options(presentation, model).into_iter().map(|option| (option.label, option.disabled)).collect()
}

/// The chooser (`chooseRecovery`): a small dialog with the select of copies, a note, and Cancel, Discard copy and Restore.
pub fn chooser<'a, Message: Clone + 'a>(palette: &'static Palette, presentation: &Presentation, model: &Chooser, overlay: u64, window: Size, phase: f32, wires: &Wires<'a, Message>) -> Placed<'a, Message> {
    let say = |label: &Label| presentation.label(label);
    let rows: Vec<styk_core::services::recovery::Slot> = model.rows.iter().map(|row| row.slot.clone()).collect();
    let step = {
        let send = wires.send.clone();
        let selected = model.selected;
        move |delta: i32| {
            let at = selected.map_or(0, |at| (at as i32 + delta).clamp(0, rows.len().saturating_sub(1) as i32) as usize);
            send(rows.get(at).cloned().map_or(Event::CancelChooser, Event::Pick))
        }
    };
    let open = wires.open.clone();
    let select = Select::new(ids::SELECT, FocusArea::Panels, palette, options(presentation, model), model.selected, move |request| open(request), step).form(true).into_element();
    let field = Column::with_children(vec![text(say(&words::FIELD), TextStyle::from_role(&tokens::scale::TYPE_UI), palette.text_1), select]).spacing(tokens::scale::SPACE_1_5);
    let body = Column::with_children(vec![field.boxed(), text(say(&words::NOTE), TextStyle::from_role(&tokens::scale::TYPE_BODY), palette.text_2)]).spacing(tokens::scale::SPACE_3);
    let send = |event: Event| (wires.send)(event);
    let spec = Dialog {
        size: DialogSize::Sm,
        title: say(&words::CHOOSER_TITLE),
        description: None,
        body: body.boxed(),
        actions: vec![
            Button::new(ids::CANCEL, FocusArea::Panels, palette, say(&words::CANCEL), send(Event::CancelChooser)).variant(Variant::Ghost).into_element(),
            Button::new(ids::DISCARD, FocusArea::Panels, palette, say(&words::DISCARD_COPY), send(Event::DiscardChosen)).variant(Variant::Ghost).danger(true).disabled(model.busy).into_element(),
            Button::new(ids::RESTORE, FocusArea::Panels, palette, say(&words::CHOOSER_RESTORE), send(Event::RestoreChosen)).variant(Variant::Primary).disabled(model.busy).into_element(),
        ],
        meta: None,
        error: model.error.as_ref().map(say),
        close: Some((ids::CHOOSER_CLOSE, send(Event::CancelChooser))),
    };
    modal(palette, overlay, spec, window, phase)
}

/// The close prompt (`confirmReplace`): Don't save, Cancel and Save, and Retry beside them while the recovery copy's failure
/// shows under the body.
pub fn closing<'a, Message: Clone + 'a>(palette: &'static Palette, presentation: &Presentation, model: &Closing, overlay: u64, window: Size, phase: f32, wires: &Wires<'a, Message>) -> Placed<'a, Message> {
    let say = |label: &Label| presentation.label(label);
    let send = |choice: Choice| (wires.send)(Event::Respond(choice));
    let mut actions = vec![
        Button::new(ids::DONT_SAVE, FocusArea::Panels, palette, say(&words::DONT_SAVE), send(Choice::Discard)).variant(Variant::Ghost).danger(true).into_element(),
        Button::new(ids::KEEP_EDITING, FocusArea::Panels, palette, say(&words::CANCEL), send(Choice::Cancel)).variant(Variant::Ghost).into_element(),
    ];
    if model.retry() {
        actions.push(Button::new(ids::RETRY, FocusArea::Panels, palette, say(&words::RETRY), send(Choice::Retry)).variant(Variant::Ghost).into_element());
    }
    actions.push(Button::new(ids::SAVE, FocusArea::Panels, palette, say(&words::SAVE), send(Choice::Save)).variant(Variant::Primary).into_element());
    let body = container(text(say(&model.body), TextStyle::from_role(&tokens::scale::TYPE_BODY), palette.text_2)).width(Length::Fill);
    let spec = Dialog {
        size: DialogSize::Sm,
        title: say(&model.title),
        description: None,
        body: body.boxed(),
        actions,
        meta: None,
        error: model.warning.as_ref().map(say),
        close: Some((ids::PROMPT_CLOSE, send(Choice::Cancel))),
    };
    modal(palette, overlay, spec, window, phase)
}

/// The dialogs the window mounts over the page for the core's recovery state: the chooser and the close prompt, each in the
/// focus scope of the overlay the core opened for it, entering at the phase the host gives (`Host::phase`).
#[cfg(feature = "engine")]
pub fn owned<'a>(core: &styk_core::app::Core, palette: &'static Palette, window: Size) -> Vec<Placed<'a, crate::message::Message>> {
    use crate::message::{Message, SelectRequest};
    use styk_core::commands::Command;
    let presentation = core.presentation();
    let send: Rc<dyn Fn(Event) -> Message + 'a> = Rc::new(|event| Message::Command(Command::Recovery(event)));
    let mut placed = Vec::new();
    if let Some((overlay, model)) = core.recovery_chooser() {
        let picks: Vec<Message> = model.rows.iter().map(|row| Message::Command(Command::Recovery(Event::Pick(row.slot.clone())))).collect();
        let (list, chosen) = (select_options(presentation, &model), model.selected);
        let open: Rc<dyn Fn(Open) -> Message + 'a> = Rc::new(move |open| Message::OpenSelect(Box::new(SelectRequest { invoker: ids::SELECT, anchor: open.anchor, keyboard: open.keyboard, options: list.clone(), chosen, picks: picks.clone() })));
        placed.push(chooser(palette, presentation, &model, overlay, window, core.overlays().phase(overlay), &Wires { send: send.clone(), open }));
    }
    if let Some((overlay, model)) = core.recovery().closing() {
        // The close prompt has no select: its wires never open one.
        let open: Rc<dyn Fn(Open) -> Message + 'a> = Rc::new(|_| Message::Idle);
        placed.push(closing(palette, presentation, model, overlay, window, core.overlays().phase(overlay), &Wires { send, open }));
    }
    placed
}
