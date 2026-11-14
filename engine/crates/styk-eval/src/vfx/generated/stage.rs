//! Small documents for looking at and testing generated effects: stick figures on a
//! stage, posed and moved over a few keyframes, with effect clips (keys included). The
//! review command (`styk vfx-review`) and the engine's tests build their documents here.

use std::fmt::Write;

/// The stage canvas.
pub const CANVAS: [f64; 2] = [640.0, 400.0];
/// Where a figure's hip is by default.
pub const HIP: [f64; 2] = [320.0, 300.0];

const UP: f64 = -std::f64::consts::FRAC_PI_2;

/// The stick figure's ten segments: torso, head, two arms of two, two legs of two:
/// (id, parent id, length, a circle).
pub const SEGMENTS: [(u32, u32, f64, bool); 10] = [
    (1, 0, 62.0, false),
    (2, 1, 36.0, true),
    (3, 1, 34.0, false),
    (4, 3, 32.0, false),
    (5, 1, 34.0, false),
    (6, 5, 32.0, false),
    (7, 0, 44.0, false),
    (8, 7, 44.0, false),
    (9, 0, 44.0, false),
    (10, 9, 44.0, false),
];

/// The segment whose end is the figure's left hand, and its left foot.
pub const HAND: u32 = 4;
pub const FOOT: u32 = 8;

/// Where the end of segment `id` is in a pose.
pub fn joint(hip: [f64; 2], angles: &[f64; 10], id: u32) -> [f64; 2] {
    let Some(i) = SEGMENTS.iter().position(|s| s.0 == id) else { return hip };
    let (_, parent, length, _) = SEGMENTS[i];
    let from = if parent == 0 { hip } else { joint(hip, angles, parent) };
    [from[0] + length * angles[i].cos(), from[1] + length * angles[i].sin()]
}

/// A pose: the hip and every segment's angle (absolute, y down). `arms`: 0 at rest, 1
/// raised above the head; `stride`: -1..1, legs and arms swinging.
pub fn pose(hip: [f64; 2], arms: f64, stride: f64) -> ([f64; 2], [f64; 10]) {
    let lerp = |a: f64, b: f64| a + (b - a) * arms;
    let s = stride * 0.45;
    (hip, [UP, UP, lerp(2.05 + s, -2.45), lerp(1.8 + s * 1.2, -2.05), lerp(1.1 - s, -0.7), lerp(1.35 - s * 1.2, -1.1), 1.9 - s, 1.75 - s * 0.6, 1.25 + s, 1.4 + s * 0.6])
}

/// What a figure does over the frames of a stage.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Motion {
    Still,
    /// Walks (or runs) left to right across the stage.
    Walk,
    Run,
    /// Raises its arms, holds, lowers them, raises them again.
    Arms,
    /// Leaves the stage a third of the way in.
    Vanish,
}

impl Motion {
    pub fn parse(name: &str) -> Option<Motion> {
        Some(match name {
            "still" => Motion::Still,
            "walk" => Motion::Walk,
            "run" => Motion::Run,
            "arms" => Motion::Arms,
            "vanish" => Motion::Vanish,
            _ => return None,
        })
    }
}

/// Keyframes of a figure over `ticks` ticks: (duration, pose or `None` when it is gone).
fn keyframes(motion: Motion, hip: [f64; 2], ticks: f64) -> Vec<(f64, Option<([f64; 2], [f64; 10])>)> {
    let span = ticks.max(8.0);
    match motion {
        Motion::Walk | Motion::Run => {
            let (keys, reach) = if motion == Motion::Walk { (8, 170.0) } else { (12, 240.0) };
            (0..=keys)
                .map(|k| {
                    let t = k as f64 / keys as f64;
                    let stride = if k % 2 == 0 { 1.0 } else { -1.0 };
                    let at = [hip[0] - reach + 2.0 * reach * t, hip[1] - if k % 2 == 0 { 0.0 } else { 4.0 }];
                    ((span / keys as f64).round().max(1.0), Some(pose(at, 0.0, stride)))
                })
                .collect()
        }
        Motion::Arms => {
            let q = (span / 4.0).round().max(1.0);
            vec![(q, Some(pose(hip, 0.0, 0.0))), (q, Some(pose(hip, 1.0, 0.0))), (q, Some(pose(hip, 1.0, 0.0))), (q, Some(pose(hip, 0.0, 0.0))), (1.0, Some(pose(hip, 1.0, 0.0)))]
        }
        Motion::Vanish => {
            let k = (span / 3.0).round().max(1.0);
            vec![(k, Some(pose(hip, 0.0, 0.0))), (span - k + 1.0, None)]
        }
        Motion::Still => vec![(span + 1.0, Some(pose(hip, 0.0, 0.0)))],
    }
}

