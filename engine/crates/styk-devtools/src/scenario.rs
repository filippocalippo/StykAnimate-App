//! Headless scenario seam. Owners implement operations through their normal core paths.
use std::sync::{Arc, Mutex};
use std::time::Duration;
use styk_services::{
    Spawner,
    clock::{Clock, FixedClock},
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Step {
    Open,
    Frame(u32),
    Export,
    Advance(u64),
}
/// A small versioned prefix of the automation language; unsupported steps fail visibly.
pub fn parse(text: &str) -> Result<Vec<Step>, String> {
    if text.len() > 64 * 1024 {
        return Err("scenario exceeds 64 KiB".into());
    }
    let mut lines = text.lines();
    if lines.next() != Some("styk-auto/1") {
        return Err("expected styk-auto/1".into());
    }
    let mut steps = Vec::new();
    for (line, text) in lines.enumerate() {
        let fields: Vec<_> = text.split_whitespace().collect();
        let step = match fields.as_slice() {
            [] => continue,
            ["open"] => Step::Open,
            ["export"] => Step::Export,
            ["frame", tick] => Step::Frame(
                tick.parse()
                    .map_err(|_| format!("invalid tick at line {}", line + 2))?,
            ),
            ["advance", nanos] => Step::Advance(
                nanos
                    .parse()
                    .map_err(|_| format!("invalid time at line {}", line + 2))?,
            ),
            _ => return Err(format!("unsupported scenario step at line {}", line + 2)),
        };
        if steps.len() == 1024 {
            return Err("scenario exceeds 1024 steps".into());
        }
        steps.push(step);
    }
    Ok(steps)
}
pub trait Host: Send + 'static {
    fn step(&mut self, step: &Step, logical_time: Duration) -> Result<(), String>;
}
#[derive(Debug)]
pub struct Sample {
    pub step: Step,
    pub elapsed: Duration,
}
pub type Completion = Arc<Mutex<Option<Result<Vec<Sample>, String>>>>;
/// One worker, one bounded completion slot; the UI polls with try_lock and never joins.
pub fn start(
    spawner: &dyn Spawner,
    clock: Arc<dyn Clock>,
    steps: Vec<Step>,
    mut host: impl Host,
) -> Result<Completion, String> {
    if steps.len() > 1024 {
        return Err("scenario exceeds 1024 steps".into());
    }
    let completion = Arc::new(Mutex::new(None));
    let result = completion.clone();
    spawner
        .spawn(
            "devtools.scenario",
            Box::new(move || {
                let logical = FixedClock::new();
                let run = || -> Result<Vec<Sample>, String> {
                    let mut samples = Vec::new();
                    for step in steps {
                        if let Step::Advance(nanos) = step {
                            logical.advance(Duration::from_nanos(nanos));
                            continue;
                        }
                        let _span = match &step {
                            Step::Open => styk_trace::span!("scenario.open"),
                            Step::Frame(_) => styk_trace::span!("scenario.frame"),
                            Step::Export => styk_trace::span!("scenario.export"),
                            Step::Advance(_) => styk_trace::span!("scenario.advance"),
                        };
                        let start = clock.now();
                        host.step(&step, logical.now())?;
                        samples.push(Sample {
                            step,
                            elapsed: clock.now().saturating_sub(start),
                        });
                    }
                    Ok(samples)
                };
                let outcome = run();
                if let Ok(mut slot) = result.lock() {
                    *slot = Some(outcome);
                }
            }),
        )
        .map_err(|e| e.to_string())?;
    Ok(completion)
}
#[cfg(test)]
mod tests {
    use super::*;
    struct Fake;
    impl Host for Fake {
        fn step(&mut self, _: &Step, time: Duration) -> Result<(), String> {
            assert_eq!(time, Duration::from_nanos(17));
            Ok(())
        }
    }
    #[test]
    fn clock_advances_only_at_script_barriers() {
        let spawner = styk_services::ManualSpawner::new();
        let steps = parse("styk-auto/1\nadvance 17\nopen\nframe 0\nexport").unwrap();
        let done = start(&spawner, Arc::new(FixedClock::new()), steps, Fake).unwrap();
        assert!(done.try_lock().unwrap().is_none());
        assert!(spawner.run_next());
        let result = done.lock().unwrap().take().unwrap().unwrap();
        assert_eq!(result.len(), 3);
        assert!(result.iter().all(|s| s.elapsed.is_zero()));
        assert!(parse("styk-auto/1\ndrag 0").is_err());
    }
}
