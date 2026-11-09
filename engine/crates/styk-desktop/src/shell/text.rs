//! The interface text the native side shows itself (dialogs, errors): the page's own catalogs, read from the web
//! assets (`src/locales/en.mjs` and `src/locales/messages/<id>.mjs`), so both sides say the same thing.

use std::collections::HashMap;
use std::sync::RwLock;

use serde_json::{Map, Value};

use super::web_host::WebAssets;

static CATALOGS: RwLock<Option<Catalogs>> = RwLock::new(None);

struct Catalogs {
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
            .find_map(|id| read_catalog(assets, &format!("src/locales/messages/{id}.mjs")))
    });
    *CATALOGS.write().unwrap_or_else(|e| e.into_inner()) = Some(Catalogs { english, locale });
}

fn format(template: &str, params: &Map<String, Value>) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        match after.find('}') {
            Some(close) if after[..close].chars().all(|c| c.is_ascii_alphanumeric() || c == '_') && close > 0 => {
                let name = &after[..close];
                match params.get(name) {
                    Some(Value::String(text)) => out.push_str(text),
                    Some(Value::Number(n)) => out.push_str(&n.to_string()),
                    Some(other) => out.push_str(&other.to_string()),
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
pub fn t(key: &str, params: &Map<String, Value>) -> String {
    let catalogs = CATALOGS.read().unwrap_or_else(|e| e.into_inner());
    let template = catalogs.as_ref().and_then(|c| {
        c.locale
            .as_ref()
            .and_then(|l| l.get(key))
            .and_then(|m| pick(m, params))
            .or_else(|| c.english.get(key).and_then(|m| pick(m, params)))
    });
    format(template.as_deref().unwrap_or(key), params)
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
}
