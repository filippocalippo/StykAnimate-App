//! Installed fonts of this machine: a bounded, cancellable walk of the conventional font folders.
//!
//! The walk is `desktop/font-service.cjs`'s, step for step: only the system and per-user font folders (no registry, no
//! home scan), real paths contained in an allowed root (a link that leaves one is skipped), at most 20,000 files and
//! 2,048 folders, eight levels deep, 4,096 faces; every file is validated by `styk_services::fonts::inspect_file`
//! before any parser sees it. Reads re-check the path and the file's fingerprint, repack collection faces, and keep
//! at most eight recent fonts (64 MiB) in memory.

use std::cmp::Ordering as Collation;
use std::collections::HashMap;
use std::fs::File;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, SystemTime};

use sha2::{Digest, Sha256};
use styk_services::fonts::{
    inspect_file, standalone_face, FontError, FontFace, FontId, FontService, InspectedFace, ReadAt, CACHE_BYTES, CACHE_COUNT,
    MAX_ACTIVE_READS, MAX_CONTAINER_BYTES, MAX_DEPTH, MAX_DIRECTORIES, MAX_FILES, MAX_FONTS,
};

const EXTENSIONS: [&str; 4] = ["ttf", "otf", "ttc", "otc"];
/// How often a waiting call looks at its cancel callback.
const POLL: Duration = Duration::from_millis(20);
/// A read of a file checks for cancellation after this many bytes.
const CHUNK: usize = 256 * 1024;

/// The folders of the platform, as `systemFontDirectories` lists them. `var` reads an environment variable.
pub fn system_font_directories(platform: &str, var: &dyn Fn(&str) -> Option<String>, home: &Path) -> Vec<PathBuf> {
    match platform {
        "windows" => {
            let root = var("SystemRoot").or_else(|| var("WINDIR")).unwrap_or_else(|| "C:\\Windows".to_string());
            let mut folders = vec![PathBuf::from(root).join("Fonts")];
            if let Some(local) = var("LOCALAPPDATA") {
                folders.push(PathBuf::from(local).join("Microsoft").join("Windows").join("Fonts"));
            }
            folders
        }
        "macos" => vec![PathBuf::from("/System/Library/Fonts"), PathBuf::from("/Library/Fonts"), home.join("Library/Fonts")],
        _ => vec![
            PathBuf::from("/usr/share/fonts"),
            PathBuf::from("/usr/local/share/fonts"),
            home.join(".local/share/fonts"),
            home.join(".fonts"),
        ],
    }
}

/// The folders of the machine the program runs on.
pub fn default_font_directories() -> Vec<PathBuf> {
    let platform = if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    };
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from).unwrap_or_default();
    system_font_directories(platform, &|name| std::env::var(name).ok(), &home)
}

/// The canonical form of a path, without the `\\?\` prefix Windows adds.
pub fn canonical(path: &Path) -> std::io::Result<PathBuf> {
    real_path(path)
}

thread_local! {
    // The root collation of CLDR 44, which is what ICU 74 (today's Electron) gives `localeCompare(_, "en")`: English has no tailoring.
    // A collator is not `Sync`, so each thread that sorts builds its own (a scan sorts on one thread).
    static COLLATOR: icu_collator::Collator = icu_collator::Collator::try_new(&Default::default(), icu_collator::CollatorOptions::new())
        .expect("the compiled collation data");
}

/// The order of names and families: ICU's English collation, as `localeCompare(_, "en")` gives it.
pub fn compare_text(a: &str, b: &str) -> Collation {
    COLLATOR.with(|collator| collator.compare(a, b))
}

/// The list order of a scan: family, style, then id.
fn compare_faces(a: &FontFace, b: &FontFace) -> Collation {
    compare_text(&a.family, &b.family).then_with(|| compare_text(&a.style, &b.style)).then_with(|| a.id.cmp(&b.id))
}

/// Canonical form without the `\\?\` prefix Windows adds.
fn real_path(path: &Path) -> std::io::Result<PathBuf> {
    let real = std::fs::canonicalize(path)?;
    let text = real.to_string_lossy();
    Ok(match text.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => PathBuf::from(rest),
        _ => real,
    })
}

