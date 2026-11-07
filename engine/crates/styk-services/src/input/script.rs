//! Scripted pen strokes: the deterministic input of the tests, the pen lab's self-test and the injection helper, and
//! the same strokes as the browser events that drive today's app for the parity runs.

use super::{Modifiers, PenButtons, PenSample, Phase, SampleFlags, Tool, Valid};

/// The device range of a Windows pen's pressure.
pub const PRESSURE_RANGE: u32 = 1024;

/// One step of a script: the state of the pointer at an offset from the script's start.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScriptStep {
    /// Offset from the start of the script, nanoseconds.
    pub t_ns: u64,
    pub x: f64,
    pub y: f64,
    pub tool: Tool,
    pub phase: Phase,
    /// 0 to [`PRESSURE_RANGE`].
    pub raw_pressure: u32,
    /// Whole degrees.
    pub tilt_x: i32,
    pub tilt_y: i32,
    pub barrel: bool,
    pub modifiers: Modifiers,
}

impl ScriptStep {
    /// This step as the sample a source would deliver for it, `base_ns` after the clock's origin.
    pub fn sample(&self, pointer: u32, base_ns: u64) -> PenSample {
        let mut sample = PenSample::at(base_ns + self.t_ns, pointer, self.tool, self.x, self.y);
        sample.raw_pressure = self.raw_pressure;
        sample.pressure_max = PRESSURE_RANGE;
        sample.pressure = self.raw_pressure as f32 / PRESSURE_RANGE as f32;
        sample.tilt_x = self.tilt_x as f32;
        sample.tilt_y = self.tilt_y as f32;
        sample.valid = Valid::PRESSURE | Valid::TILT;
        sample.phase = self.phase;
        sample.flags = SampleFlags::NONE;
        sample.modifiers = self.modifiers;
        if self.phase != Phase::Hover && self.phase != Phase::Up {
            sample.buttons = PenButtons::TIP;
        }
        if self.phase == Phase::Up {
            sample.buttons = PenButtons::NONE;
        }
        if self.barrel {
            sample.buttons = sample.buttons | PenButtons::BARREL;
        }
        sample
    }
}

/// One stroke of a synthetic script: a sine path from one point to another with ramps along it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StrokeSpec {
    pub tool: Tool,
    pub from: (f64, f64),
    pub to: (f64, f64),
    /// Peak sideways deviation of the sine, in pixels, and the number of full waves along the stroke.
    pub amplitude: f64,
    pub cycles: f64,
    pub pressure_from: u32,
    pub pressure_to: u32,
    pub tilt_x_from: i32,
    pub tilt_x_to: i32,
    pub tilt_y_from: i32,
    pub tilt_y_to: i32,
    /// The part of the contact (0 to 1) during which the barrel button is held, if any.
    pub barrel: Option<(f64, f64)>,
    /// Samples in range before the tip touches.
    pub hover_samples: usize,
}

/// A whole synthetic script.
#[derive(Clone, Debug, PartialEq)]
pub struct ScriptSpec {
    /// Samples per second.
    pub rate_hz: f64,
    /// Total samples, hover, contact and lift included.
    pub samples: usize,
    pub strokes: Vec<StrokeSpec>,
}

impl ScriptSpec {
    /// The standard script: a pen stroke (pressure 0.1 to 1, tilt −60 to 60, a barrel pulse in its middle) and then an
    /// eraser stroke back across the pad, `rate_hz * seconds` samples in all.
    pub fn standard(rate_hz: f64, seconds: f64, width: f64, height: f64) -> ScriptSpec {
        let stroke = |tool, y: f64, from_x: f64, to_x: f64, barrel| StrokeSpec {
            tool,
            from: (from_x, y),
            to: (to_x, y),
            amplitude: height * 0.12,
            cycles: 3.0,
            pressure_from: PRESSURE_RANGE / 10,
            pressure_to: PRESSURE_RANGE,
            tilt_x_from: -60,
            tilt_x_to: 60,
            tilt_y_from: 20,
            tilt_y_to: -20,
            barrel,
            hover_samples: 8,
        };
        ScriptSpec {
            rate_hz,
            samples: (rate_hz * seconds).round() as usize,
            strokes: vec![
                stroke(Tool::Pen, height * 0.35, width * 0.1, width * 0.9, Some((0.3, 0.4))),
                stroke(Tool::Eraser, height * 0.65, width * 0.9, width * 0.1, None),
            ],
        }
    }
}

