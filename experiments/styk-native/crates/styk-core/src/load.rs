//! `.styk` JSON (with lazily resolved container markers) → typed [`Document`].

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{Map, Value};

use crate::container::Resolver;
use crate::doc::*;
use crate::text::parse_svg_path;
use crate::Error;

pub struct Loader<'a> {
    pub r: Resolver<'a>,
    /// One image table shared by the root document and every nested movieclip.
    pub images: Vec<ImageData>,
    pub unsupported: Vec<String>,
}

fn num(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(Value::as_f64)
}
fn int(v: &Value, key: &str) -> Option<i64> {
    v.get(key).and_then(|x| x.as_i64().or_else(|| x.as_f64().map(|f| f as i64)))
}
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}
fn rgb(v: Option<&Value>) -> Option<[u8; 3]> {
    let a = v?.as_array()?;
    if a.len() != 3 {
        return None;
    }
    Some([a[0].as_u64()? as u8, a[1].as_u64()? as u8, a[2].as_u64()? as u8])
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
    if let Some(b) = v.get("bezier").and_then(Value::as_array)
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
        .as_array()?
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

impl<'a> Loader<'a> {
    pub fn new(r: Resolver<'a>) -> Self {
        Loader { r, images: Vec::new(), unsupported: Vec::new() }
    }

    fn note(&mut self, feature: &str) {
        if !self.unsupported.iter().any(|f| f == feature) {
            self.unsupported.push(feature.to_string());
        }
    }

    fn image(&mut self, v: &Value, keys: &[&str]) -> Option<u32> {
        for key in keys {
            if let Some(field) = v.get(*key)
                && let Some(bytes) = self.r.bytes(field)
                && !bytes.is_empty()
            {
                self.images.push(ImageData { bytes, color_key: None });
                return Some(self.images.len() as u32 - 1);
            }
        }
        None
    }

    fn numbers(&self, v: Option<&Value>) -> Option<Arc<[f64]>> {
        Some(self.r.numbers(v?)?.into())
    }

    pub fn document(&mut self, d: &Value, name: &str) -> Result<Document, Error> {
        let version = int(d, "version").unwrap_or(5) as u32;
        if !(2..=5).contains(&version) {
            return Err(Error::Format(format!("Expected a decoded Pivot 2-5 scene, found version {version}")));
        }
        let canvas = [int(d, "canvas_width").unwrap_or(640) as u32, int(d, "canvas_height").unwrap_or(480) as u32];
        let mut fps = num(d, "fps").unwrap_or(24.0);
        if version < 5
            && let Some(delay) = num(d, "frame_delay_ms").filter(|&v| v > 0.0)
        {
            fps = crate::piv::round_half_even(1000.0 / delay);
        }
        let styk = d.get("_styk").cloned().unwrap_or(Value::Null);
        let mut figures = Vec::new();
        for f in d.get("figure_types").and_then(Value::as_array).into_iter().flatten() {
            figures.push(Arc::new(self.figure(f, version)?));
        }
        let mut keyframes = Vec::new();
        for k in d.get("keyframes").and_then(Value::as_array).into_iter().flatten() {
            keyframes.push(Arc::new(self.keyframe(k)?));
        }
        if keyframes.is_empty() {
            return Err(Error::Format("The scene has no keyframes".into()));
        }
        let mut backgrounds = Vec::new();
        for b in d.get("backgrounds").and_then(Value::as_array).into_iter().flatten() {
            backgrounds.push(self.background(b));
        }
        let mut frame_sources = HashMap::new();
        if let Some(Value::Object(sources)) = styk.get("frameSources") {
            for (id, frame) in sources {
                frame_sources.insert(Arc::from(id.as_str()), Arc::new(self.keyframe(frame)?));
            }
        }
        let layers = styk.get("layers").filter(|v| v.is_object()).map(|l| Arc::new(layers(l)));
        let sheet = styk.get("layerSheet").filter(|v| v.is_object()).map(|s| Arc::new(self.sheet(s)));
        let camera_motion = styk
            .get("cameraMotion")
            .and_then(|m| m.get("clips"))
            .and_then(Value::as_array)
            .map(|clips| clips.iter().filter_map(camera_motion_clip).collect())
            .unwrap_or_default();
        if styk.get("vfxClips").and_then(|v| v.get("clips")).and_then(Value::as_array).is_some_and(|c| !c.is_empty()) {
            self.note("visual effects (blur, glow…)");
        }
        if styk.get("animation").and_then(|a| a.get("channels")).and_then(Value::as_array).is_some_and(|c| !c.is_empty()) {
            self.note("property channels");
        }
        let auto_easing = match d.get("auto_easing") {
            Some(v) => truthy(Some(v)),
            None => version >= 5,
        };
        let mut doc = Document {
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
            unsupported: Vec::new(),
            notes: Vec::new(),
            figure_index: HashMap::new(),
        };
        doc.reindex_figures();
        resolve_styles(&mut doc);
        Ok(doc)
    }

    fn figure(&mut self, f: &Value, version: u32) -> Result<Figure, Error> {
        let id = int(f, "figure_type_id").ok_or_else(|| Error::Format("Figure without an id".into()))? as u32;
        let styk = f.get("_styk").cloned().unwrap_or(Value::Null);
        let mut unsupported = Vec::new();
        let segs = f.get("segments").and_then(Value::as_array).cloned().unwrap_or_default();
        let mut segments = Vec::with_capacity(segs.len());
        for (i, s) in segs.iter().enumerate() {
            segments.push(self.segment(s, i, &mut unsupported));
        }
        let mut polyfills = Vec::new();
        for p in f.get("polyfills").and_then(Value::as_array).into_iter().flatten() {
            if p.get("_stykSurface").is_some() && !unsupported.contains(&"3D surfaces") {
                unsupported.push("3D surfaces");
            }
            let joints = p
                .get("segment_ids")
                .and_then(|v| self.r.numbers(v))
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
            });
        }
        let is_drawing = styk.get("drawing").is_some();
        let pixels_per_unit = styk.get("drawing").and_then(|d| num(d, "pixelsPerUnit")).unwrap_or(1.0);
        let mut images = Vec::new();
        for a in f.get("image_assets").and_then(Value::as_array).into_iter().flatten() {
            images.push(self.image_asset(a, is_drawing, pixels_per_unit));
        }
        let mut texts = Vec::new();
        for a in f.get("text_assets").and_then(Value::as_array).into_iter().flatten() {
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
        if styk.get("spatialMesh").is_some() {
            unsupported.push("3D meshes");
        }
        if styk.get("animationOrigin").is_some() {
            unsupported.push("animation origins");
        }
        let _ = version;
        let plan = plan_figure(&segments, &polyfills);
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
            plan,
            unsupported,
        })
    }

    fn segment(&mut self, s: &Value, i: usize, _unsupported: &mut Vec<&'static str>) -> Segment {
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
        let extra = s.get("extra").and_then(Value::as_array);
        let extra_at = |k: usize| extra.and_then(|e| e.get(k)).and_then(Value::as_f64);
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
        }
    }

    fn image_asset(&mut self, a: &Value, smooth: bool, pixels_per_unit: f64) -> ImageAsset {
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
        let tiles = a.get("styk_tiles").and_then(|t| self.r.bytes(t)).and_then(|bytes| {
            let anchor = point(a.get("drawing_anchor")).unwrap_or(start);
            crate::drawing::decode_tiles(&bytes, &mut self.images).map(|tiles| Arc::new(DrawingTiles { anchor, pixels_per_unit, tiles }))
        });
        let image = if tiles.is_some() { None } else { self.image(a, &["data_url", "data_base64", "data_uri"]) };
        ImageAsset { index, anchor_start: start, anchor_end: end, anchor_length, anchor_angle, display_size, image, smooth, tiles }
    }

    fn movieclip(&mut self, m: &Value) -> Result<Option<Arc<Movieclip>>, Error> {
        let Some(doc) = m.get("document").filter(|v| v.is_object()) else { return Ok(None) };
        let document = Arc::new(self.document(doc, "movieclip")?);
        Ok(Some(Arc::new(Movieclip {
            duration: num(m, "duration").unwrap_or(1.0),
            source_start: num(m, "sourceStart").unwrap_or(0.0),
            pivot: point(m.get("pivot")).unwrap_or([0.0, 0.0]),
            prepared: Arc::new(crate::eval::Prepared::new(document.clone())),
            document,
            cache: Default::default(),
        })))
    }

    fn object(&mut self, o: &Value) -> Option<Object> {
        let uid = int(o, "unique_id")? as u32;
        let figure = int(o, "figure_type_id")? as u32;
        let lengths = if truthy(o.get("len_flag")) { self.numbers(o.get("lengths")) } else { None };
        let bends = if truthy(o.get("bend_flag")) { self.numbers(o.get("bends")) } else { None };
        let join = o.get("join").filter(|j| j.is_object()).and_then(|j| {
            Some(Join { slot: int(j, "target_object_slot")? as u32, handle: int(j, "target_handle_id").unwrap_or(0) as u32 })
        });
        for (key, feature) in [
            ("_stykIK", "inverse kinematics"),
            ("_stykSpatial", "3D poses"),
            ("_stykAnimationOrigin", "animation origins"),
            ("_sticknodesSprite", "Stick Nodes sprites"),
            ("_stykVfx", "visual effects (blur, glow…)"),
        ] {
            if o.get(key).is_some() {
                self.note(feature);
            }
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
                Some(Value::Object(map)) => Some(Arc::new(
                    map.iter().filter_map(|(k, v)| Some((k.parse::<u32>().ok()?, crate::sticknodes::parse(v)?))).collect(),
                )),
                _ => None,
            },
            figure_override: None,
        })
    }

    pub fn keyframe(&mut self, k: &Value) -> Result<Keyframe, Error> {
        let objects: Vec<Arc<Object>> = k
            .get("objects")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|o| self.object(o))
            .map(Arc::new)
            .collect();
        let draw_order = k
            .get("object_draw_order")
            .and_then(|v| self.r.numbers(v))
            .map(|v| v.into_iter().map(|x| x as u32).collect::<Vec<_>>())
            .filter(|v| v.len() == objects.len())
            .unwrap_or_else(|| (0..objects.len() as u32).collect());
        let camera = k.get("camera").filter(|c| c.is_object()).map(|c| Camera {
            x: num(c, "x").unwrap_or(0.0),
            y: num(c, "y").unwrap_or(0.0),
            scale: num(c, "scale").unwrap_or(1.0),
            angle: num(c, "angle_rad").unwrap_or(0.0),
            is_default: truthy(c.get("is_default")),
        });
        let styk = k.get("_styk");
        let mut frame = Keyframe {
            duration: int(k, "duration_raw").unwrap_or(1).max(0) as u32,
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
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|c| Some((int(c, "uid")? as u32, playback(c.get("playback")?))))
                .collect(),
        };
        frame.reindex();
        Ok(frame)
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
        if let Some(Value::Object(map)) = s.get("tracks") {
            for (id, t) in map {
                let keys = t
                    .get("keys")
                    .and_then(Value::as_array)
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
                            .and_then(Value::as_array)
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
                tracks.insert(id.clone(), Arc::new(SheetTrack { end: int(t, "end").unwrap_or(0) as u32, keys }));
            }
        }
        if s.get("legacyAnimation").is_some() {
            self.note("legacy property channels");
        }
        LayerSheet { duration: int(s, "duration").unwrap_or(1).max(1) as u32, tracks }
    }
}

