//! Registry file commands and native picker continuations. The documents host owns every file operation.
use crate::{commands::CommandId, documents::{Documents, PromptId, Request}, i18n::{Msg, Presentation}};
use styk_services::dialogs::{Choice, Filter, Request as Dialog};

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

enum Pending { Open, Save(PromptId) }
#[derive(Default)]
pub struct Pickers { serial: u64, pending: Option<(u64, Pending)> }
pub enum Answer { Document(Request), None }
impl Pickers {
    pub fn pending(&self) -> bool { self.pending.is_some() }
    fn begin(&mut self, pending: Pending, request: Dialog) -> Option<(u64, Dialog)> {
        if self.pending.is_some() { return None; }
        self.serial = self.serial.wrapping_add(1); self.pending = Some((self.serial, pending)); Some((self.serial, request))
    }
    pub fn open(&mut self, presentation: &Presentation) -> Option<(u64, Dialog)> {
        let filters = [
            ("desktop.main.animationAndStickFigures", &["styk", "stykmov", "stkz", "piv", "stk", "json", "nodes", "nodemc", "stknds", "zip"][..]),
            ("desktop.main.stykanimateMovieclip", &["stykmov"]),
            ("desktop.main.stykanimateFigure", &["stkz"]),
            ("desktop.main.pivotAnimation", &["piv"]),
            ("desktop.main.pivotStickFigure", &["stk"]),
            ("desktop.main.stykanimateProject", &["styk", "json"]),
        ].into_iter().map(|(key, extensions)| Filter { label: presentation.text(&Msg::new(key)), extensions: extensions.iter().map(|s| (*s).into()).collect() }).collect();
        self.begin(Pending::Open, Dialog::Open { title: presentation.text(&Msg::new("desktop.main.openAnimationOrStickFigure")), filters })
    }
    pub fn save(&mut self, prompt: PromptId, presentation: &Presentation, name: String) -> Option<(u64, Dialog)> { self.begin(Pending::Save(prompt), Dialog::Save { title: presentation.text(&Msg::new("common.saveAs")), name, filter: Filter { label: presentation.text(&Msg::new("desktop.main.stykanimateProject")), extensions: vec!["styk".into()] } }) }
    pub fn answer(&mut self, id: u64, choice: Option<Choice>) -> Result<Answer, Msg> {
        if self.pending.as_ref().is_none_or(|(serial, _)| *serial != id) { return Ok(Answer::None); }
        let Some((_, pending)) = self.pending.take() else { return Ok(Answer::None); };
        Ok(match (pending, choice) {
            (Pending::Open, Some(Choice::File(Some(target)))) => Answer::Document(Request::OpenFile(target)),
            (Pending::Save(prompt), choice) => Answer::Document(Request::SaveTarget { prompt, target: match choice { Some(Choice::File(target)) => target, _ => None } }),
            _ => Answer::None,
        })
    }
}