fn fold(component: Component) -> String {
    let text = component.as_os_str().to_string_lossy().to_string();
    if cfg!(windows) { text.to_lowercase() } else { text }
}

/// `inside(file, root)`: the path is the root or below it.
fn inside(file: &Path, root: &Path) -> bool {
    let mut a = file.components();
    for r in root.components() {
        match a.next() {
            Some(c) if fold(c) == fold(r) => {}
            _ => return false,
        }
    }
    true
}

fn is_link(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_type().is_symlink() || metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

/// A file read at offsets, checking the caller's cancel callback between chunks.
struct FileSource<'a> {
    file: File,
    length: u64,
    cancel: &'a dyn Fn() -> bool,
}

impl ReadAt for FileSource<'_> {
    fn len(&self) -> u64 {
        self.length
    }
    fn read_exact_at(&mut self, offset: u64, buffer: &mut [u8]) -> Result<(), FontError> {
        let mut done = 0;
        while done < buffer.len() {
            if (self.cancel)() {
                return Err(FontError::Cancelled);
            }
            let end = (done + CHUNK).min(buffer.len());
            let n = read_at(&self.file, offset + done as u64, &mut buffer[done..end])?;
            if n == 0 {
                return Err(FontError::Changed);
            }
            done += n;
        }
        Ok(())
    }
}

fn read_at(file: &File, offset: u64, buffer: &mut [u8]) -> Result<usize, FontError> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileExt;
        file.seek_read(buffer, offset).map_err(|e| FontError::Io(e.to_string()))
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileExt;
        file.read_at(buffer, offset).map_err(|e| FontError::Io(e.to_string()))
    }
}

/// What identifies the file that was validated: its size and time, and which file it is (volume and file index on Windows,
/// device and inode elsewhere), all read from the open handle so that no other file can stand in for it.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Fingerprint {
    size: u64,
    modified: Option<SystemTime>,
    identity: (u64, u64),
}

fn fingerprint(file: &File) -> Result<Fingerprint, FontError> {
    let io = |e: std::io::Error| FontError::Io(e.to_string());
    let metadata = file.metadata().map_err(io)?;
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        (metadata.dev(), metadata.ino())
    };
    #[cfg(windows)]
    let identity = {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION};
        // SAFETY: `info` is a plain struct the call fills in, and the handle stays open for the call.
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) } == 0 {
            return Err(io(std::io::Error::last_os_error()));
        }
        (info.dwVolumeSerialNumber as u64, (info.nFileIndexHigh as u64) << 32 | info.nFileIndexLow as u64)
    };
    Ok(Fingerprint { size: metadata.len(), modified: metadata.modified().ok(), identity })
}

