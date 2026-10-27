//! Document tree → typed [`Document`]: the views evaluation reads.

use std::collections::HashMap;
use std::sync::{Arc, Weak};

use styk_doc::{Obj, Value};

use crate::doc::*;
use crate::text::parse_svg_path;
use crate::Error;

// Private pose-conversion eligibility, not a document or parity limit. Larger
// records retain the original converter without a new raw-field scan.
const POSE_FIELD_REUSE_LIMIT: usize = 64;

fn warning_free_stack(raw: &Value, count: usize) -> bool {
    raw.as_arr().is_some_and(|items| items.len() <= crate::vfx::parse::STACK_LIMIT && items.len() == count)
}

fn warning_free_vfx(raw: &Value, stacks: &crate::vfx::Stacks) -> bool {
    let Some(owner) = raw.as_obj() else { return false };
    // Equal cardinalities exclude invalid keys/effects, duplicates and removed
    // generators. The stack limit excludes the warning that drops nothing.
    owner.len() == stacks.entries.len() && owner.iter().zip(&stacks.entries)
        .all(|((_, raw), (_, effects))| warning_free_stack(raw, effects.len()))
}

/// Builds the typed views of a document and keeps them while their source
/// records are unchanged.
///
/// One loader lives as long as one document lineage (every revision of the open
/// project). [`Loader::document`] reuses the typed figure, keyframe and pose source
/// of every record whose tree node is the node it was built from, so after an edit
/// only the records the edit replaced are converted again.
#[derive(Clone)]
pub struct Loader {
    /// The lifetime/accounting owner shared by this lineage's typed clip
    /// resources. Cloning a Loader must preserve it along with those resources.
    scene_budget: Arc<crate::geometry::SceneBudget>,
    /// One image table shared by the root document and every nested movieclip.
    /// Append-only: an index, once handed out, names the same image for good. An image is in it once, however
    /// many records, revisions or copies of its payload (an undo that builds a record anew) name it.
    pub images: Vec<ImageData>,
    /// Records read leniently or ignored (invalid effect records).
    pub notes: Vec<String>,
    /// Image index by the address of its payload (a blob's bytes or a string's text), while the payload exists.
    image_of: HashMap<usize, (Payload, u32)>,
    /// The images with the same length and hash, to find an image whose payload was made anew.
    images_by_content: HashMap<(usize, u64), Vec<u32>>,
    /// Typed views by the address of the record they were built from. The source
    /// is held (without keeping it alive, see [`Source`]) so the address cannot be reused by another record.
    figures: HashMap<usize, (Source, Arc<Figure>)>,
    keyframes: HashMap<usize, (Source, Arc<Keyframe>)>,
    /// Resolved style overlays by base figure (address; the figure is held) and overlay key.
    styled: HashMap<(usize, String), (Arc<Figure>, Arc<Figure>)>,
    /// Effect clips by the address of the `vfxClips` record they were built from.
    vfx_clips: HashMap<usize, (Source, Option<Arc<crate::vfx::Clips>>)>,
    /// Property channels by the address of the animation record they were built from.
    animations: HashMap<usize, (Source, Option<Arc<crate::channels::Animation>>)>,
    /// Records converted (not reused) by the last [`Loader::document`] call.
    pub converted: Converted,
}

/// How much of a document [`Loader::document`] had to convert.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Converted {
    pub figures: usize,
    pub keyframes: usize,
}

/// The record a typed view was made from. It does not keep the record alive: the view is dropped
/// ([`Loader::release_unused`]) once nothing else holds the record, whoever else caches views of it (a record that
/// each of several loaders held would be held by all of them for ever). While it exists the record's allocation is
/// not reused, so an address names one record only.
#[derive(Clone)]
struct Source(Weak<Obj>);

impl Source {
    fn of(value: &Value) -> Source {
        Source(match value {
            Value::Obj(object) => Arc::downgrade(object),
            _ => Weak::new(),
        })
    }

    /// Whether something still holds the record.
    fn held(&self) -> bool {
        self.0.strong_count() > 0
    }
}

/// The payload of an image field, held without keeping it alive (as [`Source`] does for records).
#[derive(Clone)]
enum Payload {
    Bytes(Weak<[u8]>),
    Text(Weak<str>),
}

impl Payload {
    fn held(&self) -> bool {
        match self {
            Payload::Bytes(bytes) => bytes.strong_count() > 0,
            Payload::Text(text) => text.strong_count() > 0,
        }
    }
}

/// A hash of `bytes` (eight at a time; not a cryptographic one): images whose length and hash agree are compared
/// byte by byte.
fn content_hash(bytes: &[u8]) -> u64 {
    const K: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut hash = bytes.len() as u64 ^ K;
    let mut words = bytes.chunks_exact(8);
    for word in &mut words {
        hash = (hash ^ u64::from_le_bytes(word.try_into().expect("eight bytes"))).wrapping_mul(K).rotate_left(29);
    }
    for &byte in words.remainder() {
        hash = (hash ^ byte as u64).wrapping_mul(K).rotate_left(29);
    }
    hash ^ (hash >> 32)
}

/// The address of a container node, the identity typed views are cached by.
fn node_address(value: &Value) -> Option<usize> {
    match value {
        Value::Obj(object) => Some(Arc::as_ptr(object) as usize),
        _ => None,
    }
}

fn num(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(Value::as_f64)
}
fn int(v: &Value, key: &str) -> Option<i64> {
    v.get(key).and_then(Value::as_f64).map(|f| f as i64)
}
fn truthy(v: Option<&Value>) -> bool {
    v.is_some_and(Value::truthy)
}
fn rgb(v: Option<&Value>) -> Option<[u8; 3]> {
    let a = v?.numbers()?;
    if a.len() != 3 || a.iter().any(|c| c.fract() != 0.0 || !(0.0..=255.0).contains(c)) {
        return None;
    }
    Some([a[0] as u8, a[1] as u8, a[2] as u8])
}
fn point(v: Option<&Value>) -> Option<[f64; 2]> {
    let v = v?;
    Some([num(v, "x")?, num(v, "y")?])
}

pub fn easing(v: Option<&Value>) -> Option<Easing> {
    let v = v?;
    let mode = match v.get("interpolation").and_then(Value::as_str) {
        Some("auto") => EasingMode::Auto,
        Some("bezier") => EasingMode::Bezier,
        Some("ease-in") => EasingMode::EaseIn,
        Some("ease-out") => EasingMode::EaseOut,
        Some("constant") | Some("hold") => EasingMode::Constant,
        _ => EasingMode::Linear,
    };
    let mut bezier = Easing::LINEAR.bezier;
    if let Some(b) = v.get("bezier").and_then(Value::elements)
        && b.len() == 4
    {
        for (i, x) in b.iter().enumerate() {
            bezier[i] = x.as_f64().unwrap_or(bezier[i]);
        }
    }
    Some(Easing { mode, bezier })
}

pub fn paint(v: Option<&Value>) -> Option<Arc<Paint>> {
    let v = v?;
    let stops: Vec<PaintStop> = v
        .get("stops")?
        .as_arr()?
        .iter()
        .filter_map(|s| {
            Some(PaintStop {
                offset: num(s, "offset")?.clamp(0.0, 1.0),
                rgb: rgb(s.get("color"))?,
                opacity: num(s, "opacity").unwrap_or(1.0).clamp(0.0, 1.0),
            })
        })
        .collect();
    if stops.is_empty() {
        return None;
    }
    let mut stops = stops;
    stops.sort_by(|a, b| a.offset.total_cmp(&b.offset));
    Some(Arc::new(Paint {
        kind: match v.get("type").and_then(Value::as_str) {
            Some("solid") => PaintKind::Solid,
            Some("radial") => PaintKind::Radial,
            Some("angular") => PaintKind::Angular,
            Some("diamond") => PaintKind::Diamond,
            _ => PaintKind::Linear,
        },
        angle: num(v, "angle").unwrap_or(0.0),
        stops,
    }))
}

