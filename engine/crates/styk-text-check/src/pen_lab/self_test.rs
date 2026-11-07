//! Nonblocking interface entry to the pen diagnostic worker.
use std::sync::Arc;
use styk_core::services::Spawner;
use styk_core::drawing::probe::{Context, Completion, PenProbe};
mod worker;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TestKind {
    /// 240 Hz for the given seconds: fields, rate, latency, slices.
    Standard,
    /// The same, with the interface thread blocked for 50 ms twenty times: no sample may be lost or reordered.
    Blocked,
    /// The pad's gestures from scripted samples: the barrel, a finger, the palm, a press on a control.
    Behaviour,
    /// Worst inputs for the worker: a huge gap with a fine brush at deep zoom, a mirrored stroke.
    Stress,
}

#[derive(Clone, Debug)]
pub struct SelfTest {
    pub kind: TestKind,
    pub seconds: f64,
    pub rate_hz: f64,
}

impl SelfTest {
    /// Reads `kind[:seconds]`: `standard`, `blocked`, `behaviour` or `stress`, 240 Hz, five seconds unless said.
    pub fn parse(text: &str) -> Result<SelfTest, String> {
        let (kind, seconds) = text.split_once(':').map_or((text, None), |(k, s)| (k, Some(s)));
        let kind = match kind {
            "standard" => TestKind::Standard,
            "blocked" => TestKind::Blocked,
            "behaviour" => TestKind::Behaviour,
            "stress" => TestKind::Stress,
            other => return Err(format!("unknown self-test {other:?}: standard, blocked, behaviour or stress")),
        };
        let seconds = match seconds {
            None => 5.0,
            Some(s) => s.parse::<f64>().ok().filter(|s| *s > 0.0 && s.is_finite()).ok_or_else(|| format!("self-test seconds want a positive number, not {s:?}"))?,
        };
        Ok(SelfTest { kind, seconds, rate_hz: 240.0 })
    }
}

pub struct Runner { worker: worker::Worker }
impl Runner {
    pub fn new(test: SelfTest, spawner: Arc<dyn Spawner>) -> Result<Self, String> {
        Ok(Self { worker: worker::Worker::start(test, spawner)? })
    }
}
impl PenProbe for Runner {
    fn step(&mut self, context: Context, captured: bool, complete: Completion) -> Result<(), String> {
        self.worker.submit(context, captured, complete)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_self_test_names_its_kind_and_seconds() {
        let t = SelfTest::parse("blocked:7.5").unwrap();
        assert_eq!((t.kind, t.seconds, t.rate_hz), (TestKind::Blocked, 7.5, 240.0));
        assert_eq!(SelfTest::parse("standard").unwrap().seconds, 5.0);
        assert!(SelfTest::parse("fast").unwrap_err().contains("unknown self-test"));
        assert!(SelfTest::parse("standard:0").unwrap_err().contains("positive"));
    }
}
