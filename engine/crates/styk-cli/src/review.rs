//! `styk vfx-review`: review pictures of a generated effect (docs/engine/vfx.md, "Reviewing generated effects").
//!
//!   styk vfx-review shapes [--sizes 5,18,60] [--columns 8] [--out sheet.png]   every shape and material, both renderers
//!   styk vfx-review <particles|aura|beam|smoke|explosion> [options]
//!     --style <name|index>      the style (the Particles look); default the first
//!     --set <name>=<value>      a saved parameter (repeatable): `--set color=0xff8a2a --set size=1.5`
//!     --ticks <a,b,…>           the frames shown (default: a row across the effect's life)
//!     --start <tick>            the clip's start (default 0); --duration <ticks|none> its length
//!     --motion <still|walk|arms|run|vanish|loop>   what the stick figure does (default still)
//!     --scene                   the effect on the scene instead of the figure (at --set x/y)
//!     --backgrounds <white,dark,…>  colours: white, dark, grey, sky or 0xRRGGBB, or picture: a mid-tone landscape (default white,dark)
//!     --zooms <1,4>             the zooms shown, 1 = one canvas pixel per screen pixel (default 1,4)
//!     --focus <x,y>             the canvas point zoomed views centre on (default: where the effect is)
//!     --cell <WxH>              one picture's size (default 400x300)
//!     --cpu                     the processor renderer (styk-raster) instead of the graphics card
//!     --out <sheet.png>         the contact sheet (default vfx-review.png)
//!     --seq <folder>            instead, every tick from the clip's start to --until as numbered PNGs
//!                               (frame-0000.png…) at the first background and zoom
//!     --until <tick>            the last tick of --seq (default: the last of --ticks)
//!     --save <file.json>        also writes the review document, to open in the app or `styk render`
//!
//! The document is a stage of `styk_eval::vfx::generated::stage`: a canvas of 640 × 400, a stick figure 180 pixels tall
//! standing at its middle, one effect clip. A sheet has a row per background and zoom and a column per tick, each labelled; the header names the effect.

use std::path::Path;
use std::time::Instant;

use styk_eval::eval::Prepared;
use styk_eval::geometry::build;
use styk_eval::vfx::generated::stage::{Clip, Motion, Stage, CANVAS, HIP};
use styk_eval::vfx::registry::{AuraStyle, BeamStyle, ExplosionStyle, ParticleLook, SmokeStyle};

/// What the review shows, read from the command line.
struct Request {
    kind: String,
    style: Option<String>,
    sets: Vec<(String, String)>,
    ticks: Vec<f64>,
    start: f64,
    duration: Option<f64>,
    motion: String,
    scene: bool,
    backgrounds: Vec<(String, u32)>,
    zooms: Vec<f64>,
    focus: Option<[f64; 2]>,
    cell: [u32; 2],
    cpu: bool,
    out: String,
    seq: Option<String>,
    until: Option<f64>,
    save: Option<String>,
}

fn background(name: &str) -> Option<(String, u32)> {
    let argb = match name {
        "white" => 0xffffffff,
        "dark" => 0xff14161c,
        "grey" | "gray" => 0xff8a8d93,
        "sky" => 0xff9fc8ec,
        // A mid-tone landscape (`picture`); the colour only decides the figure's ink.
        "picture" => 0xff7f8082,
        hex => 0xff000000 | u32::from_str_radix(hex.trim_start_matches("0x").trim_start_matches('#'), 16).ok()?,
    };
    Some((name.to_string(), argb))
}

