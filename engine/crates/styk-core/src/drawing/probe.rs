//! Interface-neutral protocol for a diagnostic workload supplied by the host.
use super::pad::PadCore;
use std::sync::Arc;
use std::path::PathBuf;
use styk_services::input::InputDiagnostics;
pub struct Context {
    pub core: Arc<PadCore>,
    pub counters: Option<Arc<dyn InputDiagnostics>>,
    pub refresh_hz: f64,
    pub out_dir: Option<PathBuf>,
}

#[derive(Clone, Debug)]
pub enum Step {
    Continue,
    Capture(PathBuf),
    Done(i32),
    /// Only the explicitly selected Blocked diagnostic may request this disturbance.
    DisturbBlockedProbe,
}


pub type Completion = Box<dyn FnOnce(Result<Step, String>) + Send>;

pub trait PenProbe: Send {
    /// Queues one step without waiting. The host reports its result as a UI message.
    fn step(&mut self, context: Context, captured: bool, complete: Completion) -> Result<(), String>;
}
