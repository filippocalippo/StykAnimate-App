//! When the device thread ends, what the renderer holds is not freed there: it is left in the control block's graveyard for the
//! closer to free elsewhere. (On every exit path: closing, and a device lost before the stop applied.)

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use styk_services::audio::fake::{FakeConfig, FakeOutput};
use styk_services::audio::{AudioOutput, Next, RenderResult, RenderSource};

struct Spy(Arc<AtomicBool>);

impl Drop for Spy {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

/// A renderer that plays silence and holds something big.
struct Holding(Arc<AtomicBool>);

impl RenderSource for Holding {
    fn render(&mut self, out: &mut [f32]) -> RenderResult {
        out.fill(0.0);
        RenderResult { next: Next::Continue, generation: 1, playing_frames: (out.len() / 2) as u32, project_start: 0, held_at: 0 }
    }

    fn poll(&mut self) -> RenderResult {
        RenderResult { next: Next::Continue, generation: 1, playing_frames: 0, project_start: 0, held_at: 0 }
    }

    fn rewind(&mut self, _frames: u32) {}

    fn retire(&mut self) -> Box<dyn Send> {
        Box::new(Spy(self.0.clone()))
    }
}

#[test]
fn closing_leaves_what_the_renderer_holds_in_the_graveyard_instead_of_freeing_it() {
    for lose_first in [false, true] {
        let dropped = Arc::new(AtomicBool::new(false));
        let (mut output, fake) = FakeOutput::new(FakeConfig::default(), false);
        let control = output.control();
        output.open(Box::new(Holding(dropped.clone()))).unwrap();
        control.activate();
        fake.advance_ms(50);
        if lose_first {
            fake.lose_device();
            assert!(control.is_lost());
        }
        output.close();
        assert!(!dropped.load(Ordering::SeqCst), "the output (lost first: {lose_first}) freed what the renderer held");
        let junk = control.take_graveyard();
        assert_eq!(junk.len(), 1);
        drop(junk);
        assert!(dropped.load(Ordering::SeqCst), "and the closer frees it");
    }
}
