//! Runtime-only deadline adapter. Draws nothing and owns no interaction or animation state.
//! iced merges scheduled redraws into its single window wake. A stale wake is harmless:
//! only the current core deadline can publish a tick; None cancels publication entirely.
use iced::Widget as _;
use std::sync::Arc;
use std::time::Duration;
use iced::advanced::{layout, renderer, widget, Layout, Shell, Widget};
use iced::{Element, Event, Length, Rectangle, Renderer, Size, Theme, mouse, window};
use styk_services::Clock;

struct Wake<Message> {
    deadline: Option<u64>,
    clock: Arc<dyn Clock>,
    message: fn(u64) -> Message,
}
impl<Message> widget::Meta for Wake<Message> {}
impl<Message> Widget<Message, Theme, Renderer> for Wake<Message> {
    fn size(&self) -> Size<Length> { Size::new(Length::Fixed(0.0), Length::Fixed(0.0)) }
    fn layout(&mut self, tree: &mut widget::Tree, _: &Renderer, _: &layout::Limits) { tree.size = Size::ZERO; }
    fn update(&mut self, _: &mut widget::Tree, event: &Event, _: Layout, _: mouse::Cursor, _: &Renderer, shell: &mut Shell<'_, Message>, _: &Rectangle) {
        if let (Some(deadline), Event::Window(window::Event::RedrawRequested(at))) = (self.deadline, event) {
            let now = self.clock.now().as_millis().min(u128::from(u64::MAX)) as u64;
            if now >= deadline { shell.publish((self.message)(now)); }
            else { shell.request_redraw_at(*at + Duration::from_millis(deadline - now)); }
        }
    }
    fn draw(&self, _: &widget::Tree, _: &mut Renderer, _: &Theme, _: &renderer::Style, _: Layout, _: mouse::Cursor, _: &Rectangle) {}
}
pub fn element<'a, Message: 'a>(deadline: Option<u64>, clock: Arc<dyn Clock>, message: fn(u64) -> Message) -> Element<'a, Message> {
    Wake { deadline, clock, message }.boxed()
}