fn parse(args: &[String]) -> Result<Request, String> {
    let kind = args.first().ok_or("vfx-review needs an effect type")?.clone();
    if !["particles", "aura", "beam", "smoke", "explosion"].contains(&kind.as_str()) {
        return Err(format!("unknown generated effect {kind:?}: particles, aura, beam, smoke or explosion"));
    }
    let mut r = Request {
        kind,
        style: None,
        sets: Vec::new(),
        ticks: Vec::new(),
        start: 0.0,
        duration: None,
        motion: "still".into(),
        scene: false,
        backgrounds: vec![background("white").unwrap(), background("dark").unwrap()],
        zooms: vec![1.0, 4.0],
        focus: None,
        cell: [400, 300],
        cpu: false,
        out: "vfx-review.png".into(),
        seq: None,
        until: None,
        save: None,
    };
    let mut duration_given = false;
    let mut i = 1;
    let value = |i: usize| args.get(i + 1).cloned().ok_or_else(|| format!("{} needs a value", args[i]));
    while i < args.len() {
        match args[i].as_str() {
            "--style" => r.style = Some(value(i)?),
            "--set" => {
                let v = value(i)?;
                let (k, x) = v.split_once('=').ok_or_else(|| format!("--set {v}: expected name=value"))?;
                r.sets.push((k.to_string(), x.to_string()));
            }
            "--ticks" => r.ticks = value(i)?.split(',').map(|t| t.trim().parse::<f64>().map_err(|e| format!("--ticks: {e}"))).collect::<Result<_, _>>()?,
            "--start" => r.start = value(i)?.parse().map_err(|e| format!("--start: {e}"))?,
            "--duration" => {
                let v = value(i)?;
                duration_given = true;
                r.duration = if v == "none" { None } else { Some(v.parse().map_err(|e| format!("--duration: {e}"))?) };
            }
            "--motion" => r.motion = value(i)?,
            "--backgrounds" => r.backgrounds = value(i)?.split(',').map(|b| background(b.trim()).ok_or_else(|| format!("unknown background {b:?}"))).collect::<Result<_, _>>()?,
            "--zooms" => r.zooms = value(i)?.split(',').map(|z| z.trim().parse::<f64>().map_err(|e| format!("--zooms: {e}"))).collect::<Result<_, _>>()?,
            "--focus" => {
                let v = value(i)?;
                let (x, y) = v.split_once(',').ok_or("--focus x,y")?;
                r.focus = Some([x.parse().map_err(|_| "--focus x,y")?, y.parse().map_err(|_| "--focus x,y")?]);
            }
            "--cell" => {
                let v = value(i)?;
                let (w, h) = v.split_once('x').ok_or("--cell WxH")?;
                r.cell = [w.parse().map_err(|_| "--cell WxH")?, h.parse().map_err(|_| "--cell WxH")?];
            }
            "--out" => r.out = value(i)?,
            "--seq" => r.seq = Some(value(i)?),
            "--until" => r.until = Some(value(i)?.parse().map_err(|e| format!("--until: {e}"))?),
            "--save" => r.save = Some(value(i)?),
            "--scene" => {
                r.scene = true;
                i += 1;
                continue;
            }
            "--cpu" => {
                r.cpu = true;
                i += 1;
                continue;
            }
            other => return Err(format!("unknown option {other}")),
        }
        i += 2;
    }
    if !duration_given {
        r.duration = match r.kind.as_str() {
            "explosion" => Some(20.0),
            "beam" => Some(40.0),
            _ => None,
        };
    }
    if r.ticks.is_empty() {
        r.ticks = match r.kind.as_str() {
            "explosion" => vec![1.0, 2.0, 4.0, 7.0, 11.0, 16.0, 24.0, 34.0, 48.0],
            "beam" => vec![3.0, 8.0, 12.0, 14.0, 17.0, 22.0, 30.0, 39.0, 46.0],
            "smoke" => vec![4.0, 10.0, 20.0, 32.0, 48.0, 64.0, 90.0],
            _ => vec![2.0, 6.0, 12.0, 20.0, 30.0, 44.0, 60.0],
        }
        .into_iter()
        .map(|t| t + r.start)
        .collect();
    }
    Ok(r)
}

