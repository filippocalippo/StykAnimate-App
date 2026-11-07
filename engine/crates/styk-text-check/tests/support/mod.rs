//! A headless window: the loop of a real one (draw a candidate, show it unless the renderer keeps the last frame), for the
//! glyph tests.

#![allow(dead_code)]

use iced::advanced::renderer::{self, Headless};
use iced::advanced::shell;
use iced::widget::text::LineHeight;
use iced::widget::{column, text};
use iced::{Color, Pixels, Size, Widget, mouse, window};
use iced_runtime::UserInterface;
use iced_runtime::user_interface::Cache;
use std::time::{Duration, Instant};
use styk_design::{warm_up, widgets};

pub type Interface = UserInterface<'static, (), iced::Theme, iced_wgpu::Renderer>;

pub const BACKGROUND: Color = Color::WHITE;

/// A headless window: a renderer, and the picture it is showing.
pub struct Window {
    pub renderer: iced_wgpu::Renderer,
    pub size: Size,
    pub shown: Vec<u8>,
    pub held: usize,
}

impl Window {
    pub fn open(size: Size) -> Option<Self> {
        let settings = iced::Settings { font: widgets::INTER, ..iced::Settings::default() };
        let renderer = pollster::block_on(<iced_wgpu::Renderer as Headless>::new(renderer::Settings::from(&settings), None))?;
        let _ready = warm_up::install_bundled();
        let blank = vec![255u8; (size.width as usize) * (size.height as usize) * 4];
        Some(Window { renderer, size, shown: blank, held: 0 })
    }

    pub fn interface(&mut self, lines: &[String], pixels: f32) -> Interface {
        self.interface_sized(lines.iter().map(|line| (line.clone(), pixels)).collect())
    }

    /// A screen of rows, each in its own size.
    pub fn interface_sized(&mut self, lines: Vec<(String, f32)>) -> Interface {
        let rows: Vec<iced::Element<'static, (), iced::Theme, iced_wgpu::Renderer>> = lines
            .into_iter()
            .map(|(line, pixels)| text(line).font(widgets::INTER).size(pixels).line_height(LineHeight::Absolute(Pixels(pixels * 1.4))).color(Color::BLACK).boxed())
            .collect();
        let root: iced::Element<'static, (), iced::Theme, iced_wgpu::Renderer> = column(rows).boxed();
        let mut interface = UserInterface::build(root, self.size, Cache::default(), &mut self.renderer);
        let _ = interface.update(&window::Headless, &shell::Waker::noop(), &[iced::event::Event::Window(window::Event::RedrawRequested(iced::time::Instant::now()))], mouse::Cursor::Unavailable, &mut self.renderer, &mut shell::Bus::new());
        interface
    }

    /// One redraw of the window: the candidate is drawn and shown, unless the renderer holds it back. Whether it was shown.
    pub fn frame(&mut self, interface: &mut Interface) -> bool {
        interface.draw(&mut self.renderer, &iced::Theme::Light, &renderer::Style { text_color: Color::BLACK }, mouse::Cursor::Unavailable);
        let picture = <iced_wgpu::Renderer as Headless>::screenshot(&mut self.renderer, Size::new(self.size.width as u32, self.size.height as u32), 1.0, BACKGROUND);
        if self.renderer.hold_frame().is_some() {
            self.held += 1;
            return false;
        }
        self.shown = picture;
        true
    }

    /// Redraws until a complete frame is shown, returning every frame shown on the way, the last one first.
    pub fn until_complete(&mut self, interface: &mut Interface) -> Vec<Vec<u8>> {
        let mut shown = Vec::new();
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(40) {
            if self.frame(interface) {
                shown.push(self.shown.clone());
                if !self.renderer.text_incomplete() {
                    shown.reverse();
                    return shown;
                }
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        panic!("no complete frame in forty seconds");
    }
}


pub fn lines(words: &[&str]) -> Vec<String> {
    words.iter().map(|word| (*word).to_string()).collect()
}

pub fn ink(picture: &[u8]) -> usize {
    picture.chunks_exact(4).filter(|pixel| pixel[..3] != [255, 255, 255]).count()
}
