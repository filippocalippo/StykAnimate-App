use styk_core::command_queue::{Activity, GestureQueue, Invocation, Next, Settlement, Submitted, CAPACITY};
use styk_core::commands::CommandId;
use styk_core::documents::DocumentId;
use styk_core::focus::FocusState;
use styk_core::shortcuts::{Activation, Input, Platform, Press, Scope, Shortcuts};
use styk_core::text_entry::Chord;
use styk_core::command_queue::{Phase, Source};
use std::collections::{BTreeSet, HashSet};

fn document() -> Option<DocumentId> { Some(DocumentId::preview(1)) }
fn active() -> Activity { Activity { gesture: true, keyboard_handles: document(), ..Activity::default() } }
fn press(keys: &mut Shortcuts, key: &str, repeat: bool) -> Activation {
    let Press::Run(activation) = keys.press(&FocusState::new(), &Chord::new(key, false, false, false), &[Scope::Canvas],
        Input { repeat, ..Input::default() }, |_| true) else { panic!("handle press"); };
    activation
}
fn save() -> Invocation { Invocation::action(CommandId::from_id("save").unwrap(), document()) }

#[test]
fn a_release_cannot_overtake_a_repeat_blocked_by_an_overlapping_operation() {
    let mut keys = Shortcuts::new(Platform::Control, true);
    let mut queue = GestureQueue::default();
    let first = Invocation::press(press(&mut keys, "ArrowLeft", false), document());
    assert_eq!(queue.submit(first, Activity::default(), keys.held()), Submitted::Ready(first));
    let busy = Activity { operation: true, ..active() };
    let repeat = Invocation::press(press(&mut keys, "ArrowLeft", true), document());
    assert_eq!(queue.submit(repeat, busy, keys.held()), Submitted::Queued);
    let release = Invocation::release(keys.release("ArrowLeft").unwrap(), document());
    assert_eq!(queue.submit(release, busy, keys.held()), Submitted::Queued);
    assert_eq!(queue.next(document(), busy, Settlement::Ready), Next::Blocked);
    assert_eq!(queue.reserved_releases(keys.held()), 0);
    assert_eq!(queue.next(document(), active(), Settlement::Ready), Next::Ready(repeat));
    assert_eq!(queue.next(document(), active(), Settlement::Ready), Next::Ready(release));
    assert!(queue.is_empty());
}

#[test]
fn a_new_direction_waits_for_earlier_unstarted_handle_events() {
    let mut keys = Shortcuts::new(Platform::Control, true);
    let mut queue = GestureQueue::default();
    let busy = Activity { stroke: true, ..Activity::default() };
    let left = Invocation::press(press(&mut keys, "ArrowLeft", false), document());
    let right = Invocation::press(press(&mut keys, "ArrowRight", false), document());
    for event in [left, save(), right] { assert_eq!(queue.submit(event, busy, keys.held()), Submitted::Queued); }
    assert_eq!(queue.next(document(), Activity::default(), Settlement::Ready), Next::Ready(left));
    let up = Invocation::press(press(&mut keys, "ArrowUp", false), document());
    assert_eq!(queue.submit(up, active(), keys.held()), Submitted::Queued);
    assert_eq!(queue.next(document(), active(), Settlement::Ready), Next::Ready(right));
    assert_eq!(queue.next(document(), active(), Settlement::Ready), Next::Ready(up));
    assert_eq!(queue.next(document(), active(), Settlement::Ready), Next::Blocked);
}