/// The option names of an effect type's style parameter, in saved order.
fn styles(kind: &str) -> (&'static str, Vec<String>) {
    let names = |all: Vec<String>| all.into_iter().map(|s| s.to_lowercase()).collect::<Vec<_>>();
    match kind {
        "particles" => ("look", names(ParticleLook::ALL.iter().map(|s| format!("{s:?}")).collect())),
        "aura" => ("style", names(AuraStyle::ALL.iter().map(|s| format!("{s:?}")).collect())),
        "beam" => ("style", names(BeamStyle::ALL.iter().map(|s| format!("{s:?}")).collect())),
        "smoke" => ("style", names(SmokeStyle::ALL.iter().map(|s| format!("{s:?}")).collect())),
        _ => ("style", names(ExplosionStyle::ALL.iter().map(|s| format!("{s:?}")).collect())),
    }
}

/// The style's saved index and name.
fn style_of(r: &Request) -> Result<(&'static str, usize, String), String> {
    let (param, names) = styles(&r.kind);
    let Some(style) = &r.style else { return Ok((param, 0, names[0].clone())) };
    let wanted = style.to_lowercase().replace([' ', '-', '_'], "");
    let index = match wanted.parse::<usize>() {
        Ok(i) if i < names.len() => i,
        _ => names.iter().position(|n| *n == wanted).ok_or_else(|| format!("unknown {param} {style:?}: {}", names.join(", ")))?,
    };
    Ok((param, index, names[index].clone()))
}

/// The review document: one stick figure doing `r.motion`, one clip of the effect.
fn stage(r: &Request, background: &(String, u32)) -> Result<Stage, String> {
    let (param, index, _) = style_of(r)?;
    let motion = Motion::parse(&r.motion).ok_or_else(|| format!("unknown motion {:?}: still, walk, run, arms or vanish", r.motion))?;
    let last = r.ticks.iter().copied().fold(0.0f64, f64::max).max(r.until.unwrap_or(0.0)) + 2.0;
    let mut clip = Clip::new(if r.scene { None } else { Some(1) }, &r.kind).set(param, &index.to_string()).timed(r.start, r.duration);
    for (k, v) in &r.sets {
        clip = clip.set(k, v);
    }
    let mut stage = Stage::new(last).clip(clip);
    stage.background = background.1;
    if background.0 == "picture" {
        stage.picture = Some(picture());
    }
    stage.figures[0].motion = motion;
    Ok(stage)
}

fn prepared(r: &Request, background: &(String, u32)) -> Result<Prepared, String> {
    let json = stage(r, background)?.json();
    let doc = styk_eval::open_bytes(json.as_bytes(), "json", "vfx review").map_err(|e| e.to_string())?;
    Ok(styk_eval::prepare(doc))
}

/// Where zoomed views look: `--focus`, else the effect's own place.
fn focus(r: &Request) -> [f64; 2] {
    if let Some(f) = r.focus {
        return f;
    }
    let num = |name: &str| r.sets.iter().find(|(k, _)| k == name).and_then(|(_, v)| v.parse::<f64>().ok());
    if r.scene {
        return [num("x").unwrap_or(0.5) * CANVAS[0], num("y").unwrap_or(0.5) * CANVAS[1]];
    }
    match r.kind.as_str() {
        "beam" => [HIP[0] + 60.0, HIP[1] - 40.0],
        "smoke" => [HIP[0], HIP[1] - 30.0],
        _ => [HIP[0], HIP[1] - 50.0],
    }
}

/// Draws frames of one document.
enum Painter {
    Gpu { device: styk_render::wgpu::Device, queue: styk_render::wgpu::Queue, renderer: Box<styk_render::Renderer>, name: String },
    Cpu { images: styk_raster::Images },
}

