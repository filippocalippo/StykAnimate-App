//! The shared styk-auto/1 language, beginning with the stage's internal seam.
//! Runners own file access, waiting and measurement; steps use the normal core
//! input/command entries. The shell adds its commands here, not another parser.
use crate::stage::input::{Button, Pointer, PointerPhase};
use styk_doc::Value;
use styk_services::input::{Modifiers, PenButtons, PenSample, Phase, Tool, Valid};

#[derive(Clone, Debug)]
pub enum Action {
    Open { input: String },
    Pan { delta: [f64; 2] },
    Zoom { factor: f64, at: [f64; 2] },
    Pointer(Pointer),
    Pen(PenSample),
    Frame { tick: f64 },
    Play { from: f64, frames: u32 },
    Measure { label: String },
}
#[derive(Clone, Debug)]
pub struct Step {
    pub at_ms: f64,
    pub action: Action,
}
#[derive(Clone, Debug)]
pub struct Script {
    pub steps: Vec<Step>,
}

impl Script {
    pub fn parse(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() > 1 << 20 {
            return Err("automation script exceeds 1 MiB".into());
        }
        let root = styk_doc::json::parse(bytes).map_err(|e| e.to_string())?;
        if root.get("format").and_then(Value::as_str) != Some("styk-auto/1") {
            return Err("expected styk-auto/1".into());
        }
        let steps = root
            .get("steps")
            .and_then(Value::elements)
            .ok_or("expected steps array")?;
        if steps.len() > 8192 {
            return Err("automation script exceeds 8192 steps".into());
        }
        let mut result = Vec::with_capacity(steps.len());
        let mut previous = 0.0;
        for step in steps {
            let at_ms = number(&step, "at_ms")?;
            if at_ms < previous || at_ms > u64::MAX as f64 / 1_000_000.0 {
                return Err(
                    "step times must be nonnegative, ordered and representable in nanoseconds"
                        .into(),
                );
            }
            previous = at_ms;
            let action = match text(&step, "op")? {
                "open" => Action::Open {
                    input: text(&step, "input")?.into(),
                },
                "pan" => Action::Pan {
                    delta: pair(&step, "delta")?,
                },
                "zoom" => Action::Zoom {
                    factor: number(&step, "factor")?,
                    at: pair(&step, "at")?,
                },
                "frame" => Action::Frame {
                    tick: nonnegative(&step, "tick")?,
                },
                "play" => {
                    let count = number(&step, "frames")?;
                    if !(1.0..=1_000_000.0).contains(&count) || count.fract() != 0.0 {
                        return Err("invalid play frame count".into());
                    }
                    Action::Play {
                        from: nonnegative(&step, "from")?,
                        frames: count as u32,
                    }
                }
                "measure" => Action::Measure {
                    label: text(&step, "label")?.into(),
                },
                "pointer" => Action::Pointer(Pointer {
                    id: id(&step)?,
                    phase: match text(&step, "phase")? {
                        "down" => PointerPhase::Down,
                        "move" => PointerPhase::Move,
                        "up" => PointerPhase::Up,
                        "cancel" => PointerPhase::Cancel,
                        _ => return Err("invalid pointer phase".into()),
                    },
                    point: pair(&step, "at")?,
                    button: match text(&step, "button")? {
                        "left" => Button::Left,
                        "middle" => Button::Middle,
                        "right" => Button::Right,
                        _ => return Err("invalid pointer button".into()),
                    },
                    modifiers: modifiers(&step)?,
                }),
                "pen" => {
                    let point = pair(&step, "at")?;
                    let mut sample = PenSample::at(
                        (at_ms * 1_000_000.0) as u64,
                        id(&step)?,
                        match text(&step, "tool")? {
                            "pen" => Tool::Pen,
                            "eraser" => Tool::Eraser,
                            _ => return Err("invalid pen tool".into()),
                        },
                        point[0],
                        point[1],
                    );
                    sample.phase = match text(&step, "phase")? {
                        "hover" => Phase::Hover,
                        "down" => Phase::Down,
                        "move" => Phase::Move,
                        "up" => Phase::Up,
                        _ => return Err("invalid pen phase".into()),
                    };
                    if matches!(sample.phase, Phase::Down | Phase::Move) {
                        sample.buttons = PenButtons::TIP;
                    }
                    let pressure = number(&step, "pressure")?;
                    if !(0.0..=1.0).contains(&pressure) {
                        return Err("invalid pen pressure".into());
                    }
                    sample.pressure = pressure as f32;
                    sample.valid = Valid::PRESSURE;
                    sample.modifiers = modifiers(&step)?;
                    if step.get("tilt").is_some() {
                        let tilt = pair(&step, "tilt")?;
                        if tilt.iter().any(|x| x.abs() > 90.0) {
                            return Err("invalid pen tilt".into());
                        }
                        sample.tilt_x = tilt[0] as f32;
                        sample.tilt_y = tilt[1] as f32;
                        sample.valid = sample.valid | Valid::TILT;
                    }
                    Action::Pen(sample)
                }
                op => return Err(format!("unknown automation operation: {op}")),
            };
            result.push(Step { at_ms, action });
        }
        Ok(Self { steps: result })
    }
}
fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("expected string {key}"))
}
fn number(v: &Value, key: &str) -> Result<f64, String> {
    v.get(key)
        .and_then(Value::as_f64)
        .filter(|x| x.is_finite())
        .ok_or_else(|| format!("expected finite {key}"))
}
fn nonnegative(v: &Value, key: &str) -> Result<f64, String> {
    let n = number(v, key)?;
    if n < 0.0 {
        Err(format!("negative {key}"))
    } else {
        Ok(n)
    }
}
fn id(v: &Value) -> Result<u32, String> {
    let n = nonnegative(v, "id")?;
    if n > u32::MAX as f64 || n.fract() != 0.0 {
        Err("invalid pointer id".into())
    } else {
        Ok(n as u32)
    }
}
fn pair(v: &Value, key: &str) -> Result<[f64; 2], String> {
    let values = v
        .get(key)
        .and_then(Value::elements)
        .ok_or_else(|| format!("expected pair {key}"))?;
    if values.len() != 2 {
        return Err(format!("expected pair {key}"));
    }
    Ok([
        values
            .get(0)
            .and_then(|v| v.as_f64())
            .filter(|x| x.is_finite())
            .ok_or("nonfinite coordinate")?,
        values
            .get(1)
            .and_then(|v| v.as_f64())
            .filter(|x| x.is_finite())
            .ok_or("nonfinite coordinate")?,
    ])
}
fn modifiers(v: &Value) -> Result<Modifiers, String> {
    let Some(values) = v.get("modifiers") else {
        return Ok(Modifiers::NONE);
    };
    let mut flags = Modifiers::NONE;
    for value in values.elements().ok_or("expected modifiers array")? {
        flags = flags
            | match value.as_str() {
                Some("shift") => Modifiers::SHIFT,
                Some("ctrl") => Modifiers::CTRL,
                Some("alt") => Modifiers::ALT,
                Some("meta") => Modifiers::META,
                _ => return Err("invalid modifier".into()),
            };
    }
    Ok(flags)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_the_stage_scenario_and_refuses_unknown_or_unordered_steps() {
        let scenario = Script::parse(include_bytes!(
            "../../../../docs/native/scenarios/stage.json"
        ))
        .unwrap();
        assert_eq!(
            scenario
                .steps
                .iter()
                .filter(|s| matches!(s.action, Action::Open { .. }))
                .count(),
            2
        );
        assert_eq!(
            scenario
                .steps
                .iter()
                .filter(|s| matches!(s.action, Action::Play { .. }))
                .count(),
            2
        );
        assert!(
            Script::parse(br#"{"format":"styk-auto/1","steps":[{"at_ms":0,"op":"typo"}]}"#)
                .is_err()
        );
        assert!(
            Script::parse(
                br#"{"format":"styk-auto/1","steps":[{"at_ms":-1,"op":"frame","tick":0}]}"#
            )
            .is_err()
        );
    }
}