/// A generated script: the steps of one pointer.
#[derive(Clone, Debug, PartialEq)]
pub struct Script {
    pub pointer: u32,
    pub steps: Vec<ScriptStep>,
}

impl Script {
    /// Generates the steps of `spec`. The total is exactly `spec.samples`; strokes share it equally and the last takes the
    /// remainder.
    pub fn generate(spec: &ScriptSpec, pointer: u32) -> Script {
        let count = spec.strokes.len().max(1);
        let mut steps = Vec::with_capacity(spec.samples);
        for (index, stroke) in spec.strokes.iter().enumerate() {
            let share = spec.samples / count + if index + 1 == count { spec.samples % count } else { 0 };
            let hover = stroke.hover_samples.min(share.saturating_sub(2));
            let contact = share - hover;
            for i in 0..share {
                let t_ns = ((steps.len() as u128) * 1_000_000_000 / spec.rate_hz as u128) as u64;
                let (phase, u) = if i < hover {
                    (Phase::Hover, 0.0)
                } else {
                    let k = i - hover;
                    let u = if contact > 1 { k as f64 / (contact - 1) as f64 } else { 0.0 };
                    (if k == 0 { Phase::Down } else if k + 1 == contact { Phase::Up } else { Phase::Move }, u)
                };
                let lerp = |a: f64, b: f64| a + (b - a) * u;
                let x = lerp(stroke.from.0, stroke.to.0);
                let y = lerp(stroke.from.1, stroke.to.1) + stroke.amplitude * (std::f64::consts::TAU * stroke.cycles * u).sin();
                let touching = phase == Phase::Down || phase == Phase::Move;
                let raw_pressure = if touching { lerp(stroke.pressure_from as f64, stroke.pressure_to as f64).round() as u32 } else { 0 };
                let barrel = touching && stroke.barrel.is_some_and(|(a, b)| u >= a && u < b);
                steps.push(ScriptStep {
                    t_ns,
                    x,
                    y,
                    tool: stroke.tool,
                    phase,
                    raw_pressure,
                    tilt_x: lerp(stroke.tilt_x_from as f64, stroke.tilt_x_to as f64).round() as i32,
                    tilt_y: lerp(stroke.tilt_y_from as f64, stroke.tilt_y_to as f64).round() as i32,
                    barrel,
                    modifiers: Modifiers::NONE,
                });
            }
        }
        Script { pointer, steps }
    }

    /// The script's length in nanoseconds.
    pub fn duration_ns(&self) -> u64 {
        self.steps.last().map_or(0, |step| step.t_ns)
    }

    /// The script as the pointer events of a browser, one JSON object per step, for the page that drives today's app
    /// (`pointerType: "pen"`, `button 5` and `buttons 32` for the eraser end, `buttons & 2` for the barrel, pressure as a
    /// fraction, tilt in degrees, `t` in milliseconds). Positions are client pixels of the window the script was made for.
    pub fn to_browser_json(&self) -> String {
        let mut out = String::from("[");
        for (i, step) in self.steps.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            let eraser = step.tool == Tool::Eraser;
            let touching = matches!(step.phase, Phase::Down | Phase::Move);
            let (kind, button) = match step.phase {
                Phase::Hover | Phase::Move => ("pointermove", -1),
                Phase::Down => ("pointerdown", if eraser { 5 } else { 0 }),
                Phase::Up => ("pointerup", if eraser { 5 } else { 0 }),
            };
            let mut buttons = 0;
            if touching {
                buttons |= 1;
            }
            if step.barrel {
                buttons |= 2;
            }
            if eraser && touching {
                buttons |= 32;
            }
            out.push_str(&format!(
                "{{\"t\":{:.4},\"type\":\"{kind}\",\"x\":{:.4},\"y\":{:.4},\"pressure\":{:.6},\"tiltX\":{},\"tiltY\":{},\"button\":{button},\"buttons\":{buttons}}}",
                step.t_ns as f64 / 1e6,
                step.x,
                step.y,
                step.raw_pressure as f64 / PRESSURE_RANGE as f64,
                step.tilt_x,
                step.tilt_y,
            ));
        }
        out.push(']');
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn standard() -> Script {
        Script::generate(&ScriptSpec::standard(240.0, 5.0, 800.0, 600.0), 7)
    }

