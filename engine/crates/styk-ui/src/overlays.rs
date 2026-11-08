//! The window's overlay layer: menus, selects' lists, the stage's message, a tooltip and the owner's dialogs, over the page.
//!
//! The core owns every decision and every clock (`styk_core::overlay::host` inside `Core`): what is open, what a key or a
//! hover does, which animation is at which phase and when the next wake is due (`Core::overlay_deadline`). This only draws
//! what the host holds, at the phases it gives: [`layer`] is mounted over the window's content, and every message its
//! widgets send reaches `message::update_at` and from there `Core::dispatch(Command::Overlay { .. })`. The runtime owns the
//! one wake (`styk-app`'s `overlay_wake`), the focus snapshot and the pointer releases it forwards.

#[cfg(feature = "engine")]
use crate::message::Message;
#[cfg(feature = "engine")]
use iced::{Element, Rectangle};
#[cfg(feature = "engine")]
use styk_core::overlay::host::{message_animation_id, message_progress_id};
#[cfg(feature = "engine")]
use styk_design::widgets::layer::Placed;
#[cfg(feature = "engine")]
use styk_design::widgets::{menu, toast, tooltip};
#[cfg(feature = "engine")]
use styk_design::Palette;

/// The production layer, drawn from the Core-owned host. `owned` are the boxes the window's owner mounts (a dialog, a
/// popover, a sheet: built with `styk_design::widgets::dialog` at `core.overlays().phase(id)`); they sit with the menus in
/// the one layer so a press outside them is reported like any other.
#[cfg(feature = "engine")]
pub fn layer<'a>(core: &'a styk_core::app::Core, palette: &'static Palette, top_inset: f32, stage: Option<Rectangle>, owned: Vec<Placed<'a, Message>>) -> Element<'a, Message> {
    layer_of(core.overlays(), core.focus().focus_visible(), palette, top_inset, stage, owned)
}

/// [`layer`] from the host and the ring flag it reads (a test mounts a copy of the host it holds).
#[cfg(feature = "engine")]
pub fn layer_of<'a>(host: &'a styk_core::overlay::host::Host, ring: bool, palette: &'static Palette, top_inset: f32, stage: Option<Rectangle>, owned: Vec<Placed<'a, Message>>) -> Element<'a, Message> {
    let mut extra = Vec::new();
    if let Some(current) = host.messages().current() {
        extra.push(toast::placed(palette, current, host.phase(message_animation_id(current.id)), host.phase(message_progress_id(current.id)), stage, Message::Toast));
    }
    // The tooltip of the control the core says shows now, at the bounds the last walk of the tree measured for it.
    if let Some((tip, at)) = host.tooltip_anchor() {
        let anchor = Rectangle { x: at.x as f32, y: at.y as f32, width: at.width as f32, height: at.height as f32 };
        extra.push(tooltip::placed(palette, &tip.content, anchor, false, top_inset));
    }
    // The owner's boxes (a dialog) sit under the menus: a select inside a dialog opens its list over it.
    menu::layer_over(palette, host, ring, top_inset, owned, extra, Message::Overlay)
}