fn layers(l: &Value) -> Layers {
    let order = l.get("order").and_then(Value::as_array).into_iter().flatten().filter_map(|v| v.as_str().map(str::to_string)).collect();
    let mut assignments = HashMap::new();
    if let Some(Value::Object(map)) = l.get("assignments") {
        for (uid, layer) in map {
            if let (Ok(uid), Some(layer)) = (uid.parse::<u32>(), layer.as_str()) {
                assignments.insert(uid, layer.to_string());
            }
        }
    }
    let hidden = match l.get("byId") {
        Some(Value::Object(map)) => map
            .iter()
            .filter(|(_, v)| v.get("visible") == Some(&Value::Bool(false)))
            .map(|(k, _)| k.clone())
            .collect(),
        _ => vec![],
    };
    let fixed_visible = |id: &str| l.get("fixed").and_then(|f| f.get(id)).and_then(|v| v.get("visible")) != Some(&Value::Bool(false));
    Layers {
        order,
        assignments,
        default_layer: l.get("defaultLayerId").and_then(Value::as_str).unwrap_or("layer-1").to_string(),
        hidden,
        camera_visible: fixed_visible("camera"),
        scene_visible: fixed_visible("scene"),
    }
}

fn camera_motion_clip(c: &Value) -> Option<CameraMotionClip> {
    let params = match c.get("params") {
        Some(Value::Object(map)) => map.iter().filter_map(|(k, v)| Some((k.clone(), v.as_f64()?))).collect(),
        _ => HashMap::new(),
    };
    Some(CameraMotionClip {
        kind: c.get("type")?.as_str()?.to_string(),
        start: num(c, "start")?,
        duration: num(c, "duration")?,
        enabled: c.get("enabled") != Some(&Value::Bool(false)),
        muted: c
            .get("mutedRanges")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|r| Some((num(r, "start")?, num(r, "end")?)))
            .collect(),
        params,
    })
}

