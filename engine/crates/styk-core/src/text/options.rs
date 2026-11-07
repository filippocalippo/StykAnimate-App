//! `textOptionsWithDefaults`: the validation and defaults of a text draft, in the order `text-authoring.mjs` applies them.

use styk_doc::{Obj, Value};
use unicode_normalization::UnicodeNormalization;

use super::paint::normalize_paint;
use super::TextError;

/// `MAX_TEXT_LENGTH`: UTF-16 units in a draft.
pub const MAX_TEXT_LENGTH: usize = 16384;

/// `Math.fround` as a double.
pub(crate) fn f32r(v: f64) -> f64 {
    v as f32 as f64
}

/// `Math.round`: halves go up.
pub(crate) fn js_round(v: f64) -> f64 {
    if !v.is_finite() {
        return v;
    }
    let floor = v.floor();
    if v - floor >= 0.5 { floor + 1.0 } else { floor }
}

/// `String.prototype.trim`: JavaScript's white space and line terminators, which differ from Unicode's `White_Space`
/// (U+FEFF counts, U+0085 does not).
pub(crate) fn js_trim(text: &str) -> &str {
    let space = |c: char| {
        matches!(
            c,
            '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}'
                | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
        )
    };
    text.trim_matches(space)
}

/// A draft as the dialog holds it (`options` of `compileTextFigure`). Numbers are not validated until compile, as there.
#[derive(Debug, Clone, PartialEq)]
pub struct TextOptions {
    pub text: String,
    /// A paint picker's value, normalized at compile time.
    pub paint: Option<Value>,
    pub name: String,
    pub font_family: Option<String>,
    pub font_size: f64,
    pub bold: bool,
    pub italic: bool,
    /// `left`, `center` or `right`.
    pub alignment: String,
    pub line_height: f64,
    pub color: [f64; 3],
    pub opacity: f64,
    pub gradient_color: Option<[f64; 3]>,
    pub outline_width: f64,
    pub outline_color: [f64; 3],
    pub figure_type_id: f64,
    /// Set by [`TextOptions::from_value`] when `bold` or `italic` was not a boolean.
    pub flags_invalid: bool,
}

impl TextOptions {
    /// The defaults of `textOptionsWithDefaults`.
    pub fn new(text: impl Into<String>) -> TextOptions {
        TextOptions {
            text: text.into(),
            paint: None,
            name: "Text".to_string(),
            font_family: None,
            font_size: 48.0,
            bold: false,
            italic: false,
            alignment: "left".to_string(),
            line_height: 1.2,
            color: [43.0, 43.0, 43.0],
            opacity: 1.0,
            gradient_color: None,
            outline_width: 0.0,
            outline_color: [0.0, 0.0, 0.0],
            figure_type_id: 1.0,
            flags_invalid: false,
        }
    }
}

/// Validated options with the text normalized: `textOptionsWithDefaults(options)`.
#[derive(Debug, Clone, PartialEq)]
pub struct TextSettings {
    /// Line breaks as `\n` and, unless the options came from imported text, in canonical composition. Basic Multilingual
    /// Plane only, so one `char` is one UTF-16 unit.
    pub text: String,
    pub paint: Option<Value>,
    pub name: String,
    pub font_family: Option<String>,
    pub font_size: f64,
    pub bold: bool,
    pub italic: bool,
    pub alignment: String,
    pub line_height: f64,
    pub color: [f64; 3],
    pub opacity: f64,
    pub gradient_color: Option<[f64; 3]>,
    pub outline_width: f64,
    pub outline_color: [f64; 3],
    pub figure_type_id: f64,
}

fn label_value(label: &str) -> Value {
    let key = match label {
        "Font size" => "errors.validationLabels.fontSize",
        "Line height" => "errors.validationLabels.lineHeight",
        "Opacity" => "errors.validationLabels.opacity",
        "Outline width" => "errors.validationLabels.outlineWidth",
        "Text color" => "errors.validationLabels.textColor",
        "Gradient color" => "errors.validationLabels.gradientColor",
        "Outline color" => "errors.validationLabels.outlineColor",
        _ => unreachable!("label {label} has no entry in src/validation-labels.mjs"),
    };
    let mut object = Obj::new();
    object.set("messageKey", Value::str(key));
    object.set("diagnosticValue", Value::str(label));
    Value::object(object)
}

fn number(value: f64, label: &str, min: f64, max: f64) -> Result<f64, TextError> {
    if !value.is_finite() || value < min || value > max {
        return Err(TextError::with(
            "errors.cameraMotion.mustBeBetweenAnd",
            vec![("label", label_value(label)), ("min", Value::Num(min)), ("max", Value::Num(max))],
        ));
    }
    Ok(value)
}

fn rgb(value: [f64; 3], label: &str) -> Result<[f64; 3], TextError> {
    if value.iter().any(|n| !n.is_finite() || n.fract() != 0.0 || *n < 0.0 || *n > 255.0) {
        return Err(TextError::with("errors.textAuthoring.mustContainThreeRgbBytes", vec![("label", label_value(label))]));
    }
    Ok(value)
}

/// `text.replace(/\r\n?/g, "\n")`.
pub(crate) fn normalize_line_breaks(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\r' {
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
            out.push('\n');
        } else {
            out.push(c);
        }
    }
    out
}

