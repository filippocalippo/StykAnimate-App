//! One update check, start to finish, against traits: fetch the signed feed, decide, download and verify the installer.
//!
//! Nothing here touches the network or the disk, so every refusal is tested with fakes: a feed whose signature does not
//! verify, a release whose tag and version disagree, a download that fails its hash, a downgrade.

use super::feed::{FileInfo, ReleaseInfo, Version, is_newer, parse_latest_yml};
use super::state::UpdateState;
use std::path::PathBuf;

/// The feed and its signature, with the tag of the release they were fetched from.
#[derive(Clone, Debug)]
pub struct FetchedFeed {
    /// `latest.yml`, exactly as served.
    pub yml: Vec<u8>,
    /// `latest.yml.sig` of the same release, exactly as served.
    pub signature: Vec<u8>,
    /// The release's tag (`v1.2.0`).
    pub tag: String,
}

/// The feed could not be fetched.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FetchError(pub String);

/// Fetches the feed of the latest release together with its signature, both from the one release the first answer
/// names, so a release published between the requests cannot mix two.
pub trait FeedSource {
    /// The feed.
    fn fetch_feed(&self) -> Result<FetchedFeed, FetchError>;
}

/// Checks a feed's signature against the key compiled into the program.
pub trait Integrity {
    /// Whether the signature is valid for the message. With no key compiled in, never.
    fn verify_signature(&self, message: &[u8], signature: &[u8]) -> bool;
}

/// Why the installer was not obtained.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StageError {
    /// The download or the disk failed.
    Io(String),
    /// The file's size or hash is not the feed's.
    Mismatch(String),
    /// Cancelled.
    Cancelled,
}

/// Downloads an installer into the shared staging folder and verifies it; returns the verified, immutable file.
pub trait Stage {
    /// Fetches `file` of the release `tag`, reporting bytes as they arrive; the file's size and SHA-512 are checked
    /// before it is returned. A file already staged and verified is returned without downloading.
    fn obtain(&self, tag: &str, version: &str, file: &FileInfo, progress: &mut dyn FnMut(u64, u64), cancelled: &dyn Fn() -> bool) -> Result<PathBuf, StageError>;
}

/// What a check ended with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CheckOutcome {
    /// A verified update is staged at this path. The staged file is only a candidate until the restart: the program opens
    /// it then, holds it, and verifies it again through that handle (`file` says what it must be).
    Ready {
        /// The staged installer.
        installer: PathBuf,
        /// Its version.
        version: String,
        /// Its size and SHA-512, from the signed feed.
        file: FileInfo,
    },
    /// Nothing newer.
    Current,
    /// Failed; the state says so.
    Failed(String),
}

/// Limits progress reports to [`super::PROGRESS_PER_SECOND`], always letting the final one through.
#[derive(Debug)]
pub struct ProgressThrottle {
    last_ms: Option<u64>,
}

impl Default for ProgressThrottle {
    fn default() -> Self {
        ProgressThrottle { last_ms: None }
    }
}

impl ProgressThrottle {
    /// Whether to report now.
    pub fn allow(&mut self, now_ms: u64, done: bool) -> bool {
        let gap = 1000 / u64::from(super::PROGRESS_PER_SECOND);
        match self.last_ms {
            Some(last) if !done && now_ms.saturating_sub(last) < gap => false,
            _ => {
                self.last_ms = Some(now_ms);
                true
            }
        }
    }
}

/// Runs one check. `notify` sees the state after each change; `now_ms` is a monotonic clock; `cancelled` ends a download.
#[allow(clippy::too_many_arguments)]
pub fn run_check(
    state: &mut UpdateState,
    current: &Version,
    source: &dyn FeedSource,
    integrity: &dyn Integrity,
    stage: &dyn Stage,
    now_ms: &dyn Fn() -> u64,
    cancelled: &dyn Fn() -> bool,
    notify: &mut dyn FnMut(&UpdateState),
) -> CheckOutcome {
    state.checking();
    notify(state);
    let fail = |state: &mut UpdateState, notify: &mut dyn FnMut(&UpdateState), why: String| {
        state.failed();
        notify(state);
        CheckOutcome::Failed(why)
    };
    let feed = match source.fetch_feed() {
        Ok(feed) => feed,
        Err(FetchError(why)) => return fail(state, notify, format!("the feed could not be fetched: {why}")),
    };
    if !integrity.verify_signature(&feed.yml, &feed.signature) {
        return fail(state, notify, "the feed's signature does not verify".into());
    }
    let info: ReleaseInfo = match std::str::from_utf8(&feed.yml).map_err(|_| "the feed is not text".to_string()).and_then(|text| parse_latest_yml(text).map_err(|e| e.to_string())) {
        Ok(info) => info,
        Err(why) => return fail(state, notify, why),
    };
    let Some(version) = info.parsed_version() else { return fail(state, notify, "the feed has no valid version".into()) };
    if feed.tag.trim_start_matches('v') != info.version {
        return fail(state, notify, format!("the feed says {} but its release is {}", info.version, feed.tag));
    }
    if !is_newer(current, &version) {
        state.not_available();
        notify(state);
        return CheckOutcome::Current;
    }
    let Some(file) = info.installer() else { return fail(state, notify, "the feed lists no installer".into()) };
    state.update_available(&info.version);
    notify(state);
    let mut throttle = ProgressThrottle::default();
    let result = stage.obtain(
        &feed.tag,
        &info.version,
        file,
        &mut |transferred, total| {
            if throttle.allow(now_ms(), transferred >= total) {
                state.progress(transferred, total);
                notify(state);
            }
        },
        cancelled,
    );
    match result {
        Ok(installer) => {
            state.downloaded(&info.version);
            notify(state);
            CheckOutcome::Ready { installer, version: info.version.clone(), file: file.clone() }
        }
        Err(StageError::Cancelled) => fail(state, notify, "cancelled".into()),
        Err(StageError::Io(why)) | Err(StageError::Mismatch(why)) => fail(state, notify, why),
    }
}