fn text_asset(a: &Value) -> Option<TextAsset> {
    let bounds = a.get("bounds")?;
    let (left, bottom) = (num(bounds, "left")?, num(bounds, "bottom")?);
    let width = num(bounds, "width")?;
    let height = num(bounds, "height").unwrap_or(0.0);
    let glyphs: Vec<Arc<Glyph>> = a
        .get("glyphs")?
        .as_array()?
        .iter()
        .map(|g| Arc::new(Glyph { path: parse_svg_path(g.get("svg_path").and_then(Value::as_str).unwrap_or("")) }))
        .collect();
    let placements = a
        .get("placements")?
        .as_array()?
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

/// Reads any JSON object map field into an owned map (helper for extensions).
pub fn object_map(v: Option<&Value>) -> Map<String, Value> {
    match v {
        Some(Value::Object(m)) => m.clone(),
        _ => Map::new(),
    }
}

/// Resolves every styled object's figure once, sharing identical overlays.
fn resolve_styles(doc: &mut Document) {
    let mut cache: HashMap<(u32, String), Arc<Figure>> = HashMap::new();
    let figures: HashMap<u32, Arc<Figure>> = doc.figures.iter().map(|f| (f.id, f.clone())).collect();
    let mut fix = |frame: &mut Arc<Keyframe>| {
        if !frame.objects.iter().any(|o| o.style.is_some()) {
            return;
        }
        let frame = Arc::make_mut(frame);
        for object in frame.objects.iter_mut() {
            let Some(style) = object.style.clone() else { continue };
            let Some(base) = figures.get(&object.figure) else { continue };
            let resolved = cache
                .entry((object.figure, style.key.clone()))
                .or_insert_with(|| Arc::new(crate::style::resolve(base, &style)))
                .clone();
            Arc::make_mut(object).figure_override = Some(resolved);
        }
    };
    for k in doc.keyframes.iter_mut() {
        fix(k);
    }
    for k in doc.frame_sources.values_mut() {
        fix(k);
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
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|k| Some((num(k, "tick")?, num(k, "offset")?)))
            .collect(),
    })
}
