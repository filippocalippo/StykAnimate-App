//! Access the clipboard.
use std::path::PathBuf;
use std::sync::Arc;

/// A set of clipboard requests.
#[derive(Debug, Clone)]
pub struct Clipboard {
    /// The read requests the runtime must fulfill, each with the [`RequestId`] its reply carries.
    pub reads: Vec<(Kind, RequestId)>,
    /// The content that must be written to the clipboard by the runtime,
    /// if any.
    pub write: Option<Content>,
}

impl Clipboard {
    /// Creates a new empty set of [`Clipboard`] requests.
    pub fn new() -> Self {
        Self {
            reads: Vec::new(),
            write: None,
        }
    }

    /// Merges the current [`Clipboard`] requests with others.
    pub fn merge(&mut self, other: &mut Self) {
        self.reads.append(&mut other.reads);
        self.write = other.write.take().or(self.write.take());
    }
}

impl Default for Clipboard {
    fn default() -> Self {
        Self::new()
    }
}

/// The identity of a clipboard read: the reply carries the ID of the request it answers, so a widget can tell its own
/// reply from another's and drop one that arrives after it lost focus.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct RequestId(pub u64);

impl RequestId {
    /// The ID of a request nobody tracks (`Shell::read_clipboard`).
    pub const ANONYMOUS: RequestId = RequestId(0);

    /// A new ID, unique in the process.
    pub fn next() -> RequestId {
        use std::sync::atomic::{AtomicU64, Ordering};

        static NEXT: AtomicU64 = AtomicU64::new(1);

        RequestId(NEXT.fetch_add(1, Ordering::Relaxed))
    }
}

/// The most bytes of text a read hands to the interface. The platform's worker cuts what it read to this, and an editor cuts
/// again what it is given, so a clipboard of any size costs the interface thread a bounded amount.
pub const MAX_TEXT_BYTES: usize = 1 << 20;

/// How many cancelled requests are remembered.
const CANCELLED_REMEMBERED: usize = 256;

static CANCELLED: std::sync::Mutex<std::collections::VecDeque<u64>> = std::sync::Mutex::new(std::collections::VecDeque::new());

/// Says nobody waits for the reply to `id` any more (its requester lost focus): the platform's worker skips the read if it
/// has not started it. The memory of cancelled requests is bounded; the oldest is forgotten first.
pub fn cancel(id: RequestId) {
    if id == RequestId::ANONYMOUS {
        return;
    }

    if let Ok(mut cancelled) = CANCELLED.lock() {
        if cancelled.len() >= CANCELLED_REMEMBERED {
            let _ = cancelled.pop_front();
        }

        cancelled.push_back(id.0);
    }
}

/// Whether `id` was cancelled; asking forgets it.
pub fn take_cancelled(id: RequestId) -> bool {
    let Ok(mut cancelled) = CANCELLED.lock() else {
        return false;
    };

    match cancelled.iter().position(|cancelled| *cancelled == id.0) {
        Some(at) => cancelled.remove(at).is_some(),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cancelled_request_is_noted_once_and_the_memory_is_bounded() {
        let id = RequestId::next();
        assert!(!take_cancelled(id));
        cancel(id);
        assert!(take_cancelled(id));
        assert!(!take_cancelled(id));

        let first = RequestId::next();
        cancel(first);
        for _ in 0..CANCELLED_REMEMBERED {
            cancel(RequestId::next());
        }
        assert!(!take_cancelled(first), "the oldest note was forgotten");
        cancel(RequestId::ANONYMOUS);
        assert!(!take_cancelled(RequestId::ANONYMOUS), "a request nobody tracks is never cancelled");
    }
}

/// A clipboard event.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    /// The clipboard was read; the reply to the request with this [`RequestId`].
    Read(Result<Arc<Content>, Error>, RequestId),

    /// The clipboard was written.
    Written(Result<(), Error>),
}

/// Some clipboard content.
#[derive(Debug, Clone, PartialEq)]
#[allow(missing_docs)]
#[non_exhaustive]
pub enum Content {
    Text(String),
    Html(String),
    #[cfg(feature = "image")]
    Image(Image),
    Files(Vec<PathBuf>),
}

impl From<String> for Content {
    fn from(text: String) -> Self {
        Self::Text(text)
    }
}

#[cfg(feature = "image")]
impl From<Image> for Content {
    fn from(image: Image) -> Self {
        Self::Image(image)
    }
}

impl From<Vec<PathBuf>> for Content {
    fn from(files: Vec<PathBuf>) -> Self {
        Self::Files(files)
    }
}

/// The kind of some clipboard [`Content`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(missing_docs)]
#[non_exhaustive]
pub enum Kind {
    Text,
    Html,
    #[cfg(feature = "image")]
    Image,
    Files,
}

/// A clipboard image.
#[cfg(feature = "image")]
#[derive(Debug, Clone, PartialEq)]
pub struct Image {
    /// The pixels of the image in RGBA format.
    pub rgba: crate::Bytes,

    /// The physical [`Size`](crate::Size) of the image.
    pub size: crate::Size<u32>,
}

/// A clipboard error.
#[derive(Debug, Clone, PartialEq)]
pub enum Error {
    /// The clipboard in the current environment is either not present or could not be accessed.
    ClipboardUnavailable,

    /// The native clipboard is not accessible due to being held by another party.
    ClipboardOccupied,

    /// The clipboard contents were not available in the requested format.
    /// This could either be due to the clipboard being empty or the clipboard contents having
    /// an incompatible format to the requested one
    ContentNotAvailable,

    /// The image or the text that was about the be transferred to/from the clipboard could not be
    /// converted to the appropriate format.
    ConversionFailure,

    /// Any error that doesn't fit the other error types.
    Unknown {
        /// A description only meant to help the developer that should not be relied on as a
        /// means to identify an error case during runtime.
        description: Arc<String>,
    },
}
