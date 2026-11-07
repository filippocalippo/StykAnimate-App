//! The updater on Windows: the signed feed over HTTPS, the shared staging folder, and the hand-over to the installer.
//!
//! `styk_services::updates` decides; this module does the network, the files and the process. Nothing here runs on the
//! interface thread: the app calls [`styk_services::updates::flow::run_check`] on a worker with these implementations.

use ring::signature::{ED25519, UnparsedPublicKey};
use sha2::{Digest, Sha512};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use styk_services::updates::feed::{Endpoint, FileInfo, MAX_FEED};
use styk_services::updates::flow::{FeedSource, FetchError, FetchedFeed, Integrity, Stage, StageError};
use styk_services::updates::plan::{Handoff, InstallPlan, handoff_from_error};
use styk_services::updates::staging::{self, LOCK_FILE};
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, WAIT_TIMEOUT};
use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, WaitForSingleObject};
use windows_sys::Win32::UI::Shell::{SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW, ShellExecuteExW};
use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

use super::wide;

/// Verifies the feed's Ed25519 signature against the key compiled into the program.
pub struct Ed25519Integrity {
    key: Option<[u8; 32]>,
}

impl Ed25519Integrity {
    /// With no key, nothing verifies and so nothing updates.
    pub fn new(key: Option<[u8; 32]>) -> Ed25519Integrity {
        Ed25519Integrity { key }
    }
}

impl Integrity for Ed25519Integrity {
    fn verify_signature(&self, message: &[u8], signature: &[u8]) -> bool {
        self.key.is_some_and(|key| UnparsedPublicKey::new(&ED25519, key).verify(message, signature).is_ok())
    }
}

/// SHA-512 of a file, base64, as the feed writes it. Stops with `None` if `cancelled` says so.
pub fn sha512_base64(path: &Path, cancelled: &dyn Fn() -> bool) -> std::io::Result<Option<String>> {
    hash_reader(&mut File::open(path)?, cancelled)
}

/// SHA-512 of everything a reader yields, base64; `None` if cancelled.
fn hash_reader(file: &mut impl Read, cancelled: &dyn Fn() -> bool) -> std::io::Result<Option<String>> {
    let mut hasher = Sha512::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        if cancelled() {
            return Ok(None);
        }
        let read = file.read(&mut buffer)?;
        if read == 0 {
            return Ok(Some(staging::encode_base64(&hasher.finalize())));
        }
        hasher.update(&buffer[..read]);
    }
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .max_redirects(0)
        .http_status_as_error(false)
        .timeout_connect(Some(Duration::from_secs(15)))
        .timeout_recv_response(Some(Duration::from_secs(30)))
        .timeout_recv_body(Some(Duration::from_secs(60)))
        .user_agent("StykAnimate-updater")
        .build()
        .into()
}

/// One GET that follows redirects by hand, only to places the endpoint allows. Returns the final response and the
/// chain of URLs it went through.
fn get(endpoint: &Endpoint, url: &str, range_from: u64) -> Result<(ureq::http::Response<ureq::Body>, Vec<String>), String> {
    let agent = agent();
    let mut chain = vec![url.to_string()];
    for _ in 0..6 {
        let current = chain.last().expect("the chain is never empty").clone();
        let mut request = agent.get(&current);
        if range_from > 0 {
            request = request.header("Range", format!("bytes={range_from}-"));
        }
        let response = request.call().map_err(|e| format!("{current}: {e}"))?;
        let status = response.status().as_u16();
        if matches!(status, 301 | 302 | 303 | 307 | 308) {
            let next = response.headers().get("location").and_then(|v| v.to_str().ok()).ok_or_else(|| "a redirect with no location".to_string())?;
            let next = if next.starts_with("http://") || next.starts_with("https://") { next.to_string() } else { format!("{}{}", endpoint.base, next) };
            if !endpoint.may_redirect_to(&next) {
                return Err(format!("refusing to follow a redirect to {next}"));
            }
            chain.push(next);
            continue;
        }
        return Ok((response, chain));
    }
    Err("too many redirects".into())
}

fn read_limited(response: &mut ureq::http::Response<ureq::Body>, limit: u64) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    response.body_mut().as_reader().take(limit + 1).read_to_end(&mut out).map_err(|e| e.to_string())?;
    if out.len() as u64 > limit { Err("the response is larger than allowed".into()) } else { Ok(out) }
}

