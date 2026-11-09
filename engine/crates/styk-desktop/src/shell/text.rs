//! The interface text the native side shows itself (dialogs, errors): the page's own catalogs, read from the web
//! assets (`src/locales/en.mjs` and `src/locales/messages/<id>.mjs`), so both sides say the same thing.

use std::collections::HashMap;
use std::sync::RwLock;

use serde_json::{Map, Value};

use super::web_host::WebAssets;

static CATALOGS: RwLock<Option<Catalogs>> = RwLock::new(None);

struct Catalogs {
    /// The language in use (`en` when only English is loaded), for number formatting.
    id: String,
    english: HashMap<String, Value>,
    locale: Option<HashMap<String, Value>>,
}

/// Parses one generated catalog module: `const messages = { ...JSON... };`.
fn parse_catalog(text: &str) -> Option<HashMap<String, Value>> {
    let start = text.find("const messages = ")? + "const messages = ".len();
    let end = text[start..].find("\n};")? + start;
    let value: Map<String, Value> = serde_json::from_str(&text[start..end + 2]).ok()?;
    Some(value.into_iter().collect())
}

fn read_catalog(assets: &WebAssets, relative: &str) -> Option<HashMap<String, Value>> {
    let bytes = assets.read(relative)?;
    parse_catalog(std::str::from_utf8(&bytes).ok()?)
}

/// Loads English, and the language `locale` names when there is a catalog for it.
pub fn use_locale(assets: &WebAssets, locale: Option<&str>) {
    let english = read_catalog(assets, "src/locales/en.mjs").unwrap_or_default();
    let locale = locale.and_then(|value| {
        let value = value.trim();
        if value.is_empty() || value.len() > 64 || !value.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return None;
        }
        let base = value.split('-').next().unwrap_or(value);
        [value, base]
            .into_iter()
            .filter(|id| *id != "en")
            .find_map(|id| read_catalog(assets, &format!("src/locales/messages/{id}.mjs")).map(|catalog| (id.to_owned(), catalog)))
    });
    let (id, locale) = match locale { Some((id, catalog)) => (id, Some(catalog)), None => ("en".to_owned(), None) };
    *CATALOGS.write().unwrap_or_else(|e| e.into_inner()) = Some(Catalogs { id, english, locale });
}

#[cfg(test)]
fn format(template: &str, params: &Map<String, Value>) -> String { format_at(template, params, 0) }

fn format_at(template: &str, params: &Map<String, Value>, depth: usize) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        match after.find('}') {
            Some(close) if after[..close].chars().all(|c| c.is_ascii_alphanumeric() || c == '_') && close > 0 => {
                let name = &after[..close];
                match params.get(name) {
                    Some(value) => match param_text(value, depth) {
                        Some(text) => out.push_str(&text),
                        None => out.push_str(&rest[open..open + close + 2]),
                    },
                    None => out.push_str(&rest[open..open + close + 2]),
                }
                rest = &after[close + 1..];
            }
            _ => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// A parameter as `Localization.t` shows it: strings as they are, numbers in the language's digits grouping, display
/// references (`{messageKey, messageParams}`) in the current language, `{format: 'number'|'list'}` values formatted.
fn param_text(value: &Value, depth: usize) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => number.as_f64().filter(|n| n.is_finite()).map(|n| format_number(n, true)),
        Value::Object(object) if depth < 8 => {
            if let Some(key) = object.get("messageKey").and_then(Value::as_str) {
                let params = object.get("messageParams").and_then(Value::as_object).cloned().unwrap_or_default();
                return Some(t_at(key, &params, depth + 1));
            }
            match object.get("format").and_then(Value::as_str) {
                Some("number") => {
                    let grouping = object.get("options").and_then(|o| o.get("useGrouping")) != Some(&Value::Bool(false));
                    object.get("value").and_then(Value::as_f64).filter(|n| n.is_finite()).map(|n| format_number(n, grouping))
                }
                Some("list") => {
                    let items: Vec<String> = object.get("value")?.as_array()?.iter().take(256).filter_map(|item| param_text(item, depth + 1)).collect();
                    Some(items.join(", "))
                }
                _ => None,
            }
        }
        _ => None,
    }
}

