//! Registry file commands and native picker continuations. The documents host owns every file operation.
use crate::{commands::CommandId, documents::{DocumentId, Documents, PromptId, Request}, i18n::Msg};
use styk_services::dialogs::{Choice, Request as Dialog};

pub fn request(id: CommandId, documents: &Documents) -> Option<Request> {
    Some(match id {
        CommandId::Open => Request::OpenDialog,
        CommandId::New => Request::New,
        CommandId::Save | CommandId::SaveAs => Request::Save { document: documents.active()?.id(), save_as: id == CommandId::SaveAs },
        CommandId::SaveAll => Request::SaveAll,
        CommandId::CloseProject => Request::Close(documents.active()?.id()),
        CommandId::CloseSavedProjects => Request::CloseSaved,
        _ => return None,
    })
}

enum Pending { Open, Save(PromptId), Color(Color) }
struct Color {
    valid: bool, document: DocumentId, lineage: u64, revision: u64, tick: f64,
    selection: crate::engine::Selection, target: crate::inspector::model::ColorTarget,
}
#[derive(Default)]
pub struct Pickers { serial: u64, pending: Option<(u64, Pending)> }
pub enum Answer { Document(Request), Color(crate::inspector::model::ColorTarget, [u8; 3]), None }
impl Pickers {
    pub fn pending(&self) -> bool { self.pending.is_some() }
    fn begin(&mut self, pending: Pending, request: Dialog) -> Option<(u64, Dialog)> {
        if self.pending.is_some() { return None; }
        self.serial = self.serial.wrapping_add(1); self.pending = Some((self.serial, pending)); Some((self.serial, request))
    }
    pub fn open(&mut self, title: String) -> Option<(u64, Dialog)> { self.begin(Pending::Open, Dialog::Open { title }) }
    pub fn save(&mut self, prompt: PromptId, title: String, name: String) -> Option<(u64, Dialog)> { self.begin(Pending::Save(prompt), Dialog::Save { title, name }) }
    pub fn color(&mut self, documents: &Documents, target: crate::inspector::model::ColorTarget, initial: [u8; 3]) -> Option<(u64, Dialog)> {
        let doc = documents.active()?; let view = doc.view().ok()?;
        self.begin(Pending::Color(Color { valid: true, document: doc.id(), lineage: doc.lineage(), revision: doc.revision(), tick: view.tick, selection: view.selection.clone(), target }), Dialog::Color { initial })
    }
    /// Every new editor intent invalidates a pending colour by event, including an A-B-A switch.
    pub fn invalidate_color(&mut self) { if let Some((_, Pending::Color(color))) = &mut self.pending { color.valid = false; } }
    pub fn answer(&mut self, id: u64, choice: Option<Choice>, documents: &Documents) -> Result<Answer, Msg> {
        if self.pending.as_ref().is_none_or(|(serial, _)| *serial != id) { return Ok(Answer::None); }
        let Some((_, pending)) = self.pending.take() else { return Ok(Answer::None); };
        Ok(match (pending, choice) {
            (Pending::Open, Some(Choice::File(Some(target)))) => Answer::Document(Request::OpenFile(target)),
            (Pending::Save(prompt), choice) => Answer::Document(Request::SaveTarget { prompt, target: match choice { Some(Choice::File(target)) => target, _ => None } }),
            (Pending::Color(color), Some(Choice::Color(Some(rgb)))) => {
                let valid = color.valid && documents.active().is_some_and(|doc| doc.id() == color.document && doc.lineage() == color.lineage && doc.revision() == color.revision && doc.view().is_ok_and(|view| view.tick == color.tick && *view.selection == color.selection));
                if !valid { return Err(Msg::new("errors.app.selectionChangedReopenTheColorPicker")); }
                Answer::Color(color.target, rgb)
            }
            _ => Answer::None,
        })
    }
}
