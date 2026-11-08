//! Interface text as data, and its presentation.
//!
//! View models never hold finished strings they did not get from the document: a label is a [`Label`] (a message, or
//! a name the person typed). Only a [`Presentation`] formats text: the selected locale's catalogue (built into the
//! crate by `build.rs` from the committed, language-neutral `locales/`, generated from today's `src/locales`), its
//! direction, its CLDR plural rules and number formatting, with today's fallbacks (`Localization.t` in
//! `src/localization.mjs`): `{name}` placeholders, a plural form chosen by `count`, nested messages.
//!
//! Errors use the same type: a refusal reaches the person as a message key and scalar parameters (the error policy).

use std::borrow::Cow;
use std::sync::Arc;

/// One parameter of a message.
#[derive(Clone, Debug, PartialEq)]
pub enum Arg {
    Text(Arc<str>),
    Num(f64),
    Msg(Msg),
}

/// A message of the catalogue with its parameters.
#[derive(Clone, Debug, PartialEq)]
pub struct Msg {
    pub key: Cow<'static, str>,
    pub params: Vec<(Cow<'static, str>, Arg)>,
}

impl Msg {
    pub const fn new(key: &'static str) -> Msg {
        Msg { key: Cow::Borrowed(key), params: Vec::new() }
    }

    /// A message whose key arrived at run time (a refusal from the session).
    pub fn owned(key: String) -> Msg {
        Msg { key: Cow::Owned(key), params: Vec::new() }
    }

    /// Adds a parameter.
    pub fn with(mut self, name: impl Into<Cow<'static, str>>, value: impl Into<Arg>) -> Msg {
        self.params.push((name.into(), value.into()));
        self
    }

