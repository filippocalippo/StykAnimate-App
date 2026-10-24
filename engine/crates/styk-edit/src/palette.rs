//! The project palette (src/editor-colors.mjs): colours added, removed and reordered, each
//! one `palette` history entry that touches no frame or figure (`publishPalette`).

use styk_doc::{Obj, Value};

use crate::history::{Command, CommandKind, Direction};
use crate::{EditError, Editor};

/// `PROJECT_PALETTE_LIMIT`.
const LIMIT: usize = 64;

/// `hexColor(rgb)`: `#` and each channel rounded, in lower-case hexadecimal.
fn hex_color(rgb: &[f64]) -> String {
    let mut out = String::from("#");
    for v in rgb {
        let n = (v + 0.5).floor();
        let text = if n.is_finite() && n >= 0.0 { format!("{:x}", n as u64) } else if n.is_finite() { format!("-{:x}", (-n) as u64) } else { "NaN".to_string() };
        out.push_str(&format!("{text:0>2}"));
    }
    out
}

/// `paletteColor(color)`: RGB bytes, or `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa` text.
fn palette_color(color: &Value) -> Result<String, EditError> {
    if let Some(items) = color.elements() {
        let rgb: Vec<f64> = items.iter().map(|v| v.as_f64().unwrap_or(f64::NAN)).collect();
        return Ok(hex_color(&rgb));
    }
    let text = match color {
        Value::Str(_) | Value::Blob(_) => color.text().unwrap_or_default().to_string(),
        Value::Num(n) => styk_doc::json::to_string(&Value::Num(*n)),
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".into(),
        _ => return Err(EditError::Unported("a palette colour that is not text or bytes".into())),
    };
    let mut h: String = text.strip_prefix('#').unwrap_or(&text).to_string();
    let hex = |s: &str| s.chars().all(|c| c.is_ascii_hexdigit());
    if (3..=4).contains(&h.len()) && hex(&h) {
        h = h.chars().flat_map(|c| [c, c]).collect();
    }
    if !(h.len() == 6 || h.len() == 8) || !hex(&h) {
        return Err(EditError::Invalid("errors.paint.useAValidHexColorOptionallyIncludingAlpha".into()));
    }
    let rgb: Vec<f64> = (0..3).map(|i| u8::from_str_radix(&h[i * 2..i * 2 + 2], 16).unwrap_or(0) as f64).collect();
    Ok(hex_color(&rgb))
}

/// `paletteHex(value)`.
fn palette_hex(value: &str) -> Option<String> {
    let lower = value.to_lowercase();
    (lower.len() == 7 && lower.starts_with('#') && lower[1..].chars().all(|c| c.is_ascii_hexdigit())).then_some(lower)
}

impl Editor {
    /// `projectColors(report)`: the saved colours, cleaned.
    fn project_colors(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for value in self.report.path(&["_styk", "palette", "colors"]).and_then(Value::elements).map(|e| e.iter().collect::<Vec<_>>()).unwrap_or_default() {
            if let Some(hex) = value.as_str().and_then(palette_hex)
                && !out.contains(&hex)
            {
                out.push(hex);
            }
            if out.len() >= LIMIT {
                break;
            }
        }
        out
    }

    /// `publishPalette(editor, colors, label)`.
    fn publish_palette(&mut self, colors: Vec<String>, label: &str) -> Result<bool, EditError> {
        if colors == self.project_colors() {
            return Ok(false);
        }
        let unique = colors.iter().collect::<std::collections::HashSet<_>>().len() == colors.len();
        if colors.len() > LIMIT {
            return Err(EditError::Invalid("errors.colorPalette.aProjectPaletteHoldsUpToColors".into()));
        }
        if colors.iter().any(|c| palette_hex(c).as_deref() != Some(c.as_str())) || !unique {
            return Err(EditError::Invalid("errors.colorPalette.paletteColorsMustBeUniqueRrggbbValues".into()));
        }
        if self.drag.is_some() {
            self.commit_drag()?;
        }
        let report = self.report.make_obj().ok_or_else(|| EditError::Unported("a document that is not an object".into()))?;
        if report.get("_styk").is_none() {
            report.set("_styk", Value::object(Obj::new()));
        }
        let metadata = report.get_mut("_styk").and_then(Value::make_obj).ok_or_else(|| EditError::Unported("metadata that is not an object".into()))?;
        let before = metadata.get("palette").cloned();
        let after = (!colors.is_empty()).then(|| {
            let mut palette = Obj::new();
            palette.set("version", Value::Num(1.0));
            palette.set("colors", Value::array(colors.iter().map(|c| Value::str(c)).collect()));
            Value::object(palette)
        });
        match &after {
            Some(palette) => metadata.set("palette", palette.clone()),
            None => {
                metadata.remove("palette");
            }
        }
        let selection = self.selection_state();
        self.record(Command { kind: CommandKind::Palette { before, after }, label: label.into(), before_selection: selection.clone(), after_selection: selection, before_revision: 0, after_revision: 0, layer_changes: Vec::new(), captured_source_bytes: 0, layers: false })?;
        self.emit("edit", vec![("label", Value::str(label)), ("palette", Value::Bool(true))]);
        Ok(true)
    }

