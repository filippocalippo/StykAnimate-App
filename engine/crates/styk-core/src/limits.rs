//! What a text field accepts, applied to text before an editor mutates (`docs/native/text-input.md` section 2).
//!
//! The one implementation: the interface's editor calls [`Limits::admit_in`] with the field's context (its size, its
//! selection, the text around the caret) and inserts only what comes back, so an over-long paste never reaches the
//! shaper and a rejected key never makes a history entry.
//!
//! Every role is bounded in six ways, each because the shaper's or the editor's cost grows with it:
//! characters ([`HARD_MAX_CHARS`]), lines ([`MAX_LINES`]), the length of a paragraph ([`MAX_PARAGRAPH`]: the editor shapes a
//! whole paragraph on every edit, so one 16,000-character line took 32 ms an edit and four of 4,000 take 9), the run of
//! characters without a space ([`MAX_RUN`]), the marks piled on one base character
//! ([`MAX_CLUSTER`]: 16,000 of them took seven seconds a frame) and, for the text tool, the distinct UTF-16 units
//! ([`MAX_DISTINCT_UNITS`]). The scan itself stops after [`SCAN_CAP`] characters, however many were refused.

/// No field holds more characters than this, whatever its role asks for.
pub const HARD_MAX_CHARS: usize = 16384;

/// The most characters of a single-line field (names, search): a line of this many shapes in well under a frame.
pub const MAX_LINE_CHARS: usize = 4096;

/// The most line breaks a multiline field takes.
pub const MAX_LINES: usize = 1000;

/// The longest paragraph (the characters between two line breaks) a multiline field holds. The editor shapes the whole
/// paragraph being edited on every edit, so its cost grows with this, not with the field's size: lines of 80 characters
/// cost an edit about 7 ms in a 16,000-character field, one line of 16,000 cost 32.
pub const MAX_PARAGRAPH: usize = 4096;

/// The longest run of characters without white space.
pub const MAX_RUN: usize = 2048;

/// The most extending characters (marks, joiners, variation selectors) after one base character.
pub const MAX_CLUSTER: usize = 16;

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
    /// The most characters (Unicode scalar values) the field holds; never more than [`HARD_MAX_CHARS`].
    pub max_chars: Option<usize>,
    /// The alphabet.
    pub accept: Accept,
    /// A single-line field joins lines (drops line breaks) instead of taking them.
    pub single_line: bool,
    /// The most line breaks the field holds.
    pub max_lines: Option<usize>,
    /// The longest run of characters without white space.
    pub max_run: Option<usize>,
    /// The longest paragraph.
    pub max_paragraph: Option<usize>,
}

/// What the editor tells the limits about the field at the moment of an edit.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Context {
    /// Characters in the field, a line break counting one.
    pub chars: usize,
    /// Characters of the selection, which the incoming text replaces.
    pub selected: usize,
    /// Lines in the field.
    pub lines: usize,
    /// Line breaks inside the selection.
    pub selected_breaks: usize,
    /// The characters of the caret's line before the caret, all of them.
    pub before_chars: usize,
    /// The characters of the caret's line after the caret, all of them.
    pub after_chars: usize,
    /// The text before the caret on its line (at least the last [`MAX_RUN`] characters, or all of it).
    pub before: String,
    /// The text after the caret on its line (at least the first [`MAX_RUN`] characters, or all of it).
    pub after: String,
    /// The distinct UTF-16 units of the text that stays (sorted), when the limits ask for them ([`Limits::tracks_units`]).
    pub units: Vec<u16>,
}

impl Context {
    /// A context that knows only how much the field holds: what [`Limits::admit`] uses.
    pub fn sized(chars: usize, selected: usize) -> Context {
        Context { chars, selected, lines: 1, ..Context::default() }
    }
}

impl Limits {
    /// A single-line field of any text.
    pub const fn line() -> Limits {
        Limits { max_chars: Some(MAX_LINE_CHARS), accept: Accept::Text, single_line: true, max_lines: None, max_run: Some(MAX_RUN), max_paragraph: None }
    }

    /// A multiline field with a limit.
    pub const fn area(max_chars: usize) -> Limits {
        let max_chars = if max_chars < HARD_MAX_CHARS { max_chars } else { HARD_MAX_CHARS };
        Limits { max_chars: Some(max_chars), accept: Accept::Text, single_line: false, max_lines: Some(MAX_LINES), max_run: Some(MAX_RUN), max_paragraph: Some(MAX_PARAGRAPH) }
    }

    /// The text tool's content field: `MAX_TEXT_LENGTH` 16384, BMP only (`src/text-authoring.mjs`).
    pub const fn text_tool() -> Limits {
        Limits { max_chars: Some(16384), accept: Accept::TextTool, single_line: false, max_lines: Some(MAX_LINES), max_run: Some(MAX_RUN), max_paragraph: Some(MAX_PARAGRAPH) }
    }