impl Default for Loader {
    fn default() -> Self {
        Loader::new()
    }
}

impl Loader {
    pub fn new() -> Self {
        Self::with_scene_limits(crate::geometry::SceneBudget::DEFAULT_BYTES, crate::geometry::SceneBudget::DEFAULT_ENTRIES)
    }

    /// Sets aggregate derived Scene retention limits for a new document
    /// lineage. Revisions and nested clips created by this loader share them.
    pub fn with_scene_limits(bytes: usize, entries: usize) -> Self {
        Loader {
            scene_budget: Arc::new(crate::geometry::SceneBudget::with_limits(bytes, entries)),
            images: Vec::new(),
            notes: Vec::new(),
            image_of: HashMap::new(),
            images_by_content: HashMap::new(),
            figures: HashMap::new(),
            keyframes: HashMap::new(),
            styled: HashMap::new(),
            vfx_clips: HashMap::new(),
            animations: HashMap::new(),
            converted: Converted::default(),
        }
    }

    pub fn scene_budget(&self) -> &Arc<crate::geometry::SceneBudget> {
        &self.scene_budget
    }

    fn image(&mut self, v: &Value, keys: &[&str]) -> Option<u32> {
        for key in keys {
            let Some(field) = v.get(*key) else { continue };
            // The same payload (the same blob, or the same string) is one image, however
            // many records or revisions name it.
            let (identity, payload) = match field {
                Value::Blob(blob) => (blob.bytes.as_ptr() as usize, Payload::Bytes(Arc::downgrade(&blob.bytes))),
                Value::Str(text) => (text.as_ptr() as usize, Payload::Text(Arc::downgrade(text))),
                _ => continue,
            };
            if let Some(&(_, index)) = self.image_of.get(&identity) {
                return Some(index);
            }
            if let Some(bytes) = field.payload_bytes()
                && !bytes.is_empty()
            {
                // The same picture in a payload made anew is the picture the table has.
                let content = (bytes.len(), content_hash(&bytes));
                let index = match self.images_by_content.get(&content).and_then(|known| known.iter().copied().find(|&at| *self.images[at as usize].bytes == *bytes)) {
                    Some(index) => index,
                    None => {
                        self.images.push(ImageData { bytes, color_key: None });
                        let index = self.images.len() as u32 - 1;
                        self.images_by_content.entry(content).or_default().push(index);
                        index
                    }
                };
                self.image_of.insert(identity, (payload, index));
                return Some(index);
            }
        }
        None
    }

    fn numbers(&self, v: Option<&Value>) -> Option<Arc<[f64]>> {
        Some(v?.numbers()?.into())
    }

    /// The typed views of `d`, reusing those of records unchanged since the last call.
    pub fn document(&mut self, d: &Value, name: &str) -> Result<Document, Error> {
        self.converted = Converted::default();
        let mut document = self.nested_document(d, name)?;
        document.images = self.images.clone();
        // Each distinct note once, and a bounded number of them however many revisions are read.
        let mut notes: Vec<String> = Vec::new();
        for note in self.notes.drain(..) {
            if notes.len() < 64 && !notes.contains(&note) {
                notes.push(note);
            }
        }
        self.notes = notes;
        document.notes = self.notes.clone();
        if document.name.is_empty() {
            document.name = name.to_string();
        }
        Ok(document)
    }