    #[test]
    fn five_seconds_at_240_hz_is_1200_samples_4_17_ms_apart() {
        let script = standard();
        assert_eq!(script.steps.len(), 1200);
        let gap = script.steps[1].t_ns - script.steps[0].t_ns;
        assert!((4_160_000..=4_170_000).contains(&gap), "{gap}");
        assert!(script.steps.windows(2).all(|pair| pair[1].t_ns > pair[0].t_ns));
        assert_eq!(script.duration_ns(), 1199 * 1_000_000_000 / 240);
    }

    #[test]
    fn each_stroke_runs_hover_down_moves_up() {
        let script = standard();
        let phases: Vec<Phase> = script.steps.iter().map(|s| s.phase).collect();
        assert_eq!(phases.iter().filter(|p| **p == Phase::Down).count(), 2);
        assert_eq!(phases.iter().filter(|p| **p == Phase::Up).count(), 2);
        assert_eq!(phases[0], Phase::Hover);
        assert_eq!(phases[8], Phase::Down);
        assert_eq!(phases[599], Phase::Up);
    }

    #[test]
    fn the_eraser_is_the_second_half_and_the_barrel_a_pulse_in_the_first() {
        let script = standard();
        for (i, step) in script.steps.iter().enumerate() {
            assert_eq!(step.tool == Tool::Eraser, i >= 600, "{i}");
            if i >= 600 {
                assert!(!step.barrel);
            }
        }
        let barrel: Vec<usize> = script.steps.iter().enumerate().filter(|(_, s)| s.barrel).map(|(i, _)| i).collect();
        assert!(!barrel.is_empty());
        assert!(barrel.windows(2).all(|pair| pair[1] == pair[0] + 1), "one pulse");
        assert!(barrel[0] > 100 && *barrel.last().unwrap() < 400);
    }

    #[test]
    fn pressure_ramps_and_tilt_sweeps() {
        let script = standard();
        let contact: Vec<&ScriptStep> = script.steps[..600].iter().filter(|s| matches!(s.phase, Phase::Down | Phase::Move)).collect();
        assert_eq!(contact[0].raw_pressure, 102);
        // The last contact sample is the one before the lift, which carries zero pressure.
        assert!(contact.last().unwrap().raw_pressure >= 1020);
        assert!(contact.windows(2).all(|pair| pair[1].raw_pressure >= pair[0].raw_pressure));
        assert_eq!(contact[0].tilt_x, -60);
        assert!(contact.last().unwrap().tilt_x >= 59);
        assert!(script.steps.iter().filter(|s| s.phase == Phase::Hover || s.phase == Phase::Up).all(|s| s.raw_pressure == 0));
    }

    #[test]
    fn a_step_becomes_the_sample_a_source_would_deliver() {
        let script = standard();
        let step = script.steps.iter().find(|s| s.barrel).unwrap();
        let sample = step.sample(7, 1_000);
        assert_eq!(sample.time_ns, 1_000 + step.t_ns);
        assert!(sample.buttons.contains(PenButtons::TIP | PenButtons::BARREL));
        assert_eq!(sample.pressure_max, 1024);
        assert!((sample.pressure - step.raw_pressure as f32 / 1024.0).abs() < 1e-6);
        let up = script.steps.iter().find(|s| s.phase == Phase::Up).unwrap().sample(7, 0);
        assert!(!up.buttons.contains(PenButtons::TIP));
    }

    #[test]
    fn the_browser_script_carries_the_eraser_end_as_button_5() {
        let script = standard();
        let json = script.to_browser_json();
        assert!(json.starts_with("[{\"t\":0.0000,\"type\":\"pointermove\""));
        assert!(json.contains("\"type\":\"pointerdown\",") && json.contains("\"button\":5,\"buttons\":33"));
        assert_eq!(json.matches("pointerdown").count(), 2);
        assert_eq!(json.matches("\"type\"").count(), 1200);
    }
}
