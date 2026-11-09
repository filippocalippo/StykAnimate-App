//! Asynchronous native pickers. Results are choices, never permission to mutate a document.
use crate::files::FileTarget;

#[derive(Clone, Debug, PartialEq)]
pub enum Request {
    Open { title: String },
    Save { title: String, name: String },
    Color { initial: [u8; 3] },
}
#[derive(Clone, Debug, PartialEq)]
pub enum Choice { File(Option<FileTarget>), Color(Option<[u8; 3]>) }
pub type Completion = Box<dyn FnOnce(Result<Choice, String>) + Send>;

pub trait Dialogs: Send + Sync {
    /// Returns immediately. Exactly one callback follows an accepted request; dismissal is None.
    /// The implementation refuses unattended runs before creating any OS window.
    fn choose(&self, request: Request, complete: Completion) -> Result<(), String>;
}
