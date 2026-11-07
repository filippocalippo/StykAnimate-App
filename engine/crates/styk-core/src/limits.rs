//! What a text field accepts, applied to text before an editor mutates (`docs/native/text-input.md` section 2).
//!
//! The one implementation: the interface's editor calls [`Limits::admit_in`] with the field's context (its size, its
//! selection, the distinct units it holds) and inserts only what comes back, so an over-long paste never reaches the
//! shaper and a rejected key never makes a history entry.
//!
//! **A field refuses nothing today's field takes.** The limits are today's: a field's `maxlength` (16,384 in the text
//! tool), the alphabet and, in the text tool, the 255 distinct UTF-16 units (`src/text-authoring.mjs`), and single-line
//! fields have no line breaks. A field with no `maxlength` takes up to [`CEILING_CHARS`], which only caps the work done
//! for an input larger than any field in the app holds; the admission scan itself stops after [`SCAN_CAP`] characters,
//! however many were refused. Long lines, many lines, long words and marks piled on one letter are all taken: making them
//! cheap is the editor's job, not a refusal.

/// What a field with no `maxlength` takes at most: four times the largest field in the app (the text tool's 16,384).
pub const CEILING_CHARS: usize = 65_536;

/// How many characters of an incoming text are looked at, accepted or not.
pub const SCAN_CAP: usize = 262_144;

/// The text tool's limit on distinct UTF-16 units.
pub const MAX_DISTINCT_UNITS: usize = 255;

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
    /// The most characters (Unicode scalar values) the field holds (`maxlength`); `None` takes [`CEILING_CHARS`].
    pub max_chars: Option<usize>,
    /// The alphabet.
    pub accept: Accept,
    /// A single-line field joins lines (drops line breaks) instead of taking them.
    pub single_line: bool,
}

/// What the editor tells the limits about the field at the moment of an edit.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Context {
    /// Characters in the field, a line break counting one.
    pub chars: usize,
    /// Characters of the selection, which the incoming text replaces.
    pub selected: usize,
    /// The distinct UTF-16 units of the text that stays (sorted), when the limits ask for them ([`Limits::tracks_units`]).
    pub units: Vec<u16>,
}

impl Context {
    /// A context that knows only how much the field holds: what [`Limits::admit`] uses.
    pub fn sized(chars: usize, selected: usize) -> Context {
        Context { chars, selected, units: Vec::new() }
    }
}

impl Limits {
    /// A single-line field of any text (no `maxlength`).
    pub const fn line() -> Limits {
        Limits { max_chars: None, accept: Accept::Text, single_line: true }
    }

    /// A multiline field with a `maxlength`.
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

    /// Whether [`Context::units`] is needed.
    pub fn tracks_units(&self) -> bool {
        self.accept == Accept::TextTool
    }

    fn takes(&self, c: char) -> bool {
        match self.accept {
            Accept::Text => !c.is_control() || (c == '\t' && !self.single_line),
            Accept::Number => c.is_ascii_digit() || matches!(c, '-' | '+' | '.' | ',' | 'e' | 'E'),
            Accept::TextTool => (!c.is_control() || c == '\t') && (c as u32) <= 0xFFFF,
        }
    }

    /// What of `incoming` the field takes, given only that it holds `chars` characters of which `selected` are
    /// selected. See [`Limits::admit_in`] for the full rule.
    pub fn admit(&self, chars: usize, selected: usize, incoming: &str) -> Option<String> {
        self.admit_in(&Context::sized(chars, selected), incoming)
    }