/// The signed feed of a GitHub-style release endpoint.
pub struct HttpFeed {
    /// Where releases live.
    pub endpoint: Endpoint,
}

impl FeedSource for HttpFeed {
    fn fetch_feed(&self) -> Result<FetchedFeed, FetchError> {
        let fail = |why: String| FetchError(why);
        let (mut response, chain) = get(&self.endpoint, &self.endpoint.latest_feed_url(), 0).map_err(fail)?;
        if response.status().as_u16() != 200 {
            return Err(FetchError(format!("the feed answered {}", response.status())));
        }
        // The release this answer belongs to: the tag in the download URL the "latest" alias redirected to.
        let tag = chain.iter().find_map(|url| self.endpoint.tag_of_download_url(url)).ok_or_else(|| FetchError("the feed's release could not be identified".into()))?;
        let yml = read_limited(&mut response, MAX_FEED as u64).map_err(fail)?;
        // The signature and (later) the installer come from that same release, however many releases have been
        // published since.
        let sig_url = self.endpoint.asset_url(&tag, "latest.yml.sig").ok_or_else(|| FetchError("bad release tag".into()))?;
        let (mut sig_response, _) = get(&self.endpoint, &sig_url, 0).map_err(fail)?;
        if sig_response.status().as_u16() != 200 {
            return Err(FetchError(format!("the feed's signature answered {}", sig_response.status())));
        }
        let signature = read_limited(&mut sig_response, 1024).map_err(fail)?;
        Ok(FetchedFeed { yml, signature, tag })
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// Whether a process with this id exists.
pub fn process_alive(pid: u32) -> bool {
    // SAFETY: opens a query-only handle to the process, looks at it and closes it.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | 0x0010_0000, 0, pid); // + SYNCHRONIZE
        if handle.is_null() {
            return GetLastError() == 5; // access denied: it exists
        }
        let alive = WaitForSingleObject(handle, 0) == WAIT_TIMEOUT;
        CloseHandle(handle);
        alive
    }
}

/// The shared staging folders under one root (`%LOCALAPPDATA%\StykAnimate\updates`).
pub struct HttpStage {
    /// Where the version folders live.
    pub root: PathBuf,
    /// Where releases live.
    pub endpoint: Endpoint,
}

/// The download lock: the lock file opened with no sharing at all, and deleted when the handle closes. The kernel owns
/// it: it is held exactly as long as its holder lives (a crashed holder's lock is gone with the process), nobody can
/// take it from a live holder, and there is no age or process id to judge, no lock to delete, no takeover to race.
struct LockGuard(#[allow(dead_code)] File);

/// Takes the download lock, or `None` while another holder has it.
fn try_lock(path: &Path) -> std::io::Result<Option<LockGuard>> {
    const GENERIC_WRITE_AND_DELETE: u32 = 0x4000_0000 | 0x0001_0000;
    const FILE_FLAG_DELETE_ON_CLOSE: u32 = 0x0400_0000;
    const ERROR_SHARING_VIOLATION: i32 = 32;
    match OpenOptions::new().write(true).create(true).access_mode(GENERIC_WRITE_AND_DELETE).share_mode(0).custom_flags(FILE_FLAG_DELETE_ON_CLOSE).open(path) {
        Ok(mut file) => {
            // For a person looking at the folder; nothing reads it.
            let _ = file.write_all(format!("{}\n", std::process::id()).as_bytes());
            Ok(Some(LockGuard(file)))
        }
        Err(e) if e.raw_os_error() == Some(ERROR_SHARING_VIOLATION) => Ok(None),
        Err(e) => Err(e),
    }
}

fn stage_io(e: impl std::fmt::Display) -> StageError {
    StageError::Io(e.to_string())
}

impl HttpStage {
    /// A verified staged installer for these bytes, if there is one already.
    fn existing(&self, final_path: &Path, file: &FileInfo, cancelled: &dyn Fn() -> bool) -> Result<Option<PathBuf>, StageError> {
        match fs::metadata(final_path) {
            Ok(meta) if meta.len() == file.size => match sha512_base64(final_path, cancelled).map_err(stage_io)? {
                Some(hash) if hash == file.sha512 => Ok(Some(final_path.to_path_buf())),
                None => Err(StageError::Cancelled),
                Some(_) => {
                    let _ = fs::remove_file(final_path);
                    Ok(None)
                }
            },
            Ok(_) => {
                let _ = fs::remove_file(final_path);
                Ok(None)
            }
            Err(_) => Ok(None),
        }
    }

    fn download(&self, dir: &Path, tag: &str, file: &FileInfo, final_path: &Path, progress: &mut dyn FnMut(u64, u64), cancelled: &dyn Fn() -> bool) -> Result<PathBuf, StageError> {
        let url = self.endpoint.asset_url(tag, &file.name).ok_or_else(|| StageError::Io("bad release tag or file name".into()))?;
        // Adopt the largest partial file a previous holder of the lock left (they cannot be writing: the lock is ours),
        // and delete the others.
        let mine = dir.join(staging::part_name(std::process::id(), now_ms()));
        let mut parts: Vec<(u64, PathBuf)> = fs::read_dir(dir)
            .map_err(stage_io)?
            .filter_map(|e| e.ok())
            .filter(|e| staging::is_part_name(&e.file_name().to_string_lossy()))
            .filter_map(|e| Some((e.metadata().ok()?.len(), e.path())))
            .collect();
        parts.sort();
        if let Some((_, best)) = parts.pop() {
            fs::rename(&best, &mine).map_err(stage_io)?;
        }
        for (_, other) in parts {
            let _ = fs::remove_file(other);
        }
        let mut have = fs::metadata(&mine).map_or(0, |m| m.len());
        if have > file.size {
            fs::remove_file(&mine).map_err(stage_io)?;
            have = 0;
        }
        if have < file.size {
            let (mut response, _) = get(&self.endpoint, &url, have).map_err(StageError::Io)?;
            let status = response.status().as_u16();
            let mut out = match status {
                206 => OpenOptions::new().append(true).create(true).open(&mine).map_err(stage_io)?,
                200 => {
                    have = 0;
                    File::create(&mine).map_err(stage_io)?
                }
                416 => {
                    let _ = fs::remove_file(&mine);
                    return Err(StageError::Io("the server refused the resume; try again".into()));
                }
                other => return Err(StageError::Io(format!("the download answered {other}"))),
            };
            let mut reader = response.body_mut().as_reader();
            let mut buffer = vec![0u8; 1 << 20];
            let mut total = have;
            progress(total, file.size);
            loop {
                if cancelled() {
                    return Err(StageError::Cancelled);
                }
                let read = reader.read(&mut buffer).map_err(stage_io)?;
                if read == 0 {
                    break;
                }
                if total + read as u64 > file.size {
                    drop(out);
                    let _ = fs::remove_file(&mine);
                    return Err(StageError::Mismatch("the download is larger than the feed says".into()));
                }
                out.write_all(&buffer[..read]).map_err(stage_io)?;
                total += read as u64;
                progress(total, file.size);
            }
            out.sync_all().map_err(stage_io)?;
            drop(out);
            if total < file.size {
                return Err(StageError::Io(format!("the connection ended at {total} of {} bytes", file.size)));
            }
        }
        match sha512_base64(&mine, cancelled).map_err(stage_io)? {
            None => return Err(StageError::Cancelled),
            Some(hash) if hash != file.sha512 => {
                let _ = fs::remove_file(&mine);
                return Err(StageError::Mismatch("the installer's SHA-512 is not the feed's".into()));
            }
            Some(_) => {}
        }
        if final_path.exists() {
            let _ = fs::remove_file(&mine);
        } else {
            fs::rename(&mine, final_path).map_err(stage_io)?;
        }
        Ok(final_path.to_path_buf())
    }
}

impl Stage for HttpStage {
    fn obtain(&self, tag: &str, version: &str, file: &FileInfo, progress: &mut dyn FnMut(u64, u64), cancelled: &dyn Fn() -> bool) -> Result<PathBuf, StageError> {
        let name = staging::artifact_name(version, &file.sha512).ok_or_else(|| StageError::Mismatch("the feed's hash or version is malformed".into()))?;
        let dir = self.root.join(version);
        fs::create_dir_all(&dir).map_err(stage_io)?;
        let final_path = dir.join(name);
        let lock_path = dir.join(LOCK_FILE);
        let started = Instant::now();
        loop {
            if cancelled() {
                return Err(StageError::Cancelled);
            }
            if let Some(path) = self.existing(&final_path, file, cancelled)? {
                progress(file.size, file.size);
                return Ok(path);
            }
            match try_lock(&lock_path).map_err(stage_io)? {
                Some(_guard) => {
                    // Between the check above and the lock, another process may have finished.
                    if let Some(path) = self.existing(&final_path, file, cancelled)? {
                        progress(file.size, file.size);
                        return Ok(path);
                    }
                    return self.download(&dir, tag, file, &final_path, progress, cancelled);
                }
                None => {
                    // Another process holds the lock, and is alive (a dead one holds nothing): wait for its result.
                    if started.elapsed() > Duration::from_secs(3 * 60 * 60) {
                        return Err(StageError::Io("another process has been downloading the update for too long".into()));
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
        }
    }
}

/// The installer, held open without write or delete sharing, from the moment it is verified until the installer has
/// started. The file is opened first and checked through that very handle, so what was checked is what is held, and
/// nobody can replace it between the check and the launch (a staged file that waited in `ready` is only a candidate).
pub struct HeldInstaller {
    path: PathBuf,
    _file: File,
}

impl HeldInstaller {
    /// Opens the staged file, sharing only reads, and checks its size and SHA-512 against the signed feed's through the
    /// handle it holds. Fails if the file is being written, is not what the feed says, or cannot be read.
    pub fn open_verified(path: &Path, expected: &FileInfo, cancelled: &dyn Fn() -> bool) -> Result<HeldInstaller, StageError> {
        let mut file = OpenOptions::new().read(true).share_mode(1).open(path).map_err(stage_io)?; // FILE_SHARE_READ
        if file.metadata().map_err(stage_io)?.len() != expected.size {
            return Err(StageError::Mismatch("the staged installer is not the size the feed says".into()));
        }
        match hash_reader(&mut file, cancelled).map_err(stage_io)? {
            None => Err(StageError::Cancelled),
            Some(hash) if hash != expected.sha512 => Err(StageError::Mismatch("the staged installer is not the one the feed describes".into())),
            Some(_) => Ok(HeldInstaller { path: path.to_path_buf(), _file: file }),
        }
    }

    /// The file's path.
    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// Runs the installer with the plan's arguments, elevated if the plan says so. Returns only once the process exists (or
/// the attempt failed); the caller quits the program on [`Handoff::Started`] and on nothing else.
pub fn launch_installer(installer: &HeldInstaller, plan: &InstallPlan) -> Handoff {
    let file = wide(&installer.path().to_string_lossy());
    let verb = wide(if plan.elevate { "runas" } else { "open" });
    let params = wide(&plan.args.join(" "));
    // SAFETY: the strings outlive the call; `info` is initialised field by field and only read by the system.
    unsafe {
        let mut info: SHELLEXECUTEINFOW = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
        info.fMask = SEE_MASK_NOCLOSEPROCESS;
        info.lpVerb = verb.as_ptr();
        info.lpFile = file.as_ptr();
        info.lpParameters = params.as_ptr();
        info.nShow = SW_SHOWNORMAL;
        if ShellExecuteExW(&mut info) == 0 {
            return handoff_from_error(GetLastError(), "start the installer");
        }
        if info.hProcess.is_null() {
            // Started through an existing process (no handle to look at): the system accepted it.
            return Handoff::Started;
        }
        // Acknowledge that the process really exists and has not already died.
        let alive = WaitForSingleObject(info.hProcess, 0) == WAIT_TIMEOUT;
        CloseHandle(info.hProcess);
        if alive { Handoff::Started } else { Handoff::Failed("the installer ended at once".into()) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::{Ed25519KeyPair, KeyPair};
    use std::cell::Cell;
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    fn temp(tag: &str) -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!("styk-updates-{tag}-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst)));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn keypair() -> Ed25519KeyPair {
        Ed25519KeyPair::from_seed_unchecked(&[7u8; 32]).unwrap()
    }

    #[test]
    fn sha512_matches_the_known_vector() {
        let dir = temp("sha");
        fs::write(dir.join("abc"), b"abc").unwrap();
        assert_eq!(sha512_base64(&dir.join("abc"), &|| false).unwrap().unwrap(), "3a81oZNherrMQXNJriBBMRLm+k6JqX6iCp7u5ktV05ohkpkqJ0/BqDa6PCOj/uu9RU1EI2Q86A4qmslPpUyknw==");
        assert_eq!(sha512_base64(&dir.join("abc"), &|| true).unwrap(), None, "cancelled");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_signature_verifies_only_for_its_message_and_key() {
        let pair = keypair();
        let public: [u8; 32] = pair.public_key().as_ref().try_into().unwrap();
        let message = b"version: 1.2.0\n";
        let signature = pair.sign(message);
        let good = Ed25519Integrity::new(Some(public));
        assert!(good.verify_signature(message, signature.as_ref()));
        let mut flipped = signature.as_ref().to_vec();
        flipped[10] ^= 1;
        assert!(!good.verify_signature(message, &flipped), "a flipped signature byte");
        assert!(!good.verify_signature(b"version: 1.2.1\n", signature.as_ref()), "a changed feed");
        assert!(!good.verify_signature(message, &signature.as_ref()[..63]), "a truncated signature");
        assert!(!Ed25519Integrity::new(Some([9u8; 32])).verify_signature(message, signature.as_ref()), "another key");
        assert!(!Ed25519Integrity::new(None).verify_signature(message, signature.as_ref()), "no key compiled in: nothing verifies");
    }

    /// A small release server: the "latest" alias redirects to a tag, files are served with Range support.
    struct Server {
        base: String,
        latest_tag: Arc<Mutex<String>>,
        requests: Arc<Mutex<Vec<String>>>,
        file_hits: Arc<AtomicUsize>,
        cut_at: Arc<AtomicU64>,
        stop: Arc<std::sync::atomic::AtomicBool>,
    }

    impl Drop for Server {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
        }
    }

    struct Truncated {
        data: std::io::Cursor<Vec<u8>>,
        fail_at_end: bool,
    }

    impl Read for Truncated {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            match self.data.read(buf)? {
                0 if self.fail_at_end => Err(std::io::Error::from(std::io::ErrorKind::ConnectionAborted)),
                n => Ok(n),
            }
        }
    }

    fn serve(files: Vec<(String, Vec<u8>)>) -> Server {
        let http = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}", http.server_addr().to_ip().unwrap());
        let latest_tag = Arc::new(Mutex::new("v1.2.0".to_string()));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let file_hits = Arc::new(AtomicUsize::new(0));
        let cut_at = Arc::new(AtomicU64::new(u64::MAX));
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (tag, log, hits, cut, halt) = (latest_tag.clone(), requests.clone(), file_hits.clone(), cut_at.clone(), stop.clone());
        std::thread::spawn(move || {
            while !halt.load(Ordering::SeqCst) {
                let Ok(Some(request)) = http.recv_timeout(Duration::from_millis(50)) else { continue };
                let url = request.url().to_string();
                log.lock().unwrap().push(url.clone());
                let prefix = "/o/r/releases/";
                if url == "/o/r/releases/latest/download/latest.yml" {
                    let location = format!("{prefix}download/{}/latest.yml", tag.lock().unwrap());
                    let _ = request.respond(tiny_http::Response::empty(302).with_header(tiny_http::Header::from_bytes("Location", location).unwrap()));
                    continue;
                }
                let name = url.rsplit('/').next().unwrap_or("").to_string();
                let found = files.iter().find(|(n, _)| *n == name).cloned();
                match found {
                    Some((_, body)) => {
                        hits.fetch_add(1, Ordering::SeqCst);
                        let start = request.headers().iter().find(|h| h.field.equiv("Range")).and_then(|h| h.value.as_str().strip_prefix("bytes=").and_then(|v| v.trim_end_matches('-').parse::<usize>().ok())).unwrap_or(0);
                        let cut_here = cut.load(Ordering::SeqCst) as usize;
                        let end = body.len().min(cut_here);
                        let slice = body[start.min(end)..end].to_vec();
                        let status = if start > 0 { 206 } else { 200 };
                        // A response cut short: the stream fails after the bytes it has, as a dropped connection does.
                        let cut_short = end < body.len();
                        let reader = Truncated { data: std::io::Cursor::new(slice), fail_at_end: cut_short };
                        let response = tiny_http::Response::new(tiny_http::StatusCode(status), vec![], reader, Some(body.len() - start), None);
                        let _ = request.respond(response);
                    }
                    None => {
                        let _ = request.respond(tiny_http::Response::empty(404));
                    }
                }
            }
        });
        Server { base, latest_tag, requests, file_hits, cut_at, stop }
    }

    fn endpoint(server: &Server) -> Endpoint {
        Endpoint { base: server.base.clone(), owner: "o".into(), repo: "r".into() }
    }

    fn file_info(name: &str, body: &[u8]) -> FileInfo {
        let dir = temp("hash");
        fs::write(dir.join("f"), body).unwrap();
        let sha512 = sha512_base64(&dir.join("f"), &|| false).unwrap().unwrap();
        let _ = fs::remove_dir_all(dir);
        FileInfo { name: name.into(), sha512, size: body.len() as u64 }
    }

    fn body(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i * 31 % 251) as u8).collect()
    }

    #[test]
    fn the_signature_and_the_feed_come_from_the_release_the_alias_named_even_if_another_is_published_between() {
        let server = serve(vec![("latest.yml".into(), b"version: 1.2.0\n".to_vec()), ("latest.yml.sig".into(), vec![5; 64])]);
        let feed = HttpFeed { endpoint: endpoint(&server) };
        let got = feed.fetch_feed().unwrap();
        assert_eq!((got.tag.as_str(), got.yml.as_slice(), got.signature.len()), ("v1.2.0", &b"version: 1.2.0\n"[..], 64));
        // The sig was asked for by tag, not through "latest" again: publishing 1.3.0 now cannot mix the two.
        *server.latest_tag.lock().unwrap() = "v1.3.0".into();
        let log = server.requests.lock().unwrap().clone();
        assert!(log.iter().any(|u| u == "/o/r/releases/download/v1.2.0/latest.yml.sig"), "{log:?}");
        assert_eq!(log.iter().filter(|u| u.contains("latest/download")).count(), 1, "the alias was resolved once");
    }

    #[test]
    fn a_redirect_off_the_allowed_hosts_is_refused() {
        let http = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}", http.server_addr().to_ip().unwrap());
        std::thread::spawn(move || {
            if let Ok(request) = http.recv() {
                let _ = request.respond(tiny_http::Response::empty(302).with_header(tiny_http::Header::from_bytes("Location", "http://evil.example/latest.yml").unwrap()));
            }
        });
        let feed = HttpFeed { endpoint: Endpoint { base, owner: "o".into(), repo: "r".into() } };
        assert!(feed.fetch_feed().unwrap_err().0.contains("refusing to follow"));
    }

    fn stage(server: &Server, root: &Path) -> HttpStage {
        HttpStage { root: root.to_path_buf(), endpoint: endpoint(server) }
    }

    #[test]
    fn a_download_is_verified_staged_under_an_immutable_name_and_reused() {
        let data = body(3 * 1024 * 1024 + 17);
        let info = file_info("Setup.exe", &data);
        let server = serve(vec![("Setup.exe".into(), data.clone())]);
        let root = temp("full");
        let reports = Cell::new(0u32);
        let path = stage(&server, &root).obtain("v1.2.0", "1.2.0", &info, &mut |t, total| {
            assert!(t <= total);
            reports.set(reports.get() + 1);
        }, &|| false).unwrap();
        assert_eq!(fs::read(&path).unwrap(), data);
        assert!(path.file_name().unwrap().to_string_lossy().starts_with("Setup-1.2.0-"));
        assert!(!root.join("1.2.0").join(LOCK_FILE).exists(), "the lock is released");
        assert_eq!(fs::read_dir(root.join("1.2.0")).unwrap().count(), 1, "only the verified file remains");
        let again = stage(&server, &root).obtain("v1.2.0", "1.2.0", &info, &mut |_, _| {}, &|| false).unwrap();
        assert_eq!((again, server.file_hits.load(Ordering::SeqCst)), (path, 1), "a staged and verified file is not downloaded again");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_wrong_hash_a_wrong_size_and_a_truncated_file_are_refused() {
        let data = body(1_000_000);
        let good = file_info("Setup.exe", &data);
        let server = serve(vec![("Setup.exe".into(), data.clone())]);
        let root = temp("bad");
        let st = stage(&server, &root);
        let wrong_hash = FileInfo { sha512: file_info("x", b"other").sha512, ..good.clone() };
        assert!(matches!(st.obtain("v1.2.0", "1.2.0", &wrong_hash, &mut |_, _| {}, &|| false), Err(StageError::Mismatch(_))));
        assert_eq!(fs::read_dir(root.join("1.2.0")).unwrap().count(), 0, "a file that failed its hash is deleted, not kept");
        let too_small = FileInfo { size: good.size - 1, ..good.clone() };
        assert!(matches!(st.obtain("v1.2.0", "1.2.0", &too_small, &mut |_, _| {}, &|| false), Err(StageError::Mismatch(_))), "larger than the feed says");
        server.cut_at.store(400_000, Ordering::SeqCst);
        assert!(matches!(st.obtain("v1.2.0", "1.2.0", &good, &mut |_, _| {}, &|| false), Err(StageError::Io(_))), "a truncated download");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_download_interrupted_at_40_percent_resumes_from_there() {
        let data = body(2_000_000);
        let info = file_info("Setup.exe", &data);
        let server = serve(vec![("Setup.exe".into(), data.clone())]);
        let root = temp("resume");
        let st = stage(&server, &root);
        server.cut_at.store(800_000, Ordering::SeqCst);
        assert!(st.obtain("v1.2.0", "1.2.0", &info, &mut |_, _| {}, &|| false).is_err());
        server.cut_at.store(u64::MAX, Ordering::SeqCst);
        let kept: Vec<u64> = fs::read_dir(root.join("1.2.0")).unwrap().filter_map(|e| e.ok()).filter(|e| staging::is_part_name(&e.file_name().to_string_lossy())).map(|e| e.metadata().unwrap().len()).collect();
        assert_eq!(kept.len(), 1, "the interrupted download left one partial file");
        assert!(kept[0] > 0 && kept[0] <= 800_000, "{}", kept[0]);
        let first_progress = Cell::new(u64::MAX);
        let path = st.obtain("v1.2.0", "1.2.0", &info, &mut |t, _| first_progress.set(first_progress.get().min(t)), &|| false).unwrap();
        assert_eq!(fs::read(&path).unwrap(), data);
        assert_eq!(first_progress.get(), kept[0], "the second attempt started from the bytes already on disk");
        let downloads = server.requests.lock().unwrap().iter().filter(|u| u.ends_with("Setup.exe")).count();
        assert_eq!(downloads, 2, "one interrupted request and one resuming request");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn two_processes_of_one_profile_download_once_and_both_get_the_same_verified_file() {
        let data = body(4_000_000);
        let info = file_info("Setup.exe", &data);
        let server = serve(vec![("Setup.exe".into(), data.clone())]);
        let root = temp("race");
        let results: Vec<PathBuf> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..4).map(|_| scope.spawn(|| stage(&server, &root).obtain("v1.2.0", "1.2.0", &info, &mut |_, _| {}, &|| false).unwrap())).collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });
        assert!(results.windows(2).all(|w| w[0] == w[1]));
        assert_eq!(fs::read(&results[0]).unwrap(), data);
        assert_eq!(server.file_hits.load(Ordering::SeqCst), 1, "one download for four callers");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_lock_file_left_behind_by_a_dead_process_holds_nothing() {
        let data = body(500_000);
        let info = file_info("Setup.exe", &data);
        let server = serve(vec![("Setup.exe".into(), data.clone())]);
        let root = temp("stale");
        let dir = root.join("1.2.0");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(LOCK_FILE), "4000000000 1
").unwrap();
        let path = stage(&server, &root).obtain("v1.2.0", "1.2.0", &info, &mut |_, _| {}, &|| false).unwrap();
        assert_eq!(fs::read(path).unwrap(), data);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_lock_held_by_a_live_process_makes_the_caller_wait_and_cancel_ends_the_wait() {
        let data = body(1000);
        let info = file_info("Setup.exe", &data);
        let server = serve(vec![("Setup.exe".into(), data)]);
        let root = temp("held");
        let dir = root.join("1.2.0");
        fs::create_dir_all(&dir).unwrap();
        let _holder = try_lock(&dir.join(LOCK_FILE)).unwrap().expect("the lock was free");
        let started = Instant::now();
        let polls = Cell::new(0);
        let outcome = stage(&server, &root).obtain("v1.2.0", "1.2.0", &info, &mut |_, _| {}, &|| {
            polls.set(polls.get() + 1);
            polls.get() > 5
        });
        assert_eq!(outcome, Err(StageError::Cancelled));
        assert!(started.elapsed() < Duration::from_secs(3));
        assert_eq!(server.file_hits.load(Ordering::SeqCst), 0, "a live holder is never raced");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_lock_whose_holder_is_alive_is_never_taken_however_old_its_record_or_odd_its_pid() {
        // The holder is alive: it has the lock file open. Its record says it started three hours ago, and names a pid that
        // does not exist. Neither age nor pid is evidence of death; only the holder's handle is.
        let data = body(1000);
        let info = file_info("Setup.exe", &data);
        let server = serve(vec![("Setup.exe".into(), data)]);
        let root = temp("live-holder");
        let dir = root.join("1.2.0");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(LOCK_FILE), "4000000000 1
").unwrap();
        let holder = OpenOptions::new().read(true).open(dir.join(LOCK_FILE)).unwrap();
        let polls = Cell::new(0);
        let outcome = stage(&server, &root).obtain("v1.2.0", "1.2.0", &info, &mut |_, _| {}, &|| {
            polls.set(polls.get() + 1);
            polls.get() > 5
        });
        assert_eq!(outcome, Err(StageError::Cancelled), "the caller waited");
        assert_eq!(server.file_hits.load(Ordering::SeqCst), 0, "nothing was downloaded alongside the holder");
        assert!(dir.join(LOCK_FILE).exists(), "the holder's lock was not deleted");
        drop(holder);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cancelling_a_running_download_stops_it_within_a_chunk() {
        let data = body(8_000_000);
        let info = file_info("Setup.exe", &data);
        let server = serve(vec![("Setup.exe".into(), data)]);
        let root = temp("cancel");
        let sent = Cell::new(0u64);
        let outcome = stage(&server, &root).obtain("v1.2.0", "1.2.0", &info, &mut |t, _| sent.set(t), &|| sent.get() > 1_000_000);
        assert_eq!(outcome, Err(StageError::Cancelled));
        assert!(sent.get() < 8_000_000);
        assert!(!root.join("1.2.0").join(LOCK_FILE).exists(), "the lock is released on cancel");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_held_installer_cannot_be_replaced_or_deleted_until_released() {
        let dir = temp("held-file");
        let path = dir.join("Setup.exe");
        fs::write(&path, b"MZ").unwrap();
        let info = file_info("Setup.exe", b"MZ");
        let held = HeldInstaller::open_verified(&path, &info, &|| false).unwrap();
        assert!(fs::remove_file(&path).is_err(), "deleting the held installer is refused");
        assert!(OpenOptions::new().write(true).open(&path).is_err(), "writing to it is refused");
        assert!(File::open(&path).is_ok(), "reading it (the installer's own access) is allowed");
        drop(held);
        assert!(fs::remove_file(&path).is_ok());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_staged_file_replaced_while_the_update_waited_is_not_held_or_run() {
        let dir = temp("swapped");
        let path = dir.join("Setup.exe");
        let good = body(100_000);
        let info = file_info("Setup.exe", &good);
        fs::write(&path, &good).unwrap();
        assert!(HeldInstaller::open_verified(&path, &info, &|| false).is_ok(), "the file the feed describes is accepted");
        // Same size, other bytes: replaced after it was verified and staged.
        let mut evil = good.clone();
        evil[5_000] ^= 0xff;
        fs::write(&path, &evil).unwrap();
        assert!(matches!(HeldInstaller::open_verified(&path, &info, &|| false), Err(StageError::Mismatch(_))), "the swapped file is refused");
        // Another size.
        fs::write(&path, &good[..good.len() - 1]).unwrap();
        assert!(matches!(HeldInstaller::open_verified(&path, &info, &|| false), Err(StageError::Mismatch(_))));
        // Gone.
        fs::remove_file(&path).unwrap();
        assert!(HeldInstaller::open_verified(&path, &info, &|| false).is_err());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn our_own_process_is_alive_and_an_absurd_pid_is_not() {
        assert!(process_alive(std::process::id()));
        assert!(!process_alive(4_000_000_000));
    }
}
