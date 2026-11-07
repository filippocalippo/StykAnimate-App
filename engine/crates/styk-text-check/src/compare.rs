//! Chromium against native: widths, fonts picked and pixels, from the files both sheets wrote.
//!
//! Widths come from the two renderers' own layout (a Range rectangle; an iced paragraph) and must agree within
//! `WIDTH_TOLERANCE` for the scripts Inter covers and `FALLBACK_TOLERANCE` for the fallback scripts. Pixels are
//! compared as luminance in each row's cell: the error is the sum of absolute differences over the sum of the ink the
//! Chromium cell holds, at the same place and at the best shift of up to two pixels (a shift that helps is a baseline
//! or pitch difference, which the report names).

use crate::matrix::{self, PAGE_ROWS, PAGE_WIDTH, ROW_HEIGHT};
use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::Path;

/// Widest difference between Chromium's and the native width of a row Inter covers, in logical pixels.
pub const WIDTH_TOLERANCE: f32 = 0.5;
/// The same for the rows set in a fallback font (Arabic, Hebrew, Chinese, Japanese).
pub const FALLBACK_TOLERANCE: f32 = 1.0;

struct Measured {
    width: f32,
    fonts: String,
}

fn read_measurements(path: &Path) -> Result<BTreeMap<String, Measured>, String> {
    let text = std::fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
    text.lines()
        .map(|line| {
            let cells: Vec<&str> = line.split('\t').collect();
            if cells.len() < 3 {
                return Err(format!("{}: not a measurement: {line}", path.display()));
            }
            let width = cells[1].parse::<f32>().map_err(|error| format!("{}: {error}", path.display()))?;
            Ok((cells[0].to_string(), Measured { width, fonts: cells[2].to_string() }))
        })
        .collect()
}

struct Picture {
    width: usize,
    height: usize,
    rgba: Vec<u8>,
}