    /// One document of the tree: the project, or a movieclip's own.
    fn nested_document(&mut self, d: &Value, name: &str) -> Result<Document, Error> {
        let version = int(d, "version").unwrap_or(5) as u32;
        if !(2..=5).contains(&version) {
            return Err(Error::Format(format!("Expected a decoded Pivot 2-5 scene, found version {version}")));
        }
        let canvas = [int(d, "canvas_width").unwrap_or(640) as u32, int(d, "canvas_height").unwrap_or(480) as u32];
        let mut fps = num(d, "fps").unwrap_or(24.0);
        if version < 5
            && let Some(delay) = num(d, "frame_delay_ms").filter(|&v| v > 0.0)
        {
            fps = round_half_even(1000.0 / delay);
        }
        let styk = d.get("_styk").cloned().unwrap_or(Value::Null);
        let mut figures = Vec::new();
        for f in d.get("figure_types").and_then(Value::as_arr).into_iter().flatten() {
            figures.push(self.cached_figure(f, version)?);
        }
        let mut keyframes = Vec::new();
        // Where each frame's record is: its resolved styles are kept there for the next read.
        let mut addresses: Vec<Option<usize>> = Vec::new();
        for k in d.get("keyframes").and_then(Value::as_arr).into_iter().flatten() {
            keyframes.push(self.cached_keyframe(k)?);
            addresses.push(node_address(k));
        }
        let mut backgrounds = Vec::new();
        for b in d.get("backgrounds").and_then(Value::as_arr).into_iter().flatten() {
            backgrounds.push(self.background(b));
        }
        let mut frame_sources = HashMap::new();
        let mut source_addresses: Vec<(Arc<str>, usize)> = Vec::new();
        if let Some(Value::Obj(sources)) = styk.get("frameSources") {
            for (id, frame) in sources.iter() {
                frame_sources.insert(id.clone(), self.cached_keyframe(frame)?);
                if let Some(address) = node_address(frame) {
                    source_addresses.push((id.clone(), address));
                }
            }
        }
        let layers = styk.get("layers").filter(|v| v.is_object()).map(|l| Arc::new(layers(l)));
        let sheet = styk.get("layerSheet").filter(|v| v.is_object()).map(|s| Arc::new(self.sheet(s)));
        let camera_motion = styk
            .get("cameraMotion")
            .and_then(|m| m.get("clips"))
            .and_then(Value::as_arr)
            .map(|clips| clips.iter().filter_map(camera_motion_clip).collect())
            .unwrap_or_default();
        let vfx_clips = self.cached_vfx_clips(styk.get("vfxClips"));
        fn channels(animation: Option<&Value>) -> &[Value] {
            animation.and_then(|a| a.get("channels")).and_then(Value::as_arr).unwrap_or(&[])
        }
        // The channels the native timeline is evaluated with: a layer sheet's imported keys
        // sample its `legacyAnimation` (`legacySheetReport`); `_styk.animation` is not read then.
        let animation = match &sheet {
            Some(_) => self.cached_animation(styk.path(&["layerSheet", "legacyAnimation"])),
            None => self.cached_animation(styk.get("animation")),
        };
        let effect_channels = [styk.get("animation"), styk.path(&["layerSheet", "legacyAnimation"])]
            .into_iter()
            .any(|animation| channels(animation).iter().any(|c| c.get("property").and_then(Value::as_str).is_some_and(crate::vfx::parse::is_vfx_property)));
        // Source effects remain visible to the document-level effect census.
        let source_vfx = styk.path(&["movieclipSource", "document"]).is_some_and(raw_has_vfx);
        let auto_easing = match d.get("auto_easing") {
            Some(v) => truthy(Some(v)),
            None => version >= 5,
        };
        let movieclip_source = match styk.get("movieclipSource") {
            Some(source) if source.get("document").is_some_and(Value::is_object) => {
                let mut retained = source.get("document").unwrap().as_obj().cloned().unwrap();
                if source.get("inheritFigures").is_some_and(Value::truthy) {
                    retained.set(
                        "figure_types",
                        d.get("figure_types").cloned().unwrap_or(Value::Null),
                    );
                }
                let document = Arc::new(self.nested_document(&Value::object(retained), name)?);
                let ticks = d
                    .get("keyframes")
                    .and_then(Value::as_arr)
                    .map(|frames| {
                        frames
                            .iter()
                            .map(|frame| {
                                frame
                                    .path(&["_styk", "movieclipSourceTick"])
                                    .and_then(Value::as_f64)
                                    .filter(|n| n.is_finite())
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                Some(Arc::new(MovieclipSource { document, ticks }))
            }
            _ => None,
        };
        let mut doc = Document {
            scene_budget: self.scene_budget.clone(),
            name: styk.get("name").and_then(Value::as_str).unwrap_or(name).to_string(),
            version,
            canvas,
            fps,
            auto_easing,
            figures,
            keyframes,
            backgrounds,
            images: Vec::new(),
            layers,
            sheet,
            frame_sources,
            camera_motion,
            vfx_clips,
            vfx_elsewhere: effect_channels || source_vfx,
            animation,
            notes: Vec::new(),
            figure_index: HashMap::new(),
            origins: false,
            movieclip_source,
        };
        doc.origins = doc.figures.iter().any(|f| f.origin.is_some());
        doc.reindex_figures();
        self.resolve_styles(&mut doc);
        // Frames whose styled figures were resolved are cached resolved: the next read of an
        // unchanged record and figure finds nothing stale.
        let resolved = doc.keyframes.iter().zip(&addresses).filter_map(|(frame, address)| Some((address.as_ref()?, frame)));
        let sources = source_addresses.iter().filter_map(|(id, address)| Some((address, doc.frame_sources.get(id)?)));
        for (address, frame) in resolved.chain(sources) {
            if let Some(entry) = self.keyframes.get_mut(address)
                && !Arc::ptr_eq(&entry.1, frame)
            {
                entry.1 = frame.clone();
            }
        }
        Ok(doc)
    }

    fn cached_figure(&mut self, f: &Value, version: u32) -> Result<Arc<Figure>, Error> {
        if let Some(address) = node_address(f) {
            if let Some((_, figure)) = self.figures.get(&address) {
                return Ok(figure.clone());
            }
            let figure = Arc::new(self.figure(f, version)?);
            self.converted.figures += 1;
            self.figures.insert(address, (Source::of(f), figure.clone()));
            return Ok(figure);
        }
        Ok(Arc::new(self.figure(f, version)?))
    }

    /// The effect clips of a `vfxClips` record, reused while the record is unchanged.
    fn cached_vfx_clips(&mut self, v: Option<&Value>) -> Option<Arc<crate::vfx::Clips>> {
        let v = v?;
        let Some(address) = node_address(v) else { return crate::vfx::parse::clips(Some(v), &mut self.notes) };
        if let Some((_, clips)) = self.vfx_clips.get(&address) {
            return clips.clone();
        }
        let clips = crate::vfx::parse::clips(Some(v), &mut self.notes);
        self.vfx_clips.insert(address, (Source::of(v), clips.clone()));
        clips
    }

    /// The property channels of an animation record, reused while the record is unchanged.
    fn cached_animation(&mut self, v: Option<&Value>) -> Option<Arc<crate::channels::Animation>> {
        let v = v?;
        let Some(address) = node_address(v) else { return crate::channels::parse(Some(v), &mut self.notes) };
        if let Some((_, animation)) = self.animations.get(&address) {
            return animation.clone();
        }
        let animation = crate::channels::parse(Some(v), &mut self.notes);
        self.animations.insert(address, (Source::of(v), animation.clone()));
        animation
    }

    fn cached_keyframe(&mut self, k: &Value) -> Result<Arc<Keyframe>, Error> {
        if let Some(address) = node_address(k) {
            if let Some((_, frame)) = self.keyframes.get(&address) {
                return Ok(frame.clone());
            }
            let frame = Arc::new(self.keyframe(k)?);
            self.converted.keyframes += 1;
            self.keyframes.insert(address, (Source::of(k), frame.clone()));
            return Ok(frame);
        }
        Ok(Arc::new(self.keyframe(k)?))
    }

    /// How many typed records the loader holds: figures, keyframes, effect clips, animations and styled figures.
    pub fn cached_records(&self) -> [usize; 5] {
        [self.figures.len(), self.keyframes.len(), self.vfx_clips.len(), self.animations.len(), self.styled.len()]
    }

    /// Forgets the views of records that nothing holds any more (not the document, not its history, not another
    /// loader's document). Call after converting a revision.
    pub fn release_unused(&mut self) {
        self.figures.retain(|_, (source, _)| source.held());
        self.keyframes.retain(|_, (source, _)| source.held());
        self.vfx_clips.retain(|_, (source, _)| source.held());
        self.animations.retain(|_, (source, _)| source.held());
        self.image_of.retain(|_, (payload, _)| payload.held());
        let live: std::collections::HashSet<usize> = self.figures.values().map(|(_, figure)| Arc::as_ptr(figure) as usize).collect();
        self.styled.retain(|(base, _), _| live.contains(base));
    }

    fn figure(&mut self, f: &Value, version: u32) -> Result<Figure, Error> {
        let id = int(f, "figure_type_id").ok_or_else(|| Error::Format("Figure without an id".into()))? as u32;
        let styk = f.get("_styk").cloned().unwrap_or(Value::Null);
        let segs = f.get("segments").and_then(Value::as_arr).unwrap_or_default();
        let mut segments = Vec::with_capacity(segs.len());
        for (i, s) in segs.iter().enumerate() {
            segments.push(self.segment(s, i));
        }
        let mut polyfills = Vec::new();
        for p in f.get("polyfills").and_then(Value::as_arr).into_iter().flatten() {
            let joints = p
                .get("segment_ids")
                .and_then(Value::numbers)
                .unwrap_or_default()
                .into_iter()
                .map(|v| v as u32)
                .collect();
            polyfills.push(Polyfill {
                id: int(p, "polyfill_id").map(|v| v as u32).unwrap_or(polyfills.len() as u32 + 1),
                joints,
                rgb: rgb(p.get("color_rgb")).unwrap_or([0, 0, 0]),
                alpha: match num(p, "alpha_raw") {
                    Some(a) => 1.0 - a / 255.0,
                    None => num(p, "color_alpha").unwrap_or(1.0),
                },
                z: num(p, "z_order").unwrap_or(0.0),
                surface: p.get("_stykSurface").and_then(crate::spatial::parse_surface),
            });
        }
        let is_drawing = styk.get("drawing").is_some();
        let pixels_per_unit = styk.get("drawing").and_then(|d| num(d, "pixelsPerUnit")).unwrap_or(1.0);
        let drawing_bounds = styk.path(&["drawing", "bounds"]).and_then(|b| Some([num(b, "x")?, num(b, "y")?, num(b, "width")?, num(b, "height")?]));
        let cel_id: Option<Arc<str>> = styk.path(&["drawing", "celId"]).and_then(Value::as_str).filter(|id| !id.is_empty()).map(Arc::from);
        let mut images = Vec::new();
        for a in f.get("image_assets").and_then(Value::as_arr).into_iter().flatten() {
            images.push(self.image_asset(a, is_drawing, pixels_per_unit, drawing_bounds, cel_id.as_ref()));
        }
        let mut texts = Vec::new();
        for a in f.get("text_assets").and_then(Value::as_arr).into_iter().flatten() {
            if let Some(t) = text_asset(a) {
                texts.push(t);
            }
        }
        let outline = f.get("segment_decode").and_then(|d| d.get("global_style")).and_then(|s| {
            let width = match int(s, "u28") {
                Some(bits) => f32::from_bits(bits as u32) as f64,
                None => num(s, "outline_thickness")?,
            };
            (width > 0.0 && width.is_finite()).then(|| Outline {
                width,
                rgb: rgb(s.get("rgb")).unwrap_or([0, 0, 0]),
                alpha: 1.0 - num(s, "u30").unwrap_or(0.0) / 255.0,
            })
        });
        let movieclip = match styk.get("movieclip") {
            Some(m) => self.movieclip(m)?,
            None => None,
        };
        let _ = version;
        let plan = plan_figure(&segments, &polyfills);
        // The editor refuses a figure whose origin does not fit its segments; here it is left out and noted.
        let origin = styk.get("animationOrigin").filter(|o| o.is_object()).and_then(|o| match crate::origin::compile(o, &segments) {
            Ok(origin) => Some(Arc::new(origin)),
            Err(reason) => {
                self.notes.push(format!("figure {id}: {reason}"));
                None
            }
        });
        // A mesh is compiled against the figure's joints once (`spatialMeshPlan`). The
        // editor rejects a file whose mesh is invalid; here it is left out and noted.
        let mesh = styk.get("spatialMesh").and_then(|mesh| match crate::spatial::MeshPlan::compile(mesh, &|id| plan.index_of.get(&id).copied()) {
            Ok(mesh) => Some(Arc::new(mesh)),
            Err(reason) => {
                self.notes.push(format!("figure {id}: {reason}"));
                None
            }
        });
        let mesh_colors: Arc<[[u8; 3]]> = mesh.as_ref().map(|mesh| mesh.palette.as_slice().into()).unwrap_or_else(|| Arc::from(Vec::new()));
        Ok(Figure {
            id,
            name: f.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
            segments,
            polyfills,
            images,
            texts,
            outline,
            segment_colors: styk.get("colorMode").and_then(Value::as_str) == Some("segments"),
            is_drawing,
            movieclip,
            mesh,
            mesh_colors,
            origin,
            plan,
            base: None,
        })
    }

    fn segment(&mut self, s: &Value, i: usize) -> Segment {
        let prim = int(s, "primitive_code")
            .and_then(|c| Prim::from_code(c as u8))
            .or_else(|| match s.get("segment_kind").and_then(Value::as_str) {
                Some("circle") => Some(Prim::Circle),
                Some("image") => Some(Prim::Image),
                Some("circleFill") => Some(Prim::CircleFill),
                Some("circleClear") => Some(Prim::CircleClear),
                Some("text") => Some(Prim::Text),
                Some("squareLine") => Some(Prim::SquareLine),
                _ => None,
            })
            .unwrap_or(Prim::Line);
        let is_static = if let Some(aux) = int(s, "aux_code") {
            aux & 1 != 0
        } else if let Some(raw) = s.get("static_raw") {
            truthy(Some(raw))
        } else if let Some(b) = s.get("flag_bits").and_then(|f| f.get("is_static")) {
            truthy(Some(b))
        } else if let Some(b) = s.get("is_static") {
            truthy(Some(b))
        } else {
            int(s, "flags").unwrap_or(0) & 256 != 0
        };
        let extra = s.get("extra").and_then(Value::elements);
        let extra_at = |k: usize| extra.and_then(|e| e.get(k)).and_then(|v| v.as_f64());
        let asset = num(s, "extra_u16")
            .or_else(|| extra_at(0))
            .or_else(|| num(s, "image_asset_index"))
            .or_else(|| num(s, "sprite_index"))
            .unwrap_or(0.0) as u32;
        let reverse = num(s, "extra_u8_a").or_else(|| extra_at(1)).unwrap_or(0.0) != 0.0;
        let mirror = num(s, "extra_u8_b").or_else(|| extra_at(2)).unwrap_or(0.0) != 0.0;
        let thickness = num(s, "thickness").unwrap_or(0.0);
        let sticknodes = s.get("_sticknodes").and_then(crate::sticknodes::parse);
        Segment {
            id: int(s, "segment_id").unwrap_or(i as i64 + 1) as u32,
            parent: int(s, "parent_id").unwrap_or(0) as u32,
            length: num(s, "length").unwrap_or(0.0),
            angle: num(s, "angle_rad").unwrap_or(0.0),
            thickness,
            bend: num(s, "bend_rad").unwrap_or(0.0),
            prim,
            is_static,
            control_detail: s.get("_stykControl").and_then(|c| c.get("level")).and_then(Value::as_str) == Some("detail"),
            rgb: rgb(s.get("color_rgb")).unwrap_or([0, 0, 0]),
            alpha: match num(s, "transparency") {
                Some(t) => 1.0 - t / 255.0,
                None => num(s, "color_alpha").unwrap_or(1.0),
            },
            secondary: s.get("secondary").filter(|v| v.is_object()).and_then(|v| Some((rgb(v.get("rgb"))?, num(v, "a")? as u8))),
            z: num(s, "z_order").unwrap_or(i as f64 + 1.0),
            visible: match s.get("visible") {
                Some(Value::Bool(b)) => *b,
                _ => true,
            },
            asset,
            reverse,
            mirror,
            paint: paint(s.get("paint")),
            sticknodes_shape: sticknodes,
            name: s.get("name").and_then(Value::as_str).map(str::to_string),
            rig: s.get("_stykRig").and_then(crate::rig::parse).map(Arc::new),
            choice_scale: s.get("_stykPoseChoice").and_then(|choice| num(choice, "hidden")) == Some(0.0),
        }
    }

    fn image_asset(&mut self, a: &Value, smooth: bool, pixels_per_unit: f64, bounds: Option<[f64; 4]>, cel_id: Option<&Arc<str>>) -> ImageAsset {
        let index = ["asset_index", "table_index", "image_index", "sprite_index"]
            .iter()
            .find_map(|k| num(a, k))
            .unwrap_or(0.0) as u32;
        let mut start = point(a.get("anchor_start")).or_else(|| point(a.get("pivot"))).unwrap_or([0.0, 0.0]);
        let mut end = point(a.get("anchor_end")).or_else(|| point(a.get("endpoint"))).unwrap_or([1.0, 0.0]);
        if a.get("anchor_start").is_none()
            && a.get("pivot").is_none()
            && let (Some(w), Some(h)) = (num(a, "width"), num(a, "height"))
        {
            start = [0.0, h];
            end = [w, h];
        }
        let anchor_length = num(a, "anchor_length").filter(|v| *v > 0.0).unwrap_or_else(|| (end[0] - start[0]).hypot(end[1] - start[1]));
        let anchor_angle = num(a, "anchor_angle_rad").unwrap_or_else(|| (end[1] - start[1]).atan2(end[0] - start[0]));
        let display_size = match (num(a, "display_width"), num(a, "display_height")) {
            (Some(w), Some(h)) => Some([w, h]),
            _ => None,
        };
        let tiles = a.get("styk_tiles").and_then(Value::payload_bytes).and_then(|bytes| {
            let anchor = point(a.get("drawing_anchor")).unwrap_or(start);
            crate::drawing::parse_tiles(&bytes).map(|tiles| {
                let levels = crate::drawing::level_tiles(&tiles);
                Arc::new(DrawingTiles { anchor, pixels_per_unit, bounds, decoded_bounds: Default::default(), tiles, levels })
            })
        });
        let image = if tiles.is_some() { None } else { self.image(a, &["data_url", "data_base64", "data_uri"]) };
        let size = match (num(a, "width"), num(a, "height")) {
            (Some(w), Some(h)) => Some([w, h]),
            _ => None,
        };
        let cel = cel_id.map(|id| CelRef { id: id.clone(), anchor: point(a.get("drawing_anchor")).unwrap_or(start) });
        ImageAsset { index, anchor_start: start, anchor_end: end, anchor_length, anchor_angle, display_size, size, image, smooth, tiles, cel }
    }

    fn movieclip(&mut self, m: &Value) -> Result<Option<Arc<Movieclip>>, Error> {
        let Some(doc) = m.get("document").filter(|v| v.is_object()) else { return Ok(None) };
        let document = Arc::new(self.nested_document(doc, "movieclip")?);
        // Attached meshes: one per local frame. An invalid one leaves the clip without meshes.
        let meshes = m.get("spatialMeshes").and_then(Value::elements).and_then(|meshes| {
            let parsed: Option<Vec<Arc<crate::spatial::ClipMesh>>> = meshes.iter().map(|mesh| crate::spatial::ClipMesh::parse(&mesh).map(Arc::new)).collect();
            if parsed.is_none() {
                self.notes.push("a movieclip's 3D meshes are not valid indexed meshes".to_string());
            }
            parsed.filter(|meshes| !meshes.is_empty()).map(Arc::from)
        });
        let drawing_sets: Vec<Vec<f64>> = m
            .get("drawingSets")
            .and_then(Value::as_arr)
            .into_iter()
            .flatten()
            .map(|set| set.get("views").and_then(Value::as_arr).into_iter().flatten().map(|view| num(view, "frame").unwrap_or(f64::NAN)).collect())
            .collect();
        // `validateDrawingSets` refuses rotation without 3 × steps views per set; it is left out here.
        let drawing_rotation = m.get("drawingRotation").filter(|r| r.is_object()).and_then(|r| {
            let rotation = DrawingRotation { steps: num(r, "steps")? as u32, tilt_threshold: num(r, "tiltThreshold")? };
            let fits = rotation.steps >= 2 && !drawing_sets.is_empty() && drawing_sets.iter().all(|views| views.len() == rotation.steps as usize * 3);
            if !fits {
                self.notes.push("a movieclip's rotating drawings do not have three views per direction".to_string());
            }
            fits.then_some(rotation)
        });
        Ok(Some(Arc::new(Movieclip {
            duration: num(m, "duration").unwrap_or(1.0),
            source_start: num(m, "sourceStart").unwrap_or(0.0),
            pivot: point(m.get("pivot")).unwrap_or([0.0, 0.0]),
            meshes,
            drawing_sets,
            drawing_rotation,
            prepared: Arc::new(crate::eval::Prepared::new(document.clone())),
            document,
            cache: Default::default(),
        })))
    }

    fn object(&mut self, o: &Value) -> Option<Object> {
        self.object_reusing_ik(o, None)
    }

    fn object_reusing_ik(&mut self, o: &Value, previous: Option<(&Value, &Object)>) -> Option<Object> {
        let uid = int(o, "unique_id")? as u32;
        let figure = int(o, "figure_type_id")? as u32;
        if let Some(object) = previous.and_then(|(raw, typed)| {
            let current = o.as_obj()?;
            // The bound precedes iteration; sharing a Shape also proves exact
            // field presence/order. Unknown fields participate in the guard.
            if current.len() > POSE_FIELD_REUSE_LIMIT || typed.uid != uid || typed.figure != figure {
                return None;
            }
            let old = raw.as_obj()?;
            if !Arc::ptr_eq(current.shape(), old.shape()) { return None; }
            // Rich conversion and overlay resolution keep their existing owner.
            if ["_stykStyle", "_sticknodesSprite", "_sticknodesShapes", "_stykMovieclip",
                "_stykSpatial", "_stykAnimationOrigin", "color_transition"].iter().any(|key| current.contains(key))
                || typed.style.is_some() || typed.sticknodes_sprite.is_some() || typed.figure_override.is_some()
            { return None; }
            let mut changed = [false; 4];
            for ((key, value), old) in current.iter().zip(old.values()) {
                match &**key {
                    "angles" => changed[0] |= !value.same_node(old),
                    "root_x" => changed[1] |= !value.same_node(old),
                    "root_y" => changed[2] |= !value.same_node(old),
                    "scale" => changed[3] |= !value.same_node(old),
                    _ if value.same_node(old) => {},
                    _ => return None,
                }
            }
            match o.get("_stykVfx").filter(|value| value.truthy()) {
                None if typed.vfx.is_none() => {},
                Some(value) if value.as_obj().is_some_and(|owner| owner.len() <= POSE_FIELD_REUSE_LIMIT)
                    && typed.vfx.as_ref().is_some_and(|stacks| warning_free_vfx(value, stacks)) => {},
                _ => return None,
            }
            match o.get("_vfxConnectedEffects") {
                None if typed.vfx_connected.is_none() => {},
                Some(value) if typed.vfx_connected.as_ref().is_some_and(|stack| warning_free_stack(value, stack.len())) => {},
                _ => return None,
            }
            let mut object = typed.clone();
            if changed[0] { object.angles = self.numbers(o.get("angles")).unwrap_or_else(|| Arc::from(Vec::new())); }
            if changed[1] { object.root[0] = num(o, "root_x").unwrap_or(0.0); }
            if changed[2] { object.root[1] = num(o, "root_y").unwrap_or(0.0); }
            if changed[3] { object.scale = num(o, "scale").unwrap_or(1.0); }
            // The predecessor is Loader's complete edit-frame output. Restore
            // constructor metadata before the unchanged wrapper assigns it.
            object.clip_time = None;
            object.figure_override = None;
            Some(object)
        }) { return Some(object); }
        let lengths = if truthy(o.get("len_flag")) { self.numbers(o.get("lengths")) } else { None };
        let bends = if truthy(o.get("bend_flag")) { self.numbers(o.get("bends")) } else { None };
        let join = o.get("join").filter(|j| j.is_object()).and_then(|j| {
            Some(Join { slot: int(j, "target_object_slot")? as u32, handle: int(j, "target_handle_id").unwrap_or(0) as u32 })
        });
        // `validateSticknodesObject` refuses a sprite without a finite ratio and pivot; it is left out here.
        let sticknodes_sprite = o.get("_sticknodesSprite").filter(|s| s.is_object()).and_then(|s| {
            let sprite = crate::sticknodes::Sprite { ratio: num(s, "ratio")?, pivot: [num(s, "pivotX")?, num(s, "pivotY")?] };
            if !sprite.ratio.is_finite() || !sprite.pivot.iter().all(|p| p.is_finite()) {
                return None;
            }
            Some(Arc::new(sprite))
        });
        if o.get("_sticknodesSprite").is_some() && sticknodes_sprite.is_none() {
            self.notes.push(format!("object {uid}: a Stick Nodes sprite without a finite ratio and pivot is drawn unstretched"));
        }
        let movieclip = o.get("_stykMovieclip").filter(|v| v.is_object()).map(playback);
        Some(Object {
            uid,
            figure,
            root: [num(o, "root_x").unwrap_or(0.0), num(o, "root_y").unwrap_or(0.0)],
            scale: num(o, "scale").unwrap_or(1.0),
            color: num(o, "color_override_raw").unwrap_or(0.0) as i64 as u32,
            transparency: num(o, "field28").or_else(|| num(o, "transparency")).unwrap_or(0.0),
            image_text_flags: truthy(o.get("image_text_flags")),
            angles: self.numbers(o.get("angles")).unwrap_or_else(|| Arc::from(Vec::new())),
            lengths,
            bends,
            join,
            movieclip,
            clip_time: None,
            z_index: num(o, "_stykZIndex").unwrap_or(0.0),
            style: crate::style::parse(o.get("_stykStyle"), o.get("_styk").and_then(|s| s.get("colorMode"))),
            sticknodes_shapes: match o.get("_sticknodesShapes") {
                Some(Value::Obj(map)) => Some(Arc::new(
                    map.iter().filter_map(|(k, v)| Some((k.parse::<u32>().ok()?, crate::sticknodes::parse(v)?))).collect(),
                )),
                _ => None,
            },
            figure_override: None,
            ik: previous.filter(|(raw, typed)| typed.uid == uid && typed.figure == figure
                && o.get("_stykIK").filter(|table| table.is_object())
                    .is_some_and(|table| raw.get("_stykIK").is_some_and(|old| table.same_node(old))))
                .and_then(|(_, typed)| typed.ik.clone())
                .or_else(|| crate::ik::parse::table(o.get("_stykIK")).map(Arc::new)),
            vfx: previous.and_then(|(raw, typed)| {
                if typed.uid != uid || typed.figure != figure { return None; }
                let value = o.get("_stykVfx").filter(|value| value.truthy())?;
                if !raw.get("_stykVfx").is_some_and(|old| value.same_node(old)) { return None; }
                let stacks = typed.vfx.as_ref()?;
                if !warning_free_vfx(value, stacks) { return None; }
                Some(stacks.clone())
            }).or_else(|| crate::vfx::parse::stacks(o.get("_stykVfx"), &mut self.notes)),
            vfx_scope: o.get("_stykVfxScope").and_then(Value::as_f64) == Some(1.0),
            vfx_connected: o.get("_vfxConnectedEffects").map(|v| Arc::from(crate::vfx::parse::stack(v, &mut self.notes))),
            spatial: o.get("_stykSpatial").and_then(crate::spatial::parse_pose).map(Arc::new),
            sticknodes_sprite,
            origin: o.get("_stykAnimationOrigin").and_then(crate::origin::parse_pose).map(Arc::new),
            color_transition: o.get("color_transition").filter(|c| c.is_object()).map(|c| {
                Arc::new(ColorTransition { from: js_uint32(num(c, "from")), to: js_uint32(num(c, "to")), t: num(c, "t").unwrap_or(f64::NAN) })
            }),
        })
    }

    pub fn keyframe(&mut self, k: &Value) -> Result<Keyframe, Error> {
        let objects: Vec<Arc<Object>> = k
            .get("objects")
            .and_then(Value::as_arr)
            .into_iter()
            .flatten()
            .filter_map(|o| self.object(o))
            .map(Arc::new)
            .collect();
        let vfx = crate::vfx::parse::stacks(k.get("_stykVfx"), &mut self.notes);
        Ok(Self::keyframe_of(k, objects, vfx))
    }

    /// The pose the editor is showing, which it evaluated itself: a keyframe-shaped
    /// record whose `objects` hold either a pose or `null`, meaning "the object in
    /// this slot is the one `previous` had". Only changed poses cross the boundary
    /// while a gesture runs. Figures come from `doc`.
    pub fn edit_frame(&mut self, value: &Value, previous: Option<&crate::eval::Frame>, doc: &Document) -> Result<crate::eval::Frame, Error> {
        self.edit_frame_with_ik(value, previous, None, doc)
    }

    /// Converts an edit frame with the previous coherent raw/typed record from
    /// the same document/Loader lineage. Unchanged `_stykIK` object nodes and
    /// warning-free `_stykVfx` object nodes in the same UID/figure slot reuse
    /// their parsed immutable tables. Ambiguous or warning-producing effects
    /// retain the original parse and notes; other pose fields and frame metadata
    /// follow the original conversion.
    /// Plain records with at most 64 fields may retain the parsed Object when
    /// only angle/root/scale nodes differ within the same Shape. Changed pose
    /// fields use the original conversion; clip/style metadata is assigned by
    /// the same wrapper. Larger, rich or diagnostic-producing records reparse.
    /// `previous_record` must be the complete record represented by `previous`,
    /// successfully converted by this Loader in `doc`'s current lineage.
    /// `value` may use the same null delta convention as [`Self::edit_frame`].
    pub fn edit_frame_reusing_ik(&mut self, value: &Value, previous_record: &Value, previous: &crate::eval::Frame, doc: &Document) -> Result<crate::eval::Frame, Error> {
        self.edit_frame_with_ik(value, Some(previous), Some(previous_record), doc)
    }

    fn edit_frame_with_ik(&mut self, value: &Value, previous: Option<&crate::eval::Frame>, previous_record: Option<&Value>, doc: &Document) -> Result<crate::eval::Frame, Error> {
        let items = value.get("objects").and_then(Value::as_arr).unwrap_or(&[]);
        let previous_items = previous_record.and_then(|record| record.get("objects")).and_then(Value::as_arr)
            .filter(|old| old.len() == items.len() && previous.is_some_and(|frame| frame.objects.len() == items.len()));
        let mut objects = Vec::with_capacity(items.len());
        for (slot, item) in items.iter().enumerate() {
            if item.is_null() {
                let kept = previous.and_then(|frame| frame.objects.get(slot)).ok_or_else(|| Error::Format(format!("the edit frame keeps object {slot}, which the previous frame does not have")))?;
                objects.push(kept.clone());
                continue;
            }
            let prior = previous_items.and_then(|old| old.get(slot)).zip(previous.and_then(|frame| frame.objects.get(slot)))
                .map(|(raw, typed)| (raw, typed.as_ref()));
            let mut object = self.object_reusing_ik(item, prior).ok_or_else(|| Error::Format(format!("object {slot} of the edit frame has no identity or figure")))?;
            // The editor has already chosen each clip's local time.
            object.clip_time = match item.get("_movieclipSample") {
                Some(Value::Num(time)) => Some(*time),
                Some(_) => None,
                None => Some(object.movieclip.as_ref().map_or(0.0, |playback| playback.offset)),
            };
            let mut object = Arc::new(object);
            if let Some(base) = doc.figure(object.figure) {
                self.styled_object(base, &mut object);
            }
            objects.push(object);
        }
        // The scene stack the editor composed with its clips (`vfxStack(frame)`)
        // replaces the frame's own when present.
        let vfx = match value.get("_vfxTimelineScene") {
            Some(scene) => {
                let stack = crate::vfx::parse::stack(scene, &mut self.notes);
                Some(Arc::new(crate::vfx::Stacks { entries: vec![(crate::vfx::StackKey::Figure, Arc::from(stack))] }))
            }
            None => crate::vfx::parse::stacks(value.get("_stykVfx"), &mut self.notes),
        };
        let key = Self::keyframe_of(value, objects, vfx);
        let count = key.objects.len();
        Ok(crate::eval::Frame {
            tick: num(value, "tick").unwrap_or(0.0),
            retained_vfx_tick: num(value, "_vfxTimelineTick"),
            objects: key.objects,
            draw_order: key.draw_order,
            camera: key.camera,
            background: key.background,
            background_b: key.background_b,
            background_mix: key.background_mix,
            origins: vec![None; count],
            continuations: key.continuations,
            background_color: key.background_color,
            pose_vfx: key.vfx,
            vfx: None,
            export_vfx: Vec::new(),
            parallax: None,
        })
    }

    /// A keyframe around already converted objects.
    fn keyframe_of(k: &Value, objects: Vec<Arc<Object>>, vfx: Option<Arc<crate::vfx::Stacks>>) -> Keyframe {
        let draw_order = k
            .get("object_draw_order")
            .and_then(Value::numbers)
            .map(|v| v.into_iter().map(|x| x as u32).collect::<Vec<_>>())
            .filter(|v| v.len() == objects.len())
            .unwrap_or_else(|| (0..objects.len() as u32).collect());
        let camera = k.get("camera").filter(|c| c.is_object()).map(|c| Camera {
            x: num(c, "x").unwrap_or(0.0),
            y: num(c, "y").unwrap_or(0.0),
            scale: num(c, "scale").unwrap_or(1.0),
            angle: num(c, "angle_rad").unwrap_or(0.0),
            is_default: truthy(c.get("is_default")),
            motion_offset: c.get("_parallaxMotionOffset").filter(|p| p.is_object()).map(|p| [num(p, "x").unwrap_or(0.0), num(p, "y").unwrap_or(0.0)]),
        });
        let styk = k.get("_styk");
        let mut frame = Keyframe {
            duration: int(k, "duration_raw").unwrap_or(1).max(0) as u32,
            retained_vfx_tick: num(k, "_vfxTimelineTick"),
            objects,
            draw_order,
            camera,
            background: int(k, "background_id").unwrap_or(0) as u32,
            background_b: int(k, "background_id_b").unwrap_or(0) as u32,
            background_mix: num(k, "background_mix").unwrap_or(0.0),
            easing: styk.and_then(|s| easing(s.get("easing"))),
            frame_id: styk.and_then(|s| s.get("frameId")).and_then(Value::as_str).map(Arc::from),
            slot_of: HashMap::new(),
            background_color: num(k, "_stykBackgroundColor").map(|v| v as i64 as u32),
            continuations: styk
                .and_then(|s| s.get("movieclipContinuations"))
                .and_then(Value::as_arr)
                .into_iter()
                .flatten()
                .filter_map(|c| Some((int(c, "uid")? as u32, playback(c.get("playback")?))))
                .collect(),
            vfx,
        };
        frame.reindex();
        frame
    }

    fn background(&mut self, b: &Value) -> Background {
        let id = int(b, "background_id").unwrap_or(0) as u32;
        if let Some(p) = paint(b.get("paint")) {
            return Background { id, kind: BackgroundKind::Paint(p) };
        }
        let kind = int(b, "kind").unwrap_or(0);
        let kind = match kind {
            3 | 4 => {
                let (a, c) = (num(b, "color_a").unwrap_or(0.0) as u32, num(b, "color_b").unwrap_or(0.0) as u32);
                let g = (num(b, "x1").unwrap_or(0.0), num(b, "y1").unwrap_or(0.0), num(b, "x2").unwrap_or(1.0), num(b, "y2").unwrap_or(1.0));
                if kind == 3 {
                    BackgroundKind::Linear { a, b: c, x1: g.0, y1: g.1, x2: g.2, y2: g.3 }
                } else {
                    BackgroundKind::Radial { a, b: c, x1: g.0, y1: g.1, x2: g.2, y2: g.3 }
                }
            }
            2 => BackgroundKind::Solid { argb: num(b, "color").unwrap_or(0.0) as u32 },
            _ if b.get("color").is_some() => BackgroundKind::Solid { argb: num(b, "color").unwrap_or(0.0) as u32 },
            _ => BackgroundKind::Image { image: self.image(b, &["data_url", "data_base64", "data_uri"]) },
        };
        Background { id, kind }
    }

    fn sheet(&mut self, s: &Value) -> LayerSheet {
        let mut tracks = HashMap::new();
        if let Some(Value::Obj(map)) = s.get("tracks") {
            for (id, t) in map.iter() {
                let keys = t
                    .get("keys")
                    .and_then(Value::as_arr)
                    .into_iter()
                    .flatten()
                    .map(|k| SheetKey {
                        tick: int(k, "tick").unwrap_or(0) as u32,
                        easing: if k.get("interpolation").is_some() { easing(Some(k)) } else { None },
                        hidden: truthy(k.get("hidden")),
                        patch_only: truthy(k.get("patchOnly")),
                        value: match num(k, "sourceTick") {
                            Some(t) => SheetValue::SourceTick(t),
                            None => SheetValue::Frame(
                                k.get("value").and_then(|v| v.get("frameId")).and_then(Value::as_str).map(Arc::from),
                            ),
                        },
                        movieclip_patches: k
                            .get("movieclipPatches")
                            .and_then(Value::as_arr)
                            .into_iter()
                            .flatten()
                            .filter_map(|p| {
                                Some(MovieclipPatch {
                                    uid: int(p, "uid")? as u32,
                                    frame_id: Arc::from(p.get("frameId")?.as_str()?),
                                    replacement_uid: int(p, "replacementUid").map(|v| v as u32),
                                    order_index: int(p, "orderIndex").map(|v| v as u32),
                                })
                            })
                            .collect(),
                    })
                    .collect();
                tracks.insert(id.to_string(), Arc::new(SheetTrack { end: int(t, "end").unwrap_or(0) as u32, keys }));
            }
        }
        LayerSheet { duration: int(s, "duration").unwrap_or(1).max(1) as u32, tracks }
    }
}

fn layers(l: &Value) -> Layers {
    let order: Vec<String> = l.get("order").and_then(Value::as_arr).into_iter().flatten().filter_map(|v| v.as_str().map(str::to_string)).collect();
    let mut assignments = HashMap::new();
    if let Some(Value::Obj(map)) = l.get("assignments") {
        for (uid, layer) in map.iter() {
            if let (Ok(uid), Some(layer)) = (uid.parse::<u32>(), layer.as_str()) {
                assignments.insert(uid, layer.to_string());
            }
        }
    }
    let hidden = match l.get("byId") {
        Some(Value::Obj(map)) => map
            .iter()
            .filter(|(_, v)| v.get("visible") == Some(&Value::Bool(false)))
            .map(|(k, _)| k.to_string())
            .collect(),
        _ => vec![],
    };
    let fixed_visible = |id: &str| l.get("fixed").and_then(|f| f.get(id)).and_then(|v| v.get("visible")) != Some(&Value::Bool(false));
    // `parallaxResolver`: the layers of `order` whose parallax is on. The editor refuses a
    // file whose parallax is malformed (`validateParallax`); such a layer is left still here.
    let parallax = order_parallax(l, &order);
    Layers {
        order,
        assignments,
        default_layer: l.get("defaultLayerId").and_then(Value::as_str).unwrap_or("layer-1").to_string(),
        hidden,
        camera_visible: fixed_visible("camera"),
        scene_visible: fixed_visible("scene"),
        parallax,
    }
}

fn order_parallax(l: &Value, order: &[String]) -> Vec<(String, LayerParallax)> {
    order
        .iter()
        .filter_map(|id| {
            let p = l.get("byId")?.get(id)?.get("parallax")?;
            if !truthy(p.get("enabled")) {
                return None;
            }
            let reference = p.get("reference")?;
            Some((id.clone(), LayerParallax { x: num(p, "x")?, y: num(p, "y")?, reference: [num(reference, "x")?, num(reference, "y")?] }))
        })
        .collect()
}

/// A camera motion clip of `_styk.cameraMotion.clips`.
pub fn camera_motion_clip(c: &Value) -> Option<CameraMotionClip> {
    let params = match c.get("params") {
        Some(Value::Obj(map)) => map.iter().filter_map(|(k, v)| Some((k.to_string(), v.as_f64()?))).collect(),
        _ => HashMap::new(),
    };
    Some(CameraMotionClip {
        kind: c.get("type")?.as_str()?.to_string(),
        start: num(c, "start")?,
        duration: num(c, "duration")?,
        enabled: c.get("enabled") != Some(&Value::Bool(false)),
        muted: c
            .get("mutedRanges")
            .and_then(Value::as_arr)
            .into_iter()
            .flatten()
            .filter_map(|r| Some((num(r, "start")?, num(r, "end")?)))
            .collect(),
        params,
        targets: c
            .get("targets")
            .and_then(Value::as_arr)
            .into_iter()
            .flatten()
            .filter_map(|t| Some((int(t, "uid")? as u32, num(t, "weight")?)))
            .collect(),
    })
}

fn text_asset(a: &Value) -> Option<TextAsset> {
    let bounds = a.get("bounds")?;
    let (left, bottom) = (num(bounds, "left")?, num(bounds, "bottom")?);
    let width = num(bounds, "width")?;
    let height = num(bounds, "height").unwrap_or(0.0);
    let glyphs: Vec<Arc<Glyph>> = a
        .get("glyphs")?
        .as_arr()?
        .iter()
        .map(|g| {
            let source = g.get("svg_path").and_then(Value::as_str).unwrap_or("");
            // `maskFor`: finite stored bounds of positive size, and a path to fill.
            let bounds = g.get("bounds").and_then(|b| Some([num(b, "left")?, num(b, "top")?, num(b, "right")?, num(b, "bottom")?]));
            let bounds = bounds.filter(|b| !source.is_empty() && b.iter().all(|v| v.is_finite()) && b[2] > b[0] && b[3] > b[1]);
            Arc::new(Glyph { path: parse_svg_path(source), bounds })
        })
        .collect();
    let placements = a
        .get("placements")?
        .as_arr()?
        .iter()
        .filter(|p| p.get("visible") != Some(&Value::Bool(false)))
        .filter_map(|p| {
            let g = int(p, "glyph_index")? as u32;
            let (x, y) = (num(p, "x")?, num(p, "y")?);
            ((g as usize) < glyphs.len()).then(|| (g, (x - left) as f32, (y - bottom) as f32))
        })
        .collect();
    let index = ["asset_index", "table_index"].iter().find_map(|k| num(a, k)).unwrap_or(0.0) as u32;
    Some(TextAsset { index, glyphs, placements, width, height })
}

/// `documentHasVfx` over a document tree the engine does not convert.
fn raw_has_vfx(d: &Value) -> bool {
    let styk = d.get("_styk");
    if styk.and_then(|s| s.path(&["vfxClips", "clips"])).and_then(Value::array_len).is_some_and(|n| n > 0) {
        return true;
    }
    let channels = [styk.and_then(|s| s.get("animation")), styk.and_then(|s| s.path(&["layerSheet", "legacyAnimation"]))];
    if channels.into_iter().flatten().filter_map(|a| a.get("channels")?.as_arr()).flatten().any(|c| c.get("property").and_then(Value::as_str).is_some_and(crate::vfx::parse::is_vfx_property)) {
        return true;
    }
    let has = |frame: &Value| frame.get("_stykVfx").is_some_and(Value::truthy) || frame.get("objects").and_then(Value::as_arr).is_some_and(|o| o.iter().any(|o| o.get("_stykVfx").is_some_and(Value::truthy)));
    if d.get("keyframes").and_then(Value::as_arr).is_some_and(|k| k.iter().any(has)) {
        return true;
    }
    if let Some(Value::Obj(sources)) = styk.and_then(|s| s.get("frameSources"))
        && sources.values().iter().any(has)
    {
        return true;
    }
    styk.and_then(|s| s.path(&["movieclipSource", "document"])).is_some_and(raw_has_vfx)
        || d.get("figure_types").and_then(Value::as_arr).is_some_and(|f| f.iter().any(|f| f.path(&["_styk", "movieclip", "document"]).is_some_and(raw_has_vfx)))
}

impl Loader {
    /// Gives an object the figure it draws with: its style overlay resolved, then its
    /// Stick Nodes sprite's stretch and pivot applied to the figure's pictures, sharing
    /// identical results. Returns whether the object changed.
    fn styled_object(&mut self, base: &Arc<Figure>, object: &mut Arc<Object>) -> bool {
        let (style, sprite) = (object.style.clone(), object.sticknodes_sprite.clone());
        if style.is_none() && sprite.is_none() {
            return false;
        }
        if object.figure_override.as_ref().is_some_and(|resolved| resolved.base.as_ref().is_some_and(|b| Arc::ptr_eq(b, base))) {
            return false;
        }
        let mut key = style.as_ref().map_or_else(String::new, |style| style.key.clone());
        if let Some(sprite) = &sprite {
            key.push_str(&format!("\u{1}sprite {:x} {:x} {:x}", sprite.ratio.to_bits(), sprite.pivot[0].to_bits(), sprite.pivot[1].to_bits()));
        }
        let resolved = self
            .styled
            .entry((Arc::as_ptr(base) as usize, key))
            .or_insert_with(|| {
                let mut figure = match &style {
                    Some(style) => crate::style::resolve(base, style),
                    None => (**base).clone(),
                };
                if let Some(sprite) = &sprite {
                    crate::sticknodes::sprite_figure(&mut figure, sprite);
                }
                figure.base = Some(base.clone());
                (base.clone(), Arc::new(figure))
            })
            .1
            .clone();
        Arc::make_mut(object).figure_override = Some(resolved);
        true
    }

    /// Resolves the style overlays of every frame of `doc`. A frame resolved against
    /// figures that have not changed since is kept as it is.
    fn resolve_styles(&mut self, doc: &mut Document) {
        let figures: HashMap<u32, Arc<Figure>> = doc.figures.iter().map(|f| (f.id, f.clone())).collect();
        let mut fix = |frame: &mut Arc<Keyframe>| {
            let stale = |object: &Arc<Object>| {
                if object.style.is_none() && object.sticknodes_sprite.is_none() {
                    return false;
                }
                match (&object.figure_override, figures.get(&object.figure)) {
                    (_, None) => false,
                    (Some(resolved), Some(base)) => !resolved.base.as_ref().is_some_and(|b| Arc::ptr_eq(b, base)),
                    (None, Some(_)) => true,
                }
            };
            if !frame.objects.iter().any(stale) {
                return;
            }
            let frame = Arc::make_mut(frame);
            for object in frame.objects.iter_mut() {
                if let Some(base) = figures.get(&object.figure) {
                    self.styled_object(base, object);
                }
            }
        };
        for k in doc.keyframes.iter_mut() {
            fix(k);
        }
        for k in doc.frame_sources.values_mut() {
            fix(k);
        }
    }
}

/// `Number(value) >>> 0`: JavaScript's ToUint32 of a number (zero for none, NaN or infinity).
fn js_uint32(value: Option<f64>) -> u32 {
    match value {
        Some(v) if v.is_finite() => v.trunc().rem_euclid(4294967296.0) as u32,
        _ => 0,
    }
}

/// `_stykMovieclip` playback settings (`playbackSettings`).
pub fn playback(p: &Value) -> Arc<MovieclipPlayback> {
    Arc::new(MovieclipPlayback {
        start: num(p, "start").unwrap_or(0.0),
        end: num(p, "end"),
        offset: num(p, "offset").unwrap_or(0.0),
        speed: num(p, "speed").unwrap_or(1.0),
        mode: match p.get("mode").and_then(Value::as_str) {
            Some("once") => MovieclipMode::Once,
            Some("hold") => MovieclipMode::Hold,
            Some("single") => MovieclipMode::Single,
            _ => MovieclipMode::Loop,
        },
        presence: p.get("clock").and_then(Value::as_str) == Some("presence"),
        restarts: p
            .get("restarts")
            .and_then(Value::as_arr)
            .into_iter()
            .flatten()
            .filter_map(|k| Some((num(k, "tick")?, num(k, "offset")?)))
            .collect(),
    })
}

/// Rounds half to even (Python's `round`, which the Pivot codec uses for frame rates).
fn round_half_even(v: f64) -> f64 {
    let floor = v.floor();
    let fraction = v - floor;
    if fraction < 0.5 {
        floor
    } else if fraction > 0.5 {
        floor + 1.0
    } else {
        floor + (floor % 2.0).abs()
    }
}
