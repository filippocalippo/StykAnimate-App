//! Glyphs drawn off the interface thread.
//!
//! Glyph masks are drawn by a worker thread, on Windows with DirectWrite (`docs/native/typography.md`, section 6). A
//! frame that needs a glyph the worker has not drawn yet is not shown: the window keeps its last complete frame, and
//! the worker asks for another frame ([`ready`]) when the glyphs are there. A program that captures a frame (a
//! screenshot, the typography check) draws again until [`incomplete`] is false.

use iced::Subscription;
use iced::futures::channel::mpsc;
use iced::futures::{SinkExt, StreamExt};

/// How long windows have kept their last frame for glyphs the worker was still drawing, for the developer tools. There is
/// no deadline to a wait: a frame with holes in its text is never shown.
pub fn held() -> iced::advanced::graphics::text::HeldFrames {
    iced::advanced::graphics::text::held_frames()
}

/// Whether the frame drawn last lacked glyphs the worker is still drawing.
pub fn incomplete() -> bool {
    iced::advanced::graphics::text::candidate_incomplete()
}

/// A message each time the worker has drawn glyphs: handling it asks the window for another frame, which draws them.
pub fn ready() -> Subscription<()> {
    Subscription::run(|| {
        iced::stream::channel(1, async |mut output: mpsc::Sender<()>| {
            let (sender, mut receiver) = mpsc::unbounded::<()>();
            iced::advanced::graphics::text::set_glyph_notifier(move || {
                let _ = sender.unbounded_send(());
            });
            while receiver.next().await.is_some() {
                // One message per burst: the frame it asks for takes every glyph that is ready.
                while receiver.try_recv().is_ok() {}
                if output.send(()).await.is_err() {
                    break;
                }
            }
        })
    })
}
