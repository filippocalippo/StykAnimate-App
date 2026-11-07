//! Interface-neutral protocol for a diagnostic workload supplied by the host.
use super::pad::PadCore;
use std::sync::Arc;
use std::path::{Path, PathBuf};
use styk_services::input::InputDiagnostics;
pub struct Context<'a> {
    pub core: &'a Arc<PadCore>,
    pub counters: Option<&'a Arc<dyn InputDiagnostics>>,
    pub refresh_hz: f64,
    pub out_dir: Option<&'a Path>,
}

pub enum Step {
    Continue,
    Capture(PathBuf),
    Done(i32),
}


pub trait PenProbe { fn step(&mut self, context: &Context) -> Step; fn captured(&mut self); }
