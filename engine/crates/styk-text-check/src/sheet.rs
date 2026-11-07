//! The native sheet: the matrix drawn by iced in a window, one screenshot per page, and the width of every row.
//!
//! Runs as `styk-text-check sheet <matrix.tsv> <out-dir> <theme> <scale>`. The window opens through the same path the
//! application uses (`styk_design::warm_up` builds the font system on a worker; the view holds no text until it is
//! ready; the window is created hidden and shown without activation, off-screen under `STYK_BACKGROUND_WINDOW=1`),
//! then each page is drawn, settled for a few frames and captured with the compositor (`styk_platform::window`).

use crate::matrix::{self, Item, LEFT, PAGE_ROWS, PAGE_WIDTH, ROW_HEIGHT};
use iced::advanced::graphics::text::{Paragraph, font_system};
use iced::advanced::text::{Alignment, Ellipsis, Paragraph as _, Shaping, Text, Wrapping};
use iced::widget::{column, container, text};
use iced::{Element, Length, Padding, Size, Subscription, Task, Widget, alignment, window};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use styk_design::{Theme, warm_up};
use styk_platform::unattended::{self, Strategy};
use styk_platform::window::{self as platform, Image};

/// Frames a page is drawn for before it is captured: the first presents it, the rest let the compositor catch up.
const SETTLE_FRAMES: u32 = 4;

#[derive(Clone, Debug)]
enum Message {
    Opened(window::Id),
    Shown,
    FontsReady,
    Frame,
    Captured(Result<Image, String>),
}

struct Sheet {
    items: Vec<Item>,
    theme: Theme,
    scale: f32,
    strategy: Option<Strategy>,
    out_dir: PathBuf,
    label: String,
    window: Option<window::Id>,
    fonts_ready: bool,
    /// Whether the view waits for the fonts. Off only for the negative control (`--no-font-gate`), which must be caught.
    gate: bool,
    /// The warm-up's artificial delay, to show the event loop keeps drawing while the fonts load.
    delay: Duration,
    /// Frames drawn before the fonts were ready, the time of the last one and the longest wait between two.
    early_frames: u32,
    last_frame: Option<Instant>,
    longest_gap: Duration,
    page: usize,
    frames: u32,
    capturing: bool,
    result: Arc<Mutex<Result<(), String>>>,
}

impl Sheet {
    fn pages(&self) -> usize {
        self.items.len().div_ceil(PAGE_ROWS)
    }

    fn fail(&mut self, error: String) -> Task<Message> {
        *self.result.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Err(error);
        iced::exit()
    }

    fn update(&mut self, message: Message) -> Task<Message> {
        match message {
            Message::Opened(id) => {
                self.window = Some(id);
                if self.strategy == Some(Strategy::HiddenWindow) {
                    window::run(id, |window| platform::show_without_activation(window)).map(|_| Message::Shown)
                } else {
                    Task::none()
                }
            }
            Message::Shown => Task::none(),
            Message::FontsReady => {
                self.fonts_ready = true;
                eprintln!("text rendering: {:?}", iced::advanced::graphics::text::rendering());
                if warm_up::built_early() {
                    return self.fail("the interface thread built the font system before the warm-up worker did".to_string());
                }
                if !self.delay.is_zero() {
                    eprintln!("warm-up delayed by {} ms: {} frames drawn before the fonts were ready, longest wait between two {} ms", self.delay.as_millis(), self.early_frames, self.longest_gap.as_millis());
                    if self.early_frames < 5 || self.longest_gap > Duration::from_millis(100) {
                        return self.fail("the event loop stalled while the font system was built".to_string());
                    }
                }
                match measure(&self.items, &self.out_dir.join(format!("native-{}.tsv", self.label))) {
                    Ok(()) => Task::none(),
                    Err(error) => self.fail(error),
                }
            }
            Message::Frame => {
                if !self.fonts_ready {
                    let now = Instant::now();
                    if let Some(last) = self.last_frame {
                        self.longest_gap = self.longest_gap.max(now - last);
                    }
                    self.last_frame = Some(now);
                    self.early_frames += 1;
                }
                if !self.fonts_ready || self.capturing {
                    return Task::none();
                }
                self.frames += 1;
                match self.window {
                    Some(id) if self.frames >= SETTLE_FRAMES => {
                        self.capturing = true;
                        window::run(id, |window| platform::capture(window)).map(|result| Message::Captured(result.map_err(|error| error.to_string())))
                    }
                    _ => Task::none(),
                }
            }
            Message::Captured(Ok(image)) => {
                let expected = ((PAGE_WIDTH * self.scale).round() as u32, (PAGE_ROWS as f32 * ROW_HEIGHT * self.scale).round() as u32);
                if (image.width, image.height) != expected {
                    return self.fail(format!("the window is {}x{} pixels, the sheet needs {}x{}: the operating system scaled it", image.width, image.height, expected.0, expected.1));
                }
                let path = self.out_dir.join(format!("native-{}-p{}.png", self.label, self.page));
                if let Err(error) = write_png(&path, &image) {
                    return self.fail(error);
                }
                self.page += 1;
                self.frames = 0;
                self.capturing = false;
                if self.page >= self.pages() { iced::exit() } else { Task::none() }
            }
            Message::Captured(Err(error)) => self.fail(format!("could not capture the window: {error}")),
        }
    }