    /// A number field.
    pub const fn number() -> Limits {
        Limits { max_chars: Some(32), accept: Accept::Number, single_line: true, max_lines: None, max_run: None, max_paragraph: None }
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
    /// Line breaks: "\r\n", a lone "\r" and "\n" are one break; a single-line field drops them (a pasted "a\nb" becomes
    /// "ab"). Characters are refused, not cut short, when the field is full, a run without white space would pass
    /// [`MAX_RUN`], marks would pass [`MAX_CLUSTER`] on one base character, the lines would pass [`MAX_LINES`], the
    /// alphabet does not have them, or (the text tool) they would be a 256th distinct unit. A character is never split.
    pub fn admit_in(&self, ctx: &Context, incoming: &str) -> Option<String> {
        let room = self.max_chars.map_or(HARD_MAX_CHARS, |max| max.min(HARD_MAX_CHARS)).saturating_sub(ctx.chars.saturating_sub(ctx.selected));
        let breaks_left = self.max_lines.map(|max| max.saturating_sub(ctx.lines.saturating_sub(1).saturating_sub(ctx.selected_breaks)));
        let mut breaks_taken = 0usize;
        // The run of characters without white space that ends at the caret, and the one that starts there.
        let mut run = ctx.before.chars().rev().take_while(|c| !c.is_whitespace()).count();
        let after_run = ctx.after.chars().take_while(|c| !c.is_whitespace()).count();
        let mut extending = ctx.before.chars().rev().take_while(|c| is_extender(*c)).count();
        // How long the paragraph being edited is, up to the caret; line breaks still to come in the incoming text decide
        // whether the text after the caret belongs to the same paragraph as what is inserted now.
        let mut paragraph = ctx.before_chars.max(ctx.before.chars().count());
        let mut breaks_ahead = {
            let mut chars = incoming.chars().take(SCAN_CAP).peekable();
            let mut count = 0usize;
            while let Some(c) = chars.next() {
                if c == '\n' || (c == '\r' && chars.peek() != Some(&'\n')) {
                    count += 1;
                }
            }
            count
        };
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
                breaks_ahead = breaks_ahead.saturating_sub(1);
                if self.single_line || breaks_left.is_some_and(|left| breaks_taken >= left) {
                    continue;
                }
                breaks_taken += 1;
                run = 0;
                extending = 0;
                paragraph = 0;
                taken.push(c);
                count += 1;
                continue;
            }
            if !self.takes(c) {
                continue;
            }
            if is_extender(c) {
                if extending >= MAX_CLUSTER {
                    continue;
                }
                extending += 1;
            } else {
                extending = 0;
            }
            if let Some(max) = self.max_paragraph {
                let tail = if breaks_ahead == 0 { ctx.after_chars.max(ctx.after.chars().count()) } else { 0 };
                if paragraph + 1 + tail > max {
                    continue;
                }
            }
            if c.is_whitespace() {
                run = 0;
            } else if let Some(max) = self.max_run {
                if run + 1 + after_run > max {
                    continue;
                }
                run += 1;
            }
            if self.tracks_units() {
                let unit = c as u16;
                match units.binary_search(&unit) {
                    Ok(_) => {}
                    Err(at) => {
                        if units.len() >= MAX_DISTINCT_UNITS {
                            continue;
                        }
                        units.insert(at, unit);
                    }
                }
            }
            taken.push(c);
            count += 1;
            paragraph += 1;
        }
        if taken.is_empty() { None } else { Some(taken) }
    }
}

