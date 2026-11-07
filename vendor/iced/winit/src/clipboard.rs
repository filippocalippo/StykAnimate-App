//! Access the clipboard.
use crate::core::clipboard::{Content, Error, Kind};

pub use platform::*;

impl Default for Clipboard {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(not(target_arch = "wasm32"))]
mod platform {
    use super::*;

    use crate::core::clipboard::{self, RequestId};

    use std::sync::Arc;
    use std::sync::mpsc::{SyncSender, TrySendError, sync_channel};
    use std::thread;

    /// How many requests wait for the worker. A request that finds the queue full is answered at once with
    /// [`Error::ClipboardOccupied`]: the requester sees a failure instead of a thread piling up behind a stuck clipboard.
    const QUEUE: usize = 8;

    type Reading = Box<dyn FnOnce(Result<Content, Error>) + Send>;
    type Writing = Box<dyn FnOnce(Result<(), Error>) + Send>;

    enum Job {
        Read(Kind, RequestId, Reading),
        Write(Content, Writing),
    }

    /// A buffer for short-term storage and transfer within and between
    /// applications.
    ///
    /// Every read and write runs on one worker thread, in order, never on the interface thread. The worker's queue is
    /// bounded, a read whose requester gave up is skipped, and text is cut to [`clipboard::MAX_TEXT_BYTES`] before it
    /// leaves the worker.
    pub struct Clipboard {
        worker: Option<SyncSender<Job>>,
    }

    impl Clipboard {
        /// Creates a new [`Clipboard`] for the given window.
        pub fn new() -> Self {
            let worker = arboard::Clipboard::new().ok().and_then(|clipboard| {
                let (sender, receiver) = sync_channel::<Job>(QUEUE);

                thread::Builder::new()
                    .name("clipboard".to_owned())
                    .spawn(move || run(clipboard, receiver))
                    .ok()
                    .map(|_| sender)
            });

            Clipboard { worker }
        }

        /// Reads the current content of the [`Clipboard`] as text.
        pub fn read(
            &self,
            kind: Kind,
            callback: impl FnOnce(Result<Content, Error>) + Send + 'static,
        ) {
            self.read_for(kind, RequestId::ANONYMOUS, callback);
        }

        /// Reads the clipboard for the request \`id\`: if the requester cancels it ([\`clipboard::cancel\`]) before the worker
        /// reaches it, the read is skipped.
        pub fn read_for(
            &self,
            kind: Kind,
            id: RequestId,
            callback: impl FnOnce(Result<Content, Error>) + Send + 'static,
        ) {
            self.submit(Job::Read(kind, id, Box::new(callback)));
        }

        /// Writes the given text contents to the [`Clipboard`].
        pub fn write(
            &mut self,
            content: Content,
            callback: impl FnOnce(Result<(), Error>) + Send + 'static,
        ) {
            self.submit(Job::Write(content, Box::new(callback)));
        }

        fn submit(&self, job: Job) {
            let Some(worker) = &self.worker else {
                return fail(job, Error::ClipboardUnavailable);
            };

            match worker.try_send(job) {
                Ok(()) => {}
                Err(TrySendError::Full(job)) => fail(job, Error::ClipboardOccupied),
                Err(TrySendError::Disconnected(job)) => fail(job, Error::ClipboardUnavailable),
            }
        }
    }

    /// Answers a job that could not be queued.
    fn fail(job: Job, error: Error) {
        match job {
            Job::Read(_, _, callback) => callback(Err(error)),
            Job::Write(_, callback) => callback(Err(error)),
        }
    }

