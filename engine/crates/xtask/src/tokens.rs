//! `src/styles/tokens.css` -> `styk-design/src/tokens.rs`.
//!
//! The CSS has three kinds of declarations, told apart by the rule they sit in:
//!
//! - **Theme-independent** (a rule whose selectors are `:root` only): the palette's primitives and the fixed colours,
//!   and the scales (type, space, radius, controls, motion). They become `primitives` and `scale` constants.
//! - **Themed** (a rule that also names `:root[data-theme="light"]`, or names `dark`): the semantic roles. Light is
//!   the `:root` cascade; dark is the same cascade with the dark rules applied last, exactly as the browser does. They
//!   become the fields of `Palette`, with `LIGHT` and `DARK` values.
//!
//! Every value is resolved through `var()` at generation time; colours become `Rgba` with the alpha CSS computes,
//! shadows become `BoxShadow` lists. Declarations that cannot be a constant (`calc()`, `max()`, `env()`, shorthands
//! that are not a type role) are listed at the top of the generated file so a porter can see what was left out.

use crate::css::{self, Rule};
use std::collections::HashMap;
use std::fmt::Write as _;

const LIGHT_SELECTOR: &str = ":root[data-theme=\"light\"]";
const DARK_SELECTOR: &str = ":root[data-theme=\"dark\"]";

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Color([u8; 3], f32),
    Shadows(Vec<Shadow>),
    Px(f64),
    Em(f64),
    Ms(f64),
    Number(f64),
    Bezier([f64; 4]),
    Text(String),
    Type { weight: f64, size: f64, line_height: f64, family: String },
}

#[derive(Clone, Debug, PartialEq)]
pub struct Shadow {
    pub inset: bool,
    pub x: f64,
    pub y: f64,
    pub blur: f64,
    pub spread: f64,
    pub color: ([u8; 3], f32),
}

/// The classified tokens of the file.
#[derive(Debug, Default)]
pub struct Tokens {
    /// Theme-independent colours, in source order.
    pub primitives: Vec<(String, Value)>,
    /// Theme-independent lengths, numbers, times, easings, families and type roles, in source order.
    pub scale: Vec<(String, Value)>,
    /// The themed names, in source order, with their light and dark values.
    pub themed: Vec<(String, Value, Value)>,
    /// Declarations that cannot be constants, with the reason.
    pub skipped: Vec<(String, String)>,
}

pub fn parse(source: &str) -> Result<Tokens, String> {
    let rules = css::token_rules(source)?;
    let mut base: HashMap<String, String> = HashMap::new();
    let mut dark: HashMap<String, String> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    let mut themed_names: Vec<String> = Vec::new();
    for rule in &rules {
        let Some(target) = target_of(rule) else { continue };
        for (name, value) in &rule.properties {
            if !order.contains(name) {
                order.push(name.clone());
            }
            if target.themed && !themed_names.contains(name) {
                themed_names.push(name.clone());
            }
            match target.layer {
                Layer::Base => base.insert(name.clone(), value.clone()),
                Layer::Dark => dark.insert(name.clone(), value.clone()),
            };
        }
    }
    let mut dark_env = base.clone();
    dark_env.extend(dark);
    let mut tokens = Tokens::default();
    for name in &order {
        let is_themed = themed_names.contains(name);
        let light = classify(name, &base, &mut tokens.skipped)?;
        if is_themed {
            let dark = classify(name, &dark_env, &mut tokens.skipped)?;
            match (light, dark) {
                (Some(light), Some(dark)) => {
                    if !matches!((&light, &dark), (Value::Color(..), Value::Color(..)) | (Value::Shadows(_), Value::Shadows(_))) {
                        return Err(format!("{name} is themed but is not a colour or a shadow in both themes"));
                    }
                    tokens.themed.push((name.clone(), light, dark));
                }
                (None, None) => {}
                _ => return Err(format!("{name} can be read in only one theme")),
            }
        } else if let Some(value) = light {
            if matches!(value, Value::Color(..)) {
                tokens.primitives.push((name.clone(), value));
            } else {
                tokens.scale.push((name.clone(), value));
            }
        }
    }
    Ok(tokens)
}

#[derive(PartialEq)]
enum Layer {
    Base,
    Dark,
}

struct Target {
    layer: Layer,
    themed: bool,
}