fn read_png(path: &Path) -> Result<Picture, String> {
    let file = std::fs::File::open(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let mut reader = png::Decoder::new(std::io::BufReader::new(file)).read_info().map_err(|error| format!("{}: {error}", path.display()))?;
    let mut buffer = vec![0; reader.output_buffer_size().ok_or("an image too large")?];
    let info = reader.next_frame(&mut buffer).map_err(|error| format!("{}: {error}", path.display()))?;
    let (width, height) = (info.width as usize, info.height as usize);
    let rgba = match info.color_type {
        png::ColorType::Rgba => buffer[..width * height * 4].to_vec(),
        png::ColorType::Rgb => buffer[..width * height * 3].chunks_exact(3).flat_map(|pixel| [pixel[0], pixel[1], pixel[2], 255]).collect(),
        other => return Err(format!("{}: unsupported colour type {other:?}", path.display())),
    };
    Ok(Picture { width, height, rgba })
}

impl Picture {
    fn luminance(&self, x: isize, y: isize, background: f32) -> f32 {
        if x < 0 || y < 0 || x as usize >= self.width || y as usize >= self.height {
            return background;
        }
        let at = (y as usize * self.width + x as usize) * 4;
        0.2126 * f32::from(self.rgba[at]) + 0.7152 * f32::from(self.rgba[at + 1]) + 0.0722 * f32::from(self.rgba[at + 2])
    }

    /// How coloured a pixel is: the spread of its channels. Grayscale text on a gray background has none; ClearType
    /// has colour fringes.
    fn chroma(&self, x: usize, y: usize) -> f32 {
        let at = (y * self.width + x) * 4;
        let (r, g, b) = (self.rgba[at], self.rgba[at + 1], self.rgba[at + 2]);
        f32::from(r.max(g).max(b) - r.min(g).min(b))
    }
}

/// The family a platform font name belongs to: Chromium names the face (`Segoe UI Semibold`), the native stack the family
/// (`Segoe UI`).
fn family(name: &str) -> &str {
    for style in [" Semibold", " Semilight", " Light", " Bold", " Black", " Medium", " Regular"] {
        if let Some(family) = name.strip_suffix(style) {
            return family;
        }
    }
    name
}

/// The fonts of a row as (family, glyphs) pairs, whichever order and face names the renderer reported them in.
fn font_identities(fonts: &str) -> BTreeMap<String, usize> {
    let mut identities = BTreeMap::new();
    for entry in fonts.split('|').filter(|entry| !entry.is_empty()) {
        let (name, glyphs) = entry.rsplit_once(':').unwrap_or((entry, "0"));
        *identities.entry(family(name).to_string()).or_default() += glyphs.parse::<usize>().unwrap_or(0);
    }
    identities
}

/// Whether two renderers drew a row with the same fonts, as many glyphs from each.
fn same_fonts(chromium: &str, native: &str) -> bool {
    font_identities(chromium) == font_identities(native)
}

/// What the pixels of one row say.
#[derive(Clone, Copy, Debug, Default)]
pub struct Ink {
    /// Sum of absolute luminance differences over Chromium's ink, at the same place.
    pub error: f32,
    /// The same at the best shift.
    pub best_error: f32,
    /// The shift (dx, dy) in pixels that gave `best_error`.
    pub shift: (i32, i32),
    /// Chromium's ink bounding box minus the native one: left, top, right, bottom, in pixels.
    pub bounds_delta: [i32; 4],
    /// The native ink (summed luminance distance from the background) over Chromium's: below 1 the native text is lighter.
    pub ink_ratio: f32,
    /// Mean colour spread of Chromium's ink pixels (0 for grayscale text).
    pub chromium_chroma: f32,
    /// The same natively.
    pub native_chroma: f32,
}

fn bounds(picture: &Picture, x0: usize, y0: usize, w: usize, h: usize, background: f32) -> Option<[i32; 4]> {
    let (mut left, mut top, mut right, mut bottom) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
    for y in 0..h {
        for x in 0..w {
            if (picture.luminance((x0 + x) as isize, (y0 + y) as isize, background) - background).abs() > 24.0 {
                left = left.min(x as i32);
                right = right.max(x as i32);
                top = top.min(y as i32);
                bottom = bottom.max(y as i32);
            }
        }
    }
    (left != i32::MAX).then_some([left, top, right, bottom])
}

fn mean_chroma(picture: &Picture, x0: usize, y0: usize, w: usize, h: usize, background: f32) -> f32 {
    let (mut total, mut count) = (0.0, 0);
    for y in 0..h {
        for x in 0..w {
            if (picture.luminance((x0 + x) as isize, (y0 + y) as isize, background) - background).abs() > 24.0 {
                total += picture.chroma(x0 + x, y0 + y);
                count += 1;
            }
        }
    }
    if count == 0 { 0.0 } else { total / count as f32 }
}

/// Compares one row's cell in the two pictures.
fn row_ink(chromium: &Picture, native: &Picture, row: usize, scale: f32) -> Ink {
    let cell_h = (ROW_HEIGHT * scale).round() as usize;
    let cell_w = (PAGE_WIDTH * scale).round() as usize;
    let y0 = row * cell_h;
    let background = chromium.luminance(cell_w as isize - 1, y0 as isize, 0.0);
    let ink: f32 = (0..cell_h).flat_map(|y| (0..cell_w).map(move |x| (x, y))).map(|(x, y)| (chromium.luminance(x as isize, (y0 + y) as isize, background) - background).abs()).sum();
    let difference = |dx: isize, dy: isize| -> f32 {
        (0..cell_h)
            .flat_map(|y| (0..cell_w).map(move |x| (x, y)))
            .map(|(x, y)| (chromium.luminance(x as isize, (y0 + y) as isize, background) - native.luminance(x as isize + dx, (y0 + y) as isize + dy, background)).abs())
            .sum()
    };
    let native_ink: f32 = (0..cell_h).flat_map(|y| (0..cell_w).map(move |x| (x, y))).map(|(x, y)| (native.luminance(x as isize, (y0 + y) as isize, background) - background).abs()).sum();
    let error = difference(0, 0);
    let (mut best_error, mut shift) = (error, (0, 0));
    for dy in -2..=2isize {
        for dx in -2..=2isize {
            let candidate = difference(dx, dy);
            if candidate < best_error {
                best_error = candidate;
                shift = (dx as i32, dy as i32);
            }
        }
    }
    let delta = match (bounds(chromium, 0, y0, cell_w, cell_h, background), bounds(native, 0, y0, cell_w, cell_h, background)) {
        (Some(c), Some(n)) => [c[0] - n[0], c[1] - n[1], c[2] - n[2], c[3] - n[3]],
        _ => [0; 4],
    };
    Ink {
        error: error / ink.max(1.0),
        best_error: best_error / ink.max(1.0),
        ink_ratio: native_ink / ink.max(1.0),
        shift,
        bounds_delta: delta,
        chromium_chroma: mean_chroma(chromium, 0, y0, cell_w, cell_h, background),
        native_chroma: mean_chroma(native, 0, y0, cell_w, cell_h, background),
    }
}

/// The outcome of comparing one theme at one scale.
pub struct Report {
    /// The table, as text.
    pub text: String,
    /// Whether every width and font check held.
    pub widths_hold: bool,
}

/// Compares `native-<label>` with `<chromium>-<label>` in `dir`, where `label` is `<theme>-<scale>`.
pub fn compare(matrix_path: &Path, dir: &Path, chromium: &str, label: &str, scale: f32) -> Result<Report, String> {
    let tsv = std::fs::read_to_string(matrix_path).map_err(|error| format!("{}: {error}", matrix_path.display()))?;
    let items = matrix::from_tsv(&tsv)?;
    let chromium_rows = read_measurements(&dir.join(format!("{chromium}-{label}.tsv")))?;
    let native_rows = read_measurements(&dir.join(format!("native-{label}.tsv")))?;

    let mut text = String::new();
    let mut widths_hold = true;
    let _ = writeln!(text, "== {chromium} against native, {label} ==");
    let _ = writeln!(text, "{:<34} {:>8} {:>8} {:>7} {:>6} {:>6} {:>7}  {}", "row", "chromium", "native", "dwidth", "ink", "best", "shift", "ink box delta (l t r b) / fonts");

    let mut pictures: BTreeMap<usize, (Picture, Picture)> = BTreeMap::new();
    let mut by_class: BTreeMap<&str, Vec<(f32, f32)>> = BTreeMap::new();
    let (mut chroma_chromium, mut chroma_native, mut chroma_rows) = (0.0, 0.0, 0);
    let mut shifted = 0;
    let mut ratios = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let (page, row) = (index / PAGE_ROWS, index % PAGE_ROWS);
        if !pictures.contains_key(&page) {
            let pair = (read_png(&dir.join(format!("{chromium}-{label}-p{page}.png")))?, read_png(&dir.join(format!("native-{label}-p{page}.png")))?);
            pictures.insert(page, pair);
        }
        let (c_picture, n_picture) = &pictures[&page];
        let c = chromium_rows.get(&item.id).ok_or_else(|| format!("{chromium} has no row {}", item.id))?;
        let n = native_rows.get(&item.id).ok_or_else(|| format!("native has no row {}", item.id))?;
        let ink = row_ink(c_picture, n_picture, row, scale);
        let delta = n.width - c.width;
        let class = item.class();
        let tolerance = if class == "Inter" { WIDTH_TOLERANCE } else { FALLBACK_TOLERANCE };
        let fonts_ok = same_fonts(&c.fonts, &n.fonts);
        let width_ok = delta.abs() <= tolerance && fonts_ok;
        widths_hold &= width_ok;
        by_class.entry(class).or_default().push((delta.abs(), ink.error));
        if ink.shift != (0, 0) {
            shifted += 1;
        }
        chroma_chromium += ink.chromium_chroma;
        chroma_native += ink.native_chroma;
        chroma_rows += 1;
        ratios.push(ink.ink_ratio);
        let fonts = if class == "Inter" && fonts_ok { String::new() } else { format!("  chromium [{}] native [{}]", c.fonts, n.fonts) };
        let _ = writeln!(
            text,
            "{:<34} {:>8.2} {:>8.2} {:>+7.2} {:>6.3} {:>6.3} {:>3},{:<3} {:?}{}{}",
            item.id, c.width, n.width, delta, ink.error, ink.best_error, ink.shift.0, ink.shift.1, ink.bounds_delta, if delta.abs() > tolerance { "  WIDTH" } else if !fonts_ok { "  FONTS" } else { "" }, fonts
        );
    }
    let _ = writeln!(text, "-- by class: rows, max |dwidth|, mean ink error --");
    for (class, rows) in &by_class {
        let max = rows.iter().map(|row| row.0).fold(0.0, f32::max);
        let mean = rows.iter().map(|row| row.1).sum::<f32>() / rows.len() as f32;
        let _ = writeln!(text, "{class:<8} {:>4} rows  max |dwidth| {max:>5.2}  mean ink error {mean:.3}", rows.len());
    }
    let _ = writeln!(text, "rows where a pixel shift of up to 2 helps: {shifted} of {}", items.len());
    let _ = writeln!(text, "mean colour spread of ink pixels: chromium {:.1}, native {:.1} (0 is grayscale)", chroma_chromium / chroma_rows as f32, chroma_native / chroma_rows as f32);
    let mean_ratio = ratios.iter().sum::<f32>() / ratios.len().max(1) as f32;
    let _ = writeln!(text, "native ink over chromium ink (mean of rows): {mean_ratio:.3}");
    let _ = writeln!(text, "widths {}", if widths_hold { "hold" } else { "DO NOT HOLD" });
    Ok(Report { text, widths_hold })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A comparison directory holding one fallback row whose two renderers agree on the width and say which fonts they used.
    fn directory(name: &str, chromium_fonts: &str, native_fonts: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("styk-text-check-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("matrix.tsv"), "#theme\tlight\t#eceff4\t#0c0d12\nfallback/ui/arabic\tui\t500\t13\t18\t0\t-\tمرحبا\n").unwrap();
        std::fs::write(dir.join("chromium-light-1.tsv"), format!("fallback/ui/arabic\t91.47\t{chromium_fonts}\n")).unwrap();
        std::fs::write(dir.join("native-light-1.tsv"), format!("fallback/ui/arabic\t91.47\t{native_fonts}\n")).unwrap();
        for prefix in ["chromium", "native"] {
            let file = std::fs::File::create(dir.join(format!("{prefix}-light-1-p0.png"))).unwrap();
            let (width, height) = (PAGE_WIDTH as u32, (PAGE_ROWS as f32 * ROW_HEIGHT) as u32);
            let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), width, height);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            encoder.write_header().unwrap().write_image_data(&vec![200u8; (width * height * 4) as usize]).unwrap();
        }
        dir
    }

    fn holds(dir: &std::path::Path) -> bool {
        compare(&dir.join("matrix.tsv"), dir, "chromium", "light-1", 1.0).unwrap().widths_hold
    }

    #[test]
    fn a_different_fallback_font_fails_the_comparison() {
        let dir = directory("fonts-differ", "Segoe UI Semibold:12|Inter:5", "Arial:12|Inter:5");
        assert!(!holds(&dir), "Arial where Chromium used Segoe UI must fail even when the widths agree");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_same_fonts_under_another_face_name_pass() {
        // Chromium names the face (\`Segoe UI Semibold\`), the native stack names the family (\`Segoe UI\`), in another order.
        let dir = directory("fonts-agree", "Segoe UI Semibold:12|Inter:5", "Inter:5|Segoe UI:12");
        assert!(holds(&dir));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
