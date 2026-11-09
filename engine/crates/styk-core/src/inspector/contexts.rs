//! One descriptor per context: a port of `inspectorDescriptor` (`src/inspector-view.mjs`) for the scene, the camera,
//! a keyframe or a sheet frame, a layer, one figure (a figure, a text or an image), several figures and a joint; the
//! movieclip, spatial-rig, fill and Draw contexts keep their target and reserve their sections' place for the chunks
//! that build them.

use std::sync::Arc;

use styk_doc::Value;
use styk_eval::doc::{Figure, PaintKind, Prim, Segment};

use super::facts::{self, FigureKind, degrees, item_f64, num};
use super::memory::SectionMemory;
use super::model::*;
use super::paint::{PaintSpec as Paint2, PaintType, Stop};
use super::property::PropertyKey;
use super::{CameraTab, ConnectorPart, PanelState};
use crate::commands::CommandId;
use crate::documents::Document;
use crate::i18n::{Label, Msg};
use crate::view_state::{InspectorContext, InspectorTab, ViewState};

/// What a context is built from besides the document.
pub(crate) struct Inputs<'a> {
    pub view: &'a ViewState,
    pub memory: &'a SectionMemory,
    pub panel: &'a PanelState,
    /// Facts made on the worker (the selection's bounds), as last ready.
    pub shown: &'a super::Shown,
    /// Whether the session holds a copied camera pose.
    pub can_paste: bool,
}

const STEP_DOWN: &str = "step-down";
const STEP_UP: &str = "step-up";

fn msg(key: &'static str) -> Msg {
    Msg::new(key)
}

/// `restDisplayPrecision`: at rest one decimal with a unit, two without, none for integers.
fn rest_precision(precision: u32, unit: &str) -> u32 {
    match (precision, unit.is_empty()) {
        (0, _) => 0,
        (_, false) => 1,
        (_, true) => 2,
    }
}

/// A number row (`number(label, key, value, unit, extra)` of `contextDescriptor`).
fn number(key: PropertyKey, label: impl Into<Label>, value: f64, unit: &'static str) -> NumberRow {
    let precision = key.precision();
    NumberRow {
        key,
        label: label.into(),
        description: None,
        unit,
        value,
        precision,
        display_precision: rest_precision(precision, unit),
        min: f64::NEG_INFINITY,
        max: f64::INFINITY,
        mixed: false,
        disabled: false,
        pending: false,
        span: false,
    }
}

impl NumberRow {
    fn range(mut self, min: f64, max: f64) -> NumberRow {
        self.min = min;
        self.max = max;
        self
    }
    fn described(mut self, description: Msg) -> NumberRow {
        self.description = Some(description);
        self
    }
    fn pending(mut self, pending: bool) -> NumberRow {
        self.pending = pending;
        self
    }
}

/// A label today's descriptor writes as text, not a key ("X", "Y", "W", "H").
fn plain(text: &'static str) -> Label {
    Label::plain(text)
}

fn button(command: CommandId, icon: Option<&'static str>, label: &'static str) -> Button {
    Button { action: Action::Command(command), icon, label: msg(label), text: false, outline: false, tip: None, disabled: false, pressed: None }
}

impl Button {
    fn text(mut self) -> Button {
        self.text = true;
        self
    }
    fn outline(mut self) -> Button {
        self.outline = true;
        self.text = true;
        self
    }
    fn tip(mut self, tip: &'static str) -> Button {
        self.tip = Some(msg(tip));
        self
    }
    fn disabled(mut self, disabled: bool) -> Button {
        self.disabled = disabled;
        self
    }
}

/// The badge of a section by its id (`SECTION_GLYPHS`).
fn badge(id: &str) -> Option<(&'static str, Tint)> {
    Some(match id {
        "transform" => ("arrows-move", Tint::Select),
        "placement" => ("origin", Tint::Select),
        "joint" => ("joints", Tint::Select),
        "align" => ("align-horizontal-center", Tint::Select),
        "selection" => ("cursor", Tint::Select),
        "framing" => ("fit", Tint::Camera),
        "canvas" => ("frame", Tint::Select),
        "figure" => ("person", Tint::Select),
        "appearance" => ("palette", Tint::Draw),
        "colours" | "second-colour" => ("droplet", Tint::Draw),
        "style" => ("brush", Tint::Draw),
        "fill" => ("paint-bucket", Tint::Draw),
        "text" => ("text", Tint::Draw),
        "background" => ("image", Tint::Draw),
        "drawing" => ("brush", Tint::Draw),
        "timing" | "range" => ("clock", Tint::Time),
        "playback" => ("play", Tint::Time),
        "motion" => ("route", Tint::Time),
        "exposure" => ("layers", Tint::Time),
        "arrange" | "layer" | "drawing-sets" | "parallax" => ("layers", Tint::Library),
        "connection" | "connector" => ("link", Tint::Library),
        "ik" => ("pin", Tint::Library),
        "slider" => ("sliders", Tint::Library),
        "preview" => ("camera", Tint::Camera),
        _ => return None,
    })
}

/// A section, open unless titled; titled ones resolve against the memory in [`finish`].
fn section(id: &'static str, title: Option<Msg>, rows: Vec<Row>) -> Section {
    Section { id, title: title.map(Label::Msg), badge: badge(id), place: Place::Core, open: true, auto: false, actions: Vec::new(), switch: None, rows }
}

impl Section {
    fn titled(mut self, auto: bool) -> Section {
        self.place = Place::Titled;
        self.auto = auto;
        self
    }
    fn actions(mut self, actions: Vec<Button>) -> Section {
        self.actions = actions;
        self
    }
}

fn grid(rows: Vec<Row>) -> Row {
    Row::Grid { ratio: Ratio::Even, rows }
}

/// `propertyState(key)`: the value of a property channel at the playhead as the session reads it
/// (`animationValue(target, property)`), times the display factor; `None` where the channel has no value.
fn channel(document: &Document, target: &[(&str, Value)], property: &str, factor: f64) -> Option<f64> {
    let mut object = styk_doc::Obj::new();
    for (key, value) in target {
        object.set(key, value.clone());
    }
    // Read ready: the model is built only when the frame on show and the views are.
    match document.animation_value_ready(&Value::object(object), property) {
        Some(Ok(Some(Value::Num(value)))) if value.is_finite() => Some(value * factor),
        _ => None,
    }
}