#[test]
fn full_queue_refusal_keeps_the_terminal_after_its_blocked_repeats() {
    let mut keys = Shortcuts::new(Platform::Control, true);
    let mut queue = GestureQueue::default();
    let first = Invocation::press(press(&mut keys, "ArrowLeft", false), document());
    assert_eq!(queue.submit(first, Activity::default(), keys.held()), Submitted::Ready(first));
    let busy = Activity { operation: true, ..active() };
    for _ in 0..CAPACITY - 1 {
        let repeat = Invocation::press(press(&mut keys, "ArrowLeft", true), document());
        assert_eq!(queue.submit(repeat, busy, keys.held()), Submitted::Queued);
    }
    let refused = press(&mut keys, "ArrowLeft", true);
    assert!(matches!(queue.submit(Invocation::press(refused, document()), busy, keys.held()), Submitted::Refused { .. }));
    let terminal = Invocation::release(keys.reject(refused).unwrap(), document());
    assert_eq!(queue.submit(terminal, busy, keys.held()), Submitted::Queued);
    assert_eq!(queue.len(), CAPACITY);
    assert_eq!(queue.next(document(), busy, Settlement::Ready), Next::Blocked);
    for _ in 0..CAPACITY - 1 { assert!(matches!(queue.next(document(), active(), Settlement::Ready), Next::Ready(event) if event.phase == first.phase)); }
    assert_eq!(queue.next(document(), active(), Settlement::Ready), Next::Ready(terminal));
    assert_eq!(queue.reserved_releases(keys.held()), 0);
    assert!(queue.is_empty());
}

#[test]
fn live_keys_keep_terminal_space_and_a_refused_fresh_key_only_rolls_back() {
    let mut keys = Shortcuts::new(Platform::Control, true);
    let mut queue = GestureQueue::default();
    for key in ["ArrowLeft", "ArrowDown"] {
        let event = Invocation::press(press(&mut keys, key, false), document());
        assert_eq!(queue.submit(event, active(), keys.held()), Submitted::Ready(event));
    }
    let busy = Activity { operation: true, ..active() };
    let right = Invocation::press(press(&mut keys, "ArrowRight", false), document());
    assert_eq!(queue.submit(right, busy, keys.held()), Submitted::Queued);
    for _ in 0..CAPACITY - 4 { assert_eq!(queue.submit(save(), busy, keys.held()), Submitted::Queued); }
    assert_eq!(queue.reserved_releases(keys.held()), 3, "two live keys and the queued key each need a terminal");
    let fresh = press(&mut keys, "ArrowUp", false);
    assert!(matches!(queue.submit(Invocation::press(fresh, document()), busy, keys.held()), Submitted::Refused { .. }));
    assert_eq!(keys.reject(fresh), None, "a never-admitted key has no feature owner to release");
    assert!(keys.release("ArrowUp").is_none(), "refusal rolls back the physical hold");
    let mut terminals = Vec::new();
    for key in ["ArrowLeft", "ArrowDown", "ArrowRight"] {
        let terminal = Invocation::release(keys.release(key).unwrap(), document());
        assert_eq!(queue.submit(terminal, busy, keys.held()), Submitted::Queued);
        terminals.push(terminal);
    }
    assert_eq!(queue.len(), CAPACITY);
    assert_eq!(queue.reserved_releases(keys.held()), 0);
    assert_eq!(queue.next(document(), busy, Settlement::Ready), Next::Blocked);
    assert_eq!(queue.next(document(), active(), Settlement::Ready), Next::Ready(right));
    for terminal in terminals { assert_eq!(queue.next(document(), active(), Settlement::Ready), Next::Ready(terminal)); }
    for _ in 0..CAPACITY - 4 { assert_eq!(queue.next(document(), Activity::default(), Settlement::Ready), Next::Ready(save())); }
    assert!(queue.is_empty());
}

const HANDLE_KEYS: [&str; 5] = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "KeyR"];
fn family(event: Invocation) -> bool { event.source == Source::Keyboard && event.command.id().starts_with("handle-") }

/// An independent event ledger: it observes public admissions/outcomes, never the queue's storage or helpers.
struct Audit {
    keys: Shortcuts,
    queue: GestureQueue,
    pending: Vec<Invocation>,
    resolved_starts: HashSet<(Option<DocumentId>, &'static str)>,
    live: BTreeSet<&'static str>,
    document: Option<DocumentId>,
    busy: Activity,
    failed: bool,
    terminals: usize,
    completed_terminals: usize,
    seed: u64,
    step: usize,
}

impl Audit {
    fn new(seed: u64) -> Self {
        Self { keys: Shortcuts::new(Platform::Control, true), queue: GestureQueue::default(), pending: Vec::new(),
            resolved_starts: HashSet::new(), live: BTreeSet::new(), document: document(), busy: Activity::default(),
            failed: false, terminals: 0, completed_terminals: 0, seed, step: 0 }
    }