    /// A count message (`counts.figures`, `inspectorView.selectedFigures`): `count` picks the plural form.
    pub fn count(key: &'static str, count: f64) -> Msg {
        Msg::new(key).with("count", count)
    }
}

impl From<f64> for Arg {
    fn from(value: f64) -> Arg {
        Arg::Num(value)
    }
}
impl From<usize> for Arg {
    fn from(value: usize) -> Arg {
        Arg::Num(value as f64)
    }
}
impl From<&str> for Arg {
    fn from(value: &str) -> Arg {
        Arg::Text(value.into())
    }
}
impl From<Arc<str>> for Arg {
    fn from(value: Arc<str>) -> Arg {
        Arg::Text(value)
    }
}
impl From<String> for Arg {
    fn from(value: String) -> Arg {
        Arg::Text(value.into())
    }
}
impl From<Msg> for Arg {
    fn from(value: Msg) -> Arg {
        Arg::Msg(value)
    }
}

/// Text a view shows: a catalogue message, or text that belongs to the document (a figure's name) shown as it is.
#[derive(Clone, Debug, PartialEq)]
pub enum Label {
    Msg(Msg),
    Plain(Arc<str>),
}

impl Label {
    pub fn key(key: &'static str) -> Label {
        Label::Msg(Msg::new(key))
    }
    pub fn plain(text: impl Into<Arc<str>>) -> Label {
        Label::Plain(text.into())
    }
    /// The label in English (tests and logs; the interface formats through its [`Presentation`]).
    pub fn english(&self) -> String {
        Presentation::english().label(self)
    }
}

impl From<Msg> for Label {
    fn from(msg: Msg) -> Label {
        Label::Msg(msg)
    }
}

/// The catalogue `build.rs` makes from `locales/` (see its layout there), read in place.
static CATALOGUE: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/catalogue.bin"));
const MAGIC: usize = 8;

fn word(index: usize) -> u32 {
    let at = MAGIC + index * 4;
    CATALOGUE.get(at..at + 4).map_or(0, |bytes| u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

struct Tables {
    keys: usize,
    locales: usize,
    pool: usize,
}

fn tables() -> Tables {
    Tables { keys: word(0) as usize, locales: word(1) as usize, pool: word(2) as usize }
}

impl Tables {
    fn text(&self, offset: u32, length: u32) -> &'static str {
        let start = self.pool + offset as usize;
        CATALOGUE.get(start..start + length as usize).and_then(|bytes| std::str::from_utf8(bytes).ok()).unwrap_or("")
    }

    fn key(&self, index: usize) -> &'static str {
        self.text(word(3 + 2 * index), word(4 + 2 * index))
    }

    fn find(&self, key: &str) -> Option<usize> {
        let (mut low, mut high) = (0, self.keys);
        while low < high {
            let middle = (low + high) / 2;
            match self.key(middle).cmp(key) {
                std::cmp::Ordering::Less => low = middle + 1,
                std::cmp::Ordering::Greater => high = middle,
                std::cmp::Ordering::Equal => return Some(middle),
            }
        }
        None
    }

    fn locale(&self, index: usize) -> (&'static str, bool, usize) {
        let base = 3 + 2 * self.keys + 4 * index;
        (self.text(word(base), word(base + 1)), word(base + 2) == 1, word(base + 3) as usize)
    }

    fn entry(&self, locale: usize, key: usize) -> Option<Entry> {
        let (_, _, table) = self.locale(locale);
        let entry = word(table + key);
        if entry == u32::MAX {
            return None;
        }
        let entry = entry as usize;
        Some(match word(entry) {
            0 => Entry::Plain(self.text(word(entry + 1), word(entry + 2))),
            _ => Entry::Plural((0..word(entry + 1) as usize).map(|form| {
                let at = entry + 2 + 4 * form;
                (self.text(word(at), word(at + 1)), self.text(word(at + 2), word(at + 3)))
            }).collect()),
        })
    }
}

enum Entry {
    Plain(&'static str),
    Plural(Vec<(&'static str, &'static str)>),
}

/// The catalogue's locales, English first, with whether each is written right to left.
pub fn locales() -> Vec<(&'static str, bool)> {
    let tables = tables();
    (0..tables.locales).map(|index| {
        let (id, rtl, _) = tables.locale(index);
        (id, rtl)
    }).collect()
}

/// Whether today's English catalogue has `key`.
pub fn has(key: &str) -> bool {
    let tables = tables();
    tables.find(key).is_some_and(|index| tables.entry(0, index).is_some())
}

/// The interface's direction.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    Ltr,
    Rtl,
}

/// How the interface writes text and numbers in one locale: today's `Localization` (`src/localization.mjs`). The
/// catalogue's message, else English's; the plural form by the locale's CLDR rules (ICU4X 1.4, CLDR 44, the data of
/// Electron 39's ICU 74), English's rules for an English fallback, chosen for the count as `Intl.PluralRules` rounds it
/// (at most three decimals); numbers as `Intl.NumberFormat(locale)` writes them by default (grouped, at most three
/// decimals, a tie away from zero), in Latin digits, as Electron's ICU data writes every catalogue locale's.
pub struct Presentation {
    tables: Tables,
    locale: usize,
    id: &'static str,
    direction: Direction,
    plurals: icu_plurals::PluralRules,
    english_plurals: icu_plurals::PluralRules,
    decimal: icu_decimal::FixedDecimalFormatter,
}

impl std::fmt::Debug for Presentation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Presentation").field("locale", &self.id).field("direction", &self.direction).finish()
    }
}

fn data_locale(id: &str) -> icu_provider::DataLocale {
    let locale: icu_locid::Locale = id.parse().unwrap_or(icu_locid::Locale::UND);
    icu_provider::DataLocale::from(&locale)
}

impl Presentation {
    /// The presentation of a catalogue locale (`de`, `pt-BR`, `zh-Hans`); `None` for one the catalogue lacks.
    pub fn new(id: &str) -> Option<Presentation> {
        let tables = tables();
        let locale = (0..tables.locales).find(|index| tables.locale(*index).0 == id)?;
        let (id, rtl, _) = tables.locale(locale);
        let plurals = icu_plurals::PluralRules::try_new_cardinal(&data_locale(id)).ok()?;
        let english_plurals = icu_plurals::PluralRules::try_new_cardinal(&data_locale("en")).ok()?;
        // Electron's ICU data writes Latin digits for every catalogue locale (Arabic included, where CLDR's default is
        // Arabic-Indic): `-u-nu-latn`.
        let decimal = icu_decimal::FixedDecimalFormatter::try_new(&data_locale(&format!("{id}-u-nu-latn")), Default::default()).ok()?;
        Some(Presentation { tables, locale, id, direction: if rtl { Direction::Rtl } else { Direction::Ltr }, plurals, english_plurals, decimal })
    }

