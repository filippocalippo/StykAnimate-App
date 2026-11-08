//! Measurement around the application's one automation AST; there is no tooling grammar.
use std::sync::{Arc, Mutex};
use std::time::Duration;
pub use styk_core::automation::{Script, Step};
use styk_services::{Spawner, clock::{Clock, FixedClock}};

const MAX_ACTIONS: usize = 1024;
const MAX_BUDGETS: usize = 64;
const MAX_BYTES: usize = styk_core::automation::MAX_SCRIPT_BYTES
    + 2 * (MAX_ACTIONS + MAX_BUDGETS) * std::mem::size_of::<(usize, Step)>();

/// Admit the actual AST allocation before cloning it or starting a worker. Unknown UI steps
/// are explicit errors, never ignored actions that would change the measured workload.
fn admit(script: &Script) -> Result<(), String> {
    let mut bytes = script.steps.capacity().checked_mul(std::mem::size_of::<(usize, Step)>()).ok_or("scenario byte budget exhausted")?;
    let mut actions = 0;
    let mut budgets = 0;
    for (line, step) in &script.steps {
        let payload = match step {
            Step::Open(path) => path.capacity(),
            Step::Frame(_) | Step::Export | Step::Advance(_) => 0,
            Step::Budget(spec) => {
                budgets += 1;
                spec.metric.capacity() + spec.op.capacity() + spec.unit.capacity()
                    + spec.floor.as_ref().map_or(0, String::capacity)
            }
            _ => return Err(format!("line {line}: step is unavailable in headless profiling")),
        };
        if !matches!(step, Step::Budget(_)) { actions += 1; }
        bytes = bytes.checked_add(payload).ok_or("scenario byte budget exhausted")?;
        if bytes > MAX_BYTES || actions > MAX_ACTIONS || budgets > MAX_BUDGETS {
            return Err(format!("line {line}: scenario byte/action/budget admission exhausted"));
        }
    }
    if bytes > MAX_BYTES { return Err("scenario byte budget exhausted".into()); }
    Ok(())
}

/// Measurement policy consumes parsed budget declarations; syntax belongs to core.
pub fn budgets(script: &Script) -> Result<Vec<crate::budget::Budget>, String> {
    admit(script)?;
    Ok(script.steps.iter().filter_map(|(line, step)| match step {
        Step::Budget(spec) => Some(crate::budget::Budget { spec: spec.clone(), line: *line }),
        _ => None,
    }).collect())
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
    script: Script,
    mut host: impl Host,
) -> Result<Completion, String> {
    admit(&script)?;
    let completion = Arc::new(Mutex::new(None));
    let result = completion.clone();
    spawner.spawn("devtools.scenario", Box::new(move || {
        let _clock = styk_trace::clock::scoped(clock.clone());
        let logical = FixedClock::new();
        let run = || -> Result<Vec<Sample>, String> {
            let mut samples = Vec::new();
            for (line, step) in script.steps {
                match &step {
                    Step::Advance(nanos) => { logical.advance(Duration::from_nanos(*nanos)); continue; }
                    Step::Budget(_) => continue,
                    _ => {}
                }
                let _span = match &step {
                    Step::Open(_) => styk_trace::span!("scenario.open"),
                    Step::Frame(_) => styk_trace::span!("scenario.frame"),
                    Step::Export => styk_trace::span!("scenario.export"),
                    _ => return Err(format!("line {line}: step is unavailable in headless profiling")),
                };
                let start = clock.now();
                host.step(&step, logical.now()).map_err(|error| format!("line {line}: {error}"))?;
                samples.push(Sample { step, elapsed: clock.now().saturating_sub(start) });
            }
            Ok(samples)
        };
        let outcome = run();
        drop(host);
        if let Ok(mut slot) = result.lock() { *slot = Some(outcome); }
    })).map_err(|e| e.to_string())?;
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
        let _serial = crate::TRACE_TEST_LOCK.lock().unwrap();
        let spawner = styk_services::ManualSpawner::new();
        let script = Script::parse("styk-auto/1\nadvance 17\nopen fixture.styk\nframe 0\nexport\nbudget export.ms <= 10ms").unwrap();
        assert_eq!(budgets(&script).unwrap()[0].line, 6);
        let done = start(&spawner, Arc::new(FixedClock::new()), script, Fake).unwrap();
        assert!(done.try_lock().unwrap().is_none());
        assert!(spawner.run_next());
        let result = done.lock().unwrap().take().unwrap().unwrap();
        assert_eq!(result.len(), 3);
        assert!(result.iter().all(|s| s.elapsed.is_zero()));
    }
    #[test]
    fn unsupported_steps_and_allocation_pressure_are_refused_before_spawn() {
        let spawner = styk_services::ManualSpawner::new();
        let script = Script::parse("styk-auto/1\nkey escape").unwrap();
        assert!(start(&spawner, Arc::new(FixedClock::new()), script, Fake).unwrap_err().contains("line 2"));
        let script = Script::parse(&format!("styk-auto/1\n{}", "export\n".repeat(1025))).unwrap();
        assert!(budgets(&script).is_err());
        let mut path = std::path::PathBuf::with_capacity(MAX_BYTES + 1);
        path.push("tiny");
        assert!(budgets(&Script { steps: vec![(1, Step::Open(path))] }).is_err());
        assert!(!spawner.run_next());
    }
}