    fn activity(&self) -> Activity {
        Activity { gesture: self.busy.gesture || !self.live.is_empty(),
            keyboard_handles: if self.live.is_empty() { None } else { self.document }, ..self.busy }
    }

    fn check(&self) {
        assert_eq!(self.queue.len(), self.pending.len(), "seed {} step {}", self.seed, self.step);
        // Replay the ledger forward, independently of the production reservation calculation.
        let mut unmatched = BTreeSet::new();
        for event in &self.pending {
            if let Some(key) = event.key {
                match event.phase {
                    Phase::Press if event.command.info().shortcut.is_some_and(|s| s.hold) => { unmatched.insert(key); }
                    Phase::Release { .. } => { unmatched.remove(key); }
                    _ => {}
                }
            }
        }
        unmatched.extend(self.keys.held().iter().map(|held| held.key));
        assert_eq!(self.queue.reserved_releases(self.keys.held()), unmatched.len(), "reservations: seed {} step {}", self.seed, self.step);
        assert!(self.queue.len() + unmatched.len() <= CAPACITY, "capacity: seed {} step {}", self.seed, self.step);
    }

    fn delivered(&mut self, event: Invocation, cancelled: bool) {
        if !cancelled && event.command == CommandId::Cancel {
            self.finish_gesture();
            self.release_all(); // cancelKeyboardCommand also calls hotkeys.releaseAll().
        }
        if !family(event) { return; }
        let key = event.key.unwrap();
        match event.phase {
            Phase::Press => {
                self.resolved_starts.insert((event.document, key));
                // R changes the handle-edit modifier only; arrows own the keyboard gesture.
                if !cancelled && key != "KeyR" { self.live.insert(key); }
            }
            Phase::Release { .. } => {
                assert!(self.resolved_starts.remove(&(event.document, key)),
                    "release without an accepted preceding press: seed {} step {} {key}", self.seed, self.step);
                if event.document == self.document { self.live.remove(key); }
                self.completed_terminals += 1;
            }
            Phase::Invoke => panic!("a keyboard event is a press or release"),
        }
    }

    fn submit(&mut self, event: Invocation) -> bool {
        let terminal = matches!(event.phase, Phase::Release { .. });
        match self.queue.submit(event, self.activity(), self.keys.held()) {
            Submitted::Ready(actual) => {
                assert_eq!(actual, event);
                assert!(!family(event) || !self.pending.iter().copied().any(family),
                    "submit overtook a handle: seed {} step {}", self.seed, self.step);
                if terminal { self.terminals += 1; }
                self.delivered(event, false);
                true
            }
            Submitted::Queued => {
                if terminal { self.terminals += 1; }
                self.pending.push(event);
                true
            }
            Submitted::Refused { invocation, .. } => {
                assert_eq!(invocation, event);
                assert!(!terminal, "terminal refused: seed {} step {}", self.seed, self.step);
                false
            }
        }
    }

    fn press(&mut self, key: &str, shifted: bool) {
        let repeat = self.keys.held().iter().any(|held| held.key == key);
        let result = self.keys.press(&FocusState::new(), &Chord::new(key, false, false, shifted), &[Scope::Canvas],
            Input { repeat, ..Input::default() }, |_| true);
        if let Press::Run(activation) = result {
            let event = Invocation::press(activation, self.document);
            if !self.submit(event) && let Some(release) = self.keys.reject(activation) {
                assert!(self.submit(Invocation::release(release, self.document)));
            }
        }
        self.check();
    }

    fn release(&mut self, key: &str) {
        if let Some(release) = self.keys.release(key) {
            assert!(self.submit(Invocation::release(release, self.document)));
        }
        self.check();
    }

    fn release_all(&mut self) {
        let releases: Vec<_> = self.keys.release_all().collect();
        for release in releases { assert!(self.submit(Invocation::release(release, self.document))); self.check(); }
    }

    fn finish_gesture(&mut self) {
        // A commit or cancellation can settle the gesture before the physical key comes up.
        self.live.clear();
        self.busy.gesture = false;
    }

    fn cancel(&mut self) {
        self.press("Escape", false);
    }

