//! A source that plays scripted input: the test double of every platform source.

use super::{InputCaps, InputEvent, InputQueue, InputSource, InterruptReason, Modifiers, Script};

/// Plays a [`Script`] into an [`InputQueue`] on demand, with the timestamps the script gives plus a base, and can raise
/// the interrupts a real source raises.
pub struct FakeSource {
    queue: InputQueue,
    played: usize,
    attached: bool,
}

impl FakeSource {
    pub fn new(queue: InputQueue) -> FakeSource {
        FakeSource { queue, played: 0, attached: true }
    }

    /// Pushes every step of `script` not yet played whose time is before `until_ns` (relative to the script), with the
    /// modifiers `modifiers` added to each. Returns how many steps were pushed.
    pub fn play_until(&mut self, script: &Script, base_ns: u64, until_ns: u64, modifiers: Modifiers) -> usize {
        let mut pushed = 0;
        while self.attached && self.played < script.steps.len() && script.steps[self.played].t_ns < until_ns {
            let mut sample = script.steps[self.played].sample(script.pointer, base_ns);
            sample.modifiers = sample.modifiers | modifiers;
            self.queue.push(InputEvent::Sample(sample));
            self.played += 1;
            pushed += 1;
        }
        pushed
    }

    /// Pushes the rest of the script.
    pub fn play_all(&mut self, script: &Script, base_ns: u64) -> usize {
        self.play_until(script, base_ns, u64::MAX, Modifiers::NONE)
    }

    /// Starts the script over.
    pub fn rewind(&mut self) {
        self.played = 0;
    }

    /// Raises the interrupt a real source raises when a pointer's capture is lost, a contact is cancelled or the window
    /// loses focus.
    pub fn interrupt(&self, pointer: u32, time_ns: u64, reason: InterruptReason) {
        if self.attached {
            self.queue.push(InputEvent::Interrupted { pointer, time_ns, reason });
        }
    }
}

impl InputSource for FakeSource {
    fn caps(&self) -> InputCaps {
        InputCaps { name: "fake", pressure: true, pressure_max: 1024, tilt: true, twist: false, eraser: true, barrel: true, hover: true, history: true }
    }

    fn detach(&mut self) {
        self.attached = false;
    }
}

#[cfg(test)]
mod tests {
    use super::super::ScriptSpec;
    use super::*;

    fn script() -> Script {
        Script::generate(&ScriptSpec::standard(240.0, 1.0, 400.0, 300.0), 3)
    }

    fn drained(queue: &InputQueue) -> Vec<InputEvent> {
        let mut out = Vec::new();
        queue.drain(&mut out);
        out
    }

    #[test]
    fn playing_in_slices_delivers_every_step_once_in_order() {
        let queue = InputQueue::new();
        let mut source = FakeSource::new(queue.clone());
        let script = script();
        let mut total = 0;
        for slice in 1..=10 {
            total += source.play_until(&script, 5_000, slice * 100_000_000, Modifiers::NONE);
        }
        total += source.play_all(&script, 5_000);
        assert_eq!(total, 240);
        let events = drained(&queue);
        assert_eq!(events.len(), 240);
        let times: Vec<u64> = events.iter().map(|e| if let InputEvent::Sample(s) = e { s.time_ns } else { 0 }).collect();
        assert!(times.windows(2).all(|pair| pair[1] > pair[0]));
        assert_eq!(times[0], 5_000);
    }

    #[test]
    fn modifiers_are_carried_by_the_samples_they_were_held_for() {
        let queue = InputQueue::new();
        let mut source = FakeSource::new(queue.clone());
        let script = script();
        let half = script.steps[120].t_ns;
        source.play_until(&script, 0, half, Modifiers::SHIFT);
        source.play_all(&script, 0);
        let events = drained(&queue);
        let held: Vec<bool> = events.iter().map(|e| matches!(e, InputEvent::Sample(s) if s.modifiers.contains(Modifiers::SHIFT))).collect();
        assert!(held[..120].iter().all(|h| *h));
        assert!(held[120..].iter().all(|h| !*h), "released before the later samples");
    }

    #[test]
    fn an_interrupt_is_its_own_event_and_a_detached_source_is_silent() {
        let queue = InputQueue::new();
        let mut source = FakeSource::new(queue.clone());
        source.interrupt(3, 77, InterruptReason::CaptureLost);
        source.detach();
        source.interrupt(3, 78, InterruptReason::Canceled);
        assert_eq!(source.play_all(&script(), 0), 0);
        let events = drained(&queue);
        assert_eq!(events, [InputEvent::Interrupted { pointer: 3, time_ns: 77, reason: InterruptReason::CaptureLost }]);
        assert!(source.caps().history);
    }
}
