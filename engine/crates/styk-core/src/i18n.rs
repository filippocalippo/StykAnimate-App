//! Interface text as data: a message key and its parameters, as today's `interfaceText(key, params)` takes them.
//!
//! View models never hold finished strings they did not get from the document: a label is a [`Label`] (a message, or
//! a name the person typed), so a later locale chunk changes the catalogue, not a panel. [`english`] formats a message
//! with today's English catalogue (`src/locales/en.mjs`, built into the crate by `build.rs`) and today's rules
//! (`Localization.t` in `src/localization.mjs`): `{name}` placeholders, a plural form chosen by `count`, nested
//! messages, and numbers as `Intl.NumberFormat('en')` writes them (grouped, at most three decimals).
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
    /// The label in English.
    pub fn english(&self) -> String {
        match self {
            Label::Msg(msg) => english(msg),
            Label::Plain(text) => text.to_string(),
        }
    }
}

impl From<Msg> for Label {
    fn from(msg: Msg) -> Label {
        Label::Msg(msg)
    }
}

pub(crate) enum Entry {
    Plain(&'static str),
    Plural(&'static [(&'static str, &'static str)]),
}

include!(concat!(env!("OUT_DIR"), "/english.rs"));

/// The English message for `key`, or `None` when the catalogue has no such key.
pub fn has(key: &str) -> bool {
    lookup(key).is_some()
}

fn lookup(key: &str) -> Option<&'static Entry> {
    ENGLISH.binary_search_by(|(candidate, _)| (*candidate).cmp(key)).ok().map(|at| &ENGLISH[at].1)
}

/// `msg` in English, as `interfaceText(key, params)` writes it. A key the catalogue lacks is shown as the key, as today.
pub fn english(msg: &Msg) -> String {
    format_message(msg, 0)
}

fn format_message(msg: &Msg, depth: usize) -> String {
    let count = msg.params.iter().find(|(name, _)| *name == "count").and_then(|(_, arg)| match arg {
        Arg::Num(value) if value.is_finite() => Some(*value),
        _ => None,
    });
    let template: &str = match lookup(&msg.key) {
        Some(Entry::Plain(text)) => text,
        Some(Entry::Plural(forms)) => {
            // English has two categories: "one" for exactly 1, "other" for the rest.
            let category = if count == Some(1.0) { "one" } else { "other" };
            let pick = |name: &str| forms.iter().find(|(form, _)| *form == name).map(|(_, text)| *text);
            pick(category).or_else(|| pick("other")).unwrap_or(&msg.key)
        }
        None => &msg.key,
    };
    substitute(template, &msg.params, depth)
}

fn substitute(template: &str, params: &[(Cow<'static, str>, Arg)], depth: usize) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let name_end = after.find('}');
        let token = name_end.map(|end| &after[..end]).filter(|name| is_name(name));
        match token {
            Some(name) => {
                match params.iter().find(|(candidate, _)| *candidate == name) {
                    Some((_, Arg::Text(text))) => out.push_str(text),
                    Some((_, Arg::Num(value))) if value.is_finite() => out.push_str(&format_number(*value)),
                    Some((_, Arg::Msg(inner))) if depth < 8 => out.push_str(&format_message(inner, depth + 1)),
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

fn is_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|first| first.is_ascii_alphabetic()) && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// A number as `Intl.NumberFormat('en')` writes it by default: at most three decimals (a tie away from zero), the
/// whole part grouped by thousands, `-0` as `-0` only when it is not rounded away.
pub fn format_number(value: f64) -> String {
    let fixed = crate::number::format(value, 3);
    let (sign, digits) = fixed.strip_prefix('-').map_or(("", fixed.as_str()), |rest| ("-", rest));
    let (whole, fraction) = digits.split_once('.').map_or((digits, None), |(whole, fraction)| (whole, Some(fraction)));
    let mut grouped = String::with_capacity(whole.len() + whole.len() / 3);
    for (index, digit) in whole.chars().enumerate() {
        if index > 0 && (whole.len() - index) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    match fraction {
        Some(fraction) => format!("{sign}{grouped}.{fraction}"),
        None => format!("{sign}{grouped}"),
    }
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
        assert_eq!(format_number(0.0005), "0.001", "a tie rounds away from zero");
        assert_eq!(format_number(-12.5), "-12.5");
        assert_eq!(english(&Msg::new("inspectorView.keyframe")), "Keyframe {frame}", "an absent parameter stays a token");
    }
}