/// Fakes of the traits, for tests here and in the crates that use the updater.
pub mod fakes {
    use super::*;
    use std::cell::RefCell;

    /// A feed source that answers as scripted.
    pub struct FakeFeed(pub Result<FetchedFeed, FetchError>);

    impl FeedSource for FakeFeed {
        fn fetch_feed(&self) -> Result<FetchedFeed, FetchError> {
            self.0.clone()
        }
    }

    /// An integrity check that says yes or no.
    pub struct FakeIntegrity(pub bool);

    impl Integrity for FakeIntegrity {
        fn verify_signature(&self, _: &[u8], _: &[u8]) -> bool {
            self.0
        }
    }

    /// A stage that "downloads" in the steps given and answers as scripted.
    pub struct FakeStage {
        /// Byte counts to report.
        pub steps: Vec<u64>,
        /// The answer after the steps.
        pub result: Result<PathBuf, StageError>,
        /// The `(tag, version, file name)` of each call.
        pub calls: RefCell<Vec<(String, String, String)>>,
    }

    impl Stage for FakeStage {
        fn obtain(&self, tag: &str, version: &str, file: &FileInfo, progress: &mut dyn FnMut(u64, u64), cancelled: &dyn Fn() -> bool) -> Result<PathBuf, StageError> {
            self.calls.borrow_mut().push((tag.into(), version.into(), file.name.clone()));
            for step in &self.steps {
                if cancelled() {
                    return Err(StageError::Cancelled);
                }
                progress(*step, file.size);
            }
            self.result.clone()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fakes::*;
    use super::*;
    use crate::updates::state::UpdateStatus;
    use std::cell::{Cell, RefCell};

    const SHA: &str = "AkhkLETWEbqgXa8ZyQhjSA5e8jKYbYsvkvA68ambkVXg5cIyhSObh8m2qeCWxuLiJSTbLyomjQwEwAZAzvJhtw==";

    fn yml(version: &str) -> Vec<u8> {
        format!("version: {version}\nfiles:\n  - url: Setup {version}.exe\n    sha512: {SHA}\n    size: 1000\n").into_bytes()
    }

    fn feed(version: &str, tag: &str) -> FakeFeed {
        FakeFeed(Ok(FetchedFeed { yml: yml(version), signature: vec![1; 64], tag: tag.into() }))
    }

    fn stage(result: Result<PathBuf, StageError>) -> FakeStage {
        FakeStage { steps: vec![250, 500, 1000], result, calls: RefCell::new(Vec::new()) }
    }

    struct Run {
        outcome: CheckOutcome,
        state: UpdateState,
        seen: Vec<UpdateStatus>,
    }

    fn run(current: &str, source: &FakeFeed, ok: bool, stage: &FakeStage, clock: &dyn Fn() -> u64) -> Run {
        let mut state = UpdateState::new(current, None);
        let mut seen = Vec::new();
        let outcome = run_check(&mut state, &Version::parse(current).unwrap(), source, &FakeIntegrity(ok), stage, clock, &|| false, &mut |s| seen.push(s.status));
        Run { outcome, state, seen }
    }

    #[test]
    fn a_newer_signed_release_is_downloaded_and_ready() {
        let st = stage(Ok(PathBuf::from("staged/Setup-1.2.0.exe")));
        let r = run("1.1.0", &feed("1.2.0", "v1.2.0"), true, &st, &|| 1_000_000);
        assert_eq!(
            r.outcome,
            CheckOutcome::Ready { installer: PathBuf::from("staged/Setup-1.2.0.exe"), version: "1.2.0".into(), file: FileInfo { name: "Setup 1.2.0.exe".into(), sha512: SHA.into(), size: 1000 } }
        );
        assert_eq!(r.state.status, UpdateStatus::Ready);
        assert_eq!(r.seen.first(), Some(&UpdateStatus::Checking));
        assert_eq!(st.calls.borrow()[0], ("v1.2.0".into(), "1.2.0".into(), "Setup 1.2.0.exe".into()), "the installer is asked for against the feed's own tag");
    }

    #[test]
    fn a_feed_whose_signature_does_not_verify_is_refused_before_it_is_read() {
        let st = stage(Ok(PathBuf::from("x")));
        let r = run("1.1.0", &feed("1.2.0", "v1.2.0"), false, &st, &|| 0);
        assert!(matches!(r.outcome, CheckOutcome::Failed(ref why) if why.contains("signature")));
        assert_eq!(r.state.status, UpdateStatus::Error);
        assert!(st.calls.borrow().is_empty(), "nothing is downloaded on an unsigned feed");
    }

    #[test]
    fn a_downgrade_a_prerelease_and_the_same_version_are_not_updates() {
        for (current, version, tag) in [("1.2.0", "1.1.0", "v1.1.0"), ("1.2.0", "1.2.0", "v1.2.0"), ("1.1.0", "1.2.0-beta.1", "v1.2.0-beta.1")] {
            let st = stage(Ok(PathBuf::from("x")));
            let r = run(current, &feed(version, tag), true, &st, &|| 0);
            assert_eq!(r.outcome, CheckOutcome::Current, "{current} -> {version}");
            assert_eq!(r.state.status, UpdateStatus::Current);
            assert!(st.calls.borrow().is_empty());
        }
    }

    #[test]
    fn a_feed_and_a_release_that_disagree_are_refused() {
        // The feed says 1.3.0 but came from the 1.2.0 release: two releases mixed by a publish between requests.
        let st = stage(Ok(PathBuf::from("x")));
        let r = run("1.1.0", &feed("1.3.0", "v1.2.0"), true, &st, &|| 0);
        assert!(matches!(r.outcome, CheckOutcome::Failed(ref why) if why.contains("1.2.0")));
        assert!(st.calls.borrow().is_empty());
    }

    #[test]
    fn a_failed_hash_a_failed_download_and_a_failed_fetch_all_end_in_error() {
        for result in [Err(StageError::Mismatch("the installer's hash is not the feed's".into())), Err(StageError::Io("the connection dropped".into()))] {
            let r = run("1.1.0", &feed("1.2.0", "v1.2.0"), true, &stage(result), &|| 0);
            assert_eq!(r.state.status, UpdateStatus::Error);
            assert_eq!(r.state.message_key, Some("desktop.updates.retryConnection"));
        }
        let r = run("1.1.0", &FakeFeed(Err(FetchError("offline".into()))), true, &stage(Ok(PathBuf::from("x"))), &|| 0);
        assert_eq!(r.state.status, UpdateStatus::Error);
    }

    #[test]
    fn a_malformed_feed_is_an_error_even_when_signed() {
        let bad = FakeFeed(Ok(FetchedFeed { yml: b"version: 1.2.0\n".to_vec(), signature: vec![], tag: "v1.2.0".into() }));
        let r = run("1.1.0", &bad, true, &stage(Ok(PathBuf::from("x"))), &|| 0);
        assert_eq!(r.state.status, UpdateStatus::Error);
    }

    #[test]
    fn progress_is_reported_at_most_ten_times_a_second() {
        // 1000 reports in one simulated second.
        let ticks = Cell::new(0u64);
        let st = FakeStage { steps: (1..=1000).map(|n| n).collect(), result: Ok(PathBuf::from("x")), calls: RefCell::new(Vec::new()) };
        let mut state = UpdateState::new("1.1.0", None);
        let mut reports = 0;
        run_check(
            &mut state,
            &Version::parse("1.1.0").unwrap(),
            &feed("1.2.0", "v1.2.0"),
            &FakeIntegrity(true),
            &st,
            &|| {
                ticks.set(ticks.get() + 1);
                ticks.get()
            },
            &|| false,
            &mut |s| {
                if s.status == UpdateStatus::Downloading && s.transferred > 0 {
                    reports += 1;
                }
            },
        );
        assert!(reports <= 11, "{reports} reports for 1000 steps in 1000 ms (10 per second plus the final one)");
        assert!(reports >= 10);
        assert_eq!(state.status, UpdateStatus::Ready);
    }

    #[test]
    fn the_final_report_always_gets_through() {
        let mut throttle = ProgressThrottle::default();
        assert!(throttle.allow(0, false));
        assert!(!throttle.allow(50, false));
        assert!(throttle.allow(60, true), "done is never swallowed");
        assert!(throttle.allow(200, false));
    }

    #[test]
    fn cancelling_stops_the_download_and_reports_it() {
        let st = stage(Ok(PathBuf::from("x")));
        let mut state = UpdateState::new("1.1.0", None);
        let outcome = run_check(&mut state, &Version::parse("1.1.0").unwrap(), &feed("1.2.0", "v1.2.0"), &FakeIntegrity(true), &st, &|| 0, &|| true, &mut |_| {});
        assert!(matches!(outcome, CheckOutcome::Failed(_)));
    }
}