/// Whether a character extends the one before it instead of standing alone: combining marks, joiners, variation
/// selectors, emoji modifiers. An approximation of the grapheme extenders that is exact for the blocks below.
fn is_extender(c: char) -> bool {
    matches!(c as u32,
        0x0300..=0x036F | 0x0483..=0x0489 | 0x0591..=0x05BD | 0x05BF | 0x05C1..=0x05C2 | 0x05C4..=0x05C5 | 0x05C7
        | 0x0610..=0x061A | 0x064B..=0x065F | 0x0670 | 0x06D6..=0x06DC | 0x06DF..=0x06E4 | 0x06E7..=0x06E8 | 0x06EA..=0x06ED
        | 0x0900..=0x0903 | 0x093A..=0x094F | 0x0951..=0x0957 | 0x0E31 | 0x0E34..=0x0E3A | 0x0E47..=0x0E4E
        | 0x1AB0..=0x1AFF | 0x1DC0..=0x1DFF | 0x200C..=0x200D | 0x20D0..=0x20FF | 0xFE00..=0xFE0F | 0xFE20..=0xFE2F
        | 0x1F3FB..=0x1F3FF | 0xE0100..=0xE01EF)
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
    let mut units: Vec<u16> = text.flat_map(|c| {
        let mut buffer = [0u16; 2];
        c.encode_utf16(&mut buffer).to_vec()
    }).collect();
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
        let big = format!("{}\n", "ab ".repeat(30)).repeat(1000);
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
    fn every_role_is_bounded_so_a_huge_paste_cannot_freeze_the_interface() {
        let started = std::time::Instant::now();
        let huge = "x".repeat(5_000_000);
        for limits in [Limits::line(), Limits::area(1 << 30), Limits::number(), Limits::text_tool()] {
            let taken = limits.admit(0, 0, &huge);
            assert!(taken.as_deref().map_or(0, |t| t.chars().count()) <= HARD_MAX_CHARS, "{limits:?}");
        }
        assert!(started.elapsed() < std::time::Duration::from_millis(50), "{:?}", started.elapsed());
    }

    #[test]
    fn a_word_never_runs_past_the_longest_the_shaper_handles_cheaply() {
        let taken = Limits::area(16384).admit(0, 0, &"x".repeat(10_000)).unwrap();
        assert_eq!(taken.chars().count(), MAX_RUN);
        // Typing into the end of a full word, and inserting in the middle of two near-full halves.
        let before = "x".repeat(MAX_RUN);
        let ctx = Context { chars: MAX_RUN, lines: 1, before, ..Context::default() };
        assert_eq!(Limits::area(16384).admit_in(&ctx, "y"), None);
        assert_eq!(Limits::area(16384).admit_in(&ctx, " y").as_deref(), Some(" y"), "a space starts a new word");
        let ctx = Context { chars: 2000, lines: 1, before: "x".repeat(1000), after: "x".repeat(1000), ..Context::default() };
        assert_eq!(Limits::area(16384).admit_in(&ctx, &"y".repeat(100)).unwrap().chars().count(), 48, "the two halves join into one word");
    }

    #[test]
    fn a_paragraph_never_grows_past_what_one_edit_can_shape_in_a_frame() {
        let spaced = "ab ".repeat(10_000);
        let taken = Limits::area(16384).admit(0, 0, &spaced).unwrap();
        assert_eq!(taken.chars().count(), MAX_PARAGRAPH);
        // Line breaks start new paragraphs: the same text in lines of 80 is taken whole (up to the field's size).
        let lines: String = (0..300).map(|_| format!("{}\n", "ab ".repeat(26))).collect();
        assert_eq!(Limits::area(16384).admit(0, 0, &lines).unwrap().chars().count(), 16384.min(lines.chars().count()));
        // Typing at the end of a full paragraph is refused, a break is not, and typing after it is.
        let ctx = Context { chars: MAX_PARAGRAPH, lines: 1, before_chars: MAX_PARAGRAPH, before: "ab ".repeat(100), ..Context::default() };
        assert_eq!(Limits::area(16384).admit_in(&ctx, "y"), None);
        assert_eq!(Limits::area(16384).admit_in(&ctx, "\ny").as_deref(), Some("\ny"));
        // Inserting into the middle counts the text after the caret too, unless a break comes first.
        let ctx = Context { chars: MAX_PARAGRAPH - 1, lines: 1, before_chars: 10, after_chars: MAX_PARAGRAPH - 11, ..Context::default() };
        assert_eq!(Limits::area(16384).admit_in(&ctx, "yy").as_deref(), Some("y"));
        assert_eq!(Limits::area(16384).admit_in(&ctx, "yy\nz").as_deref(), Some("yy\nz"), "the tail belongs to the last paragraph only");
    }

    #[test]
    fn marks_pile_up_no_further_than_a_cluster_can_be_shaped_cheaply() {
        let marks = format!("a{}", "\u{301}".repeat(16_383));
        let taken = Limits::area(16384).admit(0, 0, &marks).unwrap();
        assert_eq!(taken.chars().count(), 1 + MAX_CLUSTER);
        // Typing marks one at a time after a base: the field remembers the run.
        let ctx = Context { chars: 17, lines: 1, before: format!("a{}", "\u{301}".repeat(MAX_CLUSTER)), ..Context::default() };
        assert_eq!(Limits::area(16384).admit_in(&ctx, "\u{301}"), None);
        assert_eq!(Limits::area(16384).admit_in(&ctx, "b").as_deref(), Some("b"));
    }

    #[test]
    fn line_breaks_are_bounded_in_number_as_well_as_in_characters() {
        let taken = Limits::area(16384).admit(0, 0, &"\n".repeat(5_000_000)).unwrap();
        assert_eq!(taken.chars().count(), MAX_LINES);
        let ctx = Context { chars: 1000, lines: MAX_LINES + 1, ..Context::default() };
        assert_eq!(Limits::area(16384).admit_in(&ctx, "\n"), None, "Enter in a field that already holds 1000 line breaks");
    }

    #[test]
    fn enter_counts_as_an_inserted_character() {
        let ctx = Context { chars: 5, lines: 1, ..Context::default() };
        assert_eq!(Limits::area(5).admit_in(&ctx, "\n"), None);
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
        let ctx = Context { chars: 255, lines: 1, units: unit_set(taken.chars()), ..Context::default() };
        assert_eq!(Limits::text_tool().admit_in(&ctx, "\u{2200}"), None, "the 256th distinct unit");
        assert_eq!(Limits::text_tool().admit_in(&ctx, "\u{100}").as_deref(), Some("\u{100}"), "a repeat is fine");
    }

    #[test]
    fn distinct_units_count_utf16() {
        assert_eq!(distinct_units("aab"), 2);
        assert_eq!(distinct_units("😀"), 2, "a surrogate pair is two units");
    }
}
