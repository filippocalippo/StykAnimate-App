//! The `stykanimate://` links: `handleProtocol` of `desktop/main.cjs`, rule for rule.

/// The scheme the program registers.
pub const SCHEME: &str = "stykanimate";

/// A public library item's id (`desktop/public-library.cjs`: a lowercase letter or digit, ten times).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicId(String);

impl PublicId {
    /// The id, if the text is one.
    pub fn parse(text: &str) -> Option<PublicId> {
        (text.len() == 10 && text.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())).then(|| PublicId(text.to_string()))
    }

    /// The id as text.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// What a link asks for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProtocolLink {
    /// `stykanimate://open`: bring the window forward.
    Open,
    /// `stykanimate://privacy`: show the privacy settings.
    Privacy,
    /// `stykanimate://library` (no item) or `stykanimate://library/<id>`.
    Library(Option<PublicId>),
}

impl ProtocolLink {
    /// The canonical text of the link.
    pub fn to_url(&self) -> String {
        match self {
            ProtocolLink::Open => "stykanimate://open".into(),
            ProtocolLink::Privacy => "stykanimate://privacy".into(),
            ProtocolLink::Library(None) => "stykanimate://library".into(),
            ProtocolLink::Library(Some(id)) => format!("stykanimate://library/{}", id.as_str()),
        }
    }
}

/// Whether an argument starts like one of our links (case-insensitive scheme, then `://`), valid or not.
pub fn looks_like_link(argument: &str) -> bool {
    // Bytes, not text: a path like "C:/Users/aé/a.piv" has a character that straddles the scheme's length.
    let head = SCHEME.len();
    let bytes = argument.as_bytes();
    bytes.len() >= head + 3 && bytes[..head].eq_ignore_ascii_case(SCHEME.as_bytes()) && &bytes[head..head + 3] == b"://"
}

/// Reads a link the way `new URL(value)` and the checks of `handleProtocol` do. Anything else is `None`.
///
/// The WHATWG parser's relevant behaviour is kept: surrounding control characters and spaces go, tabs and newlines
/// inside are dropped, the scheme is case-insensitive, the host of a non-special scheme is opaque (so it is compared
/// as written), an empty query, fragment, port or userinfo counts as absent, and `.` and `..` path segments (`%2e`
/// too) are resolved before the id is read.
pub fn parse_protocol(raw: &str) -> Option<ProtocolLink> {
    let trimmed = raw.trim_matches(|c: char| c <= ' ');
    let cleaned: String = trimmed.chars().filter(|c| !matches!(c, '\t' | '\n' | '\r')).collect();
    if !looks_like_link(&cleaned) {
        return None;
    }
    let rest = &cleaned[SCHEME.len() + 3..];
    let (rest, fragment) = rest.split_once('#').unwrap_or((rest, ""));
    let (rest, query) = rest.split_once('?').unwrap_or((rest, ""));
    if !fragment.is_empty() || !query.is_empty() {
        return None;
    }
    let (authority, path) = match rest.find('/') {
        Some(at) => (&rest[..at], &rest[at..]),
        None => (rest, ""),
    };
    let host_port = match authority.rsplit_once('@') {
        Some((userinfo, host_port)) => {
            if !userinfo.is_empty() && userinfo != ":" {
                return None;
            }
            host_port
        }
        None => authority,
    };
    let host = match host_port.split_once(':') {
        Some((host, port)) if port.is_empty() => host,
        Some(_) => return None,
        None => host_port,
    };
    let segments = normalized_segments(path);
    let root = segments.is_empty() || segments == [""];
    match host {
        "open" if root => Some(ProtocolLink::Open),
        "privacy" if root => Some(ProtocolLink::Privacy),
        "library" if root => Some(ProtocolLink::Library(None)),
        "library" => match segments.as_slice() {
            [id] | [id, _] if segments.len() == 1 || segments[1].is_empty() => PublicId::parse(id).map(|id| ProtocolLink::Library(Some(id))),
            _ => None,
        },
        _ => None,
    }
}