fn figure_target(uid: u32) -> [(&'static str, Value); 2] {
    [("kind", Value::str("figure")), ("uid", Value::Num(f64::from(uid)))]
}

fn pct_of_transparency(raw: f64) -> f64 {
    (1.0 - raw / 255.0) * 100.0
}

/// The context `auto` resolves to (`contextDescriptor`): the Animation tab shows timing, a selection its figure.
fn resolve(view: &ViewState, has_object: bool) -> InspectorContext {
    match view.context() {
        InspectorContext::Auto if view.tab() == InspectorTab::Animation => InspectorContext::Frame,
        InspectorContext::Auto if has_object => InspectorContext::Figure,
        InspectorContext::Auto => InspectorContext::Scene,
        other => other,
    }
}

/// The Inspector for `document` in this view state.
/// `frame` is the frame on show, read ready ([`Document::frame_records_ready`]): the model is never built from an
/// evaluation made on the interface thread.
pub(crate) fn build(document: &Document, frame: &Value, inputs: &Inputs<'_>) -> Inspector {
    let records = facts::records(document);
    let frame = frame.clone();
    let object = facts::selected_object(document, &frame);
    let count = facts::selection(document).uids.len();
    if let Some(tool) = inputs.view.drawing() {
        return drawing(tool);
    }
    let resolved = resolve(inputs.view, object.is_some());
    let mut inspector = match (resolved, object) {
        (InspectorContext::Camera, _) => camera(document, records, &frame, inputs),
        (InspectorContext::Layer, _) => layer(records),
        (InspectorContext::Frame, _) => frame_context(document, records),
        (InspectorContext::Scene, _) | (_, None) => scene(records, &frame),
        (_, Some(object)) => match facts::figure_of(document, &object) {
            None => scene(records, &frame),
            Some(figure) if count == 1 && figure.movieclip.is_some() => movieclip(&figure, records),
            Some(_) if count > 1 => figures(document, records, &frame, inputs, count),
            Some(figure) if spatial_origin(records, figure.id) => spatial_rig(&figure, &object),
            Some(figure) => {
                // `inspectorDescriptor` shows the instance as its style overlay resolves it (made on the facts lane).
                // Refresh waits for the lane before it builds; a resolution for another figure shows nothing as current.
                let Some(figure) = instance(inputs.shown, figure, &object) else { return pending(&scene(records, &frame)) };
                let joint = facts::selection(document).joint;
                match usize::try_from(joint).ok().and_then(|joint| figure.segments.get(joint)) {
                    Some(segment) => joint_context(document, records, &figure, &object, segment, inputs),
                    None => figure_context(document, records, &frame, &figure, &object, inputs),
                }
            }
        },
    };
    finish(&mut inspector, inputs.memory);
    inspector.library = count > 0;
    inspector
}

/// Titled sections take their open state from the memory and their rule.
fn finish(inspector: &mut Inspector, memory: &SectionMemory) {
    let kind = inspector.kind.id();
    for section in &mut inspector.sections {
        if section.place == Place::Titled {
            section.open = memory.is_open(kind, section.id, section.auto);
        }
    }
}

fn figure_record(records: &Value, id: u32) -> Option<Value> {
    records.get("figure_types").and_then(Value::elements)?.iter().find(|figure| num(figure.get("figure_type_id")) == Some(f64::from(id)))
}

/// A figure with a spatial origin (`segment._stykRig.spatial.origin`) shows its Placement and the spatial sections.
fn spatial_origin(records: &Value, id: u32) -> bool {
    figure_record(records, id)
        .and_then(|figure| figure.get("segments").and_then(Value::elements).map(|segments| segments.iter().any(|segment| segment.path(&["_stykRig", "spatial", "origin"]).is_some_and(Value::truthy))))
        .unwrap_or(false)
}

fn target(kind_label: &'static str, name: Label, glyph: Option<&'static str>, selection: &'static str) -> Target {
    Target { kind_label: Label::key(kind_label), name, glyph, rename: None, selection }
}

fn figure_rename() -> Rename {
    Rename { target: RenameTarget::Figure, description: msg("inspectorView.figureName"), tip: msg("inspectorView.doubleClickToRenameTheFigureDefinition"), max_chars: None }
}

/// The frames an edit reaches while Edit together is on: the scope line ("Editing frames 22–28 · Stop").
fn scope_line(view: &ViewState) -> Option<Scope> {
    let frames = view.range_frames()?;
    let (first, last) = (frames.first()?, frames.last()?);
    let label = if last >= first && last - first + 1 == frames.len() {
        Msg::new("inspectorView.editingFrameRange").with("first", first + 1).with("last", last + 1)
    } else {
        Msg::count("inspectorView.editingFrames", frames.len() as f64)
    };
    Some(Scope { label, stop: button(CommandId::ToggleRangeEdit, None, "inspectorView.stop").tip("inspectorView.editOnlyThisFrame") })
}

/// Edit together, shown while two or more frames are chosen.
fn range_section(view: &ViewState) -> Option<Section> {
    let length = view.edit_range().len();
    (length > 1).then(|| {
        section("range", None, vec![grid(vec![Row::Switch(SwitchRow {
            toggle: Toggle::ApplyRange,
            label: Msg::new("inspectorView.editFramesTogether").with("length", length),
            checked: view.apply_range(),
            disabled: false,
            tip: Some(msg("inspectorView.applyCanvasMovesAndFigureCommandsToEvery")),
            span: true,
        })])])
    })
}

/// The scene: summary, canvas, background and playback.
fn scene(records: &Value, frame: &Value) -> Inspector {
    let fps = num(records.get("fps")).unwrap_or(24.0);
    let figures = facts::frame_objects(frame).len();
    let frames = styk_edit::timeline_rows(records).last().map_or(0.0, |(start, count)| start + count);
    let background_id = num(frame.get("background_id"));
    let background = records.get("backgrounds").and_then(Value::elements).and_then(|items| items.iter().find(|item| background_id.is_some() && num(item.get("background_id")) == background_id));
    let raw = num(frame.get("_stykBackgroundColor")).or_else(|| background.as_ref().and_then(|item| num(item.get("color")))).unwrap_or(f64::from(0xffff_ffff_u32));
    let rgb = (raw as i64 as u32) & 0x00ff_ffff;
    let name = background.as_ref().and_then(|item| item.get("name").and_then(Value::as_str).filter(|name| !name.is_empty()).map(Label::plain)).unwrap_or_else(|| Label::key("inspectorView.white"));
    let seconds = crate::number::format(frames / fps, 2).parse().unwrap_or(0.0);
    let summary = Msg::new("inspectorView.s")
        .with("value", Msg::count("counts.figures", figures as f64))
        .with("value2", Msg::count("counts.frames", frames))
        .with("value3", seconds);
    Inspector {
        kind: Kind::Scene,
        target: target("inspectorView.scene", Label::key("inspectorView.scene"), Some("scene"), "scene"),
        scope: None,
        library: false,
        quick: None,
        sections: vec![
            section("summary", None, vec![Row::Meta(summary)]),
            section("canvas", Some(msg("inspectorView.canvas")), vec![grid(vec![
                Row::Number(number(PropertyKey::CanvasWidth, msg("inspectorView.width"), num(records.get("canvas_width")).unwrap_or(0.0), "px").range(1.0, 16384.0)),
                Row::Number(number(PropertyKey::CanvasHeight, msg("inspectorView.height"), num(records.get("canvas_height")).unwrap_or(0.0), "px").range(1.0, 16384.0)),
            ])]),
            section("background", Some(msg("inspectorView.background")), vec![grid(vec![
                Row::Color(ColorRow { paint_picker: false, disabled: false,
                    target: ColorTarget::Background,
                    label: msg("inspectorView.backgroundColor"),
                    description: None,
                    paint: Paint::Solid([(rgb >> 16) as u8, (rgb >> 8) as u8, rgb as u8]),
                    caption: Some(name),
                    mixed: false,
                    span: false,
                }),
                Row::Actions(ActionsRow { label: None, items: vec![button(CommandId::BackgroundStyle, Some("sliders"), "inspectorView.library").outline().tip("inspectorView.backgroundSettings")] }),
            ])])
            .actions(vec![button(CommandId::ImportBackground, Some("image"), "inspectorView.importBackground").tip("inspectorView.backgroundImage")]),
            section("playback", Some(msg("inspectorView.playback")), vec![grid(vec![Row::Number(number(PropertyKey::Fps, msg("inspectorView.rate"), fps, "fps").range(1.0, 120.0))])]),
        ],
    }
}

/// The camera: its preview, the Transform │ Motion switch, Transform and Framing.
fn camera(document: &Document, records: &Value, frame: &Value, inputs: &Inputs<'_>) -> Inspector {
    let [x, y, scale, angle] = facts::camera(frame);
    let camera_target = [("kind", Value::str("camera"))];
    let x = channel(document, &camera_target, "x", 1.0).unwrap_or(x);
    let y = channel(document, &camera_target, "y", 1.0).unwrap_or(y);
    let scale = channel(document, &camera_target, "scale", 1.0).unwrap_or(scale);
    let angle = channel(document, &camera_target, "rotation", 1.0).unwrap_or(angle);
    let motion = inputs.panel.camera_tab == CameraTab::Motion;
    let selected = !facts::selection(document).uids.is_empty();
    let frame_index = facts::frame_index(document);
    let keyframes = records.get("keyframes").and_then(Value::array_len).unwrap_or(0);
    let canvas = format!("{} × {}", crate::i18n::format_number(num(records.get("canvas_width")).unwrap_or(0.0)), crate::i18n::format_number(num(records.get("canvas_height")).unwrap_or(0.0)));
    let zoom: f64 = crate::number::format(100.0 / scale, 2).parse().unwrap_or(100.0);
    let mut guides = button(CommandId::CameraGuides, Some("grid"), "inspectorView.guides").tip("inspectorView.showCompositionGuides");
    guides.pressed = Some(true);
    let mut sections = vec![
        section("preview", Some(msg("inspectorView.preview")), vec![Row::Slot(Slot::CameraMonitor), Row::Caption(vec![Label::plain(canvas), Label::Msg(Msg::new("inspectorView.zoom2").with("value", zoom))])]).actions(vec![guides]),
        section("tabs", None, vec![Row::Segmented(SegmentedRow {
            segments: Segments::CameraTab,
            description: msg("inspectorView.cameraControls"),
            value: if motion { "motion" } else { "transform" },
            options: vec![("transform", msg("inspectorView.transform")), ("motion", msg("inspectorView.motion"))],
        })]),
    ];
    if motion {
        sections.push(section("motion", None, vec![Row::Slot(Slot::CameraMotion)]));
    } else {
        sections.push(
            section("transform", Some(msg("inspectorView.transform")), vec![grid(vec![
                Row::Number(number(PropertyKey::CameraX, plain("X"), x, "px")),
                Row::Number(number(PropertyKey::CameraY, plain("Y"), y, "px")),
                Row::Number(number(PropertyKey::CameraScale, msg("inspectorView.zoom"), scale * 100.0, "%").range(0.01, f64::INFINITY).described(msg("inspectorView.scale2"))),
                Row::Number(number(PropertyKey::CameraAngle, msg("inspectorView.rotation"), degrees(angle), "°")),
            ])])
            .actions(vec![
                button(CommandId::CameraCopy, Some("duplicate"), "inspectorView.copyCameraPose"),
                button(CommandId::CameraPaste, Some("clipboard"), "inspectorView.pasteCameraPose").disabled(!inputs.can_paste),
            ]),
        );
        sections.push(
            section("framing", Some(msg("inspectorView.framing")), vec![
                Row::Actions(ActionsRow { label: Some(msg("inspectorView.fit")), items: vec![button(CommandId::CameraAlignView, Some("fit"), "inspectorView.fitView").outline().tip("inspectorView.fitCameraToCurrentCanvasView")] }),
                Row::Actions(ActionsRow {
                    label: Some(msg("inspectorView.centreOnSelection")),
                    items: vec![
                        button(CommandId::CameraCenterX, Some("align-horizontal-center"), "inspectorView.centerCameraHorizontally").disabled(!selected),
                        button(CommandId::CameraCenterY, Some("align-vertical-center"), "inspectorView.centerCameraVertically").disabled(!selected),
                        button(CommandId::CameraLocatePrevious, Some("chevron-left"), "inspectorView.matchPreviousCameraPose").disabled(frame_index == 0),
                        button(CommandId::CameraLocateNext, Some("chevron-right"), "inspectorView.matchNextCameraPose").disabled(frame_index + 1 >= keyframes),
                        button(CommandId::CameraApplyFigures, Some("check"), "inspectorView.applyCameraTransformToFigures"),
                    ],
                }),
            ])
            .titled(false),
        );
    }
    Inspector { kind: Kind::Camera, target: target("inspectorView.camera", Label::key("inspectorView.camera"), Some("camera"), "camera"), scope: None, library: false, quick: Some("camera"), sections }
}

/// A keyframe's hold (classic documents) or a sheet frame's exposure (layer sheets).
fn frame_context(document: &Document, records: &Value) -> Inspector {
    let frame_index = facts::frame_index(document);
    if let Some(sheet) = records.path(&["_styk", "layerSheet"]).filter(|sheet| sheet.is_object()) {
        let layer_id = facts::active_layer(records);
        let track = sheet.get("tracks").and_then(|tracks| tracks.get(&layer_id));
        let keys: Vec<f64> = track.and_then(|track| track.get("keys")).and_then(Value::elements).map(|keys| keys.iter().filter_map(|key| num(key.get("tick"))).collect()).unwrap_or_default();
        // `sheetKeyAt`: the key at or before the playhead and the next one.
        let at = keys.iter().copied().filter(|tick| *tick <= facts::tick(document)).fold(None, |last: Option<f64>, tick| Some(last.map_or(tick, |last| last.max(tick))));
        let next = keys.iter().copied().filter(|tick| *tick > facts::tick(document)).fold(None, |first: Option<f64>, tick| Some(first.map_or(tick, |first| first.min(tick))));
        let end = next.or_else(|| track.and_then(|track| num(track.get("end")))).unwrap_or(facts::tick(document) + 1.0);
        let exposure = end - at.unwrap_or(facts::tick(document));
        let name = facts::layers(records).into_iter().find(|layer| layer.id == layer_id).map_or_else(|| Label::key("inspectorView.layer"), |layer| Label::Plain(layer.name));
        let mut exposure = section("exposure", None, vec![grid(vec![Row::Number(number(PropertyKey::Duration, msg("inspectorView.exposure"), exposure, "frames").range(1.0, 65535.0))])])
            .actions(vec![button(CommandId::AddFrame, Some("plus"), "inspectorView.insertKeyframeF6").tip("inspectorView.addFrame")]);
        // The section is titled by the layer's own name.
        exposure.title = Some(name);
        return Inspector {
            kind: Kind::Frame,
            target: target("inspectorView.timing", Label::Msg(Msg::new("filmstrip.card").with("frame", facts::tick(document) + 1.0)), None, "frame"),
            scope: None,
            library: false,
            quick: None,
            sections: vec![exposure],
        };
    }
    let duration = records.get("keyframes").and_then(|frames| frames.item(frame_index)).and_then(|frame| num(frame.get("duration_raw"))).unwrap_or(1.0);
    Inspector {
        kind: Kind::Keyframe,
        target: target("inspectorView.timing", Label::Msg(Msg::new("inspectorView.keyframe").with("frame", frame_index + 1)), None, "frame"),
        scope: None,
        library: false,
        quick: None,
        sections: vec![section("timing", Some(msg("inspectorView.timing")), vec![grid(vec![Row::Number(number(PropertyKey::Duration, msg("inspectorView.duration"), duration, "ticks").range(0.0, 65535.0))])])],
    }
}

/// A layer: its name, in the header and in its Name field; its Parallax belongs to the camera-motion chunk.
fn layer(records: &Value) -> Inspector {
    let id = facts::active_layer(records);
    let name = facts::layers(records).into_iter().find(|layer| layer.id == id).map_or_else(|| Arc::from("Layer"), |layer| layer.name);
    Inspector {
        kind: Kind::Layer,
        target: Target {
            kind_label: Label::key("inspectorView.layer"),
            name: Label::Plain(name.clone()),
            glyph: Some("layers"),
            rename: Some(Rename { target: RenameTarget::Layer, description: msg("inspectorView.layerName"), tip: msg("inspectorHeader.doubleClickToRename"), max_chars: Some(160) }),
            selection: "layer",
        },
        scope: None,
        library: false,
        quick: None,
        sections: vec![
            section("layer", Some(msg("inspectorView.layer")), vec![grid(vec![Row::Text(TextRow { key: TextKey::LayerName, label: msg("common.name"), description: msg("inspectorView.layerName"), value: name.clone(), max_chars: Some(160), span: true, disabled: false })])]),
            // Bare, edge to edge (`inspector-bare`), as today: the camera-motion chunk draws it.
            section("parallax", None, vec![Row::Slot(Slot::Parallax)]),
        ],
    }
}

/// A figure's Layer select: Mixed across layers, locked layers disabled, the label left out when the name says it is a layer.
fn layer_select(document: &Document, records: &Value, span: bool) -> Row {
    let selection = facts::selection(document);
    let mut ids: Vec<Arc<str>> = selection.uids.iter().map(|uid| facts::layer_of(records, *uid)).collect();
    ids.sort();
    ids.dedup();
    let current = (ids.len() == 1).then(|| ids[0].clone());
    let layers = facts::layers(records);
    let name = current.as_ref().and_then(|id| layers.iter().find(|layer| &layer.id == id)).map(|layer| layer.name.clone()).unwrap_or_default();
    let bare = name.get(..5).is_some_and(|start| start.eq_ignore_ascii_case("layer")) && name[5..].chars().next().is_none_or(|c| !c.is_alphanumeric() && c != '_');
    Row::Select(SelectRow {
        choice: Choice::FigureLayer,
        label: msg("inspectorView.layer"),
        description: msg("inspectorView.figureLayer"),
        value: current,
        placeholder: Some(msg("inspectorView.mixed")),
        options: layers.into_iter().map(|layer| SelectOption { value: layer.id, label: Label::Plain(layer.name), disabled: layer.locked }).collect(),
        disabled: false,
        span,
        bare,
    })
}

/// `usesSegmentColors`: the figure keeps its own segment colours under a pose's colour override.
fn uses_segment_colors(version: f64, figure: &Figure, object: &Value) -> bool {
    version >= 5.0 || figure.segment_colors || object.path(&["_styk", "colorMode"]).and_then(Value::as_str) == Some("segments")
}

/// `displayedColor`: the colour a figure shows for `rgb` under its pose's colour override.
fn displayed_color(version: f64, figure: &Figure, object: &Value, rgb: [u8; 3]) -> [u8; 3] {
    let raw = num(object.get("color_override_raw")).unwrap_or(0.0);
    let raw_bits = raw as i64 as u32;
    let segment_colors = uses_segment_colors(version, figure, object);
    let override_rgb = [raw_bits as u8, (raw_bits >> 8) as u8, (raw_bits >> 16) as u8];
    if !segment_colors {
        return if (raw as i64 as i32) < 0 { [0, 0, 0] } else { override_rgb };
    }
    let strength = raw_bits >> 24;
    match strength {
        0 => rgb,
        255 => override_rgb,
        k => {
            let mix = |base: u8, over: u8| ((f64::from(base) * 256.0 + f64::from(k) * (f64::from(over) - f64::from(base))) / 256.0).floor() as u8;
            [mix(rgb[0], override_rgb[0]), mix(rgb[1], override_rgb[1]), mix(rgb[2], override_rgb[2])]
        }
    }
}

/// The figure's displayed colours, most used first (`figurePalette`, without the spatial mesh's, which a spatial figure
/// never shows here): one entry per colour with how many segments and fills use it.
fn palette(version: f64, figure: &Figure, object: &Value) -> Vec<([u8; 3], usize, usize)> {
    let mut entries: Vec<([u8; 3], usize, usize)> = Vec::new();
    let mut add = |rgb: [u8; 3], segment: bool| {
        let at = entries.iter().position(|entry| entry.0 == rgb).unwrap_or_else(|| {
            entries.push((rgb, 0, 0));
            entries.len() - 1
        });
        if segment { entries[at].1 += 1 } else { entries[at].2 += 1 }
    };
    for segment in &figure.segments {
        let mut seen: Vec<[u8; 3]> = Vec::new();
        for stop in displayed_segment_paint(version, figure, object, segment).stops {
            let shown = stop.rgb();
            if !seen.contains(&shown) {
                seen.push(shown);
                add(shown, true);
            }
        }
    }
    for polygon in &figure.polyfills {
        add(displayed_color(version, figure, object, polygon.rgb), false);
    }
    entries.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| facts::hex(a.0).cmp(&facts::hex(b.0))));
    entries
}

