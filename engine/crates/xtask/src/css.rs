//! Just enough CSS to read `src/styles/tokens.css`: comments, the `@layer tokens { ... }` block, rules made of custom
//! property declarations, and `var()` substitution. Anything else in a rule is ignored; `@media` and other at-rules
//! inside the layer are skipped whole.

use std::collections::HashMap;

/// A rule: its selectors and its custom properties (`--name`, value), in source order.
#[derive(Debug, PartialEq)]
pub struct Rule {
    pub selectors: Vec<String>,
    pub properties: Vec<(String, String)>,
}

/// The rules directly inside `@layer tokens { ... }`.
pub fn token_rules(source: &str) -> Result<Vec<Rule>, String> {
    let text = strip_comments(source);
    let start = text.find("@layer tokens").ok_or("no `@layer tokens` block")?;
    let open = text[start..].find('{').ok_or("`@layer tokens` has no block")? + start;
    let close = matching_brace(&text, open)?;
    rules(&text[open + 1..close])
}

fn strip_comments(source: &str) -> String {
    let mut out = String::with_capacity(source.len());
    let mut rest = source;
    while let Some(start) = rest.find("/*") {
        out.push_str(&rest[..start]);
        match rest[start + 2..].find("*/") {
            Some(end) => rest = &rest[start + 2 + end + 2..],
            None => return out,
        }
    }
    out.push_str(rest);
    out
}

/// The index of the `}` that closes the `{` at `open`.
fn matching_brace(text: &str, open: usize) -> Result<usize, String> {
    let mut depth = 0usize;
    for (index, character) in text[open..].char_indices() {
        match character {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Ok(open + index);
                }
            }
            _ => {}
        }
    }
    Err("unbalanced braces".into())
}

fn rules(text: &str) -> Result<Vec<Rule>, String> {
    let mut rules = Vec::new();
    let mut rest = text;
    loop {
        rest = rest.trim_start();
        if rest.is_empty() {
            return Ok(rules);
        }
        let open = rest.find('{').ok_or_else(|| format!("a rule without a block near {:?}", &rest[..rest.len().min(40)]))?;
        let close = matching_brace(rest, open)?;
        let prelude = rest[..open].trim();
        if !prelude.starts_with('@') {
            rules.push(Rule {
                selectors: prelude.split(',').map(|selector| selector.trim().to_string()).collect(),
                properties: declarations(&rest[open + 1..close]),
            });
        }
        rest = &rest[close + 1..];
    }
}

/// The custom properties of a declaration block.
fn declarations(block: &str) -> Vec<(String, String)> {
    let mut properties = Vec::new();
    let mut depth = 0i32;
    let mut quote = None;
    let mut start = 0;
    for (index, character) in block.char_indices().chain(std::iter::once((block.len(), ';'))) {
        match (character, quote) {
            ('"' | '\'', None) => quote = Some(character),
            (c, Some(q)) if c == q => quote = None,
            ('(', None) => depth += 1,
            (')', None) => depth -= 1,
            (';', None) if depth == 0 => {
                if let Some((name, value)) = block[start..index].split_once(':') {
                    let name = name.trim();
                    if name.starts_with("--") {
                        properties.push((name.to_string(), value.split_whitespace().collect::<Vec<_>>().join(" ")));
                    }
                }
                start = index + 1;
            }
            _ => {}
        }
    }
    properties
}

/// Replaces every `var(--name)` (or `var(--name, fallback)`) in `value` with the value `env` holds, recursively.
pub fn resolve(value: &str, env: &HashMap<String, String>) -> Result<String, String> {
    resolve_at(value, env, 0)
}

fn resolve_at(value: &str, env: &HashMap<String, String>, depth: usize) -> Result<String, String> {
    if depth > 32 {
        return Err(format!("var() chain too deep or circular at {value:?}"));
    }
    let mut out = String::new();
    let mut rest = value;
    while let Some(start) = rest.find("var(") {
        out.push_str(&rest[..start]);
        let open = start + 3;
        let mut nesting = 0usize;
        let mut close = None;
        for (index, character) in rest[open..].char_indices() {
            match character {
                '(' => nesting += 1,
                ')' => {
                    nesting -= 1;
                    if nesting == 0 {
                        close = Some(open + index);
                        break;
                    }
                }
                _ => {}
            }
        }
        let close = close.ok_or_else(|| format!("unbalanced var() in {value:?}"))?;
        let inner = &rest[open + 1..close];
        let (name, fallback) = match inner.split_once(',') {
            Some((name, fallback)) => (name.trim(), Some(fallback.trim())),
            None => (inner.trim(), None),
        };
        let replacement = match (env.get(name), fallback) {
            (Some(found), _) => found.as_str(),
            (None, Some(fallback)) => fallback,
            (None, None) => return Err(format!("{name} is not defined")),
        };
        out.push_str(&resolve_at(replacement, env, depth + 1)?);
        rest = &rest[close + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rules_are_read_from_the_layer_and_media_blocks_are_skipped() {
        let css = "/* c */ @layer tokens {\n :root { --a: 1px; color-scheme: light; --b: var(--a) ; }\n @media (x) { :root { --a: 9px; } }\n :root, :root[data-theme=\"dark\"] { --c: \"A, B\", serif; }\n}\n.after { --z: 0; }";
        let rules = token_rules(css).unwrap();
        assert_eq!(rules.len(), 2);
        assert_eq!(rules[0].properties, [("--a".to_string(), "1px".to_string()), ("--b".to_string(), "var(--a)".to_string())]);
        assert_eq!(rules[1].selectors, [":root", ":root[data-theme=\"dark\"]"]);
        assert_eq!(rules[1].properties, [("--c".to_string(), "\"A, B\", serif".to_string())]);
    }

    #[test]
    fn var_chains_resolve_and_fallbacks_apply() {
        let env: HashMap<String, String> = [("--a", "#fff"), ("--b", "var(--a)"), ("--c", "0 0 var(--b)")].into_iter().map(|(k, v)| (k.into(), v.into())).collect();
        assert_eq!(resolve("var(--c) x", &env).unwrap(), "0 0 #fff x");
        assert_eq!(resolve("var(--missing, 3px)", &env).unwrap(), "3px");
        assert!(resolve("var(--missing)", &env).unwrap_err().contains("not defined"));
    }

    #[test]
    fn a_cycle_is_an_error() {
        let env: HashMap<String, String> = [("--a", "var(--b)"), ("--b", "var(--a)")].into_iter().map(|(k, v)| (k.into(), v.into())).collect();
        assert!(resolve("var(--a)", &env).is_err());
    }
}