/// The path's segments after dot segments are resolved, as the URL parser does for a path that starts with `/`.
fn normalized_segments(path: &str) -> Vec<String> {
    let Some(path) = path.strip_prefix('/') else { return Vec::new() };
    let mut out: Vec<String> = Vec::new();
    let parts: Vec<&str> = path.split('/').collect();
    for (index, part) in parts.iter().enumerate() {
        let lower = part.to_ascii_lowercase();
        let last = index + 1 == parts.len();
        match lower.as_str() {
            "." | "%2e" => {
                if last {
                    out.push(String::new());
                }
            }
            ".." | ".%2e" | "%2e." | "%2e%2e" => {
                out.pop();
                if last {
                    out.push(String::new());
                }
            }
            _ => out.push((*part).to_string()),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(text: &str) -> Option<ProtocolLink> {
        Some(ProtocolLink::Library(Some(PublicId::parse(text).unwrap())))
    }

    #[test]
    fn the_accepted_links_of_today() {
        assert_eq!(parse_protocol("stykanimate://open"), Some(ProtocolLink::Open));
        assert_eq!(parse_protocol("stykanimate://open/"), Some(ProtocolLink::Open));
        assert_eq!(parse_protocol("stykanimate://privacy"), Some(ProtocolLink::Privacy));
        assert_eq!(parse_protocol("stykanimate://library"), Some(ProtocolLink::Library(None)));
        assert_eq!(parse_protocol("stykanimate://library/"), Some(ProtocolLink::Library(None)));
        assert_eq!(parse_protocol("stykanimate://library/ab12cd34ef"), id("ab12cd34ef"));
        assert_eq!(parse_protocol("stykanimate://library/ab12cd34ef/"), id("ab12cd34ef"));
        assert_eq!(parse_protocol("STYKANIMATE://open"), Some(ProtocolLink::Open), "the scheme is case-insensitive");
        assert_eq!(parse_protocol("  stykanimate://open\r\n"), Some(ProtocolLink::Open), "surrounding whitespace goes");
        assert_eq!(parse_protocol("stykanimate://op\ten"), Some(ProtocolLink::Open), "tabs inside are dropped by the URL parser");
    }

    #[test]
    fn the_rejected_links_of_today() {
        for bad in [
            "stykanimate://open/?x=1",
            "stykanimate://open?x=1",
            "stykanimate://open#top",
            "stykanimate://user@open",
            "stykanimate://user:pw@open",
            "stykanimate://open:8080",
            "stykanimate://Open",
            "stykanimate://library/short",
            "stykanimate://library/ABCDEFGHIJ",
            "stykanimate://library/ab12cd34efg",
            "stykanimate://library/ab12cd34ef/extra",
            "stykanimate://library/%61b12cd34ef",
            "stykanimate://open/x",
            "stykanimate://privacy/x",
            "stykanimate://other",
            "stykanimate:/open",
            "stykanimate:open",
            "https://open",
            "",
            "stykanimate://",
        ] {
            assert_eq!(parse_protocol(bad), None, "{bad}");
        }
    }

    #[test]
    fn empty_parts_are_absent_as_the_url_parser_has_it() {
        assert_eq!(parse_protocol("stykanimate://open?"), Some(ProtocolLink::Open));
        assert_eq!(parse_protocol("stykanimate://open#"), Some(ProtocolLink::Open));
        assert_eq!(parse_protocol("stykanimate://open:"), Some(ProtocolLink::Open));
        assert_eq!(parse_protocol("stykanimate://@open"), Some(ProtocolLink::Open));
    }

    #[test]
    fn dot_segments_resolve_before_the_id_is_read() {
        assert_eq!(parse_protocol("stykanimate://library/../x"), None, "x is not an id");
        assert_eq!(parse_protocol("stykanimate://library/../ab12cd34ef"), id("ab12cd34ef"));
        assert_eq!(parse_protocol("stykanimate://library/ab12cd34ef/.."), Some(ProtocolLink::Library(None)));
        assert_eq!(parse_protocol("stykanimate://library/./ab12cd34ef"), id("ab12cd34ef"));
        assert_eq!(parse_protocol("stykanimate://library/%2e%2e/ab12cd34ef"), id("ab12cd34ef"));
        assert_eq!(parse_protocol("stykanimate://open/../.."), Some(ProtocolLink::Open));
    }

    #[test]
    fn a_link_round_trips_through_its_canonical_text() {
        for link in [ProtocolLink::Open, ProtocolLink::Privacy, ProtocolLink::Library(None), ProtocolLink::Library(PublicId::parse("abcdefghij"))] {
            assert_eq!(parse_protocol(&link.to_url()), Some(link));
        }
    }

    #[test]
    fn a_path_with_a_multibyte_character_where_the_scheme_would_end_is_not_a_link_and_does_not_panic() {
        // "C:/Users/aé/a.piv": the 11th byte falls inside the é.
        for argument in ["C:/Users/aé/a.piv", "stykanimaté://x", "é", "stykanimate:é/", "C:/Users/aéé"] {
            assert!(!looks_like_link(argument), "{argument}");
            assert_eq!(parse_protocol(argument), None, "{argument}");
        }
    }

    #[test]
    fn looking_like_a_link_is_not_being_one() {
        assert!(looks_like_link("StykAnimate://anything"));
        assert!(!looks_like_link("stykanimate:/x"));
        assert!(!looks_like_link("xstykanimate://open"));
        assert!(!looks_like_link("stykan"));
    }
}
