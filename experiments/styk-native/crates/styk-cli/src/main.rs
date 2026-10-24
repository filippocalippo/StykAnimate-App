//! Headless engine tools.
//!
//!   styk info <file>                      load timing, contents, unsupported features
//!   styk compare <file> <reference.json>  primitive-by-primitive parity with the JS editor
//!   styk bench <file> [--frames N]        evaluation + geometry throughput

use std::path::Path;
use std::time::Instant;

use rayon::prelude::*;
use serde_json::Value;
use styk_core::eval::Prepared;
use styk_core::geometry::{build, ItemKind, Scene};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match args.first().map(String::as_str) {
        Some("info") if args.len() >= 2 => info(&args[1]),
        Some("compare") if args.len() >= 3 => compare(&args[1], &args[2], &args[3..]),
        Some("bench") if args.len() >= 2 => bench(&args[1], &args[2..]),
        Some("render") if args.len() >= 4 => render(&args[1], &args[2], &args[3], &args[4..]),
        Some("gpubench") if args.len() >= 3 => gpubench(&args[1], &args[2]),
        Some("diff") if args.len() >= 4 => diff(&args[1], &args[2], &args[3], &args[4..]),
        _ => {
            eprintln!("usage: styk info <file> | compare <file> <reference.json> [--verbose] | bench <file> [--frames N] | render <file> <tick> <out.png> [--size WxH] [--zoom Z] [--center X,Y]");
            2
        }
    };
    std::process::exit(code);
}

fn load(path: &str) -> Result<(Prepared, f64), String> {
    let started = Instant::now();
    let doc = styk_core::open(Path::new(path)).map_err(|e| format!("{path}: {e}"))?;
    let t0 = Instant::now();
    let prepared = styk_core::prepare(doc);
    if std::env::var_os("STYK_TIMING").is_some() {
        eprintln!("  prepare (timelines, presence index) {:.1} ms", t0.elapsed().as_secs_f64() * 1000.0);
    }
    Ok((prepared, started.elapsed().as_secs_f64() * 1000.0))
}

fn info(path: &str) -> i32 {
    let (p, ms) = match load(path) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            return 1;
        }
    };
    let d = &p.doc;
    println!("{}: version {}, {}x{}, {} fps, {} ticks", d.name, d.version, d.canvas[0], d.canvas[1], d.fps, p.total_ticks);
    println!(
        "  {} figures ({} segments), {} keyframes, {} objects, {} images, {} pose sources{}",
        d.figures.len(),
        d.segment_count(),
        d.keyframes.len(),
        d.keyframes.iter().map(|k| k.objects.len()).sum::<usize>(),
        d.images.len(),
        d.frame_sources.len(),
        if d.sheet.is_some() { ", layer sheet" } else { "" }
    );
    println!("  opened in {ms:.1} ms");
    if !d.unsupported.is_empty() {
        println!("  not evaluated yet: {}", d.unsupported.join(", "));
    }
    0
}

fn bench(path: &str, rest: &[String]) -> i32 {
    let (p, ms) = match load(path) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            return 1;
        }
    };
    let frames: u32 = rest.iter().position(|a| a == "--frames").and_then(|i| rest.get(i + 1)).and_then(|v| v.parse().ok()).unwrap_or(p.total_ticks);
    let frames = frames.min(p.total_ticks).max(1);
    println!("{}: opened in {ms:.1} ms, {} ticks", p.doc.name, p.total_ticks);
    // Warm up.
    let _ = build(&p.doc, &p.evaluate(0.0));
    let started = Instant::now();
    let mut items = 0usize;
    let mut worst = 0f64;
    for t in 0..frames {
        let s = Instant::now();
        let scene = build(&p.doc, &p.evaluate(t as f64));
        worst = worst.max(s.elapsed().as_secs_f64() * 1000.0);
        items += scene.items.len();
    }
    let serial = started.elapsed().as_secs_f64() * 1000.0;
    let started = Instant::now();
    let parallel_items: usize = (0..frames).into_par_iter().map(|t| build(&p.doc, &p.evaluate(t as f64)).items.len()).sum();
    let parallel = started.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(items, parallel_items);
    println!(
        "  one frame at a time: {:.3} ms/frame (worst {:.2} ms), {:.0} primitives/frame",
        serial / frames as f64,
        worst,
        items as f64 / frames as f64
    );
    println!(
        "  all cores ({} threads): {:.3} ms/frame → {:.0} frames/s of evaluation",
        rayon::current_num_threads(),
        parallel / frames as f64,
        frames as f64 / (parallel / 1000.0)
    );
    0
}

fn kind_name(k: ItemKind) -> &'static str {
    k.name()
}

