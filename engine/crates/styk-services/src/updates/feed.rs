//! The release feed (`latest.yml`), versions, and where a release's files live.

use std::cmp::Ordering;

/// A version: `major.minor.patch`, optionally with a prerelease part (`-beta.1`). Build metadata is ignored.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Version {
    /// Major.
    pub major: u64,
    /// Minor.
    pub minor: u64,
    /// Patch.
    pub patch: u64,
    /// The prerelease identifiers, empty for a release.
    pub pre: Vec<String>,
}

impl Version {
    /// Reads `1.2.3`, `v1.2.3-beta.1` or `1.2.3+build`.
    pub fn parse(text: &str) -> Option<Version> {
        let text = text.trim().trim_start_matches('v');
        let text = text.split('+').next()?;
        let (core, pre) = match text.split_once('-') {
            Some((core, pre)) => (core, pre.split('.').map(str::to_string).collect::<Vec<_>>()),
            None => (text, Vec::new()),
        };
        if pre.iter().any(|part| part.is_empty() || !part.bytes().all(|b| b.is_ascii_alphanumeric())) {
            return None;
        }
        let mut numbers = core.split('.');
        let mut next = || numbers.next().filter(|n| !n.is_empty() && n.len() <= 9 && n.bytes().all(|b| b.is_ascii_digit())).and_then(|n| n.parse::<u64>().ok());
        let version = Version { major: next()?, minor: next()?, patch: next()?, pre };
        numbers.next().is_none().then_some(version)
    }

    /// Whether it is a prerelease.
    pub fn is_prerelease(&self) -> bool {
        !self.pre.is_empty()
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        (self.major, self.minor, self.patch).cmp(&(other.major, other.minor, other.patch)).then_with(|| match (self.pre.is_empty(), other.pre.is_empty()) {
            (true, true) => Ordering::Equal,
            (true, false) => Ordering::Greater,
            (false, true) => Ordering::Less,
            (false, false) => {
                for (a, b) in self.pre.iter().zip(&other.pre) {
                    let order = match (a.parse::<u64>(), b.parse::<u64>()) {
                        (Ok(a), Ok(b)) => a.cmp(&b),
                        (Ok(_), Err(_)) => Ordering::Less,
                        (Err(_), Ok(_)) => Ordering::Greater,
                        (Err(_), Err(_)) => a.cmp(b),
                    };
                    if order != Ordering::Equal {
                        return order;
                    }
                }
                self.pre.len().cmp(&other.pre.len())
            }
        })
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// Whether `candidate` is an update for `current`: strictly newer, and not a prerelease (`allowPrerelease = false`,
/// `allowDowngrade = false` in `desktop/updates.cjs`).
pub fn is_newer(current: &Version, candidate: &Version) -> bool {
    !candidate.is_prerelease() && candidate > current
}

/// One downloadable file of a release.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileInfo {
    /// The file's name inside the release (never a path or a URL).
    pub name: String,
    /// SHA-512 of the file, base64.
    pub sha512: String,
    /// Size in bytes.
    pub size: u64,
}

/// A parsed `latest.yml`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReleaseInfo {
    /// The version text as written.
    pub version: String,
    /// The files, the installer first.
    pub files: Vec<FileInfo>,
    /// The release date as written, if any.
    pub release_date: Option<String>,
}

impl ReleaseInfo {
    /// The version, parsed.
    pub fn parsed_version(&self) -> Option<Version> {
        Version::parse(&self.version)
    }

    /// The installer: the first file.
    pub fn installer(&self) -> Option<&FileInfo> {
        self.files.first()
    }
}

/// Why a feed was refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FeedError {
    /// Larger than [`MAX_FEED`].
    TooLarge,
    /// No `version`, or one that is not a version.
    BadVersion,
    /// No files.
    NoFiles,
    /// A file with a missing or malformed name, hash or size.
    BadFile(String),
}

impl std::fmt::Display for FeedError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FeedError::TooLarge => write!(f, "the release feed is too large"),
            FeedError::BadVersion => write!(f, "the release feed has no valid version"),
            FeedError::NoFiles => write!(f, "the release feed lists no files"),
            FeedError::BadFile(why) => write!(f, "the release feed has a bad file entry: {why}"),
        }
    }
}

impl std::error::Error for FeedError {}

/// The largest feed read, in bytes (today's holds the release notes: about 3 KiB).
pub const MAX_FEED: usize = 256 * 1024;