/// `segmentPaint(segment)`: the segment's own paint with its colour and opacity as the first stop and a two-tone's
/// secondary as the last; without one, solid, or linear to the secondary.
fn segment_paint(segment: &Segment) -> Paint2 {
    let first = Stop::new(0.0, segment.rgb, segment.alpha);
    let secondary = segment.secondary.map(|(rgb, a)| Stop::new(1.0, rgb, 1.0 - f64::from(a) / 255.0));
    if let Some(paint) = &segment.paint {
        let kind = match paint.kind {
            PaintKind::Solid => PaintType::Solid,
            PaintKind::Linear => PaintType::Linear,
            PaintKind::Radial => PaintType::Radial,
            PaintKind::Angular => PaintType::Angular,
            PaintKind::Diamond => PaintType::Diamond,
        };
        let mut stops: Vec<Stop> = paint.stops.iter().map(|stop| Stop::new(stop.offset, stop.rgb, stop.opacity)).collect();
        if let Some(stop) = stops.first_mut() {
            stop.color = first.color;
            stop.opacity = first.opacity;
        }
        if let (Some(secondary), Some(last), false) = (secondary, stops.last_mut(), kind == PaintType::Solid) {
            last.color = secondary.color;
            last.opacity = secondary.opacity;
        }
        return Paint2 { kind, angle: paint.angle, stops };
    }
    match secondary {
        Some(secondary) => Paint2 { kind: PaintType::Linear, angle: 0.0, stops: vec![first, secondary] },
        None => Paint2 { kind: PaintType::Solid, angle: 0.0, stops: vec![first] },
    }
}

