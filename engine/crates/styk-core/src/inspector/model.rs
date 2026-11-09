//! The Inspector's view model: one descriptor per context, as plain data (`src/inspector-view.mjs`'s descriptors and
//! `src/inspector-kit.mjs`'s row kinds). The core builds it from the session's reads and the view state; the interface
//! draws it with a generic kit and sends [`super::Event`]s back. Nothing here borrows the document or an engine object,
//! and every type compares by value, so a rebuilt model that equals the last one costs the view nothing.

use std::sync::Arc;

use super::order::DrawKind;
use super::paint::PaintSpec;
use super::property::PropertyKey;
use crate::commands::CommandId;
use crate::i18n::{Label, Msg};

/// What the Properties panel describes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Kind {
    Scene,
    Camera,
    /// A keyframe of a classic document.
    Keyframe,
    /// A frame of a layer-sheet document (its exposure).
    Frame,
    Layer,
    Figure,
    Text,
    Image,
    Figures,
    Joint,
    /// Contexts whose sections belong to later chunks; the panel shows their target and a slot.
    Movieclip,
    SpatialRig,
    Fill,
    Drawing,
}

impl Kind {
    /// The kind's name in `SectionMemory` and in `#inspector[data-selection-kind]`.
    pub fn id(self) -> &'static str {
        match self {
            Kind::Scene => "scene",
            Kind::Camera => "camera",
            Kind::Keyframe => "keyframe",
            Kind::Frame => "frame",
            Kind::Layer => "layer",
            Kind::Figure => "figure",
            Kind::Text => "text",
            Kind::Image => "image",
            Kind::Figures => "figures",
            Kind::Joint => "joint",
            Kind::Movieclip => "movieclip",
            Kind::SpatialRig => "spatial-rig",
            Kind::Fill => "fill",
            Kind::Drawing => "drawing",
        }
    }
}

/// The whole panel for one context.
#[derive(Clone, Debug, PartialEq)]
pub struct Inspector {
    pub kind: Kind,
    pub target: Target,
    /// The scope line under the header ("Editing frames 22–28 · Stop"), while an edit reaches beyond the selection.
    pub scope: Option<Scope>,
    /// The quick actions' context (`figure`, `joint`, `camera`, ...): the command registry fills the row (K-cmd).
    pub quick: Option<&'static str>,
    /// The Library's footer ("Add to library", a later chunk fills it) shows under the body: something is selected
    /// (`user-library.mjs` `syncSelection`, in the desktop app).
    pub library: bool,
    pub sections: Vec<Section>,
}

