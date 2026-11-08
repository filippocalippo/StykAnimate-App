//! What the recovery views show and say: plain data, no engine type (`docs/native/recovery.md`, "The views").
//!
//! The core builds these from the recovery host's view (`documents::recovery::View`) and the close prompt's effect; the
//! views in `styk-ui` draw them and send [`Event`]s. A label is a [`Label`], formatted by the window's `Presentation`.

use crate::focus::FocusId;
use crate::i18n::{Label, Msg};
use styk_services::recovery::{Record, Slot};

/// The close prompt's buttons.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Choice {
    /// Save, then close.
    Save,
    /// Close without saving (`Don't save`).
    Discard,
    /// Keep the project open.
    Cancel,
    /// Write the recovery copy again, then go on with the close.
    Retry,
}

/// What a recovery view can say. `Core::dispatch(Command::Recovery(event))` is where each lands.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    /// The offer's `Not now`: the offer is hidden.
    NotNow,
    /// The offer's `Manage copies`: the chooser opens.
    Manage,
    /// The offer's `Restore`: the one copy it names, or the chooser when several are offered.
    Restore,
    /// The chooser's select picked this copy.
    Pick(Slot),
    /// The chooser's `Restore`: the copy selected.
    RestoreChosen,
    /// The chooser's `Discard copy`: the copy selected is removed.
    DiscardChosen,
    /// The chooser's `Cancel`, its Escape: it closes.
    CancelChooser,
    /// A close prompt's button.
    Respond(Choice),
}

/// The focus targets of the two dialogs. They sit below the overlay rows' (`1 << 40` and up).
pub mod ids {
    use super::FocusId;
    const BASE: u64 = (1 << 39) + 0x100;
    /// The chooser's select.
    pub const SELECT: FocusId = FocusId(BASE);
    /// The chooser's close button.
    pub const CHOOSER_CLOSE: FocusId = FocusId(BASE + 8);
    /// The close prompt's close button.
    pub const PROMPT_CLOSE: FocusId = FocusId(BASE + 9);
    /// The chooser's `Cancel`.
    pub const CANCEL: FocusId = FocusId(BASE + 1);
    /// The chooser's `Discard copy`.
    pub const DISCARD: FocusId = FocusId(BASE + 2);
    /// The chooser's `Restore`.
    pub const RESTORE: FocusId = FocusId(BASE + 3);
    /// The close prompt's `Don't save`.
    pub const DONT_SAVE: FocusId = FocusId(BASE + 4);
    /// The close prompt's `Cancel`.
    pub const KEEP_EDITING: FocusId = FocusId(BASE + 5);
    /// The close prompt's `Retry`.
    pub const RETRY: FocusId = FocusId(BASE + 6);
    /// The close prompt's `Save`.
    pub const SAVE: FocusId = FocusId(BASE + 7);
}

/// The fixed words of the two dialogs and the offer (today's `appDialogs.*`, `app.*` and `common.*` keys).
pub mod words {
    use super::{Label, Msg};
    const fn key(key: &'static str) -> Label {
        Label::Msg(Msg::new(key))
    }
    pub const OFFER_TITLE: Label = key("app.restoreUnsavedWork");
    pub const NOT_NOW: Label = key("app.notNow");
    pub const MANAGE: Label = key("app.manageCopies");
    pub const RESTORE: Label = key("app.restore");
    pub const CHOOSER_TITLE: Label = key("appDialogs.restoreUnsavedWork");
    pub const FIELD: Label = key("appDialogs.recoveryCopy");
    pub const NOTE: Label = key("appDialogs.restoreOpensThisCopyAsAnEditedProject");
    pub const CANCEL: Label = key("common.cancel");
    pub const DISCARD_COPY: Label = key("appDialogs.discardCopy");
    pub const CHOOSER_RESTORE: Label = key("appDialogs.restore");
    pub const DONT_SAVE: Label = key("appDialogs.donTSave");
    pub const SAVE: Label = key("common.save");
    pub const RETRY: Label = key("common.retry");
    pub const UNTITLED: Label = key("app.untitled");
}

/// The recovery offer: the stage message that asks to restore unsaved work (`showRecovery`).
#[derive(Clone, Debug, PartialEq)]
pub struct Offer {
    /// `Restore unsaved work`.
    pub title: Label,
    /// `in {name} from {time}?`, or `{count} recovery copies are available.`
    pub text: Label,
    /// `Manage copies` shows when several copies are offered.
    pub manage: bool,
}

/// One copy in the chooser: `name · time` in today's select.
#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    /// The copy.
    pub slot: Slot,
    /// The project's name, or `Untitled`.
    pub name: Label,
    /// The time it was saved (`11/8/26, 2:03 PM`), empty when the stamp is unreadable.
    pub time: String,
    /// The copy's size in bytes (listed with it; today's select does not show it).
    pub size: usize,
}

impl Row {
    /// The option's words: `name · time`, with the name as the presentation writes it.
    pub fn text(&self, name: &str) -> String {
        format!("{name} \u{b7} {}", self.time)
    }
}

