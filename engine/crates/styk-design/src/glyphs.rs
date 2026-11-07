//! Glyphs drawn off the interface thread.
//!
//! On Windows glyph masks come from DirectWrite, drawn on a worker thread (`docs/native/typography.md`, section 6). A
//! frame that needs a glyph the worker has not drawn yet leaves it out; the worker then asks for another frame
//! ([`ready`]), which has it. A program that captures a frame (a screenshot, the typography check) waits until
//! [`pending`] is zero.

use iced::Subscription;
use iced::futures::channel::mpsc;
use iced::futures::{SinkExt, StreamExt};

/// How many glyphs have been asked of the worker and no frame has used yet: zero when the text on screen is complete.
pub fn pending() -> usize {
    iced::advanced::graphics::text::glyphs_pending()
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