impl Painter {
    fn new(p: &Prepared, assets: &styk_eval::assets::Assets, cpu: bool) -> Result<Painter, String> {
        if cpu {
            return Ok(Painter::Cpu { images: styk_raster::decode_all(&p.doc, assets) });
        }
        use styk_render::wgpu;
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions { power_preference: wgpu::PowerPreference::HighPerformance, ..Default::default() })).map_err(|e| format!("no GPU adapter: {e}"))?;
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor { label: Some("styk vfx-review"), required_limits: adapter.limits(), ..Default::default() })).map_err(|e| e.to_string())?;
        let images = styk_render::decode_images(&p.doc, assets);
        let mut renderer = Box::new(styk_render::Renderer::new(&device, &queue, wgpu::TextureFormat::Rgba8Unorm));
        renderer.prepare_sprites(assets);
        renderer.upload_images(assets, &images);
        Ok(Painter::Gpu { device, queue, renderer, name: adapter.get_info().name })
    }

    fn name(&self) -> String {
        match self {
            Painter::Gpu { name, .. } => format!("GPU {name}"),
            Painter::Cpu { .. } => "CPU styk-raster".into(),
        }
    }

    /// One picture of `size` pixels: tick `tick` at `zoom`, centred on `center` (canvas units); straight RGBA.
    fn frame(&mut self, p: &Prepared, assets: &styk_eval::assets::Assets, tick: f64, zoom: f64, center: [f64; 2], size: [u32; 2]) -> Vec<u8> {
        let frame = p.evaluate(tick);
        let scene = build(&p.doc, &frame);
        let list = std::sync::Arc::new(crate::encode_frame(p, assets, tick, &frame, &scene, false, true));
        let pan = [size[0] as f64 / 2.0 - center[0] * zoom, size[1] as f64 / 2.0 - center[1] * zoom];
        let (cw, ch) = (p.doc.canvas[0] as f64, p.doc.canvas[1] as f64);
        let view = styk_render::ViewParams {
            matrix: styk_eval::view::camera_matrix(&p.doc, scene.camera.as_ref(), zoom, pan),
            artboard: [pan[0], pan[1], pan[0] + cw * zoom, pan[1] + ch * zoom],
            clip_to_artboard: true,
            clear: [0.5, 0.5, 0.52, 1.0],
            zoom,
            pan,
            stretch: 1.0,
            camera_view: true,
            camera_limit: styk_render::CAMERA_PREVIEW_LIMIT,
        };
        match self {
            Painter::Cpu { images } => styk_raster::render(&list, images, &view, size, styk_raster::Edges::Smooth).straight(),
            Painter::Gpu { device, queue, renderer, .. } => {
                renderer.set_list(&list);
                let mut encoder = device.create_command_encoder(&Default::default());
                renderer.render(&mut encoder, &view, size);
                queue.submit([encoder.finish()]);
                let (_, _, pixels) = styk_render::read_frame(device, queue, renderer.frame_texture().unwrap());
                pixels
            }
        }
    }
}

/// A picture being assembled: straight RGBA.
struct Sheet {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
}

impl Sheet {
    fn new(width: u32, height: u32, fill: [u8; 3]) -> Sheet {
        let mut pixels = Vec::with_capacity((width * height * 4) as usize);
        for _ in 0..width * height {
            pixels.extend_from_slice(&[fill[0], fill[1], fill[2], 255]);
        }
        Sheet { width, height, pixels }
    }

    fn paste(&mut self, x: u32, y: u32, w: u32, h: u32, src: &[u8]) {
        for row in 0..h.min(self.height.saturating_sub(y)) {
            let n = w.min(self.width.saturating_sub(x)) as usize * 4;
            let from = (row * w) as usize * 4;
            let to = ((y + row) * self.width + x) as usize * 4;
            self.pixels[to..to + n].copy_from_slice(&src[from..from + n]);
        }
    }

    fn rect(&mut self, x: u32, y: u32, w: u32, h: u32, c: [u8; 3]) {
        for yy in y..(y + h).min(self.height) {
            for xx in x..(x + w).min(self.width) {
                let o = ((yy * self.width + xx) * 4) as usize;
                self.pixels[o..o + 3].copy_from_slice(&c);
                self.pixels[o + 3] = 255;
            }
        }
    }

    /// Text in the 5 × 7 font, `scale` pixels a dot, on a plate behind it.
    fn text(&mut self, x: u32, y: u32, text: &str, scale: u32, color: [u8; 3], plate: Option<[u8; 3]>) {
        let w = text.chars().count() as u32 * 6 * scale;
        if let Some(p) = plate {
            self.rect(x.saturating_sub(scale * 2), y.saturating_sub(scale * 2), w + scale * 3, 7 * scale + scale * 4, p);
        }
        for (i, ch) in text.chars().enumerate() {
            let rows = glyph(ch.to_ascii_uppercase());
            for (ry, bits) in rows.iter().enumerate() {
                for rx in 0..5 {
                    if bits >> (4 - rx) & 1 == 1 {
                        self.rect(x + (i as u32 * 6 + rx) * scale, y + ry as u32 * scale, scale, scale, color);
                    }
                }
            }
        }
    }