/// The chooser dialog (`chooseRecovery`).
#[derive(Clone, Debug, PartialEq)]
pub struct Chooser {
    /// The copies, newest first.
    pub rows: Vec<Row>,
    /// The select's value.
    pub selected: Option<usize>,
    /// A restore or a discard is running: the dialog's submit buttons are disabled.
    pub busy: bool,
    /// What the last restore or discard reported, under the body.
    pub error: Option<Label>,
}

/// The close prompt (`confirmReplace`, with the recovery copy's failure and its retry).
#[derive(Clone, Debug, PartialEq)]
pub struct Closing {
    /// `Save changes to {value}?`
    pub title: Label,
    /// `Your changes will be lost if you don't save.`
    pub body: Label,
    /// `Recovery copy could not be written: {message}` when the checkpoint before the close failed.
    pub warning: Option<Label>,
}

impl Closing {
    /// `Retry` shows only while the recovery copy's failure does.
    pub fn retry(&self) -> bool {
        self.warning.is_some()
    }
}

/// The offer for these copies (`None`: nothing to offer). `fallback` names a copy that has no name (the project in front);
/// `offset` is the person's UTC offset in minutes.
pub fn offer(copies: &[Record], fallback: &Label, offset: i32) -> Option<Offer> {
    let text = match copies {
        [] => return None,
        [copy] => {
            let name = if copy.name.is_empty() { fallback.clone() } else { Label::plain(copy.name.as_str()) };
            let time = super::when::clock(&copy.saved_at, offset).unwrap_or_default();
            Label::Msg(Msg::new("app.recoveryOffer").with("name", name).with("time", time))
        }
        many => Label::Msg(Msg::count("app.recoveryCopies", many.len() as f64)),
    };
    Some(Offer { title: words::OFFER_TITLE, text, manage: copies.len() > 1 })
}

/// The chooser for these copies.
pub fn chooser(copies: &[Record], selected: Option<&Slot>, busy: bool, error: Option<&str>, offset: i32) -> Chooser {
    let rows = copies
        .iter()
        .map(|copy| Row {
            slot: copy.slot.clone(),
            name: if copy.name.is_empty() { words::UNTITLED } else { Label::plain(copy.name.as_str()) },
            time: super::when::short(&copy.saved_at, offset).unwrap_or_default(),
            size: copy.size,
        })
        .collect::<Vec<_>>();
    let selected = selected.and_then(|slot| rows.iter().position(|row| row.slot == *slot));
    Chooser { rows, selected, busy, error: error.map(reported) }
}

/// What the host reported for a copy it could not use, in the words today's app gives each case (the host's view keeps the
/// error's name: `Changed`, `Owned`, `Missing`); anything else is shown as it was reported.
fn reported(error: &str) -> Label {
    match error {
        "Changed" => Label::key("errors.appDialogs.theRecoveryCopyChangedOrIsOpenIn"),
        "Owned" => Label::key("errors.app.thisRecoveryCopyIsOpenInAnotherTab"),
        "Missing" => Label::key("errors.app.theRecoveryFileIsNoLongerAvailable"),
        other => Label::plain(other),
    }
}

/// The close prompt for a project's name (several names for a quit, listed) and the recovery copy's failure, if any.
pub fn closing(names: &[String], recovery_error: Option<&str>) -> Closing {
    let value = match names {
        [] => words::UNTITLED,
        [one] if one.is_empty() => words::UNTITLED,
        many => Label::plain(many.join(", ")),
    };
    Closing {
        title: Label::Msg(Msg::new("appDialogs.saveChangesTo").with("value", value)),
        body: Label::key("appDialogs.yourChangesWillBeLostIfYouDon"),
        warning: recovery_error.map(|message| Label::Msg(Msg::new("app.recoveryCopyCouldNotBeWritten").with("message", message))),
    }
}

/// The offer as the stage's message (`showRecovery`): the clock glyph, no timeout, no dismiss button, `Not now`, `Manage copies`
/// (when several are offered) and `Restore`, each carrying its recovery event. `id` is the message's identity.
pub fn message(offer: &Offer, id: u64, presentation: &crate::i18n::Presentation) -> crate::overlay::messages::Message {
    use crate::overlay::messages::{Action, Do, Message, Priority, Tone};
    let say = |label: &Label| presentation.label(label);
    let mut actions = vec![Action { command: Do::Recovery(Event::NotNow), label: say(&words::NOT_NOW), dismiss: true, outline: false }];
    if offer.manage {
        actions.push(Action { command: Do::Recovery(Event::Manage), label: say(&words::MANAGE), dismiss: false, outline: false });
    }
    actions.push(Action { command: Do::Recovery(Event::Restore), label: say(&words::RESTORE), dismiss: false, outline: true });
    let mut message = Message::new(id, "recovery", Tone::Info, false, actions);
    message.priority = Priority::Recovery;
    message.title = say(&offer.title);
    message.text = say(&offer.text);
    message.icon = Some("clock".into());
    // The offer stays until the person answers it.
    message.timeout = 0;
    message.dismissible = false;
    message
}
