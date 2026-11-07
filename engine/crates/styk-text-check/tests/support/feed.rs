use std::sync::{Arc, Mutex};
use styk_core::services::{Job, Spawner, SpawnError};

pub fn start(prepared: styk_design::repertoire::Prepared) -> std::thread::JoinHandle<()> {
    struct Witness(Mutex<Option<std::thread::JoinHandle<()>>>);
    impl Spawner for Witness {
        fn spawn(&self, name: &str, job: Job) -> Result<(), SpawnError> {
            *self.0.lock().unwrap() = Some(std::thread::Builder::new().name(name.into()).spawn(job).map_err(|e| SpawnError(e.to_string()))?);
            Ok(())
        }
    }
    let host = Witness(Mutex::new(None));
    prepared.feed(&host, Arc::new(styk_platform::clock::SystemClock::new())).expect("a feeder task");
    host.0.into_inner().unwrap().expect("the feeder was spawned")
}