fn pt(v: &Value) -> Option<[f64; 2]> {
    let a = v.as_array()?;
    Some([a.first()?.as_f64()?, a.get(1)?.as_f64()?])
}

fn close(a: [f64; 2], b: [f64; 2], tol: f64) -> bool {
    (a[0] - b[0]).abs() <= tol && (a[1] - b[1]).abs() <= tol
}

fn compare(path: &str, reference: &str, rest: &[String]) -> i32 {
    let verbose = rest.iter().any(|a| a == "--verbose");
    let (p, _) = match load(path) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            return 1;
        }
    };
    let text = match std::fs::read_to_string(reference) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("{reference}: {e}");
            return 1;
        }
    };
    let r: Value = serde_json::from_str(&text).expect("reference JSON");
    let ref_total = r["totalTicks"].as_u64().unwrap_or(0) as u32;
    if ref_total != p.total_ticks {
        println!("total ticks differ: reference {ref_total}, engine {}", p.total_ticks);
    }
    let tol = 2e-3;
    let mut frames = 0;
    let mut bad_frames = 0;
    let mut total = 0usize;
    let mut mismatched = 0usize;
    let mut first_reports = 0;
    for f in r["frames"].as_array().unwrap() {
        let tick = f["tick"].as_f64().unwrap();
        let scene: Scene = build(&p.doc, &p.evaluate(tick));
        let expected = f["drawables"].as_array().unwrap();
        frames += 1;
        total += expected.len();
        let mut problems: Vec<String> = Vec::new();
        if expected.len() != scene.items.len() {
            problems.push(format!("drawable count: reference {}, engine {}", expected.len(), scene.items.len()));
        }
        for (i, (e, it)) in expected.iter().zip(scene.items.iter()).enumerate() {
            let uid = scene.objects[it.slot as usize].uid;
            let mut why = Vec::new();
            if e["uid"].as_u64() != Some(uid as u64) {
                why.push(format!("uid {} vs {}", e["uid"], uid));
            }
            if e["type"].as_str() != Some(kind_name(it.kind)) {
                why.push(format!("type {} vs {}", e["type"], kind_name(it.kind)));
            }
            if let Some(z) = e["z"].as_f64()
                && (z - it.z).abs() > 1e-6
            {
                why.push(format!("z {z} vs {}", it.z));
            }
            let rgb: Vec<u8> = e["rgb"].as_array().map(|a| a.iter().filter_map(|v| v.as_u64().map(|x| x as u8)).collect()).unwrap_or_default();
            if rgb.len() == 3 && rgb != it.rgb {
                why.push(format!("rgb {rgb:?} vs {:?}", it.rgb));
            }
            for (key, value) in [("alpha", it.alpha), ("opacity", it.opacity)] {
                if let Some(v) = e[key].as_f64()
                    && (v - value).abs() > 1e-4
                {
                    why.push(format!("{key} {v} vs {value}"));
                }
            }
            if it.kind == ItemKind::Poly {
                let pts: Vec<[f64; 2]> = e["points"].as_array().map(|a| a.iter().filter_map(pt).collect()).unwrap_or_default();
                let ours = scene.points_of(it);
                if pts.len() != ours.len() {
                    why.push(format!("poly points {} vs {}", pts.len(), ours.len()));
                } else if let Some(k) = (0..pts.len()).find(|&k| !close(pts[k], ours[k], tol)) {
                    why.push(format!("poly point {k} {:?} vs {:?}", pts[k], ours[k]));
                }
            } else {
                if let (Some(s), Some(en)) = (pt(&e["start"]), pt(&e["end"])) {
                    if !close(s, it.start, tol) {
                        why.push(format!("start {s:?} vs {:?}", it.start));
                    }
                    if !close(en, it.end, tol) {
                        why.push(format!("end {en:?} vs {:?}", it.end));
                    }
                }
                if let Some(th) = e["thickness"].as_f64()
                    && (th - it.thickness).abs() > tol
                {
                    why.push(format!("thickness {th} vs {}", it.thickness));
                }
            }
            if !why.is_empty() {
                mismatched += 1;
                if problems.len() < 6 {
                    problems.push(format!("#{i} {} uid {} seg/poly {}: {}", kind_name(it.kind), uid, it.index, why.join("; ")));
                }
            }
        }
        if !problems.is_empty() {
            bad_frames += 1;
            if verbose || first_reports < 3 {
                first_reports += 1;
                println!("tick {tick}:");
                for p in &problems {
                    println!("  {p}");
                }
            }
        }
    }
    println!(
        "{}: {frames} frames, {total} reference primitives, {mismatched} mismatched primitives, {bad_frames} frames with differences",
        Path::new(path).file_name().unwrap().to_string_lossy()
    );
    if bad_frames == 0 { 0 } else { 3 }
}