/// The header's target line.
#[derive(Clone, Debug, PartialEq)]
pub struct Target {
    /// The visually hidden kind ("Figure", "Joint", "Scene"...): the heading reads "Figure Bubble".
    pub kind_label: Label,
    pub name: Label,
    pub glyph: Option<&'static str>,
    /// How the name renames in place (double-click, Enter or F2), when it does.
    pub rename: Option<Rename>,
    /// `data-selection-kind`.
    pub selection: &'static str,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RenameTarget {
    Figure,
    Layer,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Rename {
    pub target: RenameTarget,
    pub description: Msg,
    pub tip: Msg,
    /// The longest name the field takes, when it has a limit (a part name: 120).
    pub max_chars: Option<usize>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Scope {
    pub label: Msg,
    pub stop: Button,
}

/// Where a section sits: core sections are always open, titled ones fold behind their title.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Place {
    Core,
    Titled,
}

/// The tint of a section's kind badge (`data-tint`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tint {
    Select,
    Draw,
    Time,
    Library,
    Camera,
    Effects,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Section {
    pub id: &'static str,
    pub title: Option<Label>,
    pub badge: Option<(&'static str, Tint)>,
    pub place: Place,
    /// Whether the section's body shows (core: always; titled: its auto-open rule and the person's memory).
    pub open: bool,
    /// Whether its auto-open rule holds now (a toggle then dismisses rather than forgets).
    pub auto: bool,
    /// At most two title actions, a title switch counting as one.
    pub actions: Vec<Button>,
    pub switch: Option<SwitchRow>,
    pub rows: Vec<Row>,
}

/// A button: a registry command (K-cmd's), or a panel action.
#[derive(Clone, Debug, PartialEq)]
pub struct Button {
    pub action: Action,
    pub icon: Option<&'static str>,
    pub label: Msg,
    /// The label shows as text (otherwise an icon button whose label is its accessible name and tooltip).
    pub text: bool,
    pub outline: bool,
    pub tip: Option<Msg>,
    pub disabled: bool,
    pub pressed: Option<bool>,
}

/// What a button does when pressed: a registry command, or an action of the panel itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Command(CommandId),
    Panel(PanelAction),
}

/// The panel's own actions (`data-*` hooks today): pages, a fill's delete and its draw-order steps.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PanelAction {
    /// One page of a pager.
    Page(Pager, i32),
    DeletePolygon(u32),
    /// `builder-order`: a drawable sent back, down, up or to the front.
    Order { kind: DrawKind, index: u32, direction: OrderDirection },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OrderDirection {
    Back,
    Down,
    Up,
    Front,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Pager {
    Palette,
    Fills,
}

/// Two columns of rows, or a ratio (`3:2`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ratio {
    Even,
    ThreeTwo,
}

/// A number field whose label scrubs; its unit follows the value.
#[derive(Clone, Debug, PartialEq)]
pub struct NumberRow {
    pub key: PropertyKey,
    pub label: Label,
    /// The accessible name when it differs from "label (unit)".
    pub description: Option<Msg>,
    pub unit: &'static str,
    /// The model value (what Mixed edits from).
    pub value: f64,
    /// Decimals while editing (`propertyPrecision`) and at rest (`restDisplayPrecision`).
    pub precision: u32,
    pub display_precision: u32,
    pub min: f64,
    pub max: f64,
    /// Several figures with different values: shown empty with a "Mixed" placeholder.
    pub mixed: bool,
    pub disabled: bool,
    /// The value is a fact still being made on a worker (a selection's bounds): shown empty, not editable yet.
    pub pending: bool,
    pub span: bool,
}

/// A number field between two step buttons (the figure's Order).
#[derive(Clone, Debug, PartialEq)]
pub struct StepperRow {
    pub field: NumberRow,
    pub down: Button,
    pub up: Button,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Choice {
    FigureLayer,
    SegmentShape,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SelectOption {
    pub value: Arc<str>,
    pub label: Label,
    pub disabled: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SelectRow {
    pub choice: Choice,
    pub label: Msg,
    pub description: Msg,
    pub value: Option<Arc<str>>,
    /// Shown while there is no single value (several layers: "Mixed").
    pub placeholder: Option<Msg>,
    pub options: Vec<SelectOption>,
    pub disabled: bool,
    pub span: bool,
    /// The label is left out when the value already says what it is ("Layer 1").
    pub bare: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Toggle {
    ApplyRange,
    StaticJoint,
    SecondaryColor,
    BuilderBranch,
}

/// Which name a text row edits.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TextKey {
    /// The active layer's name (`#inspector-layer-name`: `renameLayer`).
    LayerName,
}

/// A text field (`.ui-field` with a text input): a name typed in place, committed when it changed on Enter or when
/// focus leaves, as an input's `change` event does today.
#[derive(Clone, Debug, PartialEq)]
pub struct TextRow {
    pub key: TextKey,
    pub label: Msg,
    /// The accessible name (`description`).
    pub description: Msg,
    pub value: Arc<str>,
    pub max_chars: Option<usize>,
    pub span: bool,
    pub disabled: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SwitchRow {
    pub toggle: Toggle,
    pub label: Msg,
    pub checked: bool,
    pub disabled: bool,
    pub tip: Option<Msg>,
    pub span: bool,
}

/// Which colour a colour row edits. Pressing the row ([`super::Event::Color`]) opens the colour picker on it
/// ([`super::Panel::picker`]); a palette swatch names its colour's index in the whole palette.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ColorTarget {
    Background,
    Figure,
    Segment,
    SegmentGradient,
    Polygon(u32),
    Palette(u32),
}

/// What a swatch shows.
#[derive(Clone, Debug, PartialEq)]
pub enum Paint {
    Solid([u8; 3]),
    /// A gradient as today's swatch draws it (`paintCSS`): its kind, angle and normalised stops with their opacity.
    Gradient(PaintSpec),
}

/// One swatch of the figure's palette: pressing it opens a picker that replaces that colour (`Event::Color(target)`).
#[derive(Clone, Debug, PartialEq)]
pub struct Swatch {
    /// [`ColorTarget::Palette`] with the colour's index in the whole palette (not the page).
    pub target: ColorTarget,
    pub rgb: [u8; 3],
    /// The accessible name ("Replace #FF0000 · 3 segments").
    pub description: Msg,
    /// Not pressable or focusable (the panel is pending: the colour may be stale).
    pub disabled: bool,
}

/// A list row (`.ui-list-row`: 32 px, a glyph, the name, then its actions), the head of a fill's group: the fill's
/// colour as a chip swatch (pressing it opens the picker on [`Swatch::target`]) and its delete button.
#[derive(Clone, Debug, PartialEq)]
pub struct ListRow {
    pub glyph: &'static str,
    pub label: Msg,
    pub swatch: Option<Swatch>,
    pub actions: Vec<Button>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ColorRow {
    pub target: ColorTarget,
    pub label: Msg,
    pub description: Option<Msg>,
    pub paint: Paint,
    /// The caption beside the swatch: a background's name, "Mixed", "Linear gradient"; else the hex value.
    pub caption: Option<Label>,
    pub mixed: bool,
    pub span: bool,
    /// Opens the paint picker (`picker: 'paint'`, the segment colour): a button, which centres its swatch and hex
    /// unless it spans the row.
    pub paint_picker: bool,
    pub disabled: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ActionsRow {
    pub label: Option<Msg>,
    pub items: Vec<Button>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Segments {
    CameraTab,
    ConnectorPart,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SegmentedRow {
    pub segments: Segments,
    pub description: Msg,
    pub value: &'static str,
    pub options: Vec<(&'static str, Msg)>,
}

/// A part of the panel another chunk builds (the camera monitor, camera motion, parallax, IK, drawing sets, VFX, the
/// movieclip and spatial-rig sections, the Draw tools, builder surfaces). The panel reserves its place.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Slot {
    CameraMonitor,
    CameraMotion,
    Parallax,
    Ik,
    DrawingSets,
    Movieclip,
    Spatial,
    DrawTools,
    BuilderSurface,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Row {
    Grid { ratio: Ratio, rows: Vec<Row> },
    Number(NumberRow),
    Stepper(StepperRow),
    Select(SelectRow),
    Switch(SwitchRow),
    Text(TextRow),
    Color(ColorRow),
    Actions(ActionsRow),
    Segmented(SegmentedRow),
    /// A label and a value read-only ("Joined to · Bubble · 3").
    Value { label: Msg, text: Label },
    /// A quiet line of text (the scene's summary).
    Meta(Msg),
    /// A caption under a preview ("960 × 540 · 100% zoom").
    Caption(Vec<Label>),
    /// The palette swatches, one page at a time.
    Swatches { label: Msg, items: Vec<Swatch> },
    Pager { label: Msg, text: Arc<str>, previous: Button, next: Button },
    /// A fill of the figure: its list row (glyph, name, colour chip, delete), then its other rows.
    Group { label: Msg, head: ListRow, rows: Vec<Row> },
    Slot(Slot),
}

impl Inspector {
    /// The section with this id.
    pub fn section(&self, id: &str) -> Option<&Section> {
        self.sections.iter().find(|section| section.id == id)
    }

    /// Every number row, in order (the sections' grids included).
    pub fn numbers(&self) -> Vec<&NumberRow> {
        fn walk<'a>(rows: &'a [Row], out: &mut Vec<&'a NumberRow>) {
            for row in rows {
                match row {
                    Row::Number(number) => out.push(number),
                    Row::Stepper(stepper) => out.push(&stepper.field),
                    Row::Grid { rows, .. } | Row::Group { rows, .. } => walk(rows, out),
                    _ => {}
                }
            }
        }
        let mut out = Vec::new();
        for section in &self.sections {
            walk(&section.rows, &mut out);
        }
        out
    }

    /// The number row of `key`, when the panel shows one.
    pub fn number(&self, key: PropertyKey) -> Option<&NumberRow> {
        self.numbers().into_iter().find(|row| row.key == key)
    }

    /// The colour row of `target`, when the panel shows one.
    pub fn color(&self, target: ColorTarget) -> Option<&ColorRow> {
        fn find(rows: &[Row], target: ColorTarget) -> Option<&ColorRow> {
            rows.iter().find_map(|row| match row {
                Row::Color(color) if color.target == target => Some(color),
                Row::Grid { rows, .. } | Row::Group { rows, .. } => find(rows, target),
                _ => None,
            })
        }
        self.sections.iter().find_map(|section| find(&section.rows, target))
    }

    /// The text row of `key`, when the panel shows one.
    pub fn text(&self, key: TextKey) -> Option<&TextRow> {
        fn find(rows: &[Row], key: TextKey) -> Option<&TextRow> {
            rows.iter().find_map(|row| match row {
                Row::Text(text) if text.key == key => Some(text),
                Row::Grid { rows, .. } | Row::Group { rows, .. } => find(rows, key),
                _ => None,
            })
        }
        self.sections.iter().find_map(|section| find(&section.rows, key))
    }
}