/// A key of an effect parameter: the clip's own tick and the value.
#[derive(Clone, Debug)]
pub struct Key {
    pub param: String,
    pub tick: f64,
    pub value: String,
}

/// An effect clip of a stage.
#[derive(Clone, Debug)]
pub struct Clip {
    /// `None`: the scene; otherwise the figure's uid.
    pub target: Option<u32>,
    /// One node of the figure (a segment id: the joint at its end) instead of all of it.
    pub node: Option<u32>,
    pub kind: String,
    /// Saved parameters as JSON values (`"1.5"`, `"16747050"`, `"{...}"` for a paint).
    pub params: Vec<(String, String)>,
    pub start: f64,
    pub duration: Option<f64>,
    pub keys: Vec<Key>,
    pub include_attached: bool,
}

impl Clip {
    pub fn new(target: Option<u32>, kind: &str) -> Clip {
        Clip { target, node: None, kind: kind.into(), params: Vec::new(), start: 0.0, duration: None, keys: Vec::new(), include_attached: false }
    }

    /// Targets one node of the figure (`None`: all of it).
    pub fn on_node(mut self, node: Option<u32>) -> Clip {
        self.node = node;
        self
    }

    /// Sets a parameter (a JSON value; `0x…`, `on`, `off` are read as numbers).
    pub fn set(mut self, name: &str, value: &str) -> Clip {
        self.params.retain(|(k, _)| k != name);
        self.params.push((name.into(), json_value(value)));
        self
    }

    pub fn timed(mut self, start: f64, duration: Option<f64>) -> Clip {
        self.start = start;
        self.duration = duration;
        self
    }

    pub fn key(mut self, param: &str, tick: f64, value: &str) -> Clip {
        self.keys.push(Key { param: param.into(), tick, value: json_value(value) });
        self
    }
}

/// A figure of a stage.
#[derive(Clone, Copy, Debug)]
pub struct Figure {
    pub uid: u32,
    pub hip: [f64; 2],
    pub motion: Motion,
}

/// A stage: its background (ARGB), figures, clips and length.
#[derive(Clone, Debug)]
pub struct Stage {
    pub background: u32,
    pub figures: Vec<Figure>,
    pub clips: Vec<Clip>,
    pub ticks: f64,
}

/// A parameter value as the saved JSON holds it: numbers, hexadecimal colours (`0x…`, `#…`), switches.
pub fn json_value(v: &str) -> String {
    let t = v.trim();
    if let Some(hex) = t.strip_prefix("0x").or_else(|| t.strip_prefix('#'))
        && let Ok(n) = u32::from_str_radix(hex, 16)
    {
        return n.to_string();
    }
    match t {
        "on" | "true" => "1".into(),
        "off" | "false" => "0".into(),
        _ => t.to_string(),
    }
}

impl Stage {
    /// One still figure (uid 1) at the middle, on white, `ticks` long.
    pub fn new(ticks: f64) -> Stage {
        Stage { background: 0xffffffff, figures: vec![Figure { uid: 1, hip: HIP, motion: Motion::Still }], clips: Vec::new(), ticks }
    }

    pub fn clip(mut self, clip: Clip) -> Stage {
        self.clips.push(clip);
        self
    }