    fn save(&self, path: &str) -> Result<(), String> {
        image::save_buffer(path, &self.pixels, self.width, self.height, image::ColorType::Rgba8).map_err(|e| format!("{path}: {e}"))
    }
}

/// The 5 × 7 font: rows of five bits.
fn glyph(c: char) -> [u8; 7] {
    match c {
        'A' => [14, 17, 17, 31, 17, 17, 17],
        'B' => [30, 17, 17, 30, 17, 17, 30],
        'C' => [14, 17, 16, 16, 16, 17, 14],
        'D' => [30, 17, 17, 17, 17, 17, 30],
        'E' => [31, 16, 16, 30, 16, 16, 31],
        'F' => [31, 16, 16, 30, 16, 16, 16],
        'G' => [14, 17, 16, 23, 17, 17, 15],
        'H' => [17, 17, 17, 31, 17, 17, 17],
        'I' => [14, 4, 4, 4, 4, 4, 14],
        'J' => [7, 2, 2, 2, 2, 18, 12],
        'K' => [17, 18, 20, 24, 20, 18, 17],
        'L' => [16, 16, 16, 16, 16, 16, 31],
        'M' => [17, 27, 21, 21, 17, 17, 17],
        'N' => [17, 17, 25, 21, 19, 17, 17],
        'O' => [14, 17, 17, 17, 17, 17, 14],
        'P' => [30, 17, 17, 30, 16, 16, 16],
        'Q' => [14, 17, 17, 17, 21, 18, 13],
        'R' => [30, 17, 17, 30, 20, 18, 17],
        'S' => [15, 16, 16, 14, 1, 1, 30],
        'T' => [31, 4, 4, 4, 4, 4, 4],
        'U' => [17, 17, 17, 17, 17, 17, 14],
        'V' => [17, 17, 17, 17, 17, 10, 4],
        'W' => [17, 17, 17, 21, 21, 21, 10],
        'X' => [17, 17, 10, 4, 10, 17, 17],
        'Y' => [17, 17, 10, 4, 4, 4, 4],
        'Z' => [31, 1, 2, 4, 8, 16, 31],
        '0' => [14, 17, 19, 21, 25, 17, 14],
        '1' => [4, 12, 4, 4, 4, 4, 14],
        '2' => [14, 17, 1, 2, 4, 8, 31],
        '3' => [31, 2, 4, 2, 1, 17, 14],
        '4' => [2, 6, 10, 18, 31, 2, 2],
        '5' => [31, 16, 30, 1, 1, 17, 14],
        '6' => [6, 8, 16, 30, 17, 17, 14],
        '7' => [31, 1, 2, 4, 8, 8, 8],
        '8' => [14, 17, 17, 14, 17, 17, 14],
        '9' => [14, 17, 17, 15, 1, 2, 12],
        '.' => [0, 0, 0, 0, 0, 12, 12],
        ',' => [0, 0, 0, 0, 12, 4, 8],
        ':' => [0, 12, 12, 0, 12, 12, 0],
        '=' => [0, 0, 31, 0, 31, 0, 0],
        '-' => [0, 0, 0, 31, 0, 0, 0],
        '+' => [0, 4, 4, 31, 4, 4, 0],
        '/' => [1, 1, 2, 4, 8, 16, 16],
        '(' => [2, 4, 8, 8, 8, 4, 2],
        ')' => [8, 4, 2, 2, 2, 4, 8],
        '#' => [10, 10, 31, 10, 31, 10, 10],
        '%' => [24, 25, 2, 4, 8, 19, 3],
        '*' => [0, 4, 21, 14, 21, 4, 0],
        '_' => [0, 0, 0, 0, 0, 0, 31],
        _ => [0; 7],
    }
}