/// Which cascade layer a rule feeds, or nothing for rules this reader does not follow (touch, compact chrome).
fn target_of(rule: &Rule) -> Option<Target> {
    let has = |wanted: &str| rule.selectors.iter().any(|selector| selector == wanted);
    if has(DARK_SELECTOR) {
        Some(Target { layer: Layer::Dark, themed: true })
    } else if has(":root") {
        Some(Target { layer: Layer::Base, themed: has(LIGHT_SELECTOR) })
    } else {
        None
    }
}

/// The value of `name` in `env`, or None (and a note in `skipped`) when it cannot be a constant.
fn classify(name: &str, env: &HashMap<String, String>, skipped: &mut Vec<(String, String)>) -> Result<Option<Value>, String> {
    let Some(raw) = env.get(name) else { return Ok(None) };
    // A property the page sets at run time (`--ui-scale`) cannot be resolved here: that token is not a constant.
    let resolved = match css::resolve(raw, env) {
        Ok(resolved) => resolved,
        Err(reason) => {
            skipped.push((name.to_string(), format!("{reason}: {raw}")));
            return Ok(None);
        }
    };
    match value_of(name, &resolved) {
        Ok(value) => Ok(Some(value)),
        Err(reason) => {
            if !skipped.iter().any(|(skipped_name, _)| skipped_name == name) {
                skipped.push((name.to_string(), format!("{reason}: {resolved}")));
            }
            Ok(None)
        }
    }
}

fn value_of(name: &str, text: &str) -> Result<Value, String> {
    if name.starts_with("--elevation") || name.starts_with("--shadow") || name == "--primary-shadow" {
        return shadows(text).map(Value::Shadows);
    }
    if name.starts_with("--type-") {
        return type_role(text);
    }
    if name.starts_with("--font-") {
        return Ok(Value::Text(text.to_string()));
    }
    if text.starts_with('#') || text.starts_with("rgb") || text == "transparent" {
        return color(text).map(|(rgb, alpha)| Value::Color(rgb, alpha));
    }
    if let Some(args) = text.strip_prefix("cubic-bezier(").and_then(|rest| rest.strip_suffix(')')) {
        let numbers: Vec<f64> = args.split(',').map(|part| part.trim().parse::<f64>().map_err(|_| "easing".to_string())).collect::<Result<_, _>>()?;
        return <[f64; 4]>::try_from(numbers).map(Value::Bezier).map_err(|_| "easing needs four numbers".to_string());
    }
    if let Some(number) = text.strip_suffix("px").and_then(|n| n.parse::<f64>().ok()) {
        return Ok(Value::Px(number));
    }
    if let Some(number) = text.strip_suffix("ms").and_then(|n| n.parse::<f64>().ok()) {
        return Ok(Value::Ms(number));
    }
    if let Some(number) = text.strip_suffix("em").and_then(|n| n.parse::<f64>().ok()) {
        return Ok(Value::Em(number));
    }
    if let Ok(number) = text.parse::<f64>() {
        return Ok(Value::Number(number));
    }
    Err("not a constant".to_string())
}

fn hex_pair(text: &str) -> Result<u8, String> {
    u8::from_str_radix(text, 16).map_err(|_| format!("bad hex {text:?}"))
}

/// A CSS colour as computed: its red, green and blue bytes and its alpha as a fraction.
pub fn color(text: &str) -> Result<([u8; 3], f32), String> {
    if text == "transparent" {
        return Ok(([0, 0, 0], 0.0));
    }
    if let Some(hex) = text.strip_prefix('#') {
        let digits: Vec<String> = match hex.len() {
            3 | 4 => hex.chars().map(|c| format!("{c}{c}")).collect(),
            6 | 8 => hex.as_bytes().chunks(2).map(|pair| String::from_utf8_lossy(pair).into_owned()).collect(),
            _ => return Err(format!("bad hex colour {text:?}")),
        };
        let channel = |index: usize| hex_pair(&digits[index]);
        let alpha = if digits.len() == 4 { f32::from(channel(3)?) / 255.0 } else { 1.0 };
        return Ok(([channel(0)?, channel(1)?, channel(2)?], alpha));
    }
    let args = text
        .strip_prefix("rgba(")
        .or_else(|| text.strip_prefix("rgb("))
        .and_then(|rest| rest.strip_suffix(')'))
        .ok_or_else(|| format!("unsupported colour {text:?}"))?;
    let parts: Vec<&str> = args.split([',', ' ', '/']).map(str::trim).filter(|part| !part.is_empty()).collect();
    if parts.len() != 3 && parts.len() != 4 {
        return Err(format!("unsupported colour {text:?}"));
    }
    let byte = |part: &str| part.parse::<f64>().map(|v| v.round().clamp(0.0, 255.0) as u8).map_err(|_| format!("bad colour {text:?}"));
    let alpha = match parts.get(3) {
        Some(alpha) => match alpha.strip_suffix('%') {
            Some(percent) => percent.parse::<f32>().map(|p| p / 100.0),
            None => alpha.parse::<f32>(),
        }
        .map_err(|_| format!("bad alpha in {text:?}"))?,
        None => 1.0,
    };
    Ok(([byte(parts[0])?, byte(parts[1])?, byte(parts[2])?], alpha))
}