    /// English: the catalogue's first locale, always present.
    pub fn english() -> Presentation {
        match Presentation::new("en") {
            Some(english) => english,
            None => unreachable!("the catalogue's first locale is English and ICU4X has its data"),
        }
    }

    pub fn locale(&self) -> &'static str {
        self.id
    }

    pub fn direction(&self) -> Direction {
        self.direction
    }

    /// A label as the interface shows it.
    pub fn label(&self, label: &Label) -> String {
        match label {
            Label::Msg(msg) => self.text(msg),
            Label::Plain(text) => text.to_string(),
        }
    }

    /// `msg` as `interfaceLocalization.t(key, params)` writes it. A key no catalogue has is shown as the key, as today.
    pub fn text(&self, msg: &Msg) -> String {
        self.format(msg, 0)
    }

    fn decimal(value: f64) -> Option<fixed_decimal::FixedDecimal> {
        let mut decimal = fixed_decimal::FixedDecimal::try_from_f64(value, fixed_decimal::FloatPrecision::Floating).ok()?;
        decimal.half_expand(-3);
        decimal.trim_end();
        Some(decimal)
    }

    /// A number as `Intl.NumberFormat(locale).format(value)` writes it.
    pub fn number(&self, value: f64) -> String {
        match Presentation::decimal(value) {
            Some(decimal) => self.decimal.format(&decimal).to_string(),
            None => String::new(),
        }
    }

    /// The plural category `Intl.PluralRules(locale).select(count)` picks.
    pub fn plural(&self, count: f64) -> &'static str {
        category(&self.plurals, count)
    }

    fn format(&self, msg: &Msg, depth: usize) -> String {
        let count = msg.params.iter().find(|(name, _)| *name == "count").and_then(|(_, arg)| match arg {
            Arg::Num(value) if value.is_finite() => Some(*value),
            _ => None,
        });
        let index = self.tables.find(&msg.key);
        let localized = index.and_then(|index| self.tables.entry(self.locale, index));
        let english = index.and_then(|index| self.tables.entry(0, index));
        let translated = localized.is_some();
        let template: String = match localized.as_ref().or(english.as_ref()) {
            Some(Entry::Plain(text)) => (*text).to_owned(),
            Some(Entry::Plural(forms)) => {
                let rules = if translated { &self.plurals } else { &self.english_plurals };
                let wanted = count.map_or("other", |count| category(rules, count));
                let pick = |forms: &[(&'static str, &'static str)], name: &str| forms.iter().find(|(form, _)| *form == name).map(|(_, text)| *text);
                // `message[category] ?? english[key][englishCategory] ?? english[key].other`, then the message's `other`.
                let english_forms = match &english {
                    Some(Entry::Plural(forms)) => Some(forms.as_slice()),
                    _ => None,
                };
                pick(forms, wanted)
                    .or_else(|| english_forms.and_then(|english| pick(english, count.map_or("other", |count| category(&self.english_plurals, count))).or_else(|| pick(english, "other"))))
                    .or_else(|| pick(forms, "other"))
                    .unwrap_or(msg.key.as_ref())
                    .to_owned()
            }
            None => msg.key.to_string(),
        };
        self.substitute(&template, &msg.params, depth)
    }

    fn substitute(&self, template: &str, params: &[(Cow<'static, str>, Arg)], depth: usize) -> String {
        let mut out = String::with_capacity(template.len());
        let mut rest = template;
        while let Some(open) = rest.find('{') {
            out.push_str(&rest[..open]);
            let after = &rest[open + 1..];
            let token = after.find('}').map(|end| &after[..end]).filter(|name| is_name(name));
            match token {
                Some(name) => {
                    match params.iter().find(|(candidate, _)| *candidate == name) {
                        Some((_, Arg::Text(text))) => out.push_str(text),
                        Some((_, Arg::Num(value))) if value.is_finite() => out.push_str(&self.number(*value)),
                        Some((_, Arg::Msg(inner))) if depth < 8 => out.push_str(&self.format(inner, depth + 1)),
                        _ => {
                            out.push('{');
                            out.push_str(name);
                            out.push('}');
                        }
                    }
                    rest = &after[name.len() + 1..];
                }
                None => {
                    out.push('{');
                    rest = after;
                }
            }
        }
        out.push_str(rest);
        out
    }
}

fn category(rules: &icu_plurals::PluralRules, count: f64) -> &'static str {
    use icu_plurals::PluralCategory as C;
    // `Intl.PluralRules` chooses for the count rounded as its number format writes it (2.0004 is "2").
    let Some(decimal) = Presentation::decimal(count) else { return "other" };
    match rules.category_for(&decimal) {
        C::Zero => "zero",
        C::One => "one",
        C::Two => "two",
        C::Few => "few",
        C::Many => "many",
        C::Other => "other",
    }
}