    /// The document, as the app's JSON.
    pub fn json(&self) -> String {
        let luminance = (0.2126 * (self.background >> 16 & 255) as f64 + 0.7152 * (self.background >> 8 & 255) as f64 + 0.0722 * (self.background & 255) as f64) / 255.0;
        // A dark figure on light backgrounds, a light one on dark backgrounds.
        let ink = if luminance > 0.45 { "34,34,40" } else { "214,214,222" };
        let mut segments = Vec::new();
        for (id, parent, length, circle) in SEGMENTS {
            let (code, kind) = if circle { (1, "circle") } else { (0, "line") };
            segments.push(format!(
                r#"{{"segment_id":{id},"parent_id":{parent},"length":{length},"angle_rad":0,"thickness":7,"bend_rad":0,"primitive_code":{code},"aux_code":0,"flags":0,"segment_type":"{kind}","segment_kind":"{kind}","color_rgb":[{ink}],"transparency":0,"visible":true,"z_order":{id},"is_static":false,"flag_bits":{{"is_static":false}}}}"#
            ));
        }
        // Every figure's keyframes, merged on a common timeline of the figures' key ticks.
        let tracks: Vec<Vec<(f64, Option<([f64; 2], [f64; 10])>)>> = self.figures.iter().map(|f| keyframes(f.motion, f.hip, self.ticks)).collect();
        let mut cuts: Vec<f64> = vec![0.0];
        for track in &tracks {
            let mut t = 0.0;
            for (duration, _) in track {
                t += duration;
                cuts.push(t);
            }
        }
        cuts.sort_by(f64::total_cmp);
        cuts.dedup();
        let end = cuts.last().copied().unwrap_or(1.0);
        let pose_at = |track: &[(f64, Option<([f64; 2], [f64; 10])>)], tick: f64| -> Option<([f64; 2], [f64; 10])> {
            let mut t = 0.0;
            for (k, (duration, posed)) in track.iter().enumerate() {
                if tick < t + duration || k == track.len() - 1 {
                    // Between this key and the next, as the app tweens: exact at the key itself.
                    if tick == t {
                        return *posed;
                    }
                    let next = track.get(k + 1).and_then(|n| n.1);
                    return match (*posed, next) {
                        (Some(a), Some(b)) => {
                            let f = (tick - t) / duration;
                            let mut angles = a.1;
                            for (i, angle) in angles.iter_mut().enumerate() {
                                *angle += (b.1[i] - a.1[i]) * f;
                            }
                            Some(([a.0[0] + (b.0[0] - a.0[0]) * f, a.0[1] + (b.0[1] - a.0[1]) * f], angles))
                        }
                        (a, _) => a,
                    };
                }
                t += duration;
            }
            None
        };
        let mut frames = Vec::new();
        for (k, w) in cuts.windows(2).enumerate() {
            let mut objects = Vec::new();
            for (slot, (figure, track)) in self.figures.iter().zip(&tracks).enumerate() {
                let Some((hip, angles)) = pose_at(track, w[0]) else { continue };
                objects.push((slot, format!(
                    r#"{{"object_slot":{},"unique_id":{},"figure_type_id":1,"root_x":{:.3},"root_y":{:.3},"scale":1,"color_override_raw":0,"field28":0,"angles":[{}],"len_flag":0,"lengths":[],"bend_flag":0,"bends":[],"join":null,"color_override_rgb":[0,0,0],"color_override_mix":0,"transparency":0,"opacity":1}}"#,
                    objects.len(),
                    figure.uid,
                    hip[0],
                    hip[1],
                    angles.iter().map(|a| format!("{a:.5}")).collect::<Vec<_>>().join(",")
                )));
            }
            let order: Vec<String> = (0..objects.len()).map(|i| i.to_string()).collect();
            let uids: Vec<String> = objects.iter().map(|(slot, _)| self.figures[*slot].uid.to_string()).collect();
            frames.push(format!(
                r#"{{"duration_raw":{},"background_id":1,"background_id_b":0,"background_mix":0,"camera":{{"is_default":true,"x":0,"y":0,"scale":1,"angle_rad":0}},"objects":[{}],"object_draw_order":[{}],"object_draw_order_unique_ids":[{}],"_styk":{{"frameId":"frame-{k}"}},"inbetweens":0,"hidden":false}}"#,
                if k + 2 == cuts.len() { (w[1] - w[0]).max(1.0) + 1.0 } else { w[1] - w[0] },
                objects.iter().map(|(_, o)| o.as_str()).collect::<Vec<_>>().join(","),
                order.join(","),
                uids.join(",")
            ));
        }
        let _ = end;
        let mut clips = Vec::new();
        for (c, clip) in self.clips.iter().enumerate() {
            let effect_id = format!("00000000-0000-4000-8000-{:012x}", 2 * c + 2);
            let mut params = String::from(r#""effectStrength":1"#);
            for (k, v) in &clip.params {
                let _ = write!(params, r#","{k}":{v}"#);
            }
            let mut keys: Vec<String> = Vec::new();
            let mut names: Vec<&str> = clip.keys.iter().map(|k| k.param.as_str()).collect();
            names.dedup();
            for name in names {
                let list: Vec<String> = clip.keys.iter().filter(|k| k.param == name).map(|k| format!(r#"{{"tick":{},"value":{},"interpolation":"linear"}}"#, k.tick, k.value)).collect();
                keys.push(format!(r#""vfx1:{}:{effect_id}:{name}":[{}]"#, clip.kind, list.join(",")));
            }
            let target = match (clip.target, clip.node) {
                (None, _) => r#"{"kind":"scene"}"#.to_string(),
                (Some(uid), None) => format!(r#"{{"kind":"figure","uid":{uid}}}"#),
                (Some(uid), Some(handle)) => format!(r#"{{"kind":"segment","uid":{uid},"handleId":{handle},"figureTypeId":1}}"#),
            };
            clips.push(format!(
                r#"{{"id":"00000000-0000-4000-8000-{:012x}","name":"","target":{target},"start":{},"duration":{},"offset":0,"enabled":true,"strength":1,"fadeIn":0,"fadeOut":0,"includeAttached":{},"effects":[{{"version":2,"id":"{effect_id}","type":"{}","enabled":true,"params":{{{params}}}}}],"keys":{{{}}}}}"#,
                2 * c + 1,
                clip.start,
                clip.duration.map_or("null".to_string(), |d| d.to_string()),
                clip.include_attached,
                clip.kind,
                keys.join(",")
            ));
        }
        format!(
            r#"{{"version":5,"canvas_width":{},"canvas_height":{},"fps":24,"auto_easing":false,"auto_easing_disabled_raw":1,"auto_easing_source":"file","backgrounds":[{{"background_id":1,"kind":2,"color":{}}}],"figure_types":[{{"figure_type_id":1,"name":"Figure","segment_count":10,"segments":[{}],"polyfills":[],"image_assets":[],"text_assets":[]}}],"keyframes":[{}],"_styk":{{"format":"StykAnimate","format_version":1,"name":"generated effects stage","vfxClips":{{"version":1,"clips":[{}]}}}}}}"#,
            CANVAS[0],
            CANVAS[1],
            self.background,
            segments.join(","),
            frames.join(","),
            clips.join(",")
        )
    }

    /// The document, opened and prepared.
    pub fn prepare(&self) -> crate::eval::Prepared {
        let doc = crate::open_bytes(self.json().as_bytes(), "json", "generated effects stage").expect("a stage document opens");
        crate::prepare(doc)
    }
}

/// One specimen of [`specimens`]: what it shows.
pub struct Specimen {
    pub label: &'static str,
    pub shape: u32,
    pub softness: f32,
    pub outline: f32,
    pub emissive: f32,
    pub erosion: f32,
    /// A material's cell (`material << 4 | variant`), or a shape's seed.
    pub cell: u32,
}

/// Every particle shape and material, each in a few looks: what the renderers must draw alike.
pub fn specimen_list() -> Vec<Specimen> {
    use styk_draw::*;
    let s = |label, shape, softness: f32| Specimen { label, shape, softness, outline: 0.0, emissive: 0.0, erosion: 0.0, cell: 7 };
    let m = |label, material: u32, erosion: f32, outline: f32| Specimen { label, shape: P_MATERIAL, softness: 0.0, outline, emissive: 0.0, erosion, cell: material << 4 | 1 };
    vec![
        s("SOFT DISC", P_DISC, 1.4),
        s("DISC", P_DISC, 0.0),
        s("RING", P_RING, 0.12),
        s("STREAK", P_STREAK, 0.6),
        s("ROCK", P_ROCK, 0.0),
        s("SQUARE", P_SQUARE, 0.0),
        s("RHOMBUS", P_RHOMBUS, 0.0),
        s("STAR", P_STAR, 0.0),
        s("SPARKLE", P_SPARKLE, 0.0),
        s("SPARK", P_SPARK, 0.0),
        s("SHARD", P_SHARD, 0.0),
        s("DROP", P_DROP, 0.0),
        s("HEART", P_HEART, 0.0),
        s("BURST", P_BURST, 0.0),
        s("CLOUD", P_CLOUD, 0.0),
        s("FLAKE", P_FLAKE, 0.0),
        s("PETAL", P_PETAL, 0.0),
        s("BOLT", P_BOLT, 0.0),
        s("FLAME", P_FLAME, 0.0),
        s("SPLAT", P_SPLAT, 0.0),
        s("BOKEH", P_BOKEH, 0.0),
        s("TOON STAR", P_TOON_STAR, 0.0),
        Specimen { outline: 0.18, ..s("INKED", P_CLOUD, 0.0) },
        Specimen { emissive: 1.0, ..s("LIGHT", P_DISC, 1.4) },
        Specimen { softness: 1.0, ..s("TRAIL", P_SEGMENT, 1.0) },
        m("SMOKE", super::atlas::SMOKE, 0.05, 0.0),
        m("FLAME", super::atlas::FLAME, 0.25, 0.0),
        m("WISP", super::atlas::WISP, 0.1, 0.0),
        m("PUFF", super::atlas::PUFF, 0.35, 0.12),
    ]
}

/// A draw list of every specimen at the radii `sizes`, in a grid of `columns` cells on a
/// background of `background` (ARGB), and its size in pixels (one pixel a world unit).
pub fn specimens(background: u32, sizes: &[f32], columns: usize) -> (styk_draw::DrawList, [u32; 2]) {
    use styk_draw::*;
    let list = specimen_list();
    let gap = 14.0f32;
    let cell_w = sizes.iter().map(|r| 2.0 * r + gap).sum::<f32>() + gap;
    let cell_h = 2.0 * sizes.iter().copied().fold(0.0, f32::max) + 2.0 * gap + 4.0;
    let rows = list.len().div_ceil(columns);
    let size = [(cell_w * columns as f32).ceil() as u32, (cell_h * rows as f32).ceil() as u32];
    let mut paints: Vec<[f32; 4]> = Vec::new();
    let mut prims = vec![Prim { kind: K_FILL_VIEW, group: 0, color: argb8(background), paint: NO_PAINT, a: [0.0; 4], b: [0.0; 4], c: [0.0; 4] }];
    let colour = [1.0, 0.55, 0.15, 1.0];
    for (i, sp) in list.iter().enumerate() {
        // The specimen's rows: identity transform, full shading, its softness and outline, a rim.
        let rows = paints.len() as u32;
        paints.push([1.0, 0.0, 0.0, 1.0]);
        paints.push([0.0, 0.0, 1.0, 1.0]);
        let mut x = (i % columns) as f32 * cell_w + gap;
        let y = (i / columns) as f32 * cell_h + cell_h / 2.0;
        for (k, &r) in sizes.iter().enumerate() {
            let at = paints.len() as u32;
            if k > 0 {
                paints.push([1.0, 0.0, 0.0, 1.0]);
                paints.push([0.0, 0.0, 1.0, 1.0]);
            }
            let rows = if k == 0 { rows } else { at };
            paints.push([sp.softness, 1.0, 1.0, sp.outline * r]);
            paints.push([0.08, 0.05, 0.1, 1.0]);
            paints.push([0.12, 0.2, 0.6, 0.0]);
            paints.push([0.55, 0.08, 0.02, 0.0]);
            let cx = x + r;
            let kind = particle_kind(sp.shape) | if sp.shape == P_SEGMENT { F_CAP_START | F_CAP_END } else { 0 };
            let (a, b) = match sp.shape {
                P_SEGMENT => ([cx - r * 0.8, y + r * 0.5, cx + r * 0.8, y - r * 0.5], [r * 0.35, r * 0.08, sp.emissive, 0.3]),
                P_STREAK => ([cx + r * 0.4, y, r * 0.35, 0.0], [r * 0.9, 0.0, sp.emissive, sp.erosion]),
                _ => ([cx, y, r, 0.0], [0.0, 0.0, sp.emissive, sp.erosion]),
            };
            prims.push(Prim { kind, group: 0, color: sp.cell, paint: rows, a, b, c: colour });
            x += 2.0 * r + gap;
        }
    }
    let end = prims.len() as u32;
    let mut materials = 0;
    for sp in &list {
        if sp.shape == P_MATERIAL {
            materials |= 1 << (sp.cell >> 4);
        }
    }
    let drawn = DrawList { prims, paints, groups: vec![Group { parent: 0, depth: 0, opacity: 1.0, bounds: [0.0; 4], layer: NO_LAYER }], passes: vec![Pass { depth: 0, start: 0, end }], background_prims: 1, materials, ..Default::default() };
    (drawn, size)
}
