//! This data is included by the gated developer module only (and the negative control).
pub const CATALOGUE: &[(&str, &str)] = &[
    ("dev.mark", "Dev"),
    ("dev.overlay", "Performance overlay"),
    ("dev.profiler", "Profiler"),
    ("dev.logs", "Logs"),
    ("dev.parameters", "Live parameters"),
    ("dev.start", "Start capture"),
    ("dev.stop", "Stop capture"),
    ("dev.export", "Export to Perfetto"),
    ("dev.set", "Change parameter"),
    ("dev.reset", "Reset parameter"),
    ("dev.saveProfile", "Save parameter profile"),
    ("dev.loadProfile", "Load parameter profile"),
    ("dev.close", "Close developer panel"),
    ("dev.filter", "Filter logs"),
    ("dev.error", "Developer tools: {reason}"),
    ("dev.unavailable", "Unavailable"),
];
