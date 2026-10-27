//! Pivot `.piv` reader: version 5 (sequential grammar of `codecs/piv_codec.py`
//! and `codecs/piv_side_tables.py`) and version 4 (`codecs/piv_legacy_v4.py`).
//! Produces the typed [`Document`] directly; no JSON round trip.

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::sync::Arc;

use crate::doc::*;
use crate::text::{parse_glyph_commands, TextBuilder};
use crate::Error;

const MAX_PAYLOAD: usize = 256 * 1024 * 1024;
const MAX_SEGMENTS: usize = 30000;

fn err(message: impl Into<String>) -> Error {
    Error::Format(message.into())
}

struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Reader { data, pos: 0 }
    }
    fn take(&mut self, n: usize) -> Result<&'a [u8], Error> {
        if n > self.data.len() - self.pos {
            return Err(err(format!("Unexpected end of file at payload offset {:#x}, need {n} bytes", self.pos)));
        }
        let start = self.pos;
        self.pos += n;
        Ok(&self.data[start..self.pos])
    }
    fn u8(&mut self) -> Result<u8, Error> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<u16, Error> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }
    fn u32(&mut self) -> Result<u32, Error> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn i32(&mut self) -> Result<i32, Error> {
        Ok(i32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn u64(&mut self) -> Result<u64, Error> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn f32(&mut self) -> Result<f64, Error> {
        let at = self.pos;
        let v = f32::from_le_bytes(self.take(4)?.try_into().unwrap());
        if !v.is_finite() {
            return Err(err(format!("Non-finite number at {at:#x}")));
        }
        Ok(v as f64)
    }
    fn f64(&mut self) -> Result<f64, Error> {
        let at = self.pos;
        let v = f64::from_le_bytes(self.take(8)?.try_into().unwrap());
        if !v.is_finite() {
            return Err(err(format!("Non-finite number at {at:#x}")));
        }
        Ok(v)
    }
    fn f64s(&mut self, n: usize) -> Result<Arc<[f64]>, Error> {
        let bytes = self.take(n * 8)?;
        let mut out = Vec::with_capacity(n);
        for chunk in bytes.chunks_exact(8) {
            let v = f64::from_le_bytes(chunk.try_into().unwrap());
            if !v.is_finite() {
                return Err(err("Non-finite pose value"));
            }
            out.push(v);
        }
        Ok(out.into())
    }
    fn f32s(&mut self, n: usize) -> Result<Arc<[f64]>, Error> {
        let bytes = self.take(n * 4)?;
        let mut out = Vec::with_capacity(n);
        for chunk in bytes.chunks_exact(4) {
            let v = f32::from_le_bytes(chunk.try_into().unwrap());
            if !v.is_finite() {
                return Err(err("Non-finite pose value"));
            }
            out.push(v as f64);
        }
        Ok(out.into())
    }
    /// Pivot 5 names: u8 length + Windows-1252 bytes.
    fn string8(&mut self) -> Result<String, Error> {
        let n = self.u8()? as usize;
        Ok(cp1252(self.take(n)?))
    }
    /// UTF-16 string with a u32 code-unit count; returns the code units too.
    fn string16(&mut self) -> Result<(String, Vec<u16>), Error> {
        let n = self.u32()? as usize;
        let bytes = self.take(n.checked_mul(2).ok_or_else(|| err("Invalid text length"))?)?;
        let units: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        Ok((String::from_utf16_lossy(&units), units))
    }
}

fn cp1252(bytes: &[u8]) -> String {
    const HIGH: [char; 32] = [
        '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8d}', 'Ž', '\u{8f}', '\u{90}', '‘', '’', '“',
        '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '\u{9d}', 'ž', 'Ÿ',
    ];
    bytes
        .iter()
        .map(|&b| if (0x80..0xa0).contains(&b) { HIGH[(b - 0x80) as usize] } else { b as char })
        .collect()
}

pub fn unpack_source(source: &[u8]) -> Result<Vec<u8>, Error> {
    if source.is_empty() {
        return Err(err("Empty project"));
    }
    if (1..=5).contains(&source[0]) {
        return Ok(source.to_vec());
    }
    let mut out = Vec::with_capacity(source.len() * 3);
    let mut decoder = flate2::read::ZlibDecoder::new(source).take(MAX_PAYLOAD as u64 + 1);
    decoder.read_to_end(&mut out).map_err(|e| err(format!("Invalid compressed project: {e}")))?;
    if out.len() > MAX_PAYLOAD {
        return Err(err("Decompressed project exceeds the size limit"));
    }
    Ok(out)
}

/// Decodes a `.piv` file's bytes.
pub fn decode(source: &[u8], name: &str) -> Result<Document, Error> {
    let payload = unpack_source(source)?;
    match payload.first() {
        Some(5) => decode_v5(&payload, name),
        Some(4) => decode_v4(&payload, name),
        Some(v) => Err(Error::Unsupported(format!("Pivot project version {v} is not supported yet"))),
        None => Err(err("Empty project")),
    }
}

const BUILTIN: [(u32, f64, f64, f64, u8, u8); 12] = [
    (0, 32., -1.5707963267948968, 14., 0, 0),
    (1, 32., -1.5707963267948968, 14., 0, 0),
    (2, 33., -1.5707963267948968, 14., 0, 0),
    (3, 20., 1.5707963267948966, 20., 1, 1),
    (2, 38., 2.356194490192345, 14., 0, 0),
    (2, 38., 0.7853981633974483, 14., 0, 0),
    (5, 40., 2.0943951023931957, 14., 0, 0),
    (6, 40., 1.0471975511965979, 14., 0, 0),
    (0, 50., 1.9634954084936207, 14., 0, 0),
    (0, 50., 1.1780972450961724, 14., 0, 0),
    (9, 50., 1.9634954084936207, 14., 0, 0),
    (10, 50., 1.1780972450961724, 14., 0, 0),
];

fn segment(id: u32, parent: u32, length: f64, angle: f64, thickness: f64, prim: Prim, is_static: bool) -> Segment {
    Segment {
        id,
        parent,
        length,
        angle,
        thickness,
        bend: 0.0,
        prim,
        is_static,
        rgb: [0, 0, 0],
        alpha: 1.0,
        secondary: None,
        z: id as f64,
        visible: thickness > 0.01 || prim != Prim::Line,
        asset: 0,
        reverse: false,
        mirror: false,
        paint: None,
        sticknodes_shape: None,
        name: None,
        rig: None,
    }
}

/// Implicit native figure slot 1 ("Default"), shared by Pivot 3..5 projects.
fn builtin_man() -> Figure {
    let segments: Vec<Segment> = BUILTIN
        .iter()
        .enumerate()
        .map(|(i, &(parent, length, angle, thickness, prim, aux))| {
            segment(i as u32 + 1, parent, length, angle, thickness, if prim == 1 { Prim::Circle } else { Prim::Line }, aux & 1 != 0)
        })
        .collect();
    let plan = plan_figure(&segments, &[]);
    Figure {
        id: 1,
        name: "Default".into(),
        segments,
        polyfills: vec![],
        images: vec![],
        texts: vec![],
        outline: None,
        segment_colors: false,
        is_drawing: false,
        movieclip: None,
        plan,
        unsupported: vec![],
    }
}

fn decode_v5(payload: &[u8], name: &str) -> Result<Document, Error> {
    let mut r = Reader::new(payload);
    r.u8()?;
    let width = r.u32()?;
    let height = r.u32()?;
    if !(1..=100_000).contains(&width) || !(1..=100_000).contains(&height) {
        return Err(err("Invalid canvas dimensions"));
    }
    let mut images: Vec<ImageData> = Vec::new();
    let bg_slots = r.u16()? as u32;
    if bg_slots < 1 {
        return Err(err("Background slot count must include the implicit white background"));
    }
    let mut backgrounds = Vec::new();
    for id in 1..bg_slots {
        let at = r.pos;
        let kind = r.u8()?;
        let kind = match kind {
            0 | 1 => {
                let end = r.u64()? as usize;
                if end < r.pos || end > payload.len() {
                    return Err(err(format!("Invalid background image end at {at:#x}")));
                }
                let blob = r.take(end - r.pos)?;
                images.push(ImageData { bytes: Arc::from(blob), color_key: None });
                BackgroundKind::Image { image: Some(images.len() as u32 - 1) }
            }
            2 => BackgroundKind::Solid { argb: r.u32()? },
            3 | 4 => {
                let a = r.u32()?;
                let b = r.u32()?;
                let (x1, y1, x2, y2) = (r.f32()?, r.f32()?, r.f32()?, r.f32()?);
                if kind == 3 {
                    BackgroundKind::Linear { a, b, x1, y1, x2, y2 }
                } else {
                    BackgroundKind::Radial { a, b, x1, y1, x2, y2 }
                }
            }
            k => return Err(err(format!("Unsupported background kind {k} at {at:#x}"))),
        };
        r.string8()?;
        backgrounds.push(Background { id, kind });
    }
    let figure_slots = r.u16()? as u32;
    if figure_slots < 2 {
        return Err(err("Figure table must include the reserved and implicit slots"));
    }
    let mut figures = vec![Arc::new(builtin_man())];
    for tid in 2..figure_slots {
        figures.push(Arc::new(read_figure_v5(&mut r, tid, &mut images)?));
    }
    let types: HashMap<u32, Arc<Figure>> = figures.iter().map(|f| (f.id, f.clone())).collect();
    let count = r.u32()? as usize;
    if count > 1_000_000 {
        return Err(err("Implausible keyframe count"));
    }
    let mut keyframes = Vec::with_capacity(count);
    for fi in 0..count {
        let duration = r.u16()? as u32;
        let mix = r.u8()?;
        let bg = r.u16()? as u32;
        let bg_b = if mix != 0 { r.u16()? as u32 } else { 0 };
        if bg >= bg_slots || bg_b >= bg_slots {
            return Err(err(format!("Unknown background in keyframe {fi}")));
        }
        let obj_count = r.u16()? as usize;
        let mut objects = Vec::with_capacity(obj_count);
        for oi in 0..obj_count {
            let uid = r.u32()?;
            let tid = r.u16()? as u32;
            let fig = types.get(&tid).ok_or_else(|| err(format!("Unknown figure type {tid} in keyframe {fi}, object {oi}")))?;
            let sc = fig.segments.len();
            let scale = r.f32()?;
            let color = r.u32()?;
            let field28 = r.u8()?;
            let image_text_flags = if !fig.images.is_empty() || !fig.texts.is_empty() { r.u8()? != 0 } else { false };
            let angles = r.f64s(sc)?;
            let root = [r.f32()?, r.f32()?];
            let lengths = if r.u16()? != 0 { Some(r.f32s(sc)?) } else { None };
            let bends = if r.u16()? != 0 { Some(r.f64s(sc)?) } else { None };
            let join = if r.u8()? != 0 {
                let slot = r.u16()? as u32;
                let handle = r.u16()? as u32;
                if slot as usize >= obj_count {
                    return Err(err(format!("Invalid joined object slot {slot} in keyframe {fi}")));
                }
                Some(Join { slot, handle })
            } else {
                None
            };
            objects.push(Object {
                uid,
                figure: tid,
                root,
                scale,
                color,
                transparency: field28 as f64,
                image_text_flags,
                angles,
                lengths,
                bends,
                join,
                movieclip: None,
                clip_time: None,
                z_index: 0.0,
                style: None,
                sticknodes_shapes: None,
                figure_override: None,
            });
        }
        let mut order = Vec::with_capacity(obj_count);
        for _ in 0..obj_count {
            order.push(r.u16()? as u32);
        }
        check_permutation(&order, obj_count, fi)?;
        let camera = if r.u8()? == 0 {
            let x = r.f32()?;
            let y = r.f32()?;
            let angle = r.f64()?;
            let scale = r.f32()?;
            Some(Camera { x, y, scale, angle, is_default: false })
        } else {
            Some(Camera::default())
        };
        keyframes.push(Keyframe {
            duration,
            objects: objects.into_iter().map(Arc::new).collect(),
            draw_order: order,
            camera,
            background: bg,
            background_b: bg_b,
            background_mix: mix as f64,
            easing: None,
            frame_id: None,
            slot_of: HashMap::new(),
            continuations: Vec::new(),
            background_color: None,
        });
    }
    recover_object_ids(&mut keyframes);
    let fps = r.u32()?;
    if !(1..=1000).contains(&fps) {
        return Err(err(format!("Invalid frame rate {fps}")));
    }
    let ease = if r.pos < payload.len() { Some(r.u8()?) } else { None };
    let mut doc = Document {
        name: name.to_string(),
        version: 5,
        canvas: [width, height],
        fps: fps as f64,
        auto_easing: matches!(ease, None | Some(0)),
        figures,
        keyframes: keyframes.into_iter().map(Arc::new).collect(),
        backgrounds,
        images,
        ..Default::default()
    };
    doc.reindex_figures();
    validate_joins(&doc)?;
    Ok(doc)
}

fn check_permutation(order: &[u32], count: usize, frame: usize) -> Result<(), Error> {
    let mut seen = vec![false; count];
    for &slot in order {
        let s = slot as usize;
        if s >= count || seen[s] {
            return Err(err(format!("Invalid object draw order in keyframe {frame}")));
        }
        seen[s] = true;
    }
    Ok(())
}

/// Duplicate unique ids inside one keyframe get fresh ids (piv_codec._recover_object_ids).
fn recover_object_ids(frames: &mut [Keyframe]) {
    let mut reserved: HashSet<u32> = HashSet::new();
    let mut duplicates = Vec::new();
    for (fi, frame) in frames.iter().enumerate() {
        let mut seen = HashSet::new();
        for (oi, o) in frame.objects.iter().enumerate() {
            if !seen.insert(o.uid) {
                duplicates.push((fi, oi));
            }
        }
        reserved.extend(seen);
    }
    let mut candidate = 1u32;
    for (fi, oi) in duplicates {
        while reserved.contains(&candidate) {
            candidate += 1;
        }
        Arc::make_mut(&mut frames[fi].objects[oi]).uid = candidate;
        reserved.insert(candidate);
    }
    for frame in frames.iter_mut() {
        frame.reindex();
    }
}

fn validate_joins(doc: &Document) -> Result<(), Error> {
    for (fi, frame) in doc.keyframes.iter().enumerate() {
        for o in &frame.objects {
            if let Some(join) = o.join {
                let target = &frame.objects[join.slot as usize];
                let fig = doc.figure(target.figure).ok_or_else(|| err("Join targets an unknown figure"))?;
                if join.handle != 0 && !fig.plan.index_of.contains_key(&join.handle) {
                    return Err(err(format!("Unknown joined target handle in keyframe {fi}")));
                }
            }
        }
        for start in 0..frame.objects.len() {
            let mut cursor = start;
            let mut steps = 0;
            while let Some(join) = frame.objects[cursor].join {
                cursor = join.slot as usize;
                steps += 1;
                if steps > frame.objects.len() {
                    return Err(err(format!("Cyclic object joins in keyframe {fi}")));
                }
            }
        }
    }
    Ok(())
}

fn read_figure_v5(r: &mut Reader, figure_id: u32, images: &mut Vec<ImageData>) -> Result<Figure, Error> {
    let start = r.pos;
    let flags = r.u8()?;
    let count = r.u16()? as usize;
    if count == 0 || count > MAX_SEGMENTS {
        return Err(err(format!("Invalid segment count {count} for figure {figure_id} at {start:#x}")));
    }
    let mut segments = Vec::with_capacity(count);
    for i in 0..count {
        let parent = r.u16()? as u32;
        let id = if flags & 32 != 0 { i as u32 + 1 } else { r.u16()? as u32 };
        let length = r.f32()?;
        let angle = r.f64()?;
        let thickness = r.f32()?;
        let prim_code = if flags & 1 != 0 { 0 } else { r.u8()? };
        let aux = if flags & 2 != 0 { 0 } else { r.u8()? };
        let rgb = if flags & 4 != 0 { [0, 0, 0] } else { [r.u8()?, r.u8()?, r.u8()?] };
        let transparency = if flags & 8 != 0 { 0 } else { r.u8()? };
        let mut secondary = None;
        if flags & 128 == 0 && r.u8()? != 0 {
            let rgb = [r.u8()?, r.u8()?, r.u8()?];
            secondary = Some((rgb, r.u8()?));
        }
        let (asset, reverse, mirror) = if prim_code == 2 || prim_code == 5 {
            (r.u16()? as u32, r.u8()? != 0, r.u8()? != 0)
        } else {
            (0, false, false)
        };
        let prim = Prim::from_code(prim_code)
            .ok_or_else(|| err(format!("Unknown primitive {prim_code} in figure {figure_id}, segment {i}")))?;
        let mut s = segment(id, parent, length, angle, thickness, prim, aux & 1 != 0);
        s.rgb = rgb;
        s.alpha = 1.0 - transparency as f64 / 255.0;
        s.secondary = secondary;
        s.asset = asset;
        s.reverse = reverse;
        s.mirror = mirror;
        segments.push(s);
    }
    let ids: HashSet<u32> = segments.iter().map(|s| s.id).collect();
    if ids.len() != count || ids.contains(&0) {
        return Err(err(format!("Duplicate or zero segment ids in figure {figure_id}")));
    }
    if segments.iter().any(|s| s.parent != 0 && !ids.contains(&s.parent)) {
        return Err(err(format!("Unknown parent id in figure {figure_id}")));
    }
    let bend_count = r.u16()? as usize;
    if bend_count > count {
        return Err(err(format!("Invalid bend count in figure {figure_id}")));
    }
    for _ in 0..bend_count {
        let index = r.u16()? as usize;
        if index >= count {
            return Err(err(format!("Invalid bend index in figure {figure_id}")));
        }
        segments[index].bend = r.f64()?;
    }
    let mut image_assets = Vec::new();
    let mut text_assets = Vec::new();
    let has = |p: Prim| segments.iter().any(|s| s.prim == p);
    let (has_images, has_texts) = (has(Prim::Image), has(Prim::Text));
    if has_images {
        let n = r.u16()? as usize;
        let allow_missing = flags & 16 != 0 && flags & 64 == 0;
        for index in 0..n {
            image_assets.push(read_image(r, index as u32, allow_missing && index + 1 == n && !has_texts, images)?);
        }
        for s in segments.iter().filter(|s| s.prim == Prim::Image) {
            if s.asset as usize >= n {
                return Err(err(format!("Image segment refers to asset {}, table has {n}", s.asset)));
            }
        }
    }
    if has_texts {
        let n = r.u16()? as usize;
        for index in 0..n {
            text_assets.push(read_text(r, index as u32)?);
        }
        for s in segments.iter().filter(|s| s.prim == Prim::Text) {
            if s.asset as usize >= n {
                return Err(err(format!("Text segment refers to asset {}, table has {n}", s.asset)));
            }
        }
    }
    let poly_count = r.u16()? as usize;
    if poly_count > 20000 {
        return Err(err(format!("Invalid polygon count {poly_count} in figure {figure_id}")));
    }
    let mut polyfills = Vec::with_capacity(poly_count);
    for _ in 0..poly_count {
        let n = r.u16()? as usize;
        let rgb = [r.u8()?, r.u8()?, r.u8()?];
        let alpha_raw = r.u8()?;
        let mut joints = Vec::with_capacity(n);
        for _ in 0..n {
            let v = r.u16()? as u32;
            if v != 0 && !ids.contains(&v) {
                return Err(err(format!("Unknown polygon joint in figure {figure_id}")));
            }
            joints.push(v);
        }
        polyfills.push(Polyfill { id: polyfills.len() as u32 + 1, joints, rgb, alpha: 1.0 - alpha_raw as f64 / 255.0, z: 0.0 });
    }
    if flags & 16 == 0 {
        for s in segments.iter_mut() {
            s.z = r.u16()? as f64 + 1.0;
        }
        for p in polyfills.iter_mut() {
            p.z = r.u16()? as f64 + 1.0;
        }
    } else {
        for (i, s) in segments.iter_mut().enumerate() {
            s.z = i as f64 + 1.0;
        }
        for (i, p) in polyfills.iter_mut().enumerate() {
            p.z = (count + i) as f64 + 1.0;
        }
    }
    let outline = if flags & 64 != 0 {
        let bits = r.u32()?;
        let rgb = [r.u8()?, r.u8()?, r.u8()?];
        let u30 = r.u8()?;
        let width = f32::from_bits(bits) as f64;
        if !width.is_finite() {
            return Err(err(format!("Non-finite outline width in figure {figure_id}")));
        }
        Some(Outline { width, rgb, alpha: 1.0 - u30 as f64 / 255.0 })
    } else {
        None
    };
    let name = r.string8()?;
    let plan = plan_figure(&segments, &polyfills);
    Ok(Figure {
        id: figure_id,
        name,
        segments,
        polyfills,
        images: image_assets,
        texts: text_assets,
        outline,
        segment_colors: false,
        is_drawing: false,
        movieclip: None,
        plan,
        unsupported: vec![],
    })
}

fn read_image(r: &mut Reader, index: u32, allow_missing_end: bool, images: &mut Vec<ImageData>) -> Result<ImageAsset, Error> {
    let ax = r.i32()? as f64;
    let ay = r.i32()? as f64;
    let bx = r.i32()? as f64;
    let by = r.i32()? as f64;
    let pointer = r.pos;
    let mut end = r.u64()? as usize;
    if end == pointer {
        // A failed native save can leave its unpatched end placeholder.
        end = r.pos;
    } else if allow_missing_end
        && end > r.data.len()
        && r.data.get(pointer..pointer + 2) == Some(&[0, 0])
        && pointer + 3 <= r.data.len()
    {
        let size = r.data[pointer + 2] as usize;
        let name = r.data.get(pointer + 3..pointer + 3 + size);
        if size > 0 && name.is_some_and(|n| n.iter().all(|&c| c >= 32 && c != 127)) {
            r.pos = pointer;
            end = pointer;
        }
    }
    if end < r.pos {
        return Err(err(format!("Invalid image end at {pointer:#x}")));
    }
    let blob = r.take(end - r.pos)?;
    let image = if blob.is_empty() {
        None
    } else {
        images.push(ImageData { bytes: Arc::from(blob), color_key: None });
        Some(images.len() as u32 - 1)
    };
    Ok(ImageAsset {
        index,
        anchor_start: [ax, ay],
        anchor_end: [bx, by],
        anchor_length: (bx - ax).hypot(by - ay),
        anchor_angle: (by - ay).atan2(bx - ax),
        display_size: None,
        image,
        smooth: false,
        tiles: None,
    })
}

fn read_text(r: &mut Reader, index: u32) -> Result<TextAsset, Error> {
    let start = r.pos;
    r.string16()?; // font name
    r.u8()?; // style
    r.u32()?; // alignment
    let (_, units) = r.string16()?;
    let glyph_count = r.u8()? as usize;
    let mut glyphs = Vec::with_capacity(glyph_count);
    for _ in 0..glyph_count {
        glyphs.push(read_glyph(r)?);
    }
    let mut unique: Vec<u16> = Vec::new();
    for &u in &units {
        if !unique.contains(&u) {
            unique.push(u);
        }
    }
    if unique.len() != glyph_count {
        return Err(err(format!("Text at {start:#x} has {} unique characters but {glyph_count} glyphs", unique.len())));
    }
    let mut builder = TextBuilder::new(index);
    let parsed: Vec<Vec<PathCmd>> = glyphs.into_iter().map(|(commands, _)| commands).collect();
    for &unit in &units {
        let gi = unique.iter().position(|&u| u == unit).unwrap();
        let visible = !parsed[gi].is_empty();
        let (x, y) = if visible { (r.f32()?, r.f32()?) } else { (0.0, 0.0) };
        if visible {
            builder.place(&parsed[gi], x, y);
        }
    }
    Ok(builder.finish())
}

/// Glyph outline: node count, nibble-packed opcodes (low nibble first), then coordinates.
fn read_glyph(r: &mut Reader) -> Result<(Vec<PathCmd>, u32), Error> {
    let count = r.u32()?;
    if count as u64 > (r.data.len() - r.pos) as u64 * 6 {
        return Err(err("Impossible glyph node count"));
    }
    let mut codes = Vec::new();
    let mut expanded = 0u32;
    while expanded < count {
        let packed = r.u8()?;
        for code in [packed & 15, packed >> 4] {
            if code > 5 {
                return Err(err(format!("Unknown glyph opcode {code}")));
            }
            codes.push(code);
            expanded += if code == 2 { 3 } else { 1 };
            if expanded >= count {
                break;
            }
        }
    }
    if expanded != count {
        return Err(err("Cubic crosses the glyph node count"));
    }
    let mut ops: Vec<(char, Vec<f64>)> = Vec::with_capacity(codes.len());
    for code in codes {
        let n = [2, 2, 6, 0, 1, 1][code as usize];
        let mut values = Vec::with_capacity(n);
        for _ in 0..n {
            values.push(r.f32()?);
        }
        ops.push((['M', 'L', 'C', 'Z', 'V', 'H'][code as usize], values));
    }
    Ok((parse_glyph_commands(&ops), count))
}

// ---------------------------------------------------------------- Pivot 4

fn decode_v4(data: &[u8], name: &str) -> Result<Document, Error> {
    let mut r = Reader::new(data);
    r.u8()?;
    let width = r.u32()?;
    let height = r.u32()?;
    if width == 0 || height == 0 {
        return Err(err("Pivot canvas dimensions must be positive"));
    }
    let mut images: Vec<ImageData> = Vec::new();
    let bg_slots = r.u8()? as u32;
    if bg_slots == 0 {
        return Err(err("Pivot background table must contain default slot 0"));
    }
    let mut backgrounds = Vec::new();
    for id in 1..bg_slots {
        let kind = r.u8()?;
        let (blob, _, _) = match kind {
            0 => read_bmp(&mut r)?,
            1 => read_jpeg(&mut r)?,
            k => return Err(err(format!("Unsupported Pivot 4 background kind {k}"))),
        };
        images.push(ImageData { bytes: Arc::from(blob), color_key: None });
        r.string8()?;
        backgrounds.push(Background { id, kind: BackgroundKind::Image { image: Some(images.len() as u32 - 1) } });
    }
    let figure_slots = r.u16()? as u32;
    if figure_slots < 2 {
        return Err(err("Pivot 4 figure table must include the empty and builtin slots"));
    }
    let mut figures = vec![Arc::new(builtin_man())];
    for tid in 2..figure_slots {
        figures.push(Arc::new(read_figure_v4(&mut r, tid, &mut images)?));
    }
    let types: HashMap<u32, Arc<Figure>> = figures.iter().map(|f| (f.id, f.clone())).collect();
    let frame_count = r.u32()? as usize;
    if frame_count == 0 || frame_count > (data.len() - r.pos) / 5 {
        return Err(err(format!("Invalid Pivot 4 frame count {frame_count}")));
    }
    let mut keyframes = Vec::with_capacity(frame_count);
    for fi in 0..frame_count {
        let duration = r.u16()? as u32;
        if duration == 0 {
            return Err(err(format!("Zero frame duration at frame {fi}")));
        }
        let bg = r.u8()? as u32;
        if bg >= bg_slots {
            return Err(err(format!("Missing background {bg} at frame {fi}")));
        }
        let object_count = r.u16()? as usize;
        let mut objects = Vec::with_capacity(object_count);
        for oi in 0..object_count {
            let uid = r.u32()?;
            let tid = r.u16()? as u32;
            let fig = types.get(&tid).ok_or_else(|| err(format!("Missing figure type {tid} at frame {fi}, object {oi}")))?;
            let scale = r.f32()?;
            let color = r.u32()?;
            let transparency = r.u8()?;
            let image_text_flags = if !fig.images.is_empty() { r.u8()? != 0 } else { false };
            let n = fig.segments.len();
            let angles = r.f64s(n)?;
            if angles.iter().any(|a| a.abs() > 100.0) {
                return Err(Error::Unsupported(format!("Legacy angle-reset sentinel at frame {fi}, object {oi}")));
            }
            let root = [r.f32()?, r.f32()?];
            let lengths = if r.u8()? != 0 { Some(r.f32s(n)?) } else { None };
            let join = if r.u8()? != 0 {
                let slot = r.u16()? as u32;
                let handle = r.u8()? as u32;
                Some(Join { slot, handle })
            } else {
                None
            };
            objects.push(Object {
                uid,
                figure: tid,
                root,
                scale,
                color,
                transparency: transparency as f64,
                image_text_flags,
                angles,
                lengths,
                bends: None,
                join,
                movieclip: None,
                clip_time: None,
                z_index: 0.0,
                style: None,
                sticknodes_shapes: None,
                figure_override: None,
            });
        }
        let mut order = Vec::with_capacity(object_count);
        for _ in 0..object_count {
            order.push(r.u16()? as u32);
        }
        check_permutation(&order, object_count, fi)?;
        for o in &objects {
            if let Some(j) = o.join
                && j.slot as usize >= objects.len()
            {
                return Err(err(format!("Join target outside frame {fi}")));
            }
        }
        keyframes.push(Keyframe {
            duration,
            objects: objects.into_iter().map(Arc::new).collect(),
            draw_order: order,
            camera: Some(Camera::default()),
            background: bg,
            background_b: 0,
            background_mix: 0.0,
            easing: None,
            frame_id: None,
            slot_of: HashMap::new(),
            continuations: Vec::new(),
            background_color: None,
        });
    }
    for k in keyframes.iter_mut() {
        k.reindex();
    }
    let delay = r.u32()?;
    if delay == 0 {
        return Err(err("Pivot 4 frame delay must be positive"));
    }
    if data.len() - r.pos == 1 {
        r.u8()?;
    }
    if r.pos != data.len() {
        return Err(err(format!("Unexpected trailing data at byte {}", r.pos)));
    }
    let mut doc = Document {
        name: name.to_string(),
        version: 4,
        canvas: [width, height],
        fps: round_half_even(1000.0 / delay as f64),
        auto_easing: true,
        figures,
        keyframes: keyframes.into_iter().map(Arc::new).collect(),
        backgrounds,
        images,
        ..Default::default()
    };
    doc.reindex_figures();
    validate_joins(&doc)?;
    Ok(doc)
}

pub fn round_half_even(v: f64) -> f64 {
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

fn read_bmp<'a>(r: &mut Reader<'a>) -> Result<(&'a [u8], u32, u32), Error> {
    let start = r.pos;
    if r.data.get(start..start + 2) != Some(b"BM") || start + 26 > r.data.len() {
        return Err(err(format!("Expected a bitmap at byte {start}")));
    }
    let size = u32::from_le_bytes(r.data[start + 2..start + 6].try_into().unwrap()) as usize;
    if size < 26 {
        return Err(err(format!("Invalid bitmap size {size}")));
    }
    let blob = r.take(size)?;
    let dib = u32::from_le_bytes(blob[14..18].try_into().unwrap());
    let (w, h) = if dib == 12 {
        (u16::from_le_bytes(blob[18..20].try_into().unwrap()) as u32, u16::from_le_bytes(blob[20..22].try_into().unwrap()) as u32)
    } else {
        (
            i32::from_le_bytes(blob[18..22].try_into().unwrap()).unsigned_abs(),
            i32::from_le_bytes(blob[22..26].try_into().unwrap()).unsigned_abs(),
        )
    };
    Ok((blob, w, h))
}

fn read_jpeg<'a>(r: &mut Reader<'a>) -> Result<(&'a [u8], u32, u32), Error> {
    let start = r.pos;
    let end = r.u64()? as usize;
    if end <= r.pos || end > r.data.len() {
        return Err(err(format!("Invalid JPEG end pointer at byte {start}")));
    }
    let blob = &r.data[r.pos..end];
    r.pos = end;
    Ok((blob, 0, 0))
}