fn option<'a>(rest: &'a [String], name: &str) -> Option<&'a str> {
    rest.iter().position(|a| a == name).and_then(|i| rest.get(i + 1)).map(String::as_str)
}

/// Renders one tick headlessly through the GPU renderer and writes a PNG.
fn render(path: &str, tick: &str, out: &str, rest: &[String]) -> i32 {
    use styk_core::assets::Assets;
    use styk_core::drawlist::encode;
    use styk_core::view::camera_matrix;
    use styk_render::{wgpu, Renderer, ViewParams};
    let (p, ms) = match load(path) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            return 1;
        }
    };
    let tick: f64 = tick.parse().unwrap_or(0.0);
    let (w, h) = option(rest, "--size")
        .and_then(|s| s.split_once('x'))
        .and_then(|(a, b)| Some((a.parse::<u32>().ok()?, b.parse::<u32>().ok()?)))
        .unwrap_or((p.doc.canvas[0] + 80, p.doc.canvas[1] + 80));
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let adapter = match pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        compatible_surface: None,
        force_fallback_adapter: false,
        ..Default::default()
    })) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("No GPU adapter: {e}");
            return 1;
        }
    };
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("styk cli"),
        required_limits: adapter.limits(),
        ..Default::default()
    }))
    .expect("device");
    let started = Instant::now();
    let assets = Assets::build(&p.doc);
    let images = styk_render::decode_images(&p.doc, &assets);
    let assets_ms = started.elapsed().as_secs_f64() * 1000.0;
    let mut renderer = Renderer::new(&device, &queue, wgpu::TextureFormat::Rgba8Unorm);
    renderer.prepare_sprites(&assets);
    renderer.upload_images(&assets, &images);
    let started = Instant::now();
    let frame = p.evaluate(tick);
    let scene = build(&p.doc, &frame);
    let list = std::sync::Arc::new(encode(&p.doc, &assets, &scene));
    let encode_ms = started.elapsed().as_secs_f64() * 1000.0;
    let (cw, ch) = (p.doc.canvas[0] as f64, p.doc.canvas[1] as f64);
    let zoom = option(rest, "--zoom").and_then(|z| z.parse::<f64>().ok()).unwrap_or_else(|| ((w as f64 - 40.0) / cw).min((h as f64 - 40.0) / ch));
    let center = option(rest, "--center")
        .and_then(|s| s.split_once(','))
        .and_then(|(a, b)| Some([a.parse::<f64>().ok()?, b.parse::<f64>().ok()?]))
        .unwrap_or([cw / 2.0, ch / 2.0]);
    let pan = [w as f64 / 2.0 - center[0] * zoom, h as f64 / 2.0 - center[1] * zoom];
    let matrix = camera_matrix(&p.doc, scene.camera.as_ref(), zoom, pan);
    let view = ViewParams {
        matrix,
        artboard: [pan[0], pan[1], pan[0] + cw * zoom, pan[1] + ch * zoom],
        clip_to_artboard: !rest.iter().any(|a| a == "--no-clip"),
        clear: [0.16, 0.16, 0.17, 1.0],
    };
    renderer.set_list(&list);
    let mut encoder = device.create_command_encoder(&Default::default());
    renderer.render(&mut encoder, &view, [w, h]);
    queue.submit([encoder.finish()]);
    let (fw, fh, pixels) = styk_render::read_frame(&device, &queue, renderer.frame_texture().unwrap());
    image::save_buffer(out, &pixels, fw, fh, image::ColorType::Rgba8).expect("write png");
    println!(
        "{}: tick {tick}, {} prims, {} groups, {} passes, opened {ms:.0} ms, assets {assets_ms:.0} ms, frame {encode_ms:.2} ms → {out} ({})",
        p.doc.name,
        renderer.stats.prims,
        renderer.stats.groups,
        renderer.stats.passes,
        adapter.get_info().name
    );
    0
}