/// The current language's group and decimal separators (Intl.NumberFormat's defaults, at most three fraction digits).
fn format_number(value: f64, grouping: bool) -> String {
    let locale = CATALOGS.read().unwrap_or_else(|e| e.into_inner()).as_ref().map(|c| c.id.clone()).unwrap_or_else(|| "en".into());
    let base = locale.split('-').next().unwrap_or("en");
    let (group, decimal, minimum) = match base {
        "de" | "it" | "nl" | "da" | "el" | "id" | "tr" | "pt" => (".", ",", 1),
        "es" => (".", ",", 2),
        "pl" => ("\u{a0}", ",", 2),
        "fr" => ("\u{202f}", ",", 1),
        "fi" | "sv" | "nb" | "cs" | "sk" | "uk" | "ru" | "hu" => ("\u{a0}", ",", 1),
        _ => (",", ".", 1),
    };
    let rounded = (value * 1000.0).round() / 1000.0;
    let negative = rounded < 0.0;
    let text = format!("{}", rounded.abs());
    let (whole, fraction) = text.split_once('.').map(|(w, f)| (w.to_owned(), Some(f.to_owned()))).unwrap_or((text.clone(), None));
    let mut out = String::new();
    if grouping && whole.len() > 3 && whole.len() >= 4 + (minimum - 1) {
        for (index, digit) in whole.chars().enumerate() {
            if index > 0 && (whole.len() - index) % 3 == 0 { out.push_str(group); }
            out.push(digit);
        }
    } else { out.push_str(&whole); }
    if let Some(fraction) = fraction { out.push_str(decimal); out.push_str(&fraction); }
    if negative { format!("-{out}") } else { out }
}

fn pick(message: &Value, params: &Map<String, Value>) -> Option<String> {
    match message {
        Value::String(text) => Some(text.clone()),
        Value::Object(forms) => {
            let count = params.get("count").and_then(Value::as_f64);
            let form = if count == Some(1.0) { "one" } else { "other" };
            forms.get(form).or_else(|| forms.get("other")).and_then(Value::as_str).map(str::to_owned)
        }
        _ => None,
    }
}

/// The text of `key` in the current language (English when it has none), with `{name}` parameters filled in.
pub fn t(key: &str, params: &Map<String, Value>) -> String { t_at(key, params, 0) }

fn t_at(key: &str, params: &Map<String, Value>, depth: usize) -> String {
    let template = CATALOGS.read().unwrap_or_else(|e| e.into_inner()).as_ref().and_then(|c| {
        c.locale
            .as_ref()
            .and_then(|l| l.get(key))
            .and_then(|m| pick(m, params))
            .or_else(|| c.english.get(key).and_then(|m| pick(m, params)))
    });
    format_at(template.as_deref().unwrap_or(key), params, depth)
}

/// [`t`] without parameters.
pub fn t0(key: &str) -> String {
    t(key, &Map::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalogs_parse_and_format() {
        let catalog = parse_catalog(
            "// x\nconst messages = {\n  \"a.b\": \"Save changes to {name}?\",\n  \"c\": {\"one\": \"{count} project\", \"other\": \"{count} projects\"}\n};\nexport default messages;",
        )
        .unwrap();
        let mut params = Map::new();
        params.insert("name".into(), "Walk".into());
        assert_eq!(format(catalog["a.b"].as_str().unwrap(), &params), "Save changes to Walk?");
        params.insert("count".into(), 2.into());
        assert_eq!(format(&pick(&catalog["c"], &params).unwrap(), &params), "2 projects");
        assert_eq!(format("{missing} and {", &params), "{missing} and {");
    }

    #[test]
    fn parameters_show_as_the_page_shows_them() {
        let params: Map<String, Value> = serde_json::from_value(serde_json::json!({
            "min": 1, "max": 16384, "plain": {"format": "number", "value": 16384, "options": {"useGrouping": false}},
            "label": {"messageKey": "unknown.key", "diagnosticValue": "Video width"}, "fraction": 0.12345,
        })).unwrap();
        assert_eq!(format("{label} {min}..{max} {plain} {fraction}", &params), "unknown.key 1..16,384 16384 0.123");
    }
}
