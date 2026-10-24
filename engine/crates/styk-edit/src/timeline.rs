//! The editor's timeline (`editor.timeline`, `timeline(report)` in src/pivot/geometry.mjs):
//! one row per native keyframe, cut to the layer sheet's length when there is one.

use styk_doc::Value;

/// A row: where it starts and how many ticks it lasts. A row may end on a fraction
/// of a tick when a camera or effect clip does.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Row {
    pub start: f64,
    pub count: f64,
}

pub(crate) fn rows(report: &Value) -> Vec<Row> {
    let version = report.get("version").and_then(Value::as_f64).unwrap_or(5.0) as u32;
    let durations: Vec<u32> = report
        .get("keyframes")
        .and_then(Value::elements)
        .map(|frames| frames.iter().map(|k| k.get("duration_raw").and_then(Value::as_f64).map(|v| v as i64).unwrap_or(1).max(0) as u32).collect())
        .unwrap_or_default();
    let mut rows: Vec<Row> = styk_eval::eval::timeline_rows(version, durations.into_iter()).into_iter().map(|r| Row { start: r.start as f64, count: r.count as f64 }).collect();
    let styk = report.get("_styk");
    let clips = |path: &[&str]| -> Vec<Value> { styk.and_then(|s| s.path(path)).and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default() };
    let number = |value: &Value, key: &str| value.get(key).and_then(Value::as_f64).unwrap_or(0.0);
    let ends = clips(&["cameraMotion", "clips"])
        .iter()
        .map(|c| number(c, "start") + number(c, "duration"))
        .chain(clips(&["vfxClips", "clips"]).iter().map(|c| if matches!(c.get("duration"), Some(Value::Null)) { 0.0 } else { number(c, "start") + number(c, "duration") }))
        .fold(f64::NEG_INFINITY, f64::max);
    match styk.and_then(|s| s.get("layerSheet")).and_then(|sheet| sheet.get("duration")).and_then(Value::as_f64) {
        Some(duration) => {
            rows.retain(|row| row.start < duration);
            for row in rows.iter_mut() {
                row.count = row.count.min(duration - row.start);
            }
            if let Some(last) = rows.last_mut() {
                last.count = duration.max(ends) - last.start;
            }
        }
        None => {
            if let Some(last) = rows.last_mut() {
                let animation_end = styk_eval::channels::end_tick_of_record(styk.and_then(|s| s.get("animation")));
                last.count = last.count.max(ends.max(animation_end) - last.start);
            }
        }
    }
    rows
}

/// `editor.totalTicks`.
pub(crate) fn total_ticks(rows: &[Row]) -> f64 {
    rows.last().map(|r| r.start + r.count).unwrap_or(0.0)
}