fn length(text: &str) -> Result<f64, String> {
    let number = text.strip_suffix("px").unwrap_or(text);
    number.parse::<f64>().map_err(|_| format!("bad length {text:?}"))
}

/// `none`, or comma-separated `[inset] x y [blur [spread]] colour` shadows.
fn shadows(text: &str) -> Result<Vec<Shadow>, String> {
    if text == "none" {
        return Ok(Vec::new());
    }
    let mut parts = Vec::new();
    let (mut depth, mut start) = (0i32, 0);
    for (index, character) in text.char_indices() {
        match character {
            '(' => depth += 1,
            ')' => depth -= 1,
            ',' if depth == 0 => {
                parts.push(&text[start..index]);
                start = index + 1;
            }
            _ => {}
        }
    }
    parts.push(&text[start..]);
    parts
        .into_iter()
        .map(|part| {
            let part = part.trim();
            let (inset, part) = match part.strip_prefix("inset") {
                Some(rest) => (true, rest.trim()),
                None => (false, part),
            };
            let color_start = part.find("rgb").or_else(|| part.find('#')).ok_or_else(|| format!("no colour in shadow {part:?}"))?;
            let numbers: Vec<f64> = part[..color_start].split_whitespace().map(length).collect::<Result<_, _>>()?;
            if !(2..=4).contains(&numbers.len()) {
                return Err(format!("a shadow needs two to four lengths: {part:?}"));
            }
            Ok(Shadow {
                inset,
                x: numbers[0],
                y: numbers[1],
                blur: numbers.get(2).copied().unwrap_or(0.0),
                spread: numbers.get(3).copied().unwrap_or(0.0),
                color: color(part[color_start..].trim())?,
            })
        })
        .collect()
}

/// `weight size/line-height family`, with the line height in pixels or as a multiple of the size.
fn type_role(text: &str) -> Result<Value, String> {
    let mut words = text.splitn(3, ' ');
    let (weight, size_leading, family) = (words.next(), words.next(), words.next());
    let (Some(weight), Some(size_leading), Some(family)) = (weight, size_leading, family) else { return Err("not a type role".into()) };
    let (size, leading) = size_leading.split_once('/').ok_or("not a type role")?;
    let size = length(size)?;
    let line_height = if leading.ends_with("px") { length(leading)? } else { leading.parse::<f64>().map_err(|_| "bad line height".to_string())? * size };
    Ok(Value::Type { weight: weight.parse::<f64>().map_err(|_| "bad weight".to_string())?, size, line_height, family: family.to_string() })
}

// ---- Rust output ----

fn float(value: f64) -> String {
    format!("{:?}", value as f32)
}

fn rgba((rgb, alpha): ([u8; 3], f32)) -> String {
    format!("Rgba::new({}, {}, {}, {:?})", rgb[0], rgb[1], rgb[2], alpha)
}

fn shadow_list(shadows: &[Shadow]) -> String {
    if shadows.is_empty() {
        return "&[]".to_string();
    }
    let items: Vec<String> = shadows
        .iter()
        .map(|s| format!("BoxShadow {{ inset: {}, x: {}, y: {}, blur: {}, spread: {}, color: {} }}", s.inset, float(s.x), float(s.y), float(s.blur), float(s.spread), rgba(s.color)))
        .collect();
    format!("&[{}]", items.join(", "))
}

fn constant_name(css_name: &str) -> String {
    css_name.trim_start_matches("--").replace('-', "_").to_uppercase()
}

fn field_name(css_name: &str) -> String {
    css_name.trim_start_matches("--").replace('-', "_")
}