impl TextSettings {
    /// `textOptionsWithDefaults(options, {normalizeText})`.
    pub fn validate(options: &TextOptions, normalize_text: bool) -> Result<TextSettings, TextError> {
        let units = options.text.encode_utf16().count();
        if js_trim(&options.text).is_empty() {
            return Err(TextError::key("errors.textAuthoring.enterVisibleText"));
        }
        if units > MAX_TEXT_LENGTH {
            return Err(TextError::with(
                "errors.textAuthoring.textMustContainAtMostCharacters",
                vec![("value", Value::str(&MAX_TEXT_LENGTH.to_string()))],
            ));
        }
        if !["left", "center", "right"].contains(&options.alignment.as_str()) {
            return Err(TextError::key("errors.textAuthoring.textAlignmentMustBeLeftCenterOrRight"));
        }
        if options.flags_invalid {
            return Err(TextError::key("errors.textAuthoring.boldAndItalicMustBeTrueOrFalse"));
        }
        let id = options.figure_type_id;
        if !id.is_finite() || id.fract() != 0.0 || !(1.0..=65535.0).contains(&id) {
            return Err(TextError::key("errors.textAuthoring.figureIdMustBeBetween1And65535"));
        }
        let line_normalized = normalize_line_breaks(&options.text);
        let normalized = if normalize_text { line_normalized.nfc().collect::<String>() } else { line_normalized };
        let mut distinct: Vec<u16> = normalized.encode_utf16().collect();
        let all = distinct.clone();
        distinct.sort_unstable();
        distinct.dedup();
        if distinct.len() > 255 {
            return Err(TextError::key("errors.textAuthoring.pivotTextSupportsAtMost255DistinctUtf"));
        }
        if all.iter().any(|u| (0xd800..=0xdfff).contains(u)) {
            return Err(TextError::key("errors.textAuthoring.thisTextContainsCharactersOutsideTheSupportedUnicode"));
        }
        if normalized.chars().any(|c| matches!(c, '\u{0}'..='\u{8}' | '\u{b}'..='\u{1f}' | '\u{7f}')) {
            return Err(TextError::key("errors.textAuthoring.textContainsUnsupportedControlCharacters"));
        }
        let paint = match &options.paint {
            Some(paint) => Some(normalize_paint(paint)?),
            None => None,
        };
        let font_size = number(options.font_size, "Font size", 1.0, 2048.0)?;
        let line_height = number(options.line_height, "Line height", 0.5, 5.0)?;
        let color = rgb(options.color, "Text color")?;
        let opacity = number(options.opacity, "Opacity", 0.0, 1.0)?;
        let gradient_color = match options.gradient_color {
            Some(c) => Some(rgb(c, "Gradient color")?),
            None => None,
        };
        let outline_width = number(options.outline_width, "Outline width", 0.0, 128.0)?;
        let outline_color = rgb(options.outline_color, "Outline color")?;
        Ok(TextSettings {
            text: normalized,
            paint,
            name: options.name.clone(),
            font_family: options.font_family.clone().filter(|f| !f.is_empty()),
            font_size,
            bold: options.bold,
            italic: options.italic,
            alignment: options.alignment.clone(),
            line_height,
            color,
            opacity,
            gradient_color,
            outline_width,
            outline_color,
            figure_type_id: id,
        })
    }

    /// The object the settings spread into `_styk.textAuthoring` (`...o`), in the order they were built.
    pub(crate) fn to_object(&self) -> Obj {
        let mut o = Obj::new();
        o.set("text", Value::str(&self.text));
        if let Some(paint) = &self.paint {
            o.set("paint", paint.clone());
        }
        o.set("name", Value::str(&self.name));
        if let Some(family) = &self.font_family {
            o.set("fontFamily", Value::str(family));
        }
        o.set("fontSize", Value::Num(self.font_size));
        o.set("bold", Value::Bool(self.bold));
        o.set("italic", Value::Bool(self.italic));
        o.set("alignment", Value::str(&self.alignment));
        o.set("lineHeight", Value::Num(self.line_height));
        o.set("color", Value::array(self.color.iter().map(|&n| Value::Num(n)).collect()));
        o.set("opacity", Value::Num(self.opacity));
        o.set(
            "gradientColor",
            match self.gradient_color {
                Some(c) => Value::array(c.iter().map(|&n| Value::Num(n)).collect()),
                None => Value::Null,
            },
        );
        o.set("outlineWidth", Value::Num(self.outline_width));
        o.set("outlineColor", Value::array(self.outline_color.iter().map(|&n| Value::Num(n)).collect()));
        o.set("figureTypeId", Value::Num(self.figure_type_id));
        o
    }
}

/// `label(value)` of `text-authoring.mjs`: the figure's name restricted to the Windows-1252 repertoire.
pub(crate) fn label(name: &str) -> String {
    const EXTRA: [u16; 27] = [
        0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x017d, 0x2018,
        0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
    ];
    let source = if name.is_empty() { "Text" } else { name };
    let replaced: Vec<u16> = source
        .encode_utf16()
        .map(|u| {
            let kept = (0x20..=0x7e).contains(&u) || (0xa0..=0xff).contains(&u) || EXTRA.contains(&u);
            if kept { u } else { b'_' as u16 }
        })
        .collect();
    let replaced = String::from_utf16_lossy(&replaced);
    let trimmed = js_trim(&replaced);
    let units: Vec<u16> = trimmed.encode_utf16().take(180).collect();
    let sliced = String::from_utf16_lossy(&units);
    if sliced.is_empty() { "Text".to_string() } else { sliced }
}