/// `displayedSegmentPaint`: the segment's paint under its pose's colour override; a full override shows the first
/// stop alone (the secondary end is suppressed, alpha included).
pub(crate) fn displayed_segment_paint(version: f64, figure: &Figure, object: &Value, segment: &Segment) -> Paint2 {
    let mut paint = segment_paint(segment);
    let raw = num(object.get("color_override_raw")).unwrap_or(0.0);
    if uses_segment_colors(version, figure, object) && (raw as i64 as u32) >> 24 == 255 {
        paint.kind = PaintType::Solid;
        paint.stops.truncate(1);
    }
    for stop in &mut paint.stops {
        stop.color = displayed_color(version, figure, object, stop.rgb()).map(f64::from);
    }
    paint
}

/// One figure, text or image: Transform, Appearance and Arrange are open; Connection and Colours are titled.
fn figure_context(document: &Document, records: &Value, frame: &Value, figure: &Figure, object: &Value, inputs: &Inputs<'_>) -> Inspector {
    let kind = facts::figure_kind(figure);
    let version = num(records.get("version")).unwrap_or(0.0);
    let objects = facts::frame_objects(frame);
    let slot = num(object.get("object_slot"));
    let children = objects.iter().any(|part| slot.is_some() && part.path(&["join", "target_object_slot"]).and_then(Value::as_f64) == slot);
    let parent = object.get("join").filter(|join| join.is_object()).and_then(|join| num(join.get("target_object_slot"))).and_then(|slot| objects.get(slot as usize).cloned());
    let palette = if facts::selection(document).joint < 0 { palette(version, figure, object) } else { Vec::new() };
    let own = palette.first().map_or([0, 0, 0], |entry| entry.0);
    let (glyph, kind_id) = match kind {
        FigureKind::Text => ("text", Kind::Text),
        FigureKind::Image => ("image", Kind::Image),
        FigureKind::Figure => ("person", Kind::Figure),
    };
    let name = if figure.name.is_empty() { Label::key("inspectorView.figure") } else { Label::plain(figure.name.as_str()) };
    let transparency = num(object.get("field28")).unwrap_or(0.0);
    let uid = num(object.get("unique_id")).map(|uid| uid as u32);
    let channel_of = |property: &str, factor: f64| uid.filter(|_| figure.movieclip.is_none()).and_then(|uid| channel(document, &figure_target(uid), property, factor));
    let scale = channel_of("scale", 100.0).unwrap_or_else(|| num(object.get("scale")).unwrap_or(1.0) * 100.0);
    let opacity = channel_of("opacity", 100.0).unwrap_or_else(|| pct_of_transparency(transparency));
    let transform = section("transform", Some(msg("inspectorView.transform")), vec![grid(vec![
        Row::Number(number(PropertyKey::RootX, plain("X"), num(object.get("root_x")).unwrap_or(0.0), "px")),
        Row::Number(number(PropertyKey::RootY, plain("Y"), num(object.get("root_y")).unwrap_or(0.0), "px")),
        Row::Number(number(PropertyKey::Rotation, msg("inspectorView.angle"), facts::rotation(figure, object), "°")),
        Row::Number(number(PropertyKey::Scale, msg("inspectorView.scale"), scale, "%").range(0.01, f64::INFINITY)),
    ])]);
    let join_label = if parent.is_some() { "inspectorView.unjoin" } else { "inspectorView.join" };
    // `figureJoinAction`: one figure selected (a branch is a joint, another context).
    let mut join = button(CommandId::JoinFigure, None, join_label).text().disabled(facts::selection(document).uids.len() != 1);
    join.tip = Some(msg(if parent.is_some() { "inspectorView.unjoinFigure" } else { "inspectorView.joinToFigure" }));
    let z = channel_of("zIndex", 1.0).unwrap_or_else(|| num(object.get("_stykZIndex")).unwrap_or(0.0));
    let mut sections: Vec<Section> = Vec::new();
    sections.extend(range_section(inputs.view));
    if kind == FigureKind::Text || figure.texts.iter().any(|text| !text.glyphs.is_empty()) {
        sections.push(section("text", Some(msg("inspectorView.text")), vec![Row::Actions(ActionsRow { label: None, items: vec![button(CommandId::EditText, Some("text"), "inspectorView.editText").outline().tip("inspectorView.editText2")] })]));
    }
    sections.push(transform);
    sections.push(
        section("appearance", Some(msg("inspectorView.appearance")), vec![grid(vec![
            Row::Color(ColorRow { paint_picker: false, disabled: false,
                target: ColorTarget::Figure,
                label: msg("inspectorView.colour"),
                description: Some(msg("inspectorView.recolorAllSegments")),
                paint: Paint::Solid(own),
                caption: (palette.len() > 1).then(|| Label::key("inspectorView.mixed")),
                mixed: false,
                span: false,
            }),
            Row::Number(number(PropertyKey::FigureOpacity, msg("inspectorView.opacity"), opacity, "%").range(0.0, 100.0)),
        ])])
        .actions(vec![button(CommandId::ResetColor, Some("reset"), "inspectorView.resetColors")]),
    );
    let arrange = section("arrange", Some(msg("inspectorView.arrange")), vec![Row::Grid { ratio: Ratio::ThreeTwo, rows: vec![
        layer_select(document, records, false),
        Row::Stepper(StepperRow {
            field: number(PropertyKey::FigureZOrder, msg("inspectorView.order"), z, "").range(-1_000_000.0, 1_000_000.0).described(msg("inspectorView.zIndex")),
            down: button(CommandId::LayerDown, Some(STEP_DOWN), "inspectorView.sendBackward"),
            up: button(CommandId::LayerUp, Some(STEP_UP), "inspectorView.bringForward"),
        }),
    ] }])
    .actions(vec![join]);
    sections.push(if kind == FigureKind::Text { arrange.titled(false) } else { arrange });
    if parent.is_some() || children {
        let joined = match &parent {
            Some(parent) => {
                let parent_name = parent.get("name").and_then(Value::as_str).filter(|name| !name.is_empty()).map(str::to_owned)
                    .or_else(|| facts::figure_of(document, parent).map(|figure| figure.name.clone()).filter(|name| !name.is_empty()));
                let handle = object.path(&["join", "target_handle_id"]).map(styk_doc::json::to_string).unwrap_or_default();
                match parent_name {
                    Some(name) => Label::plain(format!("{name} · {handle}")),
                    None => Label::Msg(Msg::new("inspectorView.figure")),
                }
            }
            None => Label::key("inspectorView.none"),
        };
        sections.push(
            section("connection", Some(msg("inspectorView.connection")), vec![
                Row::Value { label: msg("inspectorView.joinedTo"), text: joined },
                Row::Actions(ActionsRow { label: None, items: vec![button(CommandId::CombineFigures, Some("combine"), "inspectorView.combineConnected").outline().tip("inspectorView.mergeTheConnectedFiguresIntoOne")] }),
            ])
            .titled(parent.is_some()),
        );
    }
    if facts::selection(document).joint < 0 {
        sections.push(colours(document, &palette, figure, object, version, inputs.panel));
    }
    Inspector {
        kind: kind_id,
        target: Target { kind_label: Label::key("inspectorView.figure"), name, glyph: Some(glyph), rename: Some(figure_rename()), selection: "figure" },
        scope: scope_line(inputs.view),
        library: false,
        quick: Some(kind_id.id()),
        sections,
    }
}

