//! What a start of the program asks for, and the bounded queue those requests wait in.

use super::protocol::{ProtocolLink, looks_like_link, parse_protocol};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Mutex;

/// The extensions an argument must end in to be opened (`desktop/main.cjs`: `pendingFiles`), lowercase.
pub const OPENABLE_EXTENSIONS: [&str; 10] = ["piv", "stk", "styk", "stkz", "stykmov", "json", "nodes", "nodemc", "stknds", "zip"];

/// The most files one request carries.
pub const MAX_FILES_PER_REQUEST: usize = 16;

/// How many requests may wait before the first is taken.
pub const QUEUE_CAPACITY: usize = 64;

/// One thing a start asks the running program to do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LaunchRequest {
    /// Open these documents.
    Files(Vec<PathBuf>),
    /// Follow this link.
    Protocol(ProtocolLink),
}

/// Whether the argument names a file the program opens: its extension is one of [`OPENABLE_EXTENSIONS`], any case.
pub fn is_openable(argument: &str) -> bool {
    argument.rsplit_once('.').is_some_and(|(_, ext)| OPENABLE_EXTENSIONS.iter().any(|known| known.eq_ignore_ascii_case(ext)))
}

/// The requests in a command line (the arguments after the program name).
///
/// As today: the first argument that starts like a link is the link (valid, or it is dropped), and every argument with
/// an openable extension is a file (at most [`MAX_FILES_PER_REQUEST`], in order). A link comes first.
pub fn launch_requests<I, S>(arguments: I) -> Vec<LaunchRequest>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let arguments: Vec<S> = arguments.into_iter().collect();
    let mut requests = Vec::new();
    if let Some(link) = arguments.iter().find(|argument| looks_like_link(argument.as_ref())).and_then(|argument| parse_protocol(argument.as_ref())) {
        requests.push(LaunchRequest::Protocol(link));
    }
    let files: Vec<PathBuf> = arguments.iter().map(AsRef::as_ref).filter(|argument| !looks_like_link(argument) && is_openable(argument)).take(MAX_FILES_PER_REQUEST).map(PathBuf::from).collect();
    if !files.is_empty() {
        requests.push(LaunchRequest::Files(files));
    }
    requests
}

/// The queue was full: the request was not taken and the sender must be told.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QueueFull;

/// A bounded first-in first-out queue of requests that a server thread fills and the interface drains.
///
/// A full queue refuses the new request, visibly: nothing already queued is ever dropped, and the sender hears `BUSY`.
/// The lock is held for one push or pop, never across work.
#[derive(Debug, Default)]
pub struct LaunchInbox {
    queue: Mutex<VecDeque<LaunchRequest>>,
}

impl LaunchInbox {
    /// An empty inbox.
    pub fn new() -> LaunchInbox {
        LaunchInbox::default()
    }

    /// Queues a request unless the queue is full.
    pub fn push(&self, request: LaunchRequest) -> Result<(), QueueFull> {
        let mut queue = self.queue.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if queue.len() >= QUEUE_CAPACITY {
            return Err(QueueFull);
        }
        queue.push_back(request);
        Ok(())
    }

    /// The oldest request.
    pub fn pop(&self) -> Option<LaunchRequest> {
        self.queue.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).pop_front()
    }

    /// How many are waiting.
    pub fn len(&self) -> usize {
        self.queue.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).len()
    }

    /// Whether none are waiting.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn files_are_picked_by_extension_as_today() {
        for yes in ["a.piv", "b.STYK", "C:/x/y.stkz", ".piv", "z.stykmov", "q.json", "f.nodes", "g.nodemc", "h.stknds", "i.zip", "j.stk"] {
            assert!(is_openable(yes), "{yes}");
        }
        for no in ["a.png", "piv", "a.piv.exe", "a.pivx", "--size", "readme"] {
            assert!(!is_openable(no), "{no}");
        }
    }

    #[test]
    fn a_command_line_gives_a_link_and_the_files() {
        let requests = launch_requests(["a.piv", "stykanimate://library/abcdefghij", "b.styk", "c.txt"]);
        assert_eq!(requests.len(), 2);
        assert!(matches!(&requests[0], LaunchRequest::Protocol(ProtocolLink::Library(Some(_)))));
        assert_eq!(requests[1], LaunchRequest::Files(vec!["a.piv".into(), "b.styk".into()]));
    }

    #[test]
    fn an_invalid_link_is_dropped_and_the_first_link_decides() {
        assert!(launch_requests(["stykanimate://open?x=1"]).is_empty());
        assert_eq!(launch_requests(["stykanimate://open?x=1", "stykanimate://open"]), vec![], "only the first link argument is considered");
    }

    #[test]
    fn a_hundred_files_are_limited_to_the_request_bound() {
        let args: Vec<String> = (0..100).map(|n| format!("f{n}.piv")).collect();
        match &launch_requests(&args)[0] {
            LaunchRequest::Files(files) => assert_eq!(files.len(), MAX_FILES_PER_REQUEST),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn the_inbox_refuses_when_full_and_loses_nothing_queued() {
        let inbox = LaunchInbox::new();
        for n in 0..QUEUE_CAPACITY {
            inbox.push(LaunchRequest::Files(vec![format!("{n}.piv").into()])).unwrap();
        }
        assert_eq!(inbox.push(LaunchRequest::Protocol(ProtocolLink::Open)), Err(QueueFull));
        assert_eq!(inbox.len(), QUEUE_CAPACITY);
        assert_eq!(inbox.pop(), Some(LaunchRequest::Files(vec!["0.piv".into()])), "the oldest is still first");
        inbox.push(LaunchRequest::Protocol(ProtocolLink::Open)).expect("a freed slot is usable");
    }
}