pub fn run(args: &[String]) -> i32 {
    let done = if args.first().is_some_and(|a| a == "shapes") { shapes(&args[1..]) } else { review(args) };
    match done {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("vfx-review: {e}");
            2
        }
    }
}

fn review(args: &[String]) -> Result<(), String> {
    let r = parse(args)?;
    let started = Instant::now();
    let (_, _, style) = style_of(&r)?;
    if let Some(path) = &r.save {
        std::fs::write(path, stage(&r, &r.backgrounds[0])?.json()).map_err(|e| format!("{path}: {e}"))?;
    }
    let centre = focus(&r);
    if let Some(folder) = &r.seq {
        std::fs::create_dir_all(folder).map_err(|e| format!("{folder}: {e}"))?;
        let p = prepared(&r, &r.backgrounds[0])?;
        let assets = styk_eval::assets::Assets::build(&p.doc);
        let mut painter = Painter::new(&p, &assets, r.cpu)?;
        let zoom = r.zooms[0];
        let until = r.until.unwrap_or_else(|| r.ticks.iter().copied().fold(0.0, f64::max));
        let first = r.start.floor() as i64;
        let centre = if zoom <= 1.0 { [CANVAS[0] / 2.0, CANVAS[1] / 2.0] } else { centre };
        for (n, tick) in (first..=until as i64).enumerate() {
            let pixels = painter.frame(&p, &assets, tick as f64, zoom, centre, r.cell);
            let path = Path::new(folder).join(format!("frame-{n:04}.png"));
            image::save_buffer(&path, &pixels, r.cell[0], r.cell[1], image::ColorType::Rgba8).map_err(|e| format!("{}: {e}", path.display()))?;
        }
        println!("{} frames ({} to {until}) of {} {style} → {folder} ({}, {:.1} s)", until as i64 - first + 1, first, r.kind, painter.name(), started.elapsed().as_secs_f64());
        return Ok(());
    }
    let [cw, ch] = r.cell;
    let (label_h, header_h, gap) = (22u32, 46u32, 4u32);
    let rows: Vec<(usize, f64)> = r.zooms.iter().flat_map(|&z| (0..r.backgrounds.len()).map(move |b| (b, z))).collect();
    let width = 150 + r.ticks.len() as u32 * (cw + gap);
    let height = header_h + rows.len() as u32 * (ch + label_h + gap);
    let mut sheet = Sheet::new(width, height, [40, 41, 46]);
    let sets = r.sets.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(" ");
    let mut painter_name = String::new();
    for (b, bg) in r.backgrounds.iter().enumerate() {
        let (bg_name, _) = bg;
        let p = prepared(&r, bg)?;
        let assets = styk_eval::assets::Assets::build(&p.doc);
        let mut painter = Painter::new(&p, &assets, r.cpu)?;
        painter_name = painter.name();
        for (row, &(rb, zoom)) in rows.iter().enumerate() {
            if rb != b {
                continue;
            }
            let y = header_h + row as u32 * (ch + label_h + gap);
            sheet.text(8, y + label_h + ch / 2 - 10, &bg_name.to_uppercase(), 2, [235, 235, 240], None);
            sheet.text(8, y + label_h + ch / 2 + 10, &format!("{zoom}X"), 2, [235, 235, 240], None);
            let centre = if zoom <= 1.0 { centre_for_unit(centre) } else { centre };
            for (col, &tick) in r.ticks.iter().enumerate() {
                let x = 150 + col as u32 * (cw + gap);
                let pixels = painter.frame(&p, &assets, tick, zoom, centre, r.cell);
                sheet.paste(x, y + label_h, cw, ch, &pixels);
                sheet.text(x + 4, y + 6, &format!("T {}", tick - r.start), 2, [235, 235, 240], None);
            }
        }
    }
    let title = format!("{} {style} {} {}  MOTION {}  {}", r.kind, if r.scene { "SCENE" } else { "" }, sets, r.motion, painter_name);
    sheet.text(10, 12, &title, 2, [255, 214, 120], None);
    sheet.save(&r.out)?;
    println!("{} × {} pictures of {} {style} → {} ({}, {:.1} s)", rows.len(), r.ticks.len(), r.kind, r.out, painter_name, started.elapsed().as_secs_f64());
    Ok(())
}