const PALETTE_PAGE: usize = 32;
const FILLS_PAGE: usize = 12;

/// A drawable's four order steps (`orderActions`): send to back, backward, forward, to front.
fn order_actions(kind: super::order::DrawKind, index: u32, label: &'static str) -> Row {
    let step = |direction, icon, label| Button { action: Action::Panel(PanelAction::Order { kind, index, direction }), ..button(CommandId::Undo, Some(icon), label) };
    Row::Actions(ActionsRow {
        label: Some(msg(label)),
        items: vec![
            step(OrderDirection::Back, "send-to-back", "inspectorView.sendToBack"),
            step(OrderDirection::Down, STEP_DOWN, "inspectorView.sendBackward"),
            step(OrderDirection::Up, STEP_UP, "inspectorView.bringForward"),
            step(OrderDirection::Front, "bring-to-front", "inspectorView.bringToFront"),
        ],
    })
}

fn page(pager: Pager, step: i32, icon: &'static str, label: &'static str) -> Button {
    Button { action: Action::Panel(PanelAction::Page(pager, step)), icon: Some(icon), label: msg(label), text: false, outline: false, tip: None, disabled: false, pressed: None }
}

fn page_text(start: usize, size: usize, total: usize) -> Arc<str> {
    format!("{}–{} / {}", start + 1, (start + size).min(total), total).into()
}

/// The figure's colours and fills (titled): the palette 32 per page, the fills 12 per page.
fn colours(document: &Document, palette: &[([u8; 3], usize, usize)], figure: &Figure, object: &Value, version: f64, panel: &PanelState) -> Section {
    let uid = num(object.get("unique_id")).map(|uid| uid as u32);
    let drawables = super::order::drawables(figure, object);
    let mut rows = Vec::new();
    let palette_start = (panel.palette_page * PALETTE_PAGE).min(palette.len().div_ceil(PALETTE_PAGE).saturating_sub(1) * PALETTE_PAGE);
    if !palette.is_empty() {
        let items = palette[palette_start..(palette_start + PALETTE_PAGE).min(palette.len())]
            .iter()
            .enumerate()
            .map(|(offset, (rgb, segments, fills))| {
                let color = facts::hex(*rgb).to_uppercase();
                let key = if *fills > 0 { "inspectorView.replaceColorSegmentsAndFills" } else { "inspectorView.replaceColorSegments" };
                Swatch { target: ColorTarget::Palette((palette_start + offset) as u32), rgb: *rgb, description: Msg::new(key).with("color", color).with("segments", Msg::count("counts.segments", *segments as f64)).with("fills", Msg::count("counts.fills", *fills as f64)), disabled: false }
            })
            .collect();
        rows.push(Row::Swatches { label: msg("inspectorView.figureColorPalette"), items });
    }
    if palette.len() > PALETTE_PAGE {
        rows.push(Row::Pager {
            label: msg("inspectorView.colourPages"),
            text: page_text(palette_start, PALETTE_PAGE, palette.len()),
            previous: page(Pager::Palette, -1, "chevron-left", "inspectorView.previousColors").disabled(palette_start == 0),
            next: page(Pager::Palette, 1, "chevron-right", "inspectorView.nextColors").disabled(palette_start + PALETTE_PAGE >= palette.len()),
        });
    }
    let polygons = &figure.polyfills;
    rows.push(Row::Value {
        label: msg("inspectorView.fills"),
        text: if polygons.is_empty() { Label::key("inspectorView.noFills") } else { Label::Msg(Msg::count("counts.fills", polygons.len() as f64)) },
    });
    let start = (panel.fills_page * FILLS_PAGE).min(polygons.len().saturating_sub(1) / FILLS_PAGE * FILLS_PAGE);
    for (index, polygon) in polygons.iter().enumerate().skip(start).take(FILLS_PAGE) {
        // `fillGroup`: its row (colour, delete), its opacity and order, and the four order steps.
        let name = Msg::new("inspectorView.polygon").with("value", index + 1);
        let at = index as u32;
        let target = uid.map(|uid| [("kind", Value::str("polygon")), ("uid", Value::Num(f64::from(uid))), ("polygonId", Value::Num(f64::from(polygon.id))), ("figureTypeId", Value::Num(f64::from(figure.id)))]);
        let opacity = target.as_ref().and_then(|target| channel(document, target, "opacity", 100.0)).unwrap_or(polygon.alpha * 100.0);
        let position = super::order::position(&drawables, super::order::DrawKind::Polygon, index).unwrap_or(1) as f64;
        let mut delete = Button { action: Action::Panel(PanelAction::DeletePolygon(at)), ..button(CommandId::Undo, Some("trash"), "inspectorView.deletePolygon") };
        delete.label = Msg::new("inspectorView.deletePolygon").with("value", index + 1);
        let chip = Swatch { target: ColorTarget::Polygon(at), rgb: displayed_color(version, figure, object, polygon.rgb), description: Msg::new("inspectorView.color").with("name", name.clone()), disabled: false };
        rows.push(Row::Group {
            label: name.clone(),
            head: ListRow { glyph: "polygon", label: name, swatch: Some(chip), actions: vec![delete] },
            rows: vec![
                grid(vec![
                    Row::Number(number(PropertyKey::PolygonOpacity(at), msg("inspectorView.opacity"), opacity, "%").range(0.0, 100.0)),
                    Row::Number(number(PropertyKey::PolygonZOrder(at), msg("inspectorView.order"), position, "").range(1.0, drawables.len() as f64)),
                ]),
                order_actions(super::order::DrawKind::Polygon, at, "inspectorView.fillOrder"),
            ],
        });
    }
    if polygons.len() > FILLS_PAGE {
        rows.push(Row::Pager {
            label: msg("inspectorView.fillPages"),
            text: page_text(start, FILLS_PAGE, polygons.len()),
            previous: page(Pager::Fills, -1, "chevron-left", "inspectorView.previousPolygons").disabled(start == 0),
            next: page(Pager::Fills, 1, "chevron-right", "inspectorView.nextPolygons").disabled(start + FILLS_PAGE >= polygons.len()),
        });
    }
    section("colours", Some(msg("inspectorView.colours")), rows).titled(false)
}

