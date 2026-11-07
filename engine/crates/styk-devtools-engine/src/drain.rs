//! A capture drain owns its storage and runs only while explicitly started.
use crate::capture::{Capture, event};
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{SyncSender, sync_channel},
    },
    time::Duration,
};
use styk_services::{Spawner, clock::Clock};
/// Conservative node allowance includes both cursor maps during a drain pass.
const MAX_CURSOR_BYTES: usize = 1024 * 1024;
const MAX_CURSORS: usize = MAX_CURSOR_BYTES / 128;
// Each live drain can retain a snapshot, ring scratch, cursor maps and bounded encoding scratch.
const DRAIN_BYTES: usize = styk_trace::MAX_SNAPSHOT_BYTES
    + MAX_CURSOR_BYTES
    + styk_trace::MAX_ARCHIVE_BYTES
    + crate::capture::MAX_CHUNK;
static DRAIN_USED: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
static DRAIN_REFUSED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
struct Reservation;
impl Drop for Reservation {
    fn drop(&mut self) {
        DRAIN_USED.fetch_sub(DRAIN_BYTES, Ordering::AcqRel);
    }
}
pub fn accounting() -> (usize, u64) {
    (
        DRAIN_USED.load(Ordering::Relaxed),
        DRAIN_REFUSED.load(Ordering::Relaxed),
    )
}
pub struct Drain {
    stop: Arc<AtomicBool>,
    wake: SyncSender<()>,
    result: Arc<Mutex<Option<Result<Capture, String>>>>,
}
impl Drain {
    pub fn start(spawner: &dyn Spawner, clock: Arc<dyn Clock>, cap: usize) -> Result<Self, String> {
        if cap < 1024 {
            return Err("capture needs at least 1024 bytes".into());
        }
        if DRAIN_USED
            .try_update(Ordering::AcqRel, Ordering::Acquire, |used| {
                used.checked_add(DRAIN_BYTES)
                    .filter(|n| *n <= 2 * DRAIN_BYTES)
            })
            .is_err()
        {
            DRAIN_REFUSED.fetch_add(1, Ordering::Relaxed);
            return Err("two capture drains are already active".into());
        }
        let reservation = Reservation;
        let mut capture = Capture::new(cap)?;
        let stop = Arc::new(AtomicBool::new(false));
        let (wake, receiver) = sync_channel(1);
        let result = Arc::new(Mutex::new(None));
        let output = result.clone();
        let cancelled = stop.clone();
        spawner.spawn("devtools.capture",Box::new(move||{
   let _reservation=reservation;
   let mut cursors=BTreeMap::<u32,u64>::new();
   loop {
    append(&mut capture,&mut cursors,styk_trace::snapshot(),cap);
    if cancelled.load(Ordering::Acquire){break;}
    // Worker-only wait, woken by stop/drop. No interface caller waits or joins.
    let _=receiver.recv_timeout(Duration::from_millis(100));
   }
   let footer=serde_json::json!({"name":"capture.accounting","ph":"C","pid":1,"tid":0,"ts":clock.now().as_micros() as u64,"args":{"capture_dropped":capture.dropped,"trace_overwritten_or_refused":styk_trace::dropped(),"clock_missing":styk_trace::clock::missing_reads()}});
   let finished=serde_json::to_vec(&footer).map_err(|e|e.to_string()).and_then(|bytes|capture.push(&bytes)).map(|()|capture);
   if let Ok(mut result)=output.lock(){*result=Some(finished);}
  })).map_err(|e|e.to_string())?;
        Ok(Self { stop, wake, result })
    }
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Release);
        let _ = self.wake.try_send(());
    }
    pub fn take(&self) -> Option<Result<Capture, String>> {
        self.result.try_lock().ok()?.take()
    }
}
impl Drop for Drain {
    fn drop(&mut self) {
        self.stop();
    }
}
fn append(
    capture: &mut Capture,
    cursors: &mut BTreeMap<u32, u64>,
    mut records: Vec<styk_trace::Record>,
    cap: usize,
) {
    records.sort_unstable_by_key(|record| (record.thread, record.sequence));
    for record in records {
        if record.sequence <= cursors.get(&record.thread).copied().unwrap_or(0) {
            continue;
        }
        if !cursors.contains_key(&record.thread) && cursors.len() == MAX_CURSORS {
            capture.dropped += 1;
            continue;
        }
        cursors.insert(record.thread, record.sequence);
        match serde_json::to_vec(&event(&record)) {
            Ok(bytes) if bytes.len() + 4 + 512 <= cap.saturating_sub(capture.bytes()) => {
                let _ = capture.push(&bytes);
            }
            _ => capture.dropped += 1,
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn archive_overlap_and_repeated_polls_do_not_duplicate_events() {
        let record = |sequence, start_ns| styk_trace::Record {
            thread_name: "test".into(),
            thread: 0,
            sequence,
            name: "drain.dedup",
            kind: styk_trace::RecordKind::Mark,
            start_ns,
            duration_ns: 0,
        };
        let mut capture = Capture::new(4096).unwrap();
        let mut cursors = BTreeMap::new();
        append(
            &mut capture,
            &mut cursors,
            vec![record(2, 0), record(1, 10), record(1, 10)],
            4096,
        );
        append(
            &mut capture,
            &mut cursors,
            vec![record(1, 10), record(2, 0)],
            4096,
        );
        assert_eq!(capture.chunks().count(), 2);
        assert_eq!(capture.dropped, 0);
    }
    #[test]
    fn stop_before_worker_start_finishes_and_writes_accounting() {
        let _serial = crate::TRACE_TEST_LOCK.lock().unwrap();
        let spawner = styk_services::ManualSpawner::new();
        let drain = Drain::start(
            &spawner,
            Arc::new(styk_services::clock::FixedClock::new()),
            1024,
        )
        .unwrap();
        drain.stop();
        assert!(drain.take().is_none());
        assert!(spawner.run_next());
        let result = drain.take().unwrap().unwrap();
        assert!(result.bytes() <= 1024);
        assert!(
            result
                .chunks()
                .any(|bytes| String::from_utf8_lossy(bytes).contains("capture.accounting"))
        );
    }
}
