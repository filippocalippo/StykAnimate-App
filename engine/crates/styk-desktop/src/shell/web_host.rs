//! The window's own origin: the `styk-app` scheme, answered here (no sockets), with today's rules from
//! `desktop/web-host.cjs`. On Windows WebView2 sees it as `http://styk-app.localhost/`.
//!
//! Every answer carries COOP `same-origin`, COEP `require-corp` and CORP `same-origin`: the engine's worker threads
//! share one WebAssembly memory, and cancelling a Pivot import flags the codec through shared memory, so the page
//! must be cross-origin isolated (docs/engine/decisions/0003-threaded-webassembly.md).
//!
//! The assets are the page's files, read-only. A development copy reads them from the source tree (also `tests` and
//! `artifacts`, as `npm run serve` does), with the app bundle (`STYK_BUNDLE_DIR`, scripts/build-app.mjs) answering in
//! place of the same paths; the packaged app serves the staged copy embedded in the executable
//! (scripts/tauri-stage-web.mjs, which lays the bundle over the modules the same way).

use std::borrow::Cow;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde_json::json;
use tauri::http::{Request, Response, StatusCode, header};
use tauri::{AppHandle, Runtime};

pub const SCHEME: &str = "styk-app";

/// The address the window loads.
pub fn origin() -> &'static str {
    if cfg!(any(windows, target_os = "android")) { "http://styk-app.localhost/" } else { "styk-app://localhost/" }
}

/// Whether `url` is a page of the app's own origin (how navigation recognises the editor page).
pub fn owns(url: &url::Url) -> bool {
    match url.scheme() {
        "http" => {
            cfg!(any(windows, target_os = "android")) && url.host_str() == Some("styk-app.localhost") && url.port().is_none()
        }
        SCHEME => url.host_str() == Some("localhost"),
        _ => false,
    }
}

fn mime(extension: &str) -> Option<&'static str> {
    Some(match extension {
        "html" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "wasm" => "application/wasm",
        _ => return None,
    })
}

/// A request that fails: its status, code and message key (`desktop.webHost.errors.*`).
#[derive(Debug, PartialEq, Eq)]
pub struct Refusal {
    pub status: u16,
    pub code: &'static str,
    pub key: &'static str,
}

const fn refusal(status: u16, code: &'static str, key: &'static str) -> Refusal {
    Refusal { status, code, key }
}
const FORBIDDEN: Refusal = refusal(403, "resource_forbidden", "desktop.webHost.errors.resourceForbidden");
const NOT_FOUND: Refusal = refusal(404, "file_not_found", "desktop.webHost.errors.fileNotFound");
const UNREADABLE: Refusal = refusal(500, "file_error", "desktop.webHost.errors.resourceUnreadable");

fn extension_of(relative: &str) -> String {
    Path::new(relative).extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).unwrap_or_default()
}

/// The relative path a request names, under today's rules: only the page's own files and folders, nothing hidden,
/// no drive or backslash, and only types the page loads.
pub fn checked_path(pathname: &str, development: bool) -> Result<(String, &'static str), Refusal> {
    let decoded = percent_encoding::percent_decode_str(pathname)
        .decode_utf8()
        .map_err(|_| refusal(400, "invalid_path", "desktop.webHost.errors.invalidPath"))?;
    let relative = match decoded.strip_prefix('/').unwrap_or(&decoded) {
        "" => "index.html".to_owned(),
        other => other.to_owned(),
    };
    let parts: Vec<&str> = relative.split('/').collect();
    let folders: &[&str] =
        if development { &["src", "vendor", "assets", "tests", "artifacts"] } else { &["src", "vendor", "assets"] };
    let extension = extension_of(&relative);
    if relative.contains('\\')
        || relative.contains(':')
        || parts.iter().any(|part| part.starts_with('.'))
        || (parts.len() > 1 && !folders.contains(&parts[0]))
        || (parts.len() == 1 && !["html", "css", "svg", "png", "ico"].contains(&extension.as_str()))
    {
        return Err(FORBIDDEN);
    }
    let kind = mime(&extension).ok_or(FORBIDDEN)?;
    Ok((relative, kind))
}