/// Several figures: Selection (group bounds), Align, Appearance and Arrange.
fn figures(document: &Document, records: &Value, frame: &Value, inputs: &Inputs<'_>, count: usize) -> Inspector {
    let objects = facts::selected_objects(document, frame);
    let object = facts::selected_object(document, frame).unwrap_or(Value::Null);
    let version = num(records.get("version")).unwrap_or(0.0);
    let mut opacities: Vec<u64> = objects.iter().map(|item| num(item.get("field28")).unwrap_or(0.0).to_bits()).collect();
    opacities.sort_unstable();
    opacities.dedup();
    let mut colours: Vec<[u8; 3]> = objects
        .iter()
        .filter_map(|item| facts::figure_of(document, item).map(|figure| palette(version, &figure, item)))
        .flat_map(|entries| entries.into_iter().map(|entry| entry.0))
        .collect();
    colours.sort_unstable();
    colours.dedup();
    let joined = objects.iter().any(|item| item.get("join").is_some_and(Value::is_object));
    // The bounds are a fact made on the worker: until they are ready the rows wait, empty.
    let pending = inputs.shown.bounds.is_none();
    let [min_x, min_y, max_x, max_y] = inputs.shown.bounds.unwrap_or([0.0; 4]);
    let align = [
        (CommandId::AlignLeft, "align-left", "inspectorView.alignLeft"),
        (CommandId::AlignCenterX, "align-horizontal-center", "inspectorView.alignCenter"),
        (CommandId::AlignRight, "align-right", "inspectorView.alignRight"),
        (CommandId::AlignTop, "align-top", "inspectorView.alignTop"),
        (CommandId::AlignCenterY, "align-vertical-center", "inspectorView.alignMiddle"),
        (CommandId::AlignBottom, "align-bottom", "inspectorView.alignBottom"),
    ];
    let mut opacity = number(PropertyKey::FigureOpacity, msg("inspectorView.opacity"), pct_of_transparency(num(object.get("field28")).unwrap_or(0.0)), "%").range(0.0, 100.0);
    opacity.mixed = opacities.len() > 1;
    let mut sections = Vec::new();
    sections.extend(range_section(inputs.view));
    sections.push(
        section("selection", Some(msg("inspectorView.selection")), vec![grid(vec![
            Row::Number(number(PropertyKey::GroupX, plain("X"), min_x, "px").pending(pending)),
            Row::Number(number(PropertyKey::GroupY, plain("Y"), min_y, "px").pending(pending)),
            Row::Number(number(PropertyKey::GroupWidth, plain("W"), max_x - min_x, "px").range(0.01, f64::INFINITY).described(msg("inspectorView.widthPx")).pending(pending)),
            Row::Number(number(PropertyKey::GroupHeight, plain("H"), max_y - min_y, "px").range(0.01, f64::INFINITY).described(msg("inspectorView.heightPx")).pending(pending)),
        ])])
        .actions(vec![button(CommandId::Rotate, None, "inspectorView.rotate15").text().tip("inspectorView.rotateTheSelection15"), button(CommandId::Center, None, "inspectorView.center").text().tip("inspectorView.centerSelection")]),
    );
    sections.push(section("align", Some(msg("inspectorView.align")), vec![Row::Actions(ActionsRow {
        label: Some(msg("inspectorView.align")),
        items: align.iter().map(|(command, icon, label)| button(*command, Some(icon), label)).collect(),
    })]));
    sections.push(
        section("appearance", Some(msg("inspectorView.appearance")), vec![grid(vec![
            Row::Color(ColorRow { paint_picker: false, disabled: false,
                target: ColorTarget::Figure,
                label: msg("inspectorView.colour"),
                description: Some(msg("inspectorView.figureColor")),
                paint: Paint::Solid(if colours.len() == 1 { colours[0] } else { [0x2b, 0x2b, 0x2b] }),
                caption: None,
                mixed: colours.len() > 1,
                span: false,
            }),
            Row::Number(opacity),
        ])])
        .actions(vec![button(CommandId::ResetColor, Some("reset"), "inspectorView.resetColors")]),
    );
    sections.push(section("arrange", Some(msg("inspectorView.arrange")), vec![Row::Grid { ratio: Ratio::ThreeTwo, rows: vec![
        layer_select(document, records, false),
        Row::Actions(ActionsRow {
            label: Some(msg("inspectorView.oneStep")),
            items: vec![button(CommandId::LayerDown, Some(STEP_DOWN), "inspectorView.sendBackward"), button(CommandId::LayerUp, Some(STEP_UP), "inspectorView.bringForward")],
        }),
    ] }]));
    if joined {
        sections.push(section("connection", Some(msg("inspectorView.connection")), vec![Row::Actions(ActionsRow { label: None, items: vec![button(CommandId::CombineFigures, Some("combine"), "inspectorView.combineConnected").outline()] })]).titled(false));
    }
    Inspector {
        kind: Kind::Figures,
        target: target("inspectorView.figures", Label::Msg(Msg::count("inspectorView.selectedFigures", count as f64)), None, "figures"),
        scope: scope_line(inputs.view),
        library: false,
        quick: Some("figures"),
        sections,
    }
}

/// The shape a segment's primitive draws (`shape` of `jointDescriptor`).
fn shape(prim: Prim) -> &'static str {
    match prim {
        Prim::Line => "line",
        Prim::Circle => "circle",
        Prim::Image => "image",
        Prim::CircleFill => "circleFill",
        Prim::CircleClear => "circleClear",
        Prim::Text => "text",
        Prim::SquareLine => "squareLine",
    }
}