    fn view(&self) -> Element<'_, Message> {
        let palette = self.theme.palette();
        let ink: iced::Color = palette.text_1.into();
        let rows = if (self.fonts_ready || !self.gate) && self.page < self.pages() {
            let first = self.page * PAGE_ROWS;
            self.items[first..(first + PAGE_ROWS).min(self.items.len())]
                .iter()
                .map(|item| {
                    let style = item.style();
                    let label = text(item.text.clone())
                        .font(style.font)
                        .size(style.pixels())
                        .line_height(style.line())
                        .shaping(text::Shaping::Advanced)
                        .wrapping(text::Wrapping::None)
                        .color(ink);
                    container(label).width(Length::Fill).height(Length::Fixed(ROW_HEIGHT)).padding(Padding { left: LEFT, ..Padding::ZERO }).align_y(alignment::Vertical::Top).boxed()
                })
                .collect::<Vec<Element<'_, Message>>>()
        } else {
            Vec::new()
        };
        column(rows).boxed()
    }

    fn subscription(&self) -> Subscription<Message> {
        Subscription::batch([window::open_events().map(Message::Opened), window::frames().map(|_| Message::Frame)])
    }
}

/// Writes the width of every row (`id`, width, fonts used) from the same text path the sheet draws with.
fn measure(items: &[Item], path: &Path) -> Result<(), String> {
    let mut out = String::new();
    for item in items {
        let style = item.style();
        let paragraph = Paragraph::with_text(Text {
            content: item.text.as_str(),
            bounds: Size::new(f32::INFINITY, f32::INFINITY),
            size: style.pixels(),
            line_height: style.line(),
            font: style.font,
            align_x: Alignment::Default,
            align_y: alignment::Vertical::Top,
            shaping: Shaping::Advanced,
            wrapping: Wrapping::None,
            ellipsis: Ellipsis::None,
            hint_factor: None,
        });
        let mut fonts: BTreeMap<String, usize> = BTreeMap::new();
        {
            let mut system = font_system().write().unwrap_or_else(|poisoned| poisoned.into_inner());
            let database = system.raw().db();
            for run in paragraph.buffer().layout_runs() {
                for glyph in run.glyphs {
                    let family = database.face(glyph.font_id).and_then(|face| face.families.first().map(|(name, _)| name.clone())).unwrap_or_else(|| "?".into());
                    *fonts.entry(family).or_default() += 1;
                }
            }
        }
        let fonts = fonts.iter().map(|(name, glyphs)| format!("{name}:{glyphs}")).collect::<Vec<_>>().join("|");
        out.push_str(&format!("{}\t{}\t{fonts}\n", item.id, paragraph.min_width()));
    }
    std::fs::write(path, out).map_err(|error| format!("{}: {error}", path.display()))
}

fn write_png(path: &Path, image: &Image) -> Result<(), String> {
    let file = std::fs::File::create(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), image.width, image.height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().map_err(|error| error.to_string())?;
    writer.write_image_data(&image.rgba).map_err(|error| error.to_string())?;
    writer.finish().map_err(|error| error.to_string())
}

/// Runs the sheet for one theme and scale.
pub fn run(matrix_path: &Path, out_dir: &Path, theme_name: &str, scale: f32, gate: bool) -> Result<(), String> {
    let tsv = std::fs::read_to_string(matrix_path).map_err(|error| format!("{}: {error}", matrix_path.display()))?;
    let items = matrix::from_tsv(&tsv)?;
    let theme = match theme_name {
        "light" => Theme::Light,
        "dark" => Theme::Dark,
        other => return Err(format!("unknown theme {other}")),
    };
    std::fs::create_dir_all(out_dir).map_err(|error| error.to_string())?;
    // A cold start of a machine with thousands of fonts, reproduced: the worker waits this long before it starts.
    let delay = warm_up::delay_from_environment();
    let strategy = unattended::requested_by_environment()?;
    if strategy == Some(Strategy::Headless) {
        return Err("the typography sheet is captured from a window: use STYK_BACKGROUND_WINDOW=1".to_string());
    }
    let result = Arc::new(Mutex::new(Ok(())));
    let sheet = Mutex::new(Some(Sheet {
        items,
        theme,
        scale,
        strategy,
        out_dir: out_dir.to_path_buf(),
        label: format!("{theme_name}-{scale}"),
        window: None,
        fonts_ready: false,
        gate,
        delay,
        early_frames: 0,
        last_frame: None,
        longest_gap: Duration::ZERO,
        page: 0,
        frames: 0,
        capturing: false,
        result: result.clone(),
    }));
    let mut settings = window::Settings {
        // iced multiplies the window's size by the interface scale factor, so this is the sheet in interface pixels.
        size: Size::new(PAGE_WIDTH, PAGE_ROWS as f32 * ROW_HEIGHT),
        resizable: false,
        decorations: false,
        visible: strategy != Some(Strategy::HiddenWindow),
        ..window::Settings::default()
    };
    if strategy.is_some() {
        settings.position = window::Position::Specific(iced::Point::new(-20000.0, -20000.0));
        #[cfg(windows)]
        {
            settings.platform_specific.skip_taskbar = true;
        }
    }
    let palette = theme.palette();
    let (background_color, text_color): (iced::Color, iced::Color) = (palette.surface_field.into(), palette.text_1.into());
    iced::application(
        move || (sheet.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take().expect("the sheet starts once"), warm_up::warm_up_after(delay).map(|()| Message::FontsReady)),
        Sheet::update,
        Sheet::view,
    )
    .subscription(Sheet::subscription)
    .style(move |_: &Sheet, _| iced::theme::Style { background_color, text_color })
    .scale_factor(move |_| scale)
    .window(settings)
    .run()
    .map_err(|error| format!("the window failed: {error}"))?;
    let outcome = result.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
    outcome
}