fn read_figure_v4(r: &mut Reader, figure_id: u32, images: &mut Vec<ImageData>) -> Result<Figure, Error> {
    let count = r.u8()? as usize;
    if count == 0 {
        return Err(err(format!("Zero-segment figure {figure_id}")));
    }
    let mut segments = Vec::with_capacity(count);
    let mut sprite_refs = Vec::new();
    for order in 0..count {
        let parent = r.u8()? as u32;
        let id = r.u8()? as u32;
        r.u16()?;
        let length = r.f32()?;
        let angle = r.f64()?;
        let thickness = r.f32()?;
        let prim_code = r.u8()?;
        let is_static = r.u8()? != 0;
        r.u16()?;
        if !matches!(prim_code, 0 | 1 | 2 | 3 | 4 | 6) {
            return Err(err(format!("Unsupported legacy primitive {prim_code}")));
        }
        if id == 0 || id as usize > count || parent as usize > count {
            return Err(err(format!("Invalid topology in figure {figure_id} at segment {order}")));
        }
        let prim = Prim::from_code(prim_code).unwrap();
        let mut s = segment(id, parent, length, angle, thickness, prim, is_static);
        s.visible = matches!(prim_code, 1..=4) || thickness > 0.01;
        s.z = order as f64 + 1.0;
        if prim == Prim::Image {
            s.asset = r.u8()? as u32;
            s.reverse = r.u8()? != 0;
            sprite_refs.push(s.asset);
        }
        segments.push(s);
    }
    let mut image_assets = Vec::new();
    if !sprite_refs.is_empty() {
        let n = r.u8()? as usize;
        for si in 0..n {
            let key = r.u32()?;
            let (blob, w, h) = read_bmp(r)?;
            images.push(ImageData {
                bytes: Arc::from(blob),
                color_key: Some([(key & 255) as u8, (key >> 8 & 255) as u8, (key >> 16 & 255) as u8]),
            });
            let (w, h) = (w as f64, h as f64);
            image_assets.push(ImageAsset {
                index: si as u32,
                anchor_start: [0.0, h],
                anchor_end: [w, h],
                anchor_length: w,
                anchor_angle: 0.0,
                display_size: None,
                image: Some(images.len() as u32 - 1),
                smooth: false,
                tiles: None,
            });
        }
        if sprite_refs.iter().any(|&s| s as usize >= n) {
            return Err(err(format!("Missing sprite resource in figure {figure_id}")));
        }
    }
    let name = r.string8()?;
    let plan = plan_figure(&segments, &[]);
    Ok(Figure {
        id: figure_id,
        name,
        segments,
        polyfills: vec![],
        images: image_assets,
        texts: vec![],
        outline: None,
        segment_colors: false,
        is_drawing: false,
        movieclip: None,
        plan,
        unsupported: vec![],
    })
}