/// At 1× the view keeps the focus in frame but leans toward the canvas centre, so the whole effect shows.
fn centre_for_unit(focus: [f64; 2]) -> [f64; 2] {
    [(focus[0] + CANVAS[0] / 2.0) / 2.0, (focus[1] + CANVAS[1] / 2.0) / 2.0]
}

/// `styk vfx-review shapes [--sizes 5,18,60] [--columns 8] [--out sheet.png]`: every particle shape and material at
/// three sizes, on white and on dark, drawn by the graphics card and by the processor, labelled.
fn shapes(args: &[String]) -> Result<(), String> {
    use styk_eval::vfx::generated::stage::{specimen_list, specimens};
    let value = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let sizes: Vec<f32> = value("--sizes").map_or(Ok(vec![5.0, 18.0, 60.0]), |v| v.split(',').map(|s| s.trim().parse::<f32>().map_err(|e| format!("--sizes: {e}"))).collect())?;
    let columns: usize = value("--columns").map_or(Ok(8), |v| v.parse().map_err(|e| format!("--columns: {e}")))?;
    let out = value("--out").unwrap_or_else(|| "vfx-shapes.png".into());
    let started = Instant::now();
    styk_eval::vfx::generated::atlas::prepare();
    let backgrounds = [("WHITE", 0xffffffffu32), ("DARK", 0xff14161cu32)];
    let (probe, [w, h]) = specimens(backgrounds[0].1, &sizes, columns);
    drop(probe);
    let label_h = 26u32;
    let mut sheet = Sheet::new(w + 140, (h + label_h) * 4 + 50, [40, 41, 46]);
    sheet.text(10, 14, "PARTICLE SHAPES AND MATERIALS AT THREE SIZES: GRAPHICS CARD AND PROCESSOR", 2, [255, 214, 120], None);
    use styk_render::wgpu;
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions { power_preference: wgpu::PowerPreference::HighPerformance, ..Default::default() })).map_err(|e| format!("no GPU adapter: {e}"))?;
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor { label: Some("styk vfx-review shapes"), required_limits: adapter.limits(), ..Default::default() })).map_err(|e| e.to_string())?;
    let view = styk_render::ViewParams { matrix: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0], artboard: [0.0, 0.0, w as f64, h as f64], clip_to_artboard: true, clear: [0.0; 4], zoom: 1.0, pan: [0.0; 2], stretch: 1.0, camera_view: false, camera_limit: styk_render::CAMERA_PREVIEW_LIMIT };
    let list_of = specimen_list();
    let cells = list_of.len();
    let mut row = 0u32;
    for (name, argb) in backgrounds {
        let (list, _) = specimens(argb, &sizes, columns);
        let list = std::sync::Arc::new(list);
        let mut renderer = styk_render::Renderer::new(&device, &queue, wgpu::TextureFormat::Rgba8Unorm);
        renderer.set_list(&list);
        let mut encoder = device.create_command_encoder(&Default::default());
        renderer.render(&mut encoder, &view, [w, h]);
        queue.submit([encoder.finish()]);
        let (_, _, gpu) = styk_render::read_frame(&device, &queue, renderer.frame_texture().unwrap());
        let cpu = styk_raster::render(&list, &styk_raster::Images::default(), &view, [w, h], styk_raster::Edges::Smooth).straight();
        for (who, pixels) in [("GPU", gpu), ("CPU", cpu)] {
            let y = 50 + row * (h + label_h);
            sheet.text(8, y + label_h + h / 2 - 8, &format!("{name} {who}"), 2, [235, 235, 240], None);
            sheet.paste(140, y + label_h, w, h, &pixels);
            let cell_w = w / columns as u32;
            let cell_h = h / cells.div_ceil(columns) as u32;
            for (i, sp) in list_of.iter().enumerate() {
                sheet.text(140 + (i % columns) as u32 * cell_w + 6, y + label_h + (i / columns) as u32 * cell_h + 4, sp.label, 1, if argb == 0xffffffff { [70, 70, 80] } else { [200, 200, 210] }, None);
            }
            row += 1;
        }
    }
    sheet.save(&out)?;
    println!("{cells} shapes and materials at sizes {sizes:?} → {out} ({:.1} s)", started.elapsed().as_secs_f64());
    Ok(())
}

