//! StykAnimate's dark design tokens (src/styles/tokens.css, `[data-theme="dark"]`)
//! mapped onto egui.

use egui::{Color32, CornerRadius, Frame, Margin, RichText, Stroke};

pub const SURFACE_FIELD: Color32 = Color32::from_rgb(0x0a, 0x0b, 0x0f); // ink-950
pub const SURFACE: Color32 = Color32::from_rgb(0x15, 0x16, 0x1c); // ink-800
pub const SURFACE_RAISED: Color32 = Color32::from_rgb(0x1b, 0x1c, 0x23); // ink-750
pub const SURFACE_SUNKEN: Color32 = Color32::from_rgb(0x1e, 0x20, 0x29); // ink-700
pub const SURFACE_HOVER: Color32 = Color32::from_rgb(0x26, 0x28, 0x33); // ink-600
pub const SURFACE_PRESSED: Color32 = Color32::from_rgb(0x2a, 0x2e, 0x3a); // ink-550
pub const STAGE: Color32 = Color32::from_rgb(0x11, 0x12, 0x17); // ink-850
pub const STAGE_LINEAR: [f64; 4] = [0x11 as f64 / 255.0, 0x12 as f64 / 255.0, 0x17 as f64 / 255.0, 1.0];
pub const TEXT_1: Color32 = Color32::from_rgb(0xec, 0xee, 0xf3); // mist-200
pub const TEXT_2: Color32 = Color32::from_rgb(0xa9, 0xae, 0xbb); // slate-350
pub const TEXT_3: Color32 = Color32::from_rgb(0x8f, 0x95, 0xa4); // slate-450
pub const LINE_1: Color32 = Color32::from_rgb(0x22, 0x24, 0x2e); // ink-650
pub const LINE_2: Color32 = Color32::from_rgb(0x2a, 0x2e, 0x3a); // ink-550
pub const LINE_3: Color32 = Color32::from_rgb(0x3a, 0x3f, 0x4f); // ink-500
pub const ACCENT: Color32 = Color32::from_rgb(0x0d, 0x99, 0xff); // blue-500
pub const ACCENT_TEXT: Color32 = Color32::from_rgb(0x45, 0xb0, 0xff); // blue-400
pub const ON_ACCENT: Color32 = Color32::from_rgb(0x0c, 0x0d, 0x12); // ink-900 (never white on blue)
pub const WARNING: Color32 = Color32::from_rgb(0xd9, 0x90, 0x35);
pub const DANGER: Color32 = Color32::from_rgb(0xdf, 0x66, 0x90);

pub fn apply(ctx: &egui::Context) {
    let mut style = (*ctx.global_style()).clone();
    let v = &mut style.visuals;
    *v = egui::Visuals::dark();
    v.panel_fill = SURFACE;
    v.window_fill = SURFACE_RAISED;
    v.extreme_bg_color = SURFACE_FIELD;
    v.faint_bg_color = SURFACE_SUNKEN;
    v.code_bg_color = SURFACE_SUNKEN;
    v.window_stroke = Stroke::new(1.0, LINE_1);
    v.window_corner_radius = CornerRadius::same(16);
    v.menu_corner_radius = CornerRadius::same(16);
    v.selection.bg_fill = Color32::from_rgb(0x0a, 0x3a, 0x66);
    v.selection.stroke = Stroke::new(1.0, ACCENT);
    v.hyperlink_color = ACCENT_TEXT;
    v.override_text_color = Some(TEXT_1);
    for (w, fill) in [
        (&mut v.widgets.noninteractive, SURFACE),
        (&mut v.widgets.inactive, SURFACE_SUNKEN),
        (&mut v.widgets.hovered, SURFACE_HOVER),
        (&mut v.widgets.active, SURFACE_PRESSED),
        (&mut v.widgets.open, SURFACE_HOVER),
    ] {
        w.bg_fill = fill;
        w.weak_bg_fill = fill;
        w.corner_radius = CornerRadius::same(10);
        w.bg_stroke = Stroke::new(1.0, LINE_1);
        w.fg_stroke = Stroke::new(1.0, TEXT_1);
    }
    v.widgets.noninteractive.bg_stroke = Stroke::new(1.0, LINE_1);
    v.widgets.noninteractive.fg_stroke = Stroke::new(1.0, TEXT_2);
    style.spacing.item_spacing = egui::vec2(8.0, 6.0);
    style.spacing.button_padding = egui::vec2(10.0, 5.0);
    ctx.set_global_style(style);
}

pub fn bar() -> Frame {
    Frame::new().fill(SURFACE).inner_margin(Margin::symmetric(12, 6)).stroke(Stroke::new(1.0, LINE_1))
}

pub fn panel() -> Frame {
    Frame::new().fill(SURFACE).inner_margin(Margin::same(12)).stroke(Stroke::new(1.0, LINE_1))
}

pub fn button(text: &str) -> egui::Button<'static> {
    egui::Button::new(RichText::new(text.to_string()).color(TEXT_1)).fill(SURFACE_SUNKEN).corner_radius(CornerRadius::same(10))
}

pub fn icon_button(text: &str) -> egui::Button<'static> {
    egui::Button::new(RichText::new(text.to_string()).size(15.0).color(TEXT_1)).fill(SURFACE_SUNKEN).corner_radius(CornerRadius::same(10)).min_size(egui::vec2(34.0, 30.0))
}

pub fn primary_button(text: &str) -> egui::Button<'static> {
    egui::Button::new(RichText::new(text.to_string()).size(15.0).color(ON_ACCENT)).fill(ACCENT).corner_radius(CornerRadius::same(10)).min_size(egui::vec2(42.0, 30.0))
}

pub fn chip(ui: &mut egui::Ui, text: &str, color: Color32) -> egui::Response {
    Frame::new()
        .fill(color.gamma_multiply(0.18))
        .stroke(Stroke::new(1.0, color.gamma_multiply(0.6)))
        .corner_radius(CornerRadius::same(6))
        .inner_margin(Margin::symmetric(8, 2))
        .show(ui, |ui| ui.label(RichText::new(text).size(11.0).color(color)))
        .response
}