fn unquote(value: &str) -> String {
    let value = value.trim();
    for quote in ['"', '\''] {
        if value.len() >= 2 && value.starts_with(quote) && value.ends_with(quote) {
            return value[1..value.len() - 1].to_string();
        }
    }
    value.to_string()
}

fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 200 && name != "." && name != ".." && !name.contains(['/', '\\', ':', '?', '#', '%', '\0']) && !name.chars().any(char::is_control)
}

fn valid_sha512(text: &str) -> bool {
    text.len() == 88 && text.ends_with("==") && text.bytes().take(86).all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
}

/// Reads a `latest.yml` as electron-builder writes it: top-level `version`, `files` (a list of `url`, `sha512`, `size`),
/// and keys this program does not use (`path`, `sha512`, `releaseNotes`, `releaseDate`, ...), which are skipped. No YAML
/// library: the format is fixed, and a feed that does not fit it is refused.
///
/// A file's `url` must be a bare name: it is resolved against the release this feed belongs to ([`asset_url`]), never
/// followed as written.
pub fn parse_latest_yml(text: &str) -> Result<ReleaseInfo, FeedError> {
    if text.len() > MAX_FEED {
        return Err(FeedError::TooLarge);
    }
    let mut version = None;
    let mut release_date = None;
    let mut files: Vec<(Option<String>, Option<String>, Option<String>)> = Vec::new();
    let mut top = String::new();
    for line in text.lines() {
        let trimmed = line.trim_end();
        if trimmed.is_empty() || trimmed.trim_start().starts_with('#') {
            continue;
        }
        let indented = trimmed.starts_with(' ') || trimmed.starts_with('\t');
        if !indented {
            let Some((key, value)) = trimmed.split_once(':') else { continue };
            top = key.trim().to_string();
            match top.as_str() {
                "version" => version = Some(unquote(value)),
                "releaseDate" => release_date = Some(unquote(value)),
                _ => {}
            }
            continue;
        }
        if top != "files" {
            continue;
        }
        let body = trimmed.trim_start();
        let (starts_item, body) = match body.strip_prefix("- ") {
            Some(rest) => (true, rest.trim_start()),
            None => (false, body),
        };
        if starts_item {
            files.push((None, None, None));
        }
        let Some((key, value)) = body.split_once(':') else { continue };
        let Some(item) = files.last_mut() else { continue };
        match key.trim() {
            "url" => item.0 = Some(unquote(value)),
            "sha512" => item.1 = Some(unquote(value)),
            "size" => item.2 = Some(unquote(value)),
            _ => {}
        }
    }
    let version = version.filter(|v| Version::parse(v).is_some()).ok_or(FeedError::BadVersion)?;
    if files.is_empty() {
        return Err(FeedError::NoFiles);
    }
    let mut out = Vec::new();
    for (name, sha512, size) in files {
        let name = name.filter(|n| valid_name(n)).ok_or_else(|| FeedError::BadFile("the name is missing or is not a bare file name".into()))?;
        let sha512 = sha512.filter(|s| valid_sha512(s)).ok_or_else(|| FeedError::BadFile(format!("{name}: the sha512 is missing or malformed")))?;
        let size = size.and_then(|s| s.parse::<u64>().ok()).filter(|s| *s > 0).ok_or_else(|| FeedError::BadFile(format!("{name}: the size is missing or malformed")))?;
        out.push(FileInfo { name, sha512, size });
    }
    Ok(ReleaseInfo { version, files: out, release_date })
}

/// Where the program fetches releases from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Endpoint {
    /// The site, e.g. `https://github.com`.
    pub base: String,
    /// The repository's owner.
    pub owner: String,
    /// The repository's name.
    pub repo: String,
}

impl Endpoint {
    /// The public release repository on GitHub.
    pub fn github() -> Endpoint {
        Endpoint { base: "https://github.com".into(), owner: super::RELEASE_REPOSITORY.0.into(), repo: super::RELEASE_REPOSITORY.1.into() }
    }

    /// The feed of the latest release; the answer redirects to the release's own download URL, which names its tag.
    pub fn latest_feed_url(&self) -> String {
        format!("{}/{}/{}/releases/latest/download/latest.yml", self.base, self.owner, self.repo)
    }