/// One answer: status, type, entity tag, length and body (empty for HEAD and 304).
struct Answer {
    status: u16,
    kind: &'static str,
    etag: String,
    length: usize,
    body: Vec<u8>,
}

type Reader = Box<dyn Fn(&str) -> Option<Vec<u8>> + Send + Sync>;

/// Where the page's files come from.
pub enum WebAssets {
    /// The source tree, and the bundle laid over it.
    Disk { root: PathBuf, bundle: Option<(PathBuf, HashSet<String>)> },
    /// The staged copy embedded in the executable.
    Embedded { read: Reader, stamp: String },
}

fn list_files(root: &Path, prefix: &str, found: &mut HashSet<String>) {
    let Ok(entries) = std::fs::read_dir(root.join(prefix)) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let relative = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            list_files(root, &relative, found);
        } else {
            found.insert(relative.to_lowercase());
        }
    }
}

impl WebAssets {
    /// The source tree at `root`, with `bundle` (an app bundle folder) answering in place of its files.
    pub fn disk(root: &Path, bundle: Option<&Path>) -> std::io::Result<Self> {
        let root = canonical(root)?;
        let bundle = match bundle {
            Some(path) => {
                let path = canonical(path)?;
                let mut files = HashSet::new();
                list_files(&path, "", &mut files);
                Some((path, files))
            }
            None => None,
        };
        Ok(Self::Disk { root, bundle })
    }

    /// The assets embedded in the executable.
    pub fn embedded<R: Runtime>(app: &AppHandle<R>) -> Self {
        let handle = app.clone();
        Self::Embedded {
            read: Box::new(move |relative| handle.asset_resolver().get(relative.to_owned()).map(|asset| asset.bytes)),
            stamp: format!("{}-{}", app.package_info().version, env!("STYK_BUILD_STAMP")),
        }
    }

    pub fn development(&self) -> bool {
        matches!(self, Self::Disk { .. })
    }

    /// The bytes of one of the page's files, for the native side's own use (the text catalogs).
    pub fn read(&self, relative: &str) -> Option<Vec<u8>> {
        let (relative, kind) = checked_path(&format!("/{relative}"), self.development()).ok()?;
        self.load(&relative, kind, "GET", "").ok().map(|answer| answer.body)
    }