    /// What of `incoming` the field takes in this context; `None` when nothing is taken (the caller then performs no
    /// edit at all).
    ///
    /// Line breaks: "\r\n", a lone "\r" and "\n" are one break (a textarea normalises them to "\n"); a single-line field
    /// drops them (a pasted "a\nb" becomes "ab"). Characters the alphabet does not have are refused, and so is a 256th
    /// distinct unit in the text tool; the text is cut where the field is full, never splitting a character.
    pub fn admit_in(&self, ctx: &Context, incoming: &str) -> Option<String> {
        let room = self.max_chars.unwrap_or(CEILING_CHARS).saturating_sub(ctx.chars.saturating_sub(ctx.selected));
        let mut units: Vec<u16> = ctx.units.clone();
        let mut taken = String::new();
        let mut count = 0usize;
        let mut iter = incoming.chars().take(SCAN_CAP).peekable();
        while let Some(mut c) = iter.next() {
            if count >= room {
                break;
            }
            // "\r\n" is one line break, and so is a lone "\r".
            if c == '\r' {
                if iter.peek() == Some(&'\n') {
                    continue;
                }
                c = '\n';
            }
            if c == '\n' {
                if self.single_line {
                    continue;
                }
                taken.push(c);
                count += 1;
                continue;
            }
            if !self.takes(c) {
                continue;
            }
            if self.tracks_units() {
                let unit = c as u16;
                if let Err(at) = units.binary_search(&unit) {
                    if units.len() >= MAX_DISTINCT_UNITS {
                        continue;
                    }
                    units.insert(at, unit);
                }
            }
            taken.push(c);
            count += 1;
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

/// The distinct UTF-16 units of `text`, sorted.
pub fn unit_set(text: impl Iterator<Item = char>) -> Vec<u16> {
    let mut units: Vec<u16> = text
        .flat_map(|c| {
            let mut buffer = [0u16; 2];
            c.encode_utf16(&mut buffer).to_vec()
        })
        .collect();
    units.sort_unstable();
    units.dedup();
    units
}

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
        let big = "ab ".repeat(20_000);
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
    fn a_field_refuses_nothing_todays_field_takes() {
        // A textarea of 16,384 characters takes one line of 16,300, any number of lines, one word, marks on one letter.
        let area = Limits::area(16384);
        let line = "x".repeat(16_300);
        assert_eq!(area.admit(0, 0, &line).as_deref(), Some(line.as_str()), "one 16,300-character line (and word)");
        let lines = "\n".repeat(16_384);
        assert_eq!(area.admit(0, 0, &lines).unwrap().chars().count(), 16_384, "16,384 line breaks");
        let marks = format!("a{}", "\u{301}".repeat(16_383));
        assert_eq!(area.admit(0, 0, &marks).as_deref(), Some(marks.as_str()), "a base and 16,383 combining marks");
        // Marks typed one at a time are all taken too.
        let ctx = Context { chars: 5000, ..Context::default() };
        assert_eq!(area.admit_in(&ctx, "\u{301}").as_deref(), Some("\u{301}"));
        // A field with no maxlength takes a line of any length up to the ceiling.
        let long = "y".repeat(CEILING_CHARS);
        assert_eq!(Limits::line().admit(0, 0, &long).unwrap().chars().count(), CEILING_CHARS);
    }

    #[test]
    fn work_on_an_input_larger_than_any_field_is_bounded() {
        let started = std::time::Instant::now();
        let huge = "x".repeat(5_000_000);
        for limits in [Limits::line(), Limits::area(1 << 30), Limits::number(), Limits::text_tool()] {
            let taken = limits.admit(0, 0, &huge);
            // The most any field takes is its own maxlength, and admission never reads past SCAN_CAP characters.
            let bound = limits.max_chars.map_or(CEILING_CHARS, |m| m.min(SCAN_CAP));
            assert!(taken.as_deref().map_or(0, |t| t.chars().count()) <= bound, "{limits:?}");
        }
        assert!(started.elapsed() < std::time::Duration::from_millis(50), "{:?}", started.elapsed());
    }

    #[test]
    fn enter_counts_as_an_inserted_character() {
        let ctx = Context { chars: 5, ..Context::default() };
        assert_eq!(Limits::area(5).admit_in(&ctx, "\n"), None);
        assert_eq!(Limits::area(6).admit_in(&ctx, "\n").as_deref(), Some("\n"));
    }

    #[test]
    fn a_lone_carriage_return_is_a_line_break() {
        assert_eq!(Limits::area(100).admit(0, 0, "a\rb\r\nc\n\rd").as_deref(), Some("a\nb\nc\n\nd"));
    }

    #[test]
    fn the_text_tool_never_takes_more_than_255_distinct_units_counting_what_is_there() {
        let many: String = (0..400u32).map(|n| char::from_u32(0x100 + n).unwrap()).collect();
        let taken = Limits::text_tool().admit(0, 0, &many).unwrap();
        assert_eq!(distinct_units(&taken), MAX_DISTINCT_UNITS);
        let ctx = Context { chars: 255, units: unit_set(taken.chars()), ..Context::default() };
        assert_eq!(Limits::text_tool().admit_in(&ctx, "\u{2200}"), None, "the 256th distinct unit");
        assert_eq!(Limits::text_tool().admit_in(&ctx, "\u{100}").as_deref(), Some("\u{100}"), "a repeat is fine");
    }

    #[test]
    fn distinct_units_count_utf16() {
        assert_eq!(distinct_units("aab"), 2);
        assert_eq!(distinct_units("😀"), 2, "a surrogate pair is two units");
    }
}
