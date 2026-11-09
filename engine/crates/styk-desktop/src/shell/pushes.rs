//! What the native side sends to the page on its own (the file the app was launched with, a `stykanimate://` link's
//! menu action, a menu's own actions) goes to listeners the page registers while it starts. A message sent before
//! they exist is dropped, and the page's load event does not wait for them: a module that waits (src/app.mjs waits
//! for the engine) has run no further when the page has loaded. So the page says when its listeners are on
//! (`page_listening`), and everything sent until then is kept, in order. A page that loads again has no listeners
//! until it says so once more. (Port of desktop/page-pushes.cjs.)

use serde_json::Value;

#[derive(Default)]
pub struct PagePushes {
    held: Vec<(String, Value)>,
    listening: bool,
}

impl PagePushes {
    /// What to deliver now: the message itself when the page listens, nothing when it is kept for later.
    pub fn send(&mut self, channel: &str, payload: Value) -> Option<(String, Value)> {
        if self.listening {
            Some((channel.to_owned(), payload))
        } else {
            self.held.push((channel.to_owned(), payload));
            None
        }
    }

    /// The page's listeners are on: what was kept goes out first, in order.
    pub fn listen(&mut self) -> Vec<(String, Value)> {
        self.listening = true;
        std::mem::take(&mut self.held)
    }

    /// The page is loading again (or is gone): it has no listeners until it says so.
    pub fn reset(&mut self) {
        self.listening = false;
    }

    pub fn listening(&self) -> bool {
        self.listening
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn holds_until_the_page_listens_then_delivers_in_order() {
        let mut pushes = PagePushes::default();
        assert!(pushes.send("a", 1.into()).is_none());
        assert!(pushes.send("b", 2.into()).is_none());
        let held = pushes.listen();
        assert_eq!(held, vec![("a".into(), 1.into()), ("b".into(), 2.into())]);
        assert_eq!(pushes.send("c", 3.into()), Some(("c".into(), 3.into())));
        pushes.reset();
        assert!(pushes.send("d", 4.into()).is_none());
        assert_eq!(pushes.listen().len(), 1);
    }
}