/// The scale constant for a value: its Rust type and expression.
fn scale_constant(name: &str, value: &Value) -> Option<(String, String, String)> {
    let base = constant_name(name);
    Some(match value {
        Value::Px(v) => (base, "f32".into(), float(*v)),
        Value::Em(v) => (format!("{base}_EM"), "f32".into(), float(*v)),
        Value::Ms(v) => (format!("{base}_MS"), "f32".into(), float(*v)),
        Value::Number(v) => (base, "f32".into(), float(*v)),
        Value::Bezier(b) => (base, "[f32; 4]".into(), format!("[{}, {}, {}, {}]", float(b[0]), float(b[1]), float(b[2]), float(b[3]))),
        Value::Text(t) => (base, "&str".into(), format!("r#\"{t}\"#")),
        Value::Type { weight, size, line_height, family } => (base, "TypeRole".into(), format!("TypeRole {{ weight: {}, size: {}, line_height: {}, family: r#\"{family}\"# }}", float(*weight), float(*size), float(*line_height))),
        Value::Color(..) | Value::Shadows(_) => return None,
    })
}

pub fn generate(source: &str) -> Result<String, String> {
    let tokens = parse(source)?;
    let mut out = String::new();
    out.push_str("// @generated by `cargo xtask design generate` from src/styles/tokens.css. Do not edit: change the CSS and regenerate.\n");
    out.push_str("// `cargo xtask design check` fails when this file is stale.\n//\n");
    out.push_str("// Left out because a constant cannot hold them (calc(), max(), env(), shorthands, touch and compact overrides):\n");
    for (name, reason) in &tokens.skipped {
        let _ = writeln!(out, "//   {name}: {reason}");
    }
    out.push_str("\nuse crate::{BoxShadow, Rgba, TypeRole};\n");

    out.push_str("\n/// The brand palette and the fixed colours: the same in both themes.\n#[allow(missing_docs)]\npub mod primitives {\n    use super::Rgba;\n");
    for (name, value) in &tokens.primitives {
        if let Value::Color(rgb, alpha) = value {
            let _ = writeln!(out, "    /// `{name}`\n    pub const {}: Rgba = {};", constant_name(name), rgba((*rgb, *alpha)));
        }
    }
    out.push_str("}\n");

    out.push_str("\n/// The scales: type, space, radius, controls, motion. The same in both themes.\n#[allow(missing_docs)]\npub mod scale {\n    #[allow(unused_imports)]\n    use super::TypeRole;\n");
    for (name, value) in &tokens.scale {
        if let Some((constant, ty, expression)) = scale_constant(name, value) {
            let _ = writeln!(out, "    /// `{name}`\n    pub const {constant}: {ty} = {expression};");
        }
    }
    out.push_str("}\n");

    out.push_str("\n/// The semantic roles of one theme. Field names are the CSS custom properties without `--` and with `_` for `-`.\n#[derive(Clone, Copy, Debug, PartialEq)]\n#[allow(missing_docs)]\npub struct Palette {\n");
    for (name, light, _) in &tokens.themed {
        let ty = if matches!(light, Value::Color(..)) { "Rgba" } else { "&'static [BoxShadow]" };
        let _ = writeln!(out, "    /// `{name}`\n    pub {}: {ty},", field_name(name));
    }
    out.push_str("}\n");
    for (constant, doc, pick_dark) in [("LIGHT", "The light theme: the brand default.", false), ("DARK", "The dark theme.", true)] {
        let _ = writeln!(out, "\n/// {doc}\npub const {constant}: Palette = Palette {{");
        for (name, light, dark) in &tokens.themed {
            let value = if pick_dark { dark } else { light };
            let expression = match value {
                Value::Color(rgb, alpha) => rgba((*rgb, *alpha)),
                Value::Shadows(list) => shadow_list(list),
                _ => unreachable!("themed tokens are colours or shadows"),
            };
            let _ = writeln!(out, "    {}: {expression},", field_name(name));
        }
        out.push_str("};\n");
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CSS: &str = r#"
@layer tokens {
  :root { --paper: #ffffff; --ink: #0c0d12; --space-2: 8px; --text-13: 13px; --leading-13: 20px; --weight-medium: 500;
          --font-ui: "Inter", sans-serif; --tracking-caps: 0.04em; --dur-fast: 100ms; --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
          --type-ui: var(--weight-medium) var(--text-13)/var(--leading-13) var(--font-ui);
          --topbar-h: max(52px, calc(44px / var(--ui-scale))); --fixed: #0a0b0f; }
  :root, :root[data-theme="light"] { --surface: var(--paper); --text-1: var(--ink); --ring: rgba(12, 13, 18, 0.36);
          --elevation-1: 0 0 0 1px rgba(12, 13, 18, 0.06), 0 1px 2px rgba(12, 13, 18, 0.04); --keep: var(--paper); }
  :root[data-theme="dark"] { --surface: #15161c; --ring: rgba(255, 255, 255, 0.5);
          --elevation-1: 0 0 0 1px rgba(255, 255, 255, 0.06), inset 0 1px 0 rgba(255, 255, 255, 0.025); }
  :root[data-input="touch"] { --space-2: 12px; }
}"#;

    #[test]
    fn colours_are_computed_the_way_css_computes_them() {
        assert_eq!(color("#0c0d12").unwrap(), ([12, 13, 18], 1.0));
        assert_eq!(color("#fff").unwrap(), ([255, 255, 255], 1.0));
        assert_eq!(color("#00000080").unwrap().1, 128.0 / 255.0);
        assert_eq!(color("rgba(13, 153, 255, 0.22)").unwrap(), ([13, 153, 255], 0.22));
        assert_eq!(color("rgb(1 2 3 / 50%)").unwrap(), ([1, 2, 3], 0.5));
        assert_eq!(color("transparent").unwrap(), ([0, 0, 0], 0.0));
        assert!(color("Canvas").is_err());
    }

    #[test]
    fn the_cascade_gives_each_theme_its_values() {
        let tokens = parse(CSS).unwrap();
        let surface = tokens.themed.iter().find(|(name, ..)| name == "--surface").unwrap();
        assert_eq!(surface.1, Value::Color([255, 255, 255], 1.0));
        assert_eq!(surface.2, Value::Color([0x15, 0x16, 0x1c], 1.0));
        // Not overridden in dark: dark keeps the light rule's value.
        let keep = tokens.themed.iter().find(|(name, ..)| name == "--keep").unwrap();
        assert_eq!(keep.1, keep.2);
        // Overridden shadows are read, and `inset` is kept.
        let Value::Shadows(dark) = &tokens.themed.iter().find(|(name, ..)| name == "--elevation-1").unwrap().2 else { panic!() };
        assert_eq!(dark.len(), 2);
        assert!(dark[1].inset);
        assert_eq!(dark[0].spread, 1.0);
    }

    #[test]
    fn primitives_and_scales_are_theme_independent_and_touch_rules_are_ignored() {
        let tokens = parse(CSS).unwrap();
        assert!(tokens.primitives.iter().any(|(name, _)| name == "--paper"));
        assert!(tokens.primitives.iter().any(|(name, _)| name == "--fixed"));
        let space = tokens.scale.iter().find(|(name, _)| name == "--space-2").unwrap();
        assert_eq!(space.1, Value::Px(8.0));
        let role = tokens.scale.iter().find(|(name, _)| name == "--type-ui").unwrap();
        assert_eq!(role.1, Value::Type { weight: 500.0, size: 13.0, line_height: 20.0, family: "\"Inter\", sans-serif".into() });
        assert!(tokens.skipped.iter().any(|(name, _)| name == "--topbar-h"));
    }

    #[test]
    fn generated_rust_names_every_token_and_compiles_to_the_same_text_twice() {
        let first = generate(CSS).unwrap();
        assert_eq!(first, generate(CSS).unwrap());
        assert!(first.contains("pub const PAPER: Rgba = Rgba::new(255, 255, 255, 1.0);"));
        assert!(first.contains("pub const SPACE_2: f32 = 8.0;"));
        assert!(first.contains("pub const DUR_FAST_MS: f32 = 100.0;"));
        assert!(first.contains("pub const TRACKING_CAPS_EM: f32 = 0.04;"));
        assert!(first.contains("pub surface: Rgba,"));
        assert!(first.contains("pub elevation_1: &'static [BoxShadow],"));
        assert!(first.contains("surface: Rgba::new(21, 22, 28, 1.0),"));
    }

    #[test]
    fn a_themed_token_that_is_not_a_colour_or_shadow_is_an_error() {
        let css = "@layer tokens { :root, :root[data-theme=\"light\"] { --size: 4px; } :root[data-theme=\"dark\"] { --size: 5px; } }";
        assert!(parse(css).unwrap_err().contains("--size"));
    }
}
