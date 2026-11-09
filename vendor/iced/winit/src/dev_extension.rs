//! Opt-in log adapter for the native developer host. No logger in shipping builds.
use std::{
    fmt,
    sync::{Arc, Mutex},
};
/// Host-owned bounded, nonblocking sink: level, module and unformatted arguments.
pub type Sink = dyn for<'a, 'b> Fn(u8, &'a str, fmt::Arguments<'b>) + Send + Sync;
struct Logger(Mutex<Option<Arc<Sink>>>);
static LOGGER: Logger = Logger(Mutex::new(None));
impl log::Log for Logger {
    fn enabled(&self, _: &log::Metadata<'_>) -> bool {
        true
    }
    fn log(&self, record: &log::Record<'_>) {
        if let Ok(sink) = self.0.try_lock()
            && let Some(sink) = sink.as_ref()
        {
            sink(record.level() as u8, record.target(), *record.args());
        }
    }
    fn flush(&self) {}
}
/// Install once during developer startup; refuse to replace another logger.
pub fn install(sink: Arc<Sink>) -> Result<(), String> {
    let mut slot = LOGGER
        .0
        .try_lock()
        .map_err(|_| "developer log adapter busy")?;
    log::set_logger(&LOGGER).map_err(|e| e.to_string())?;
    *slot = Some(sink);
    log::set_max_level(log::LevelFilter::Trace);
    Ok(())
}