    fn load(&self, relative: &str, kind: &'static str, method: &str, if_none_match: &str) -> Result<Answer, Refusal> {
        let tags: Vec<&str> = if_none_match.split(',').map(|tag| tag.trim().trim_start_matches("W/")).collect();
        let (etag, length, bytes) = match self {
            Self::Disk { root, bundle } => {
                let base = match bundle {
                    Some((path, files)) if files.contains(&relative.to_lowercase()) => path,
                    _ => root,
                };
                let target = match canonical(&base.join(relative)) {
                    Ok(target) => target,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Err(NOT_FOUND),
                    Err(_) => return Err(UNREADABLE),
                };
                if !target.starts_with(base) {
                    return Err(refusal(403, "path_forbidden", "desktop.webHost.errors.pathForbidden"));
                }
                let meta = std::fs::metadata(&target).map_err(|_| NOT_FOUND)?;
                if !meta.is_file() {
                    return Err(NOT_FOUND);
                }
                let modified = meta
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_nanos())
                    .unwrap_or(0);
                let etag = format!("\"{modified:x}-{:x}\"", meta.len());
                let unchanged = tags.iter().any(|tag| *tag == "*" || *tag == etag);
                let bytes = if unchanged || method == "HEAD" {
                    None
                } else {
                    Some(std::fs::read(&target).map_err(|_| UNREADABLE)?)
                };
                (etag, meta.len() as usize, bytes)
            }
            Self::Embedded { read, stamp } => {
                let bytes = read(relative).ok_or(NOT_FOUND)?;
                let etag = format!("\"{stamp}-{:x}\"", bytes.len());
                (etag, bytes.len(), Some(bytes))
            }
        };
        let unchanged = tags.iter().any(|tag| *tag == "*" || *tag == etag);
        let body = if unchanged || method == "HEAD" { Vec::new() } else { bytes.unwrap_or_default() };
        Ok(Answer { status: if unchanged { 304 } else { 200 }, kind, etag, length, body })
    }

    /// Answers one request of the app scheme. Only GET and HEAD, only the app's host.
    pub fn answer(&self, request: &Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
        let result = (|| {
            let uri = request.uri();
            let host = uri.host().unwrap_or("");
            if !(host == "styk-app.localhost" || host == "localhost") {
                return Err(refusal(403, "host_forbidden", "desktop.webHost.errors.hostForbidden"));
            }
            let method = request.method().as_str();
            if method != "GET" && method != "HEAD" {
                return Err(refusal(405, "method_not_allowed", "desktop.webHost.errors.resourcesReadOnly"));
            }
            let (relative, kind) = checked_path(uri.path(), self.development())?;
            let if_none_match =
                request.headers().get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()).unwrap_or("");
            let mut answer = self.load(&relative, kind, method, if_none_match)?;
            if relative == "index.html" && !answer.body.is_empty() {
                answer.body = allow_ipc(&answer.body);
                answer.length = answer.body.len();
            }
            Ok(answer)
        })();
        match result {
            Ok(answer) => Response::builder()
                .status(StatusCode::from_u16(answer.status).unwrap_or(StatusCode::OK))
                .header(header::CONTENT_TYPE, answer.kind)
                .header(header::CONTENT_LENGTH, if answer.status == 304 { 0 } else { answer.length }.to_string())
                .header(header::ETAG, answer.etag)
                .header(header::CACHE_CONTROL, "no-cache")
                .header("X-Content-Type-Options", "nosniff")
                .header("Referrer-Policy", "no-referrer")
                .header("Cross-Origin-Opener-Policy", "same-origin")
                .header("Cross-Origin-Embedder-Policy", "require-corp")
                .header("Cross-Origin-Resource-Policy", "same-origin")
                .body(Cow::Owned(answer.body))
                .unwrap_or_else(|_| failure(&UNREADABLE)),
            Err(refusal) => failure(&refusal),
        }
    }
}

/// The page's own policy (`index.html`) lets it connect to its origin only; Tauri's IPC is a fetch to its own origin
/// (`http://ipc.localhost` on Windows, `ipc:` elsewhere). Without it every call falls back to `postMessage`, where an
/// answer's bytes become a JSON array of numbers and a request's raw bytes do not arrive at all. Only that origin is
/// added; the rest of the policy is the page's.
fn allow_ipc(html: &[u8]) -> Vec<u8> {
    let text = String::from_utf8_lossy(html);
    text.replacen("connect-src 'self'", "connect-src 'self' http://ipc.localhost ipc:", 1).into_bytes()
}

/// The JSON answer to a request that failed, as today.
fn failure(refusal: &Refusal) -> Response<Cow<'static, [u8]>> {
    let message = super::text::t0(refusal.key);
    let data = serde_json::to_vec(
        &json!({"ok": false, "code": refusal.code, "error": message, "messageKey": refusal.key, "messageParams": {}}),
    )
    .unwrap_or_default();
    Response::builder()
        .status(StatusCode::from_u16(refusal.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR))
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CONTENT_LENGTH, data.len().to_string())
        .header(header::CACHE_CONTROL, "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header("Cross-Origin-Resource-Policy", "same-origin")
        .body(Cow::Owned(data))
        .expect("a fixed response")
}