/// A joint in Animate: Joint (angle, length, bend, Static), IK, Style, Second colour and its figure's Layer.
fn joint_context(document: &Document, records: &Value, figure: &Figure, object: &Value, segment: &Segment, inputs: &Inputs<'_>) -> Inspector {
    let joint = facts::selection(document).joint as usize;
    let version = num(records.get("version")).unwrap_or(0.0);
    let connector = segment.rig.as_ref().is_some_and(|rig| rig.connector.is_some());
    let part = connector.then_some(inputs.panel.connector_part);
    let slider = part == Some(ConnectorPart::Slider);
    let style = object.path(&["_stykStyle", "segments", &segment.id.to_string()]).cloned();
    let uid = num(object.get("unique_id")).map(|uid| uid as u32);
    let segment_channel = |property: &str| {
        let target = [("kind", Value::str("segment")), ("uid", Value::Num(f64::from(uid?))), ("handleId", Value::Num(f64::from(segment.id)))];
        channel(document, &target, property, 1.0)
    };
    let override_of = |name: &str| segment_channel(name).or_else(|| style.as_ref().and_then(|style| num(style.get(name))));
    let two_tone = matches!(segment.prim, Prim::Circle | Prim::CircleFill | Prim::CircleClear);
    let secondary = two_tone && segment.secondary.is_some();
    let fixed = matches!(segment.prim, Prim::Image | Prim::Text);
    let lock = segment.rig.as_ref().is_some_and(|rig| rig.lock.is_some());
    let len_flag = num(object.get("len_flag")).unwrap_or(0.0) != 0.0;
    let bend_flag = num(object.get("bend_flag")).unwrap_or(0.0) != 0.0;
    let position = if len_flag { item_f64(object.get("lengths"), joint).unwrap_or(segment.length) } else { segment.length };
    let angle = item_f64(object.get("angles"), joint).unwrap_or(segment.angle);
    let bend = if bend_flag { item_f64(object.get("bends"), joint).unwrap_or(0.0) } else { segment.bend };
    let title = segment.name.as_deref().filter(|name| !name.is_empty()).map_or_else(|| Label::Msg(Msg::new("builderSurfaceUi.jointNumber").with("id", f64::from(segment.id))), Label::plain);
    let static_switch = SwitchRow { toggle: Toggle::StaticJoint, label: msg("inspectorView.static"), checked: segment.is_static, disabled: false, tip: Some(msg("inspectorView.doesNotTurnWithItsParent")), span: false };
    let shown = displayed_segment_paint(version, figure, object, segment);
    let solid = shown.is_solid();
    let gradient_kind = shown.kind.id();
    let paint = if solid { Paint::Solid(shown.stops[0].rgb()) } else { Paint::Gradient(shown) };
    let colour = ColorRow { paint_picker: true, disabled: false,
        target: ColorTarget::Segment,
        label: msg("inspectorView.colour"),
        description: Some(msg("inspectorView.segmentColor")),
        paint,
        caption: (!solid).then(|| Label::Msg(Msg::new("inspectorView.valueValue1Gradient").with("value", Msg::owned(format!("colorPicker.{gradient_kind}"))).with("value1", ""))),
        mixed: false,
        span: false,
    };
    let width = number(PropertyKey::Thickness, msg("inspectorView.width"), override_of("thickness").unwrap_or(segment.thickness), "px").range(0.0, f64::INFINITY);
    let opacity_value = override_of("opacity").map_or(segment.alpha * 100.0, |opacity| opacity * 100.0);
    let alpha = number(PropertyKey::SegmentOpacity, msg(if secondary { "inspectorView.primaryOpacity" } else { "inspectorView.opacity" }), opacity_value, "%")
        .range(0.0, 100.0)
        .described(msg("inspectorView.primaryColorOpacity"));
    let shapes = [
        ("line", "inspectorView.roundLine"),
        ("squareLine", "inspectorView.squareLine"),
        ("circle", "inspectorView.whiteCircle"),
        ("circleFill", "inspectorView.filledCircle"),
        ("circleClear", "inspectorView.clearCircle"),
    ];
    let mut options: Vec<SelectOption> = shapes.iter().map(|(value, label)| SelectOption { value: Arc::from(*value), label: Label::key(label), disabled: false }).collect();
    if fixed {
        let label = if segment.prim == Prim::Image { "builderOutliner.image" } else { "inspectorView.text" };
        options.push(SelectOption { value: Arc::from(shape(segment.prim)), label: Label::key(label), disabled: false });
    }
    let shape_select = Row::Select(SelectRow {
        choice: Choice::SegmentShape,
        label: msg("inspectorView.shape"),
        description: msg("inspectorView.segmentShape"),
        value: Some(Arc::from(shape(segment.prim))),
        placeholder: None,
        options,
        disabled: fixed,
        span: true,
        bare: false,
    });
    let drawables = super::order::drawables(figure, object);
    let order = super::order::position(&drawables, super::order::DrawKind::Segment, joint).unwrap_or(1) as f64;
    let mut joint_rows = Vec::new();
    if !connector {
        let mut angle_row = number(PropertyKey::JointAngle, msg("inspectorView.angle"), degrees(angle), "°");
        angle_row.disabled = lock;
        joint_rows.push(Row::Number(angle_row));
        joint_rows.push(Row::Number(number(PropertyKey::JointLength, msg("inspectorView.length"), position, "px").range(0.0, f64::INFINITY)));
    }
    joint_rows.push(Row::Number(number(PropertyKey::JointBend, msg("inspectorView.bend"), degrees(bend), "°")));
    if !connector {
        joint_rows.push(Row::Switch(static_switch.clone()));
    }
    let mut sections = Vec::new();
    sections.extend(range_section(inputs.view));
    if let Some(part) = part {
        sections.push(
            section("connector", Some(Msg::new("inspectorView.connector").with("segment_id", f64::from(segment.id))), vec![Row::Segmented(SegmentedRow {
                segments: Segments::ConnectorPart,
                description: msg("inspectorView.connectorProperties"),
                value: if part == ConnectorPart::Slider { "slider" } else { "segment" },
                options: vec![("segment", msg("inspectorView.segment")), ("slider", msg("inspectorView.slider"))],
            })])
            .titled(true),
        );
    }
    if slider {
        let mut position_row = number(PropertyKey::JointLength, msg("inspectorView.position"), (position * 10000.0).round() / 100.0, "%").range(0.0, 100.0).described(msg("inspectorView.slidePosition"));
        position_row.precision = 2;
        position_row.disabled = true;
        sections.push(section("slider", Some(msg("inspectorView.slider")), vec![grid(vec![Row::Number(position_row), Row::Switch(static_switch)])]));
    } else {
        sections.push(section("joint", Some(msg("inspectorView.joint")), vec![grid(joint_rows)]));
        sections.push(section("ik", None, vec![Row::Slot(Slot::Ik)]));
        let order_row = number(PropertyKey::SegmentZOrder, msg("inspectorView.order"), order, "").range(1.0, drawables.len() as f64).described(msg("inspectorView.drawOrder"));
        sections.push(section("style", Some(msg("inspectorView.style")), vec![grid(vec![Row::Number(width), Row::Color(colour), Row::Number(alpha), Row::Number(order_row), shape_select])]));
    }
    if two_tone && !slider {
        let mut rows = Vec::new();
        if let Some((rgb, a)) = segment.secondary {
            rows.push(grid(vec![
                Row::Color(ColorRow { paint_picker: false, disabled: false, target: ColorTarget::SegmentGradient, label: msg("inspectorView.colour"), description: Some(msg("inspectorView.secondaryColor")), paint: Paint::Solid(displayed_color(version, figure, object, rgb)), caption: None, mixed: false, span: false }),
                Row::Number(
                    number(PropertyKey::SegmentGradientOpacity, msg("inspectorView.secondaryOpacity"), override_of("gradientOpacity").map_or(pct_of_transparency(f64::from(a)), |opacity| opacity * 100.0), "%")
                        .range(0.0, 100.0)
                        .described(msg("inspectorView.secondaryColorOpacity")),
                ),
            ]));
        }
        let mut second = section("second-colour", Some(msg("inspectorView.secondColour")), rows).titled(secondary);
        second.switch = Some(SwitchRow { toggle: Toggle::SecondaryColor, label: msg("inspectorView.secondaryColor"), checked: secondary, disabled: false, tip: None, span: false });
        sections.push(second);
    }
    sections.push(section("figure", Some(msg("inspectorView.figure")), vec![grid(vec![layer_select(document, records, true)])]));
    Inspector {
        kind: Kind::Joint,
        target: Target { kind_label: Label::key("inspectorView.joint"), name: title, glyph: Some(if part.is_some() { "link" } else { "nodes" }), rename: None, selection: "joint" },
        scope: scope_line(inputs.view),
        library: false,
        quick: Some("joint"),
        sections,
    }
}