    /// `applyPaletteCommand(editor, command, direction)`.
    pub(crate) fn apply_palette_command(&mut self, command: &Command, direction: Direction) -> Result<(), EditError> {
        let CommandKind::Palette { before, after } = &command.kind else { return Ok(()) };
        let value = if direction == Direction::Before { before } else { after };
        if let Some(report) = self.report.make_obj() {
            if report.get("_styk").is_none() {
                report.set("_styk", Value::object(Obj::new()));
            }
            if let Some(metadata) = report.get_mut("_styk").and_then(Value::make_obj) {
                match value.as_ref().filter(|v| v.truthy()) {
                    Some(palette) => metadata.set("palette", palette.clone()),
                    None => {
                        metadata.remove("palette");
                    }
                }
            }
        }
        self.revision = if direction == Direction::Before { command.before_revision } else { command.after_revision };
        self.emit("history", vec![("label", Value::str(&command.label)), ("palette", Value::Bool(true))]);
        Ok(())
    }

    /// `addPaletteColor(color)`.
    pub(crate) fn add_palette_color(&mut self, color: &Value) -> Result<bool, EditError> {
        let hex = palette_color(color)?;
        let colors = self.project_colors();
        if colors.contains(&hex) {
            return Ok(false);
        }
        if colors.len() >= LIMIT {
            return Err(EditError::Invalid("errors.editorColors.theProjectPaletteIsFullRemoveAColor".into()));
        }
        let mut next = colors;
        next.push(hex);
        self.publish_palette(next, "Add palette color")
    }

    /// `addPaletteColors(list)`: how many it added.
    pub(crate) fn add_palette_colors(&mut self, list: &Value) -> Result<Value, EditError> {
        let colors = self.project_colors();
        let mut added: Vec<String> = Vec::new();
        for color in list.elements().map(|e| e.iter().collect::<Vec<_>>()).unwrap_or_default() {
            let hex = palette_color(&color)?;
            if !added.contains(&hex) {
                added.push(hex);
            }
        }
        added.retain(|hex| !colors.contains(hex));
        if added.is_empty() {
            return Ok(Value::Num(0.0));
        }
        if colors.len() + added.len() > LIMIT {
            return Err(EditError::Invalid("errors.editorColors.theProjectPaletteHoldsUpToColorsRemove".into()));
        }
        let count = added.len();
        let mut next = colors;
        next.extend(added);
        self.publish_palette(next, "Add palette colors")?;
        Ok(Value::Num(count as f64))
    }

    /// `removePaletteColor(color)`.
    pub(crate) fn remove_palette_color(&mut self, color: &Value) -> Result<bool, EditError> {
        let hex = palette_color(color)?;
        let colors = self.project_colors();
        if !colors.contains(&hex) {
            return Ok(false);
        }
        self.publish_palette(colors.into_iter().filter(|c| *c != hex).collect(), "Remove palette color")
    }

    /// `movePaletteColor(color, index)`: the colour's position after the move.
    pub(crate) fn move_palette_color(&mut self, color: &Value, index: &Value) -> Result<bool, EditError> {
        let hex = palette_color(color)?;
        let colors = self.project_colors();
        if !colors.contains(&hex) {
            return Ok(false);
        }
        // `Math.max(0, Math.min(colors.length - 1, Math.trunc(index) || 0))`
        let wanted = index.as_f64().map(f64::trunc).filter(|n| n.is_finite() && *n != 0.0).unwrap_or(0.0);
        let to = wanted.min(colors.len() as f64 - 1.0).max(0.0) as usize;
        let mut next: Vec<String> = colors.into_iter().filter(|c| *c != hex).collect();
        next.insert(to.min(next.len()), hex);
        self.publish_palette(next, "Reorder palette colors")
    }
}