    fn run(mut clipboard: arboard::Clipboard, jobs: std::sync::mpsc::Receiver<Job>) {
        for job in jobs {
            match job {
                Job::Read(kind, id, callback) => {
                    if clipboard::take_cancelled(id) {
                        callback(Err(Error::ContentNotAvailable));
                        continue;
                    }

                    let get = clipboard.get();

                    let result = match kind {
                        Kind::Text => get.text().map(|text| Content::Text(bounded(text))),
                        Kind::Html => get.html().map(|html| Content::Html(bounded(html))),
                        #[cfg(feature = "image")]
                        Kind::Image => get.image().map(|image| {
                            let rgba = crate::core::Bytes::from_owner(image.bytes);
                            let size = crate::core::Size {
                                width: image.width as u32,
                                height: image.height as u32,
                            };

                            Content::Image(crate::core::clipboard::Image { rgba, size })
                        }),
                        Kind::Files => get.file_list().map(Content::Files),
                        kind => {
                            log::warn!("unsupported clipboard kind: {kind:?}");

                            Err(arboard::Error::ContentNotAvailable)
                        }
                    }
                    .map_err(to_error);

                    callback(result);
                }
                Job::Write(content, callback) => {
                    let set = clipboard.set();

                    let result = match content {
                        Content::Text(text) => set.text(text),
                        Content::Html(html) => set.html(html, None),
                        #[cfg(feature = "image")]
                        Content::Image(image) => set.image(arboard::ImageData {
                            bytes: image.rgba.as_ref().into(),
                            width: image.size.width as usize,
                            height: image.size.height as usize,
                        }),
                        Content::Files(files) => set.file_list(&files),
                        content => {
                            log::warn!("unsupported clipboard content: {content:?}");

                            Err(arboard::Error::ClipboardNotSupported)
                        }
                    }
                    .map_err(to_error);

                    callback(result);
                }
            }
        }
    }

    /// Text cut to what an interface is ever given, at a character boundary.
    fn bounded(mut text: String) -> String {
        if text.len() > clipboard::MAX_TEXT_BYTES {
            text.truncate(text.floor_char_boundary(clipboard::MAX_TEXT_BYTES));
        }

        text
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::sync::Mutex;

        #[test]
        fn a_full_queue_is_answered_at_once_with_an_occupied_error_and_never_grows() {
            let (sender, receiver) = sync_channel::<Job>(QUEUE);
            let clipboard = Clipboard { worker: Some(sender) };
            let answers: Arc<Mutex<Vec<Result<Content, Error>>>> = Arc::new(Mutex::new(Vec::new()));

            // Nothing serves the queue: the first QUEUE requests wait, the rest are refused on the spot.
            for n in 0..QUEUE + 3 {
                let sink = answers.clone();
                clipboard.read(Kind::Text, move |result| sink.lock().unwrap().push(result));
                assert_eq!(answers.lock().unwrap().len(), n.saturating_sub(QUEUE - 1).min(3), "after request {n}");
            }

            assert!(answers.lock().unwrap().iter().all(|answer| *answer == Err(Error::ClipboardOccupied)));
            drop(receiver);

            // A worker that is gone answers as unavailable.
            let answers: Arc<Mutex<Vec<Result<Content, Error>>>> = Arc::new(Mutex::new(Vec::new()));
            let again = answers.clone();
            clipboard.read(Kind::Text, move |result| again.lock().unwrap().push(result));
            assert_eq!(answers.lock().unwrap().as_slice(), [Err(Error::ClipboardUnavailable)]);
        }
    }

    fn to_error(error: arboard::Error) -> Error {
        match error {
            arboard::Error::ContentNotAvailable => Error::ContentNotAvailable,
            arboard::Error::ClipboardNotSupported => Error::ClipboardUnavailable,
            arboard::Error::ClipboardOccupied => Error::ClipboardOccupied,
            arboard::Error::ConversionFailure => Error::ConversionFailure,
            arboard::Error::Unknown { description } => Error::Unknown {
                description: Arc::new(description),
            },
            error => Error::Unknown {
                description: Arc::new(error.to_string()),
            },
        }
    }
}

// TODO: Wasm support
#[cfg(target_arch = "wasm32")]
mod platform {
    use super::*;

    /// A buffer for short-term storage and transfer within and between
    /// applications.
    pub struct Clipboard;

    impl Clipboard {
        /// Creates a new [`Clipboard`] for the given window.
        pub fn new() -> Self {
            Self
        }

        /// Reads the current content of the [`Clipboard`] as text.
        pub fn read(&self, _kind: Kind, callback: impl FnOnce(Result<Content, Error>)) {
            callback(Err(Error::ClipboardUnavailable));
        }

        /// Reads the clipboard for the request `id`.
        pub fn read_for(
            &self,
            _kind: Kind,
            _id: crate::core::clipboard::RequestId,
            callback: impl FnOnce(Result<Content, Error>),
        ) {
            callback(Err(Error::ClipboardUnavailable));
        }

        /// Writes the given text contents to the [`Clipboard`].
        pub fn write(&mut self, _content: Content, callback: impl FnOnce(Result<(), Error>)) {
            callback(Err(Error::ClipboardUnavailable));
        }
    }
}