fn is_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|first| first.is_ascii_alphabetic()) && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// `msg` in English (tests and logs; the interface formats through its [`Presentation`]).
pub fn english(msg: &Msg) -> String {
    Presentation::english().text(msg)
}

/// A number as `Intl.NumberFormat('en')` writes it.
pub fn format_number(value: f64) -> String {
    Presentation::english().number(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_read_today_s_english_catalogue() {
        assert_eq!(english(&Msg::new("inspectorView.transform")), "Transform");
        assert_eq!(english(&Msg::new("inspectorView.zoom2").with("value", 150.0)), "150% zoom");
        assert_eq!(english(&Msg::new("inspectorView.editingFrameRange").with("first", 22.0).with("last", 28.0)), "Editing frames 22–28");
        assert_eq!(english(&Msg::new("no.such.key")), "no.such.key", "a missing key shows itself, as today");
    }

    #[test]
    fn plurals_nest_and_numbers_format_as_intl_does() {
        assert_eq!(english(&Msg::count("counts.figures", 1.0)), "1 figure");
        assert_eq!(english(&Msg::count("counts.figures", 3.0)), "3 figures");
        let summary = Msg::new("inspectorView.s")
            .with("value", Msg::count("counts.figures", 2.0))
            .with("value2", Msg::count("counts.frames", 1200.0))
            .with("value3", 50.0);
        assert_eq!(english(&summary), "2 figures · 1,200 frames · 50 s");
        assert_eq!(format_number(1234567.891_23), "1,234,567.891");
        assert_eq!(format_number(-12.5), "-12.5");
        assert_eq!(english(&Msg::new("inspectorView.keyframe")), "Keyframe {frame}", "an absent parameter stays a token");
    }

    #[test]
    fn every_catalogue_locale_has_a_presentation() {
        let locales = locales();
        assert_eq!(locales.len(), 27);
        assert_eq!(locales[0], ("en", false));
        for (id, rtl) in locales {
            let presentation = Presentation::new(id).unwrap_or_else(|| panic!("{id} has a presentation"));
            assert_eq!(presentation.direction() == Direction::Rtl, rtl);
        }
        assert_eq!(Presentation::new("ar").map(|p| p.direction()), Some(Direction::Rtl));
        assert!(Presentation::new("xx").is_none());
    }

    #[test]
    fn a_message_falls_back_to_english_with_english_plural_rules() {
        let german = Presentation::new("de").unwrap();
        assert_eq!(german.text(&Msg::new("common.cancel")), "Abbrechen");
        let missing = Msg::count("counts.figures", 1.0);
        let shown = german.text(&missing);
        assert!(shown == "1 figure" || shown.contains('1'), "{shown}");
    }
}