/// `canonicalize` without Windows' `\\?\` prefix, so `starts_with` compares like paths.
pub fn canonical(path: &Path) -> std::io::Result<PathBuf> {
    let canonical = std::fs::canonicalize(path)?;
    #[cfg(windows)]
    {
        let text = canonical.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\")
            && !rest.starts_with("UNC\\")
        {
            return Ok(PathBuf::from(rest));
        }
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_page_may_reach_tauris_ipc_and_nothing_else_more() {
        let page = br#"<meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self'; worker-src 'self' blob:">"#;
        assert_eq!(String::from_utf8(allow_ipc(page)).unwrap(), r#"<meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self' http://ipc.localhost ipc:; worker-src 'self' blob:">"#);
        let index = std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../index.html")).unwrap();
        assert!(String::from_utf8(allow_ipc(&index)).unwrap().contains("connect-src 'self' http://ipc.localhost ipc:;"), "index.html keeps the directive this relies on");
    }

    #[test]
    fn paths_follow_todays_rules() {
        assert_eq!(checked_path("/", false).unwrap().0, "index.html");
        assert_eq!(checked_path("/src/app.mjs", false).unwrap(), ("src/app.mjs".into(), "text/javascript"));
        assert_eq!(checked_path("/src/engine/pkg/styk_engine_bg.wasm", false).unwrap().1, "application/wasm");
        assert_eq!(checked_path("/tests/x.html", false), Err(FORBIDDEN));
        assert!(checked_path("/tests/x.html", true).is_ok());
        assert_eq!(checked_path("/package.json", false), Err(FORBIDDEN));
        assert_eq!(checked_path("/src/.hidden/a.mjs", false), Err(FORBIDDEN));
        assert_eq!(checked_path("/src/a%5Cb.mjs", false), Err(FORBIDDEN));
        assert_eq!(checked_path("/src/C:/a.mjs", false), Err(FORBIDDEN));
        assert_eq!(checked_path("/src/a.exe", false), Err(FORBIDDEN));
        assert_eq!(checked_path("/src/%2e%2e/x.mjs", false), Err(FORBIDDEN));
        assert_eq!(checked_path("/%FF", false).unwrap_err().status, 400);
        assert!(owns(&url::Url::parse(origin()).unwrap()));
        assert!(!owns(&url::Url::parse("https://example.com/").unwrap()));
    }

    #[test]
    fn disk_assets_answer_with_isolation_headers_and_the_bundle_first() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("src")).unwrap();
        std::fs::write(root.path().join("index.html"), "<p>").unwrap();
        std::fs::write(root.path().join("src/app.mjs"), "modules").unwrap();
        let bundle = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(bundle.path().join("src")).unwrap();
        std::fs::write(bundle.path().join("src/app.mjs"), "bundle").unwrap();
        let assets = WebAssets::disk(root.path(), Some(bundle.path())).unwrap();
        let request = |method: &str, host: &str, path: &str| {
            Request::builder().method(method).uri(format!("http://{host}{path}")).body(Vec::new()).unwrap()
        };
        let page = assets.answer(&request("GET", "styk-app.localhost", "/"));
        assert_eq!(page.status(), 200);
        assert_eq!(page.headers()["Cross-Origin-Opener-Policy"], "same-origin");
        assert_eq!(page.headers()["Cross-Origin-Embedder-Policy"], "require-corp");
        assert_eq!(page.headers()["Cross-Origin-Resource-Policy"], "same-origin");
        assert_eq!(&**assets.answer(&request("GET", "styk-app.localhost", "/src/app.mjs")).body(), b"bundle");
        assert_eq!(assets.answer(&request("GET", "styk-app.localhost", "/src/missing.mjs")).status(), 404);
        assert_eq!(assets.answer(&request("GET", "evil.localhost", "/")).status(), 403);
        assert_eq!(assets.answer(&request("POST", "styk-app.localhost", "/")).status(), 405);
        let etag = page.headers()[header::ETAG].to_str().unwrap().to_owned();
        let again = assets.answer(
            &Request::builder()
                .uri("http://styk-app.localhost/")
                .header(header::IF_NONE_MATCH, etag)
                .body(Vec::new())
                .unwrap(),
        );
        assert_eq!(again.status(), 304);
        assert!(again.body().is_empty());
        assert_eq!(assets.read("src/app.mjs").unwrap(), b"bundle");
    }
}