/// The `picture` background: a mid-tone landscape of the stage's size (a hazy sky with clouds, hills, a textured
/// field and a path), as a PNG data URL. Effects must read over a picture as well as over flat colours.
fn picture() -> String {
    let (w, h) = (CANVAS[0] as u32, CANVAS[1] as u32);
    let hash = |x: i32, y: i32| -> f64 {
        let mut v = (x as u32).wrapping_mul(374761393) ^ (y as u32).wrapping_mul(668265263);
        v = (v ^ (v >> 13)).wrapping_mul(1274126177);
        ((v ^ (v >> 16)) & 0xffff) as f64 / 65535.0
    };
    let noise = |x: f64, y: f64| -> f64 {
        let (xi, yi) = (x.floor(), y.floor());
        let (fx, fy) = (x - xi, y - yi);
        let (sx, sy) = (fx * fx * (3.0 - 2.0 * fx), fy * fy * (3.0 - 2.0 * fy));
        let at = |dx: i32, dy: i32| hash(xi as i32 + dx, yi as i32 + dy);
        let top = at(0, 0) + (at(1, 0) - at(0, 0)) * sx;
        let bottom = at(0, 1) + (at(1, 1) - at(0, 1)) * sx;
        top + (bottom - top) * sy
    };
    let fbm = |x: f64, y: f64| (0..4).map(|o| noise(x * (1 << o) as f64, y * (1 << o) as f64) / (1 << o) as f64).sum::<f64>() / 1.875;
    let mix = |a: [f64; 3], b: [f64; 3], t: f64| [0, 1, 2].map(|i| a[i] + (b[i] - a[i]) * t.clamp(0.0, 1.0));
    let mut pixels = Vec::with_capacity((w * h * 3) as usize);
    for y in 0..h {
        for x in 0..w {
            let (fx, fy) = (x as f64, y as f64);
            let hills = 205.0 + 22.0 * (fx * 0.011).sin() + 12.0 * (fx * 0.027 + 1.3).sin();
            let c = if fy < hills {
                let sky = mix([112.0, 140.0, 168.0], [178.0, 182.0, 172.0], fy / hills);
                let cloud = ((fbm(fx * 0.012, fy * 0.03) - 0.52) * 3.0).clamp(0.0, 1.0) * (1.0 - fy / hills);
                mix(sky, [214.0, 216.0, 214.0], cloud)
            } else if fy < hills + 40.0 {
                mix([92.0, 108.0, 100.0], [104.0, 116.0, 84.0], (fy - hills) / 40.0)
            } else {
                let field = mix([116.0, 122.0, 78.0], [84.0, 90.0, 58.0], (fy - hills - 40.0) / 160.0);
                let grain = fbm(fx * 0.08, fy * 0.2) - 0.5;
                let path = (1.0 - ((fx - 320.0 - (fy - 300.0) * 0.6).abs() / (30.0 + (fy - 245.0) * 0.5)).clamp(0.0, 1.0)) * 0.8;
                mix(field.map(|v| v * (1.0 + grain * 0.35)), [150.0, 134.0, 108.0], path)
            };
            pixels.extend(c.map(|v| v.round().clamp(0.0, 255.0) as u8));
        }
    }
    let mut png = Vec::new();
    use image::ImageEncoder;
    image::codecs::png::PngEncoder::new(&mut png).write_image(&pixels, w, h, image::ExtendedColorType::Rgb8).expect("a PNG in memory");
    let mut out = b"data:image/png;base64,".to_vec();
    styk_doc::json::base64_into(&png, &mut out);
    String::from_utf8(out).expect("base64 is ASCII")
}