    /// A file of one release, by tag. Spaces in the name become `-`, as electron-updater's GitHub provider has it.
    pub fn asset_url(&self, tag: &str, name: &str) -> Option<String> {
        (valid_tag(tag) && valid_name(name)).then(|| format!("{}/{}/{}/releases/download/{}/{}", self.base, self.owner, self.repo, tag, name.replace(' ', "-")))
    }

    /// The tag in a release download URL (`.../releases/download/<tag>/<file>`) of this repository.
    pub fn tag_of_download_url(&self, url: &str) -> Option<String> {
        let rest = url.strip_prefix(&self.base)?;
        let prefix = format!("/{}/{}/releases/download/", self.owner, self.repo);
        let after = rest.strip_prefix(&prefix)?;
        let (tag, file) = after.split_once('/')?;
        (valid_tag(tag) && !file.is_empty()).then(|| tag.to_string())
    }

    /// Whether a redirect target may be followed: the endpoint's own origin, or HTTPS on GitHub's content hosts.
    pub fn may_redirect_to(&self, url: &str) -> bool {
        let own = url.strip_prefix(&self.base).is_some_and(|rest| rest.is_empty() || rest.starts_with('/'));
        own || https_host(url).is_some_and(|host| host == "github.com" || host == "githubusercontent.com" || host.ends_with(".githubusercontent.com"))
    }
}

fn valid_tag(tag: &str) -> bool {
    !tag.is_empty() && tag.len() <= 64 && tag != "." && tag != ".." && tag.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'+'))
}

