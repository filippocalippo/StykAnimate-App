//! The cost of subpixel text: how long a text-dense frame takes to draw and present.
//!
//! `styk-text-check bench <theme> <scale> <frames>` builds a screen of about three thousand glyphs (Inter at 13 px on
//! 18 px lines, the interface's own body text) in a headless renderer, draws and reads back `frames` frames and prints
//! the mean, median and 95th percentile of a frame in milliseconds. Run it with and without `STYK_TEXT_SUBPIXEL=0` to
//! compare the two kinds of text on the same screen. Glyphs are cached after the first frame, so this measures the
//! per-frame cost of preparing and blending them, and the time the first view takes to have every glyph (on Windows
//! they are drawn by a worker, `STYK_TEXT_RASTERIZER=swash` for the other rasterizer).

use iced::advanced::renderer::{self, Headless};
use iced::advanced::shell;
use iced::widget::{column, container, text};
use iced::{Element, Length, Padding, Size, Widget, mouse, window};
use iced_runtime::UserInterface;
use iced_runtime::user_interface::Cache;
use std::time::Instant;
use styk_design::typography::TextStyle;
use styk_design::{Theme, tokens::scale, warm_up, widgets};

const ROWS: usize = 48;
const LINE: &str = "Position  Rotation 45.25°  Zoom 100%  AVATAR To  Привет мир  Γειά σου  Tiếng Việt  Ça va très bien  0123456789  ";

pub fn run(theme_name: &str, scale_factor: f32, frames: usize) -> Result<(), String> {
    let theme = match theme_name {
        "light" => Theme::Light,
        "dark" => Theme::Dark,
        other => return Err(format!("unknown theme {other}")),
    };
    let settings = iced::Settings { font: widgets::INTER, ..iced::Settings::default() };
    let mut renderer = pollster::block_on(<iced::Renderer as Headless>::new(renderer::Settings::from(&settings), None)).ok_or("no graphics adapter is available to draw offscreen")?;
    let _ready = warm_up::install_bundled();
    let style = TextStyle::from_role(&scale::TYPE_BODY);
    let ink: iced::Color = theme.palette().text_1.into();
    let rows: Vec<Element<'_, ()>> = (0..ROWS)
        .map(|index| {
            let content = format!("{LINE}{index}");
            container(text(content).font(style.font).size(style.pixels()).line_height(style.line()).wrapping(text::Wrapping::None).color(ink)).height(Length::Fixed(style.line_height)).padding(Padding { left: 16.0, ..Padding::ZERO }).boxed()
        })
        .collect();
    let bounds = Size::new(960.0, ROWS as f32 * style.line_height);
    let iced_theme = match theme {
        Theme::Light => iced::Theme::Light,
        Theme::Dark => iced::Theme::Dark,
    };
    let mut interface: UserInterface<'_, (), iced::Theme, iced::Renderer> = UserInterface::build(column(rows).boxed(), bounds, Cache::default(), &mut renderer);
    let _ = interface.update(&window::Headless, &shell::Waker::noop(), &[iced::event::Event::Window(window::Event::RedrawRequested(iced::time::Instant::now()))], mouse::Cursor::Unavailable, &mut renderer, &mut shell::Bus::new());
    let physical = Size::new((bounds.width * scale_factor).round() as u32, (bounds.height * scale_factor).round() as u32);
    let background: iced::Color = theme.palette().surface_field.into();
    // The first frames lack the glyphs a worker is still drawing: the time until a frame has them all is how long text
    // takes to appear on a first view.
    let settling = Instant::now();
    for _ in 0..400 {
        interface.draw(&mut renderer, &iced_theme, &renderer::Style { text_color: ink }, mouse::Cursor::Unavailable);
        let _ = Headless::screenshot(&mut renderer, physical, scale_factor, background);
        if styk_design::glyphs::pending() == 0 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    let settled = settling.elapsed().as_secs_f64() * 1000.0;
    let mut times = Vec::with_capacity(frames);
    for frame in 0..frames + 20 {
        let started = Instant::now();
        interface.draw(&mut renderer, &iced_theme, &renderer::Style { text_color: ink }, mouse::Cursor::Unavailable);
        let _ = Headless::screenshot(&mut renderer, physical, scale_factor, background);
        if frame >= 20 {
            times.push(started.elapsed().as_secs_f64() * 1000.0);
        }
    }
    times.sort_by(f64::total_cmp);
    let mean = times.iter().sum::<f64>() / times.len() as f64;
    let glyphs = LINE.chars().count() * ROWS;
    println!(
        "{} text, {theme_name} at {scale_factor}: {glyphs} glyphs, {frames} frames: mean {mean:.2} ms, median {:.2} ms, p95 {:.2} ms; all glyphs on screen after {settled:.0} ms",
        if iced::advanced::graphics::text::rendering().subpixel.is_some() { "subpixel" } else { "grayscale" },
        times[times.len() / 2],
        times[times.len() * 95 / 100]
    );
    Ok(())
}