/// The path the open handle really names, so a link swapped in between resolving a path and opening it is seen.
#[cfg(windows)]
fn path_of_handle(file: &File) -> Result<PathBuf, FontError> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{GetFinalPathNameByHandleW, FILE_NAME_NORMALIZED};
    let mut buffer = vec![0u16; 1024];
    loop {
        // SAFETY: the buffer and its length are passed together; the handle stays open for the call.
        let n = unsafe { GetFinalPathNameByHandleW(file.as_raw_handle() as _, buffer.as_mut_ptr(), buffer.len() as u32, FILE_NAME_NORMALIZED) } as usize;
        if n == 0 {
            return Err(FontError::Io(std::io::Error::last_os_error().to_string()));
        }
        if n < buffer.len() {
            let text = String::from_utf16_lossy(&buffer[..n]);
            return Ok(PathBuf::from(text.strip_prefix(r"\\?\").unwrap_or(&text)));
        }
        buffer.resize(n + 1, 0);
    }
}

struct Entry {
    path: PathBuf,
    collection: bool,
    face: InspectedFace,
    fingerprint: Fingerprint,
}

/// What a finished scan holds.
struct Scan {
    roots: Vec<PathBuf>,
    list: Arc<[FontFace]>,
    entries: HashMap<FontId, Entry>,
}

/// Counters of the last scan, for tests and diagnostics.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ScanStats {
    pub directories: usize,
    pub candidates: usize,
    pub skipped: usize,
    pub faces: usize,
}

enum State {
    Idle,
    Scanning,
    Done(Arc<Scan>),
}

struct Cache {
    fonts: Vec<(FontId, Arc<[u8]>)>,
    bytes: u64,
}

/// The installed fonts of a set of folders.
pub struct SystemFonts {
    directories: Vec<PathBuf>,
    max_fonts: usize,
    max_depth: usize,
    state: Mutex<State>,
    changed: Condvar,
    stats: Mutex<ScanStats>,
    cache: Mutex<Cache>,
    reading: Mutex<()>,
    active_reads: AtomicUsize,
}

impl SystemFonts {
    /// The folders of this machine.
    pub fn new() -> SystemFonts {
        SystemFonts::with_directories(default_font_directories())
    }

    /// Trusted absolute folders (a relative one is ignored, as the JavaScript service refuses to start with one).
    pub fn with_directories(directories: Vec<PathBuf>) -> SystemFonts {
        SystemFonts {
            directories: directories.into_iter().filter(|d| d.is_absolute()).collect(),
            max_fonts: MAX_FONTS,
            max_depth: MAX_DEPTH,
            state: Mutex::new(State::Idle),
            changed: Condvar::new(),
            stats: Mutex::new(ScanStats::default()),
            cache: Mutex::new(Cache { fonts: Vec::new(), bytes: 0 }),
            reading: Mutex::new(()),
            active_reads: AtomicUsize::new(0),
        }
    }

    /// Lowers the number of faces a scan lists (tests).
    pub fn with_max_fonts(mut self, max_fonts: usize) -> SystemFonts {
        self.max_fonts = max_fonts.clamp(1, 10_000);
        self
    }

    pub fn stats(&self) -> ScanStats {
        self.stats.lock().expect("font stats").clone()
    }

    fn scan_result(&self, cancel: &dyn Fn() -> bool) -> Result<Arc<Scan>, FontError> {
        loop {
            let mut state = self.state.lock().expect("font service state");
            match &*state {
                State::Done(scan) => return Ok(scan.clone()),
                State::Idle => {
                    *state = State::Scanning;
                    drop(state);
                    let result = self.scan(cancel);
                    let mut state = self.state.lock().expect("font service state");
                    *state = match &result {
                        Ok(scan) => State::Done(scan.clone()),
                        Err(_) => State::Idle,
                    };
                    self.changed.notify_all();
                    return result;
                }
                State::Scanning => {
                    // Another call is scanning: wait for it, looking at our own cancel callback.
                    let (guard, _) = self.changed.wait_timeout(state, POLL).expect("font service state");
                    drop(guard);
                    if cancel() {
                        return Err(FontError::Cancelled);
                    }
                }
            }
        }
    }

    fn scan(&self, cancel: &dyn Fn() -> bool) -> Result<Arc<Scan>, FontError> {
        let mut stats = ScanStats::default();
        let mut roots: Vec<PathBuf> = Vec::new();
        for directory in &self.directories {
            if let Ok(real) = real_path(directory) {
                if !roots.contains(&real) && real.is_dir() {
                    roots.push(real);
                }
            }
        }
        let mut visited: Vec<PathBuf> = Vec::new();
        let mut files: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
        let mut entries: HashMap<FontId, Entry> = HashMap::new();
        let mut queue: std::collections::VecDeque<(PathBuf, usize)> = roots.iter().map(|r| (r.clone(), 0)).collect();
        while let Some((directory, depth)) = queue.pop_front() {
            if entries.len() >= self.max_fonts || visited.len() >= MAX_DIRECTORIES || files.len() >= MAX_FILES {
                break;
            }
            if cancel() {
                return Err(FontError::Cancelled);
            }
            let Ok(real) = real_path(&directory) else { continue };
            if visited.contains(&real) || !roots.iter().any(|root| inside(&real, root)) {
                continue;
            }
            visited.push(real.clone());
            stats.directories += 1;
            let Ok(read) = std::fs::read_dir(&real) else { continue };
            let mut contents: Vec<(String, std::fs::DirEntry)> =
                read.filter_map(|e| e.ok()).map(|e| (e.file_name().to_string_lossy().to_string(), e)).collect();
            contents.sort_by(|a, b| compare_text(&a.0, &b.0));
            for (name, item) in contents {
                if entries.len() >= self.max_fonts || files.len() >= MAX_FILES {
                    break;
                }
                if cancel() {
                    return Err(FontError::Cancelled);
                }
                match self.visit(&real, &name, &item, depth, &roots, &mut queue, &mut files, &mut entries, &mut stats, cancel) {
                    Ok(()) => {}
                    Err(FontError::Cancelled) => return Err(FontError::Cancelled),
                    Err(_) => stats.skipped += 1,
                }
            }
        }
        let mut faces: Vec<FontFace> = entries
            .iter()
            .map(|(id, entry)| FontFace {
                id: id.clone(),
                family: entry.face.names.family.clone(),
                style: entry.face.names.style.clone(),
                full_name: entry.face.names.full_name.clone(),
                post_script_name: entry.face.names.post_script_name.clone(),
                format: entry.face.directory.format,
                collection: entry.collection,
                byte_length: entry.face.byte_length,
            })
            .collect();
        faces.sort_by(compare_faces);
        stats.faces = faces.len();
        *self.stats.lock().expect("font stats") = stats;
        Ok(Arc::new(Scan { roots, list: faces.into(), entries }))
    }

    #[allow(clippy::too_many_arguments)]
    fn visit(
        &self,
        real: &Path,
        name: &str,
        item: &std::fs::DirEntry,
        depth: usize,
        roots: &[PathBuf],
        queue: &mut std::collections::VecDeque<(PathBuf, usize)>,
        files: &mut std::collections::HashSet<PathBuf>,
        entries: &mut HashMap<FontId, Entry>,
        stats: &mut ScanStats,
        cancel: &dyn Fn() -> bool,
    ) -> Result<(), FontError> {
        let full = real.join(name);
        let io = |e: std::io::Error| FontError::Io(e.to_string());
        let link = is_link(&item.metadata().map_err(io)?);
        let actual = if link { real_path(&full).map_err(io)? } else { full };
        if !roots.iter().any(|root| inside(&actual, root)) {
            return Ok(());
        }
        let metadata = std::fs::metadata(&actual).map_err(io)?;
        if metadata.is_dir() && depth < self.max_depth {
            queue.push_back((actual, depth + 1));
            return Ok(());
        }
        let name_extension = Path::new(name).extension().map(|e| e.to_string_lossy().to_lowercase());
        if !name_extension.as_deref().is_some_and(|e| EXTENSIONS.contains(&e)) || files.contains(&actual) {
            return Ok(());
        }
        if !metadata.is_file() {
            return Ok(());
        }
        files.insert(actual.clone());
        stats.candidates += 1;
        self.inspect(&actual, name, entries, stats, cancel)
    }

    fn inspect(
        &self,
        path: &Path,
        display_name: &str,
        entries: &mut HashMap<FontId, Entry>,
        stats: &mut ScanStats,
        cancel: &dyn Fn() -> bool,
    ) -> Result<(), FontError> {
        let file = File::open(path).map_err(|e| FontError::Io(e.to_string()))?;
        let opened = file.metadata().map_err(|e| FontError::Io(e.to_string()))?;
        if !opened.is_file() || opened.len() > MAX_CONTAINER_BYTES {
            return Err(FontError::TooLarge);
        }
        let mut source = FileSource { file, length: opened.len(), cancel };
        let remaining = self.max_fonts - entries.len();
        let (collection, faces) = inspect_file(&mut source, display_name, remaining, cancel, &mut stats.skipped)?;
        let print = fingerprint(&source.file)?;
        for face in faces {
            let id = font_id(path, face.index);
            entries.insert(id, Entry { path: path.to_path_buf(), collection, face, fingerprint: print.clone() });
        }
        Ok(())
    }

    fn cached(&self, id: &FontId) -> Option<Arc<[u8]>> {
        let mut cache = self.cache.lock().expect("font cache");
        let at = cache.fonts.iter().position(|(cached, _)| cached == id)?;
        let item = cache.fonts.remove(at);
        let bytes = item.1.clone();
        cache.fonts.push(item);
        Some(bytes)
    }

    fn remember(&self, id: &FontId, data: &Arc<[u8]>) {
        let mut cache = self.cache.lock().expect("font cache");
        if data.len() as u64 > CACHE_BYTES {
            return;
        }
        while !cache.fonts.is_empty() && (cache.bytes + data.len() as u64 > CACHE_BYTES || cache.fonts.len() >= CACHE_COUNT) {
            let (_, old) = cache.fonts.remove(0);
            cache.bytes -= old.len() as u64;
        }
        cache.fonts.push((id.clone(), data.clone()));
        cache.bytes += data.len() as u64;
    }

    fn read_entry(&self, entry: &Entry, scan: &Scan, cancel: &dyn Fn() -> bool) -> Result<Arc<[u8]>, FontError> {
        let io = |e: std::io::Error| FontError::Io(e.to_string());
        let real = real_path(&entry.path).map_err(|_| FontError::Unavailable)?;
        let same = if cfg!(windows) { real.to_string_lossy().to_lowercase() == entry.path.to_string_lossy().to_lowercase() } else { real == entry.path };
        if !same || !scan.roots.iter().any(|root| inside(&real, root)) {
            return Err(FontError::Changed);
        }
        let file = File::open(&real).map_err(io)?;
        let metadata = file.metadata().map_err(io)?;
        // What was opened must be the file that was validated: the same file (not merely one of the same size and time),
        // and, on Windows, still at the path the walk found it by and inside a root.
        if !metadata.is_file() || fingerprint(&file)? != entry.fingerprint {
            return Err(FontError::Changed);
        }
        #[cfg(windows)]
        {
            let opened = path_of_handle(&file)?;
            if opened.to_string_lossy().to_lowercase() != entry.path.to_string_lossy().to_lowercase() || !scan.roots.iter().any(|root| inside(&opened, root)) {
                return Err(FontError::Changed);
            }
        }
        let mut source = FileSource { file, length: metadata.len(), cancel };
        let data = if entry.collection {
            standalone_face(&mut source, &entry.face, cancel)?
        } else {
            let mut buffer = vec![0u8; metadata.len() as usize];
            source.read_exact_at(0, &mut buffer)?;
            buffer
        };
        let after = source.file.metadata().map_err(io)?;
        if after.len() != metadata.len() || after.modified().ok() != metadata.modified().ok() {
            return Err(FontError::Changed);
        }
        Ok(Arc::from(data.into_boxed_slice()))
    }
}

impl Default for SystemFonts {
    fn default() -> SystemFonts {
        SystemFonts::new()
    }
}

/// `font_` and the first 32 hexadecimal digits of SHA-256 of the real path (lower-cased on Windows), a NUL and the face number.
pub fn font_id(path: &Path, face: u32) -> FontId {
    let text = path.to_string_lossy();
    let text = if cfg!(windows) { text.to_lowercase() } else { text.to_string() };
    let digest = Sha256::digest(format!("{text}\0{face}").as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    FontId::from_digest_hex(&hex)
}

struct ReadGuard<'a>(&'a AtomicUsize);

impl Drop for ReadGuard<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

impl FontService for SystemFonts {
    fn list(&self, cancel: &dyn Fn() -> bool) -> Result<Arc<[FontFace]>, FontError> {
        Ok(self.scan_result(cancel)?.list.clone())
    }

    fn read(&self, id: &FontId, cancel: &dyn Fn() -> bool) -> Result<Arc<[u8]>, FontError> {
        if self.active_reads.fetch_add(1, Ordering::AcqRel) >= MAX_ACTIVE_READS {
            self.active_reads.fetch_sub(1, Ordering::AcqRel);
            return Err(FontError::TooManyReads);
        }
        let _active = ReadGuard(&self.active_reads);
        let scan = self.scan_result(cancel)?;
        let entry = scan.entries.get(id).ok_or(FontError::Unavailable)?;
        if let Some(bytes) = self.cached(id) {
            return Ok(bytes);
        }
        // One read at a time, as the JavaScript service chains them; a waiting read still looks at its cancel callback.
        let _turn = loop {
            match self.reading.try_lock() {
                Ok(guard) => break guard,
                Err(std::sync::TryLockError::Poisoned(p)) => break p.into_inner(),
                Err(std::sync::TryLockError::WouldBlock) => {
                    if cancel() {
                        return Err(FontError::Cancelled);
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
            }
        };
        if let Some(bytes) = self.cached(id) {
            return Ok(bytes);
        }
        let data = self.read_entry(entry, &scan, cancel)?;
        self.remember(id, &data);
        Ok(data)
    }
}