fn https_host(url: &str) -> Option<&str> {
    let rest = url.strip_prefix("https://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    (!authority.contains('@') && !authority.contains(':')).then_some(authority)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shape of a real feed (`release/1.1.0/latest.yml`), release notes shortened.
    const REAL: &str = "version: 1.1.0\nfiles:\n  - url: StykAnimate-1.1.0-Setup-x64.exe\n    sha512: AkhkLETWEbqgXa8ZyQhjSA5e8jKYbYsvkvA68ambkVXg5cIyhSObh8m2qeCWxuLiJSTbLyomjQwEwAZAzvJhtw==\n    size: 128693928\npath: StykAnimate-1.1.0-Setup-x64.exe\nsha512: AkhkLETWEbqgXa8ZyQhjSA5e8jKYbYsvkvA68ambkVXg5cIyhSObh8m2qeCWxuLiJSTbLyomjQwEwAZAzvJhtw==\nreleaseNotes: \"# StykAnimate 1.1.0\\r\\n\\r\\n- url: not a file\\r\\n\"\nreleaseDate: '2026-09-23T20:55:30.435Z'\n";

    #[test]
    fn a_real_feed_gives_the_exact_version_size_and_hash() {
        let info = parse_latest_yml(REAL).unwrap();
        assert_eq!(info.version, "1.1.0");
        assert_eq!(info.files.len(), 1);
        let file = info.installer().unwrap();
        assert_eq!(file.name, "StykAnimate-1.1.0-Setup-x64.exe");
        assert_eq!(file.size, 128_693_928);
        assert_eq!(file.sha512, "AkhkLETWEbqgXa8ZyQhjSA5e8jKYbYsvkvA68ambkVXg5cIyhSObh8m2qeCWxuLiJSTbLyomjQwEwAZAzvJhtw==");
        assert_eq!(info.release_date.as_deref(), Some("2026-09-23T20:55:30.435Z"));
    }

    #[test]
    fn a_block_scalar_of_release_notes_does_not_leak_into_files() {
        let text = REAL.replace("releaseNotes: \"# StykAnimate 1.1.0\\r\\n\\r\\n- url: not a file\\r\\n\"", "releaseNotes: |\n  notes\n  - url: /etc/passwd\n    size: 1");
        assert_eq!(parse_latest_yml(&text).unwrap().files.len(), 1);
    }

    #[test]
    fn a_bad_feed_is_refused_with_a_reason() {
        let no_version = REAL.replace("version: 1.1.0\n", "");
        assert_eq!(parse_latest_yml(&no_version), Err(FeedError::BadVersion));
        assert_eq!(parse_latest_yml("version: banana\nfiles:\n"), Err(FeedError::BadVersion));
        assert_eq!(parse_latest_yml("version: 1.2.3\n"), Err(FeedError::NoFiles));
        assert!(matches!(parse_latest_yml(&REAL.replace("size: 128693928", "size: lots")), Err(FeedError::BadFile(_))));
        assert!(matches!(parse_latest_yml(&REAL.replace("size: 128693928", "size: 0")), Err(FeedError::BadFile(_))));
        assert!(matches!(parse_latest_yml(&REAL.replace("AkhkLETWEbqgXa8ZyQhjSA5e8jKYbYsvkvA68ambkVXg5cIyhSObh8m2qeCWxuLiJSTbLyomjQwEwAZAzvJhtw==", "short")), Err(FeedError::BadFile(_))));
        assert_eq!(parse_latest_yml(&"x".repeat(MAX_FEED + 1)), Err(FeedError::TooLarge));
    }

    #[test]
    fn a_file_name_is_a_bare_name_never_a_url_or_a_path() {
        for bad in ["https://evil.example/Setup.exe", "../Setup.exe", "dir/Setup.exe", "C:\\Setup.exe", "Setup%2e.exe", "a?b.exe"] {
            assert!(matches!(parse_latest_yml(&REAL.replace("StykAnimate-1.1.0-Setup-x64.exe\n    sha512", &format!("{bad}\n    sha512"))), Err(FeedError::BadFile(_))), "{bad}");
        }
    }

    #[test]
    fn versions_order_as_semver_and_prereleases_are_never_offered() {
        let v = |t: &str| Version::parse(t).unwrap();
        assert!(v("1.2.0") > v("1.1.9") && v("1.10.0") > v("1.9.0") && v("2.0.0") > v("1.99.99"));
        assert!(v("1.2.0-beta.1") < v("1.2.0") && v("1.2.0-beta.2") > v("1.2.0-beta.1") && v("1.2.0-rc.1") > v("1.2.0-beta.9"));
        assert!(is_newer(&v("1.1.0"), &v("1.1.1")));
        assert!(!is_newer(&v("1.1.0"), &v("1.1.0")), "equal is not an update");
        assert!(!is_newer(&v("1.2.0"), &v("1.1.0")), "a downgrade is refused");
        assert!(!is_newer(&v("1.1.0"), &v("1.2.0-beta.1")), "a prerelease is refused");
        assert_eq!(Version::parse("v1.2.3+build.5").map(|v| (v.major, v.minor, v.patch)), Some((1, 2, 3)));
        for bad in ["", "1", "1.2", "1.2.3.4", "a.b.c", "1.2.x", "1.2.3-", "-1.2.3", "1..3"] {
            assert_eq!(Version::parse(bad), None, "{bad}");
        }
    }

    #[test]
    fn files_are_resolved_against_the_selected_release() {
        let e = Endpoint::github();
        assert_eq!(e.latest_feed_url(), "https://github.com/filippocalippo/styk-animate-releases/releases/latest/download/latest.yml");
        assert_eq!(e.asset_url("v1.2.0", "StykAnimate 1.2.0 Setup.exe").unwrap(), "https://github.com/filippocalippo/styk-animate-releases/releases/download/v1.2.0/StykAnimate-1.2.0-Setup.exe");
        assert_eq!(e.asset_url("../x", "a.exe"), None);
        assert_eq!(e.asset_url("v1", "../a.exe"), None);
        assert_eq!(e.tag_of_download_url("https://github.com/filippocalippo/styk-animate-releases/releases/download/v1.2.0/latest.yml").as_deref(), Some("v1.2.0"));
        assert_eq!(e.tag_of_download_url("https://github.com/other/repo/releases/download/v1.2.0/latest.yml"), None);
        assert_eq!(e.tag_of_download_url("https://github.com/filippocalippo/styk-animate-releases/releases/latest/download/latest.yml"), None, "the latest alias has no tag of its own");
    }

    #[test]
    fn redirects_stay_on_github() {
        let e = Endpoint::github();
        assert!(e.may_redirect_to("https://github.com/filippocalippo/styk-animate-releases/releases/download/v1/latest.yml"));
        assert!(e.may_redirect_to("https://objects.githubusercontent.com/github-production-release-asset/x"));
        assert!(e.may_redirect_to("https://release-assets.githubusercontent.com/x"));
        for bad in ["http://github.com/x", "https://evilgithub.com/x", "https://github.com.evil.example/x", "https://githubusercontent.com.evil.example/x", "https://user@github.com/x", "https://github.com:8443/x", "ftp://github.com/x", "https://example.com/githubusercontent.com"] {
            assert!(!e.may_redirect_to(bad), "{bad}");
        }
    }
}