/// Compares two renders inside an optional rectangle (`--rect x0,y0,x1,y1`).
fn diff(a: &str, b: &str, out: &str, rest: &[String]) -> i32 {
    let (Ok(ia), Ok(ib)) = (image::open(a), image::open(b)) else {
        eprintln!("cannot read inputs");
        return 1;
    };
    let (ia, ib) = (ia.to_rgba8(), ib.to_rgba8());
    let (w, h) = (ia.width().min(ib.width()), ia.height().min(ib.height()));
    let rect: [u32; 4] = option(rest, "--rect")
        .and_then(|s| {
            let v: Vec<u32> = s.split(',').filter_map(|x| x.parse().ok()).collect();
            (v.len() == 4).then(|| [v[0], v[1], v[2].min(w), v[3].min(h)])
        })
        .unwrap_or([0, 0, w, h]);
    let mut img = image::RgbaImage::new(w, h);
    let (mut total, mut count, mut over8, mut over32) = (0f64, 0u64, 0u64, 0u64);
    for y in rect[1]..rect[3] {
        for x in rect[0]..rect[2] {
            let (pa, pb) = (ia.get_pixel(x, y).0, ib.get_pixel(x, y).0);
            let d = (0..3).map(|c| (pa[c] as i32 - pb[c] as i32).abs()).max().unwrap();
            total += d as f64;
            count += 1;
            if d > 8 {
                over8 += 1;
            }
            if d > 32 {
                over32 += 1;
            }
            let g = (pa[0] as u32 + pa[1] as u32 + pa[2] as u32) / 12;
            img.put_pixel(x, y, if d > 32 { image::Rgba([255, 0, 64, 255]) } else if d > 8 { image::Rgba([255, 170, 0, 255]) } else { image::Rgba([g as u8, g as u8, g as u8, 255]) });
        }
    }
    img.save(out).expect("write diff");
    let n = count.max(1) as f64;
    println!(
        "mean |Δ| {:.3}/255, {:.3}% pixels differ by >8, {:.3}% by >32 ({} px compared) → {out}",
        total / n,
        over8 as f64 * 100.0 / n,
        over32 as f64 * 100.0 / n,
        count
    );
    0
}

/// GPU time per frame (submit + wait) across a fit → 11× zoom, at 1440×900.
fn gpubench(path: &str, tick: &str) -> i32 {
    use styk_core::assets::Assets;
    use styk_core::drawlist::encode;
    use styk_core::view::camera_matrix;
    use styk_render::{wgpu, Renderer, ViewParams};
    let (p, _) = match load(path) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            return 1;
        }
    };
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        ..Default::default()
    }))
    .expect("adapter");
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor { required_limits: adapter.limits(), ..Default::default() })).expect("device");
    let assets = Assets::build(&p.doc);
    let images = styk_render::decode_images(&p.doc, &assets);
    let mut renderer = Renderer::new(&device, &queue, wgpu::TextureFormat::Rgba8Unorm);
    renderer.prepare_sprites(&assets);
    renderer.upload_images(&assets, &images);
    let scene = build(&p.doc, &p.evaluate(tick.parse().unwrap_or(0.0)));
    let list = std::sync::Arc::new(encode(&p.doc, &assets, &scene));
    renderer.set_list(&list);
    let (w, h) = (1440u32, 900u32);
    let (cw, ch) = (p.doc.canvas[0] as f64, p.doc.canvas[1] as f64);
    let fit = ((w as f64 - 64.0) / cw).min((h as f64 - 64.0) / ch);
    let mut rows = Vec::new();
    for k in 0..=200 {
        let zoom = fit * (2.4 * k as f64 / 200.0).exp();
        let pan = [w as f64 / 2.0 - cw / 2.0 * zoom, h as f64 / 2.0 - ch / 2.0 * zoom];
        let view = ViewParams {
            matrix: camera_matrix(&p.doc, scene.camera.as_ref(), zoom, pan),
            artboard: [pan[0], pan[1], pan[0] + cw * zoom, pan[1] + ch * zoom],
            clip_to_artboard: true,
            clear: [0.07, 0.07, 0.09, 1.0],
        };
        let start = Instant::now();
        let mut encoder = device.create_command_encoder(&Default::default());
        renderer.render(&mut encoder, &view, [w, h]);
        queue.submit([encoder.finish()]);
        let _ = device.poll(wgpu::PollType::wait_indefinitely());
        if k > 0 {
            rows.push((zoom / fit, start.elapsed().as_secs_f64() * 1000.0, renderer.stats.passes, renderer.stats.groups));
        }
    }
    let mut times: Vec<f64> = rows.iter().map(|r| r.1).collect();
    times.sort_by(|a, b| a.total_cmp(b));
    println!(
        "{}: {} prims, GPU frame (submit+wait) p50 {:.2} ms, p95 {:.2} ms, max {:.2} ms over fit→11x ({})",
        p.doc.name,
        list.prims.len(),
        times[times.len() / 2],
        times[times.len() * 95 / 100],
        times[times.len() - 1],
        adapter.get_info().name
    );
    for r in rows.iter().step_by(40) {
        println!("  {:5.2}x  {:6.2} ms  {} passes  {} groups", r.0, r.1, r.2, r.3);
    }
    0
}
