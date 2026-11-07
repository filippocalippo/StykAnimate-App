//! What a text field accepts, applied to text before an editor mutates (`docs/native/text-input.md` section 2).
//!
//! The one implementation: the interface's editor calls [`Limits::admit`] with the field's size and selection and
//! inserts only what comes back, so an over-long paste never reaches the shaper and a rejected key never makes a
//! history entry.

/// Which characters a field takes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Accept {
    /// Any text (control characters other than line breaks never).
    #[default]
    Text,
    /// Characters of a decimal number: digits, sign, point, exponent.
    Number,
    /// The text tool's alphabet: no surrogates (BMP only) and no control characters other than tab and line breaks.
    TextTool,
}

/// A field's limits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    /// The most characters (Unicode scalar values) the field holds; `None` for unbounded.
    pub max_chars: Option<usize>,
    /// The alphabet.
    pub accept: Accept,
    /// A single-line field joins lines (drops line breaks) instead of taking them.
    pub single_line: bool,
}

impl Limits {
    /// A single-line field of any text, without a length limit.
    pub const fn line() -> Limits {
        Limits { max_chars: None, accept: Accept::Text, single_line: true }
    }

    /// A multiline field with a limit.
    pub const fn area(max_chars: usize) -> Limits {
        Limits { max_chars: Some(max_chars), accept: Accept::Text, single_line: false }
    }

    /// The text tool's content field: `MAX_TEXT_LENGTH` 16384, BMP only (`src/text-authoring.mjs`).
    pub const fn text_tool() -> Limits {
        Limits { max_chars: Some(16384), accept: Accept::TextTool, single_line: false }
    }

    /// A number field.
    pub const fn number() -> Limits {
        Limits { max_chars: Some(32), accept: Accept::Number, single_line: true }
    }

    fn takes(&self, c: char) -> bool {
        if c == '\n' || c == '\r' {
            return !self.single_line;
        }
        match self.accept {
            Accept::Text => !c.is_control() || (c == '\t' && !self.single_line),
            Accept::Number => c.is_ascii_digit() || matches!(c, '-' | '+' | '.' | ',' | 'e' | 'E'),
            Accept::TextTool => (!c.is_control() || c == '\t') && (c as u32) <= 0xFFFF,
        }
    }

    /// What of `incoming` the field takes, given that it holds `chars` characters of which `selected` are selected
    /// (they are replaced). `None` when nothing is taken: the caller then performs no edit at all.
    ///
    /// Single-line fields drop line breaks (a pasted "a\nb" becomes "ab", as the editor joins lines). The text is cut
    /// to the room left, never splitting a character, and the scan stops at the cut, so a huge paste costs only what
    /// is kept.
    pub fn admit(&self, chars: usize, selected: usize, incoming: &str) -> Option<String> {
        let room = self.max_chars.map(|max| max.saturating_sub(chars.saturating_sub(selected)));
        let mut taken = String::new();
        let mut count = 0usize;
        let mut iter = incoming.chars().peekable();
        while let Some(c) = iter.next() {
            if room.is_some_and(|room| count >= room) {
                break;
            }
            // "\r\n" is one line break.
            if c == '\r' && iter.peek() == Some(&'\n') {
                continue;
            }
            if self.takes(c) {
                taken.push(c);
                count += 1;
            }
        }
        if taken.is_empty() { None } else { Some(taken) }
    }
}

/// The distinct UTF-16 units of `text`, the text tool's alphabet limit.
pub fn distinct_units(text: &str) -> usize {
    let mut units: Vec<u16> = text.encode_utf16().collect();
    units.sort_unstable();
    units.dedup();
    units.len()
}

/// The text tool's limit on distinct UTF-16 units.
pub const MAX_DISTINCT_UNITS: usize = 255;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_single_line_field_joins_pasted_lines() {
        assert_eq!(Limits::line().admit(0, 0, "a\nb").as_deref(), Some("ab"));
        assert_eq!(Limits::line().admit(0, 0, "a\r\nb").as_deref(), Some("ab"));
        assert_eq!(Limits::area(100).admit(0, 0, "a\r\nb").as_deref(), Some("a\nb"));
    }

    #[test]
    fn an_oversized_paste_is_cut_to_the_room_left() {
        let limits = Limits::text_tool();
        let big = "x".repeat(20_000);
        let taken = limits.admit(0, 0, &big).unwrap();
        assert_eq!(taken.chars().count(), 16384);
        assert_eq!(limits.admit(16383, 0, "ab").as_deref(), Some("a"));
        assert_eq!(limits.admit(16384, 0, "a"), None, "full: nothing taken, so no edit");
        assert_eq!(limits.admit(16384, 5, "abcdefg").as_deref(), Some("abcde"), "the selection is replaced");
    }

    #[test]
    fn a_character_is_never_split_by_the_cut() {
        let limits = Limits { max_chars: Some(2), ..Limits::line() };
        assert_eq!(limits.admit(0, 0, "あいう").as_deref(), Some("あい"));
        assert_eq!(limits.admit(0, 0, "😀😀😀").as_deref(), Some("😀😀"));
    }

    #[test]
    fn control_characters_and_foreign_alphabets_are_refused() {
        assert_eq!(Limits::line().admit(0, 0, "\u{7}\u{1b}"), None);
        assert_eq!(Limits::number().admit(0, 0, "12a.5e-3").as_deref(), Some("12.5e-3"));
        assert_eq!(Limits::text_tool().admit(0, 0, "a😀b").as_deref(), Some("ab"), "no surrogates in the text tool");
        assert_eq!(Limits::text_tool().admit(0, 0, "a\tb").as_deref(), Some("a\tb"));
        assert_eq!(Limits::line().admit(0, 0, "a\tb").as_deref(), Some("ab"));
    }

    #[test]
    fn a_two_scalar_key_text_is_taken_whole() {
        assert_eq!(Limits::line().admit(0, 0, "لا").as_deref(), Some("لا"));
    }

    #[test]
    fn distinct_units_count_utf16() {
        assert_eq!(distinct_units("aab"), 2);
        assert_eq!(distinct_units("😀"), 2, "a surrogate pair is two units");
    }
}
