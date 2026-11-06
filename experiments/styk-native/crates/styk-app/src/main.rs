//! StykAnimate native viewer/editor prototype.
//!
//!   styk-native [file.piv|file.styk]

mod app;
mod engine;
mod gpu;
mod theme;

use eframe::egui_wgpu::{WgpuConfiguration, WgpuSetup};

/// Command-line automation (screenshots and playback measurements).
#[derive(Default, Clone)]
pub struct Script {
    pub screenshot: Option<std::path::PathBuf>,
    pub tick: Option<u32>,
    pub zoom: Option<f64>,
    pub center: Option<[f64; 2]>,
    pub play: bool,
    pub select: Option<u32>,
    /// Run the scripted benchmark (playback, zoom, pan, zoom while playing).
    pub bench: bool,
    pub exit: bool,
    pub no_handles: bool,
}

fn main() -> eframe::Result {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut script = Script::default();
    let mut initial = None;
    let mut i = 0;
    while i < args.len() {
        let next = |i: usize| args.get(i + 1).cloned().unwrap_or_default();
        match args[i].as_str() {
            "--screenshot" => {
                script.screenshot = Some(next(i).into());
                i += 1;
            }
            "--tick" => {
                script.tick = next(i).parse().ok();
                i += 1;
            }
            "--zoom" => {
                script.zoom = next(i).parse().ok();
                i += 1;
            }
            "--center" => {
                script.center = next(i).split_once(',').and_then(|(a, b)| Some([a.parse().ok()?, b.parse().ok()?]));
                i += 1;
            }
            "--select" => {
                script.select = next(i).parse().ok();
                i += 1;
            }
            "--bench" => script.bench = true,
            "--play" => script.play = true,
            "--exit" => script.exit = true,
            "--no-handles" => script.no_handles = true,
            other => initial = Some(std::path::PathBuf::from(other)),
        }
        i += 1;
    }
    let mut wgpu_options = WgpuConfiguration::default();
    if let WgpuSetup::CreateNew(setup) = &mut wgpu_options.wgpu_setup {
        setup.power_preference = eframe::wgpu::PowerPreference::HighPerformance;
    }
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default().with_title("StykAnimate · native engine").with_inner_size([1440.0, 900.0]).with_drag_and_drop(true),
        renderer: eframe::Renderer::Wgpu,
        wgpu_options,
        ..Default::default()
    };
    eframe::run_native("StykAnimate native", options, Box::new(move |cc| Ok(Box::new(app::App::new(cc, initial, script)))))
}