    fn pump(&mut self) {
        let outcome = self.queue.next(self.document, self.activity(), if self.failed { Settlement::Failed } else { Settlement::Ready });
        match outcome {
            Next::Ready(event) | Next::Cancelled(event) => {
                let index = self.pending.iter().position(|pending| *pending == event).expect("every outcome was admitted");
                let cancelled = matches!(outcome, Next::Cancelled(_));
                if family(event) {
                    assert!(!self.pending[..index].iter().copied().any(family),
                        "next overtook a handle: seed {} step {}", self.seed, self.step);
                }
                if cancelled || !family(event) { assert_eq!(index, 0); }
                self.pending.remove(index);
                self.delivered(event, cancelled);
            }
            Next::Empty => assert!(self.pending.is_empty()),
            Next::Blocked => assert!(!self.pending.is_empty()),
        }
        if self.queue.is_empty() { self.failed = false; }
        self.check();
    }

    fn fill(&mut self) {
        self.busy.operation = true;
        for _ in 0..=CAPACITY {
            let accepted = self.submit(Invocation::action(CommandId::from_id("save").unwrap(), self.document));
            self.check();
            if !accepted { return; }
        }
        panic!("the fixed queue must refuse saturation");
    }
}

#[test]
fn seeded_sequences_preserve_family_order_terminal_capacity_and_exact_reservations() {
    for seed in 0..2000u64 {
        let mut audit = Audit::new(seed);
        let mut random = seed + 1;
        for step in 0..60 {
            audit.step = step;
            random ^= random << 13; random ^= random >> 7; random ^= random << 17;
            let key = HANDLE_KEYS[(random as usize >> 8) % HANDLE_KEYS.len()];
            if step == 20 { audit.fill(); } else {
                match random % 18 {
                    0..=4 => audit.press(key, random & 64 != 0),
                    5..=8 => audit.release(key),
                    9..=10 => audit.pump(),
                    11 => {
                        audit.busy = Activity { gesture: random & 32 != 0, stroke: random & 64 != 0,
                            operation: random & 128 != 0, selection: random & 256 != 0,
                            selection_committing: random & 512 != 0, loading: random & 1024 != 0, ..Activity::default() };
                    }
                    12 => {
                        audit.release_all();
                        audit.live.clear();
                        audit.document = Some(DocumentId::preview(if audit.document == document() { 2 } else { 1 }));
                    }
                    13 => { audit.release_all(); audit.failed = true; audit.pump(); }
                    14 => audit.fill(),
                    16 => audit.cancel(),
                    17 => audit.finish_gesture(),
                    _ => { audit.submit(Invocation::action(CommandId::from_id("undo").unwrap(), audit.document)); }
                }
            }
            audit.check();
        }
        audit.release_all();
        audit.busy = Activity::default();
        for _ in 0..=CAPACITY { if audit.queue.is_empty() { break; } audit.pump(); }
        assert!(audit.queue.is_empty(), "seed {seed}: the queue cannot trap a terminal during final drain");
        assert_eq!(audit.terminals, audit.completed_terminals, "seed {seed}: no terminal may be lost");
        assert!(audit.resolved_starts.is_empty(), "seed {seed}: every admitted hold must end");
    }
}

#[test]
fn modifier_cancel_and_early_finish_leave_late_releases_owned_and_admissible() {
    let mut audit = Audit::new(2000);
    audit.press("KeyR", false);
    assert!(!audit.activity().gesture, "R only sets the handle-edit modifier in app.mjs");
    assert!(audit.submit(save()));
    assert!(audit.queue.is_empty(), "R cannot hold an unrelated action behind a gesture");
    audit.release("KeyR");
    for cancelled in [false, true] {
        audit.press("ArrowLeft", false);
        assert!(audit.activity().gesture);
        if cancelled { audit.cancel(); } else { audit.finish_gesture(); }
        assert!(!audit.activity().gesture);
        assert_eq!(audit.keys.held().len(), usize::from(!cancelled), "Cancel releases all; normal settlement leaves the key held");
        audit.fill();
        audit.release("ArrowLeft");
        assert_eq!(audit.terminals, audit.completed_terminals, "late release reaches its owner even at capacity");
        audit.busy = Activity::default();
        for _ in 0..CAPACITY { audit.pump(); }
        assert!(audit.queue.is_empty());
        assert!(audit.resolved_starts.is_empty());
    }
}