/// A movieclip instance: its target and the movieclip chunk's sections.
fn movieclip(figure: &Figure, _records: &Value) -> Inspector {
    let name = if figure.name.is_empty() { Label::key("inspectorView.figure") } else { Label::plain(figure.name.as_str()) };
    Inspector {
        kind: Kind::Movieclip,
        target: Target { kind_label: Label::key("inspectorView.figure"), name, glyph: Some("frame"), rename: None, selection: "figure" },
        scope: None,
        library: false,
        quick: Some("movieclip"),
        sections: vec![section("movieclip", None, vec![Row::Slot(Slot::Movieclip)])],
    }
}

/// A figure with a spatial origin: the spatial chunk's sections and its Placement.
fn spatial_rig(figure: &Figure, object: &Value) -> Inspector {
    let name = if figure.name.is_empty() { Label::key("inspectorView.figure") } else { Label::plain(figure.name.as_str()) };
    Inspector {
        kind: Kind::SpatialRig,
        target: Target { kind_label: Label::key("inspectorView.figure"), name, glyph: Some("person"), rename: Some(figure_rename()), selection: "figure" },
        scope: None,
        library: false,
        quick: Some("figure"),
        sections: vec![
            section("spatial", None, vec![Row::Slot(Slot::Spatial)]),
            section("placement", Some(msg("inspectorView.placement")), vec![grid(vec![
                Row::Number(number(PropertyKey::RootX, plain("X"), num(object.get("root_x")).unwrap_or(0.0), "px")),
                Row::Number(number(PropertyKey::RootY, plain("Y"), num(object.get("root_y")).unwrap_or(0.0), "px")),
                Row::Number(number(PropertyKey::Scale, msg("inspectorView.scale"), num(object.get("scale")).unwrap_or(1.0) * 100.0, "%").range(0.01, f64::INFINITY)),
            ])])
            .titled(true),
        ],
    }
}

/// A Draw tool: the panel's title names the tool; its options are the Draw chunk's.
fn drawing(tool: &'static str) -> Inspector {
    Inspector {
        kind: Kind::Drawing,
        target: Target { kind_label: Label::key("inspectorView.drawing"), name: Label::Msg(Msg::new("inspectorView.drawing")), glyph: Some(if tool.is_empty() { "brush" } else { tool }), rename: None, selection: "drawing" },
        scope: None,
        library: false,
        quick: None,
        sections: vec![section("drawing", None, vec![Row::Slot(Slot::DrawTools)])],
    }
}

/// The figure as its pose's style overlay resolves it: the definition when the pose restyles nothing, else the
/// resolution the facts lane made for exactly this state (`None` until it lands).
fn instance(shown: &super::Shown, figure: Arc<Figure>, object: &Value) -> Option<Arc<Figure>> {
    if !crate::facts::restyled(object) {
        return Some(figure);
    }
    shown.instance.clone().filter(|instance| instance.id == figure.id)
}

/// What a colour row's picker opens with (`installColorPickers`' resolver in `src/app.mjs`).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Picked {
    pub paint: Paint2,
    pub gradients: bool,
    pub alpha: bool,
    /// The palette colour a swatch replaces (`entry.color`).
    pub from: Option<String>,
    /// The palette row it replaces (`targets: entry`): the segments and stops, the fills and the instances the colour
    /// had when the picker opened, which every commit of this opening reaches.
    pub targets: Option<Value>,
}

/// The paint a colour row's picker starts from, read as the row was built: the background's paint (its own colour
/// override first), the figure's colour and opacity, the segment's displayed paint, a two-tone's secondary colour, a
/// fill's colour and opacity, a palette colour. `shown` is the colour the row shows (the figure's, or several
/// figures' shared one), as today's picker starts from the field's value. `None` when the row's target is gone.
pub(crate) fn picker(document: &Document, frame: &Value, target: ColorTarget, shown: Option<[u8; 3]>, lane: &super::Shown) -> Option<Picked> {
    let records = facts::records(document);
    let version = num(records.get("version")).unwrap_or(0.0);
    let solid = |rgb: [u8; 3], opacity: f64, alpha: bool| Picked { paint: Paint2::solid(rgb, opacity), gradients: false, alpha, from: None, targets: None };
    if target == ColorTarget::Background {
        let background_id = num(frame.get("background_id"));
        let background = records.get("backgrounds").and_then(Value::elements).and_then(|items| items.iter().find(|item| num(item.get("background_id")) == background_id));
        let paint = match num(frame.get("_stykBackgroundColor")) {
            Some(color) => {
                let mut solid = styk_doc::Obj::new();
                solid.set("kind", Value::Num(2.0));
                solid.set("color", Value::Num(color));
                Paint2::of_background(Some(&Value::object(solid)))
            }
            None => Paint2::of_background(background.as_ref()),
        };
        return paint.ok().map(|paint| Picked { paint, gradients: true, alpha: true, from: None, targets: None });
    }
    let object = facts::selected_object(document, frame)?;
    let figure = instance(lane, facts::figure_of(document, &object)?, &object)?;
    match target {
        ColorTarget::Background => None,
        ColorTarget::Figure => Some(solid(shown?, 1.0 - num(object.get("field28")).unwrap_or(0.0) / 255.0, true)),
        ColorTarget::Segment => {
            let segment = usize::try_from(facts::selection(document).joint).ok().and_then(|joint| figure.segments.get(joint))?;
            Some(Picked { paint: displayed_segment_paint(version, &figure, &object, segment), gradients: true, alpha: true, from: None, targets: None })
        }
        ColorTarget::SegmentGradient => {
            let segment = usize::try_from(facts::selection(document).joint).ok().and_then(|joint| figure.segments.get(joint))?;
            let (rgb, _) = segment.secondary?;
            // The secondary colour is a plain colour field: today's default picker, opaque, without gradients.
            Some(solid(displayed_color(version, &figure, &object, rgb), 1.0, false))
        }
        ColorTarget::Polygon(index) => {
            let polygon = figure.polyfills.get(index as usize)?;
            Some(solid(displayed_color(version, &figure, &object, polygon.rgb), polygon.alpha, true))
        }
        ColorTarget::Palette(index) => {
            let (rgb, ..) = *palette(version, &figure, &object).get(index as usize)?;
            // `editor.figurePalette().find(entry => entry.color === swatch)`: the session's own row, captured now.
            let uid = facts::selection(document).uid?;
            let from = facts::hex(rgb);
            let targets = styk_edit::attached_palette_row(records, &facts::frame_objects(frame), uid, &from).ok().flatten()?;
            Some(Picked { from: Some(from), targets: Some(targets), ..solid(rgb, 1.0, false) })
        }
    }
}

/// The model while the frame on show and the document's views are being made on a worker: the last model with every
/// value read from the frame cleared and every control disabled, so nothing stale is shown as current or edited.
pub(crate) fn pending(model: &Inspector) -> Inspector {
    fn disable(rows: &mut [Row]) {
        for row in rows {
            match row {
                Row::Grid { rows: inner, .. } => disable(inner),
                Row::Group { head, rows: inner, .. } => {
                    if let Some(swatch) = head.swatch.as_mut() {
                        swatch.disabled = true;
                    }
                    head.actions.iter_mut().for_each(|action| action.disabled = true);
                    disable(inner);
                }
                Row::Swatches { items, .. } => items.iter_mut().for_each(|item| item.disabled = true),
                Row::Number(number) => number.pending = true,
                Row::Stepper(stepper) => {
                    stepper.field.pending = true;
                    stepper.down.disabled = true;
                    stepper.up.disabled = true;
                }
                Row::Select(select) => select.disabled = true,
                Row::Switch(switch) => switch.disabled = true,
                Row::Color(color) => color.disabled = true,
                Row::Text(text) => text.disabled = true,
                Row::Actions(actions) => actions.items.iter_mut().for_each(|item| item.disabled = true),
                Row::Pager { previous, next, .. } => {
                    previous.disabled = true;
                    next.disabled = true;
                }
                Row::Segmented(_) | Row::Value { .. } | Row::Meta(_) | Row::Caption(_) | Row::Slot(_) => {}
            }
        }
    }
    let mut model = model.clone();
    for section in &mut model.sections {
        section.actions.iter_mut().for_each(|action| action.disabled = true);
        if let Some(switch) = section.switch.as_mut() {
            switch.disabled = true;
        }
        disable(&mut section.rows);
    }
    model
}
