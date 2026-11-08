//! Where the panels sit: the docked window (`docs/native/docking-views.md`) draws what `styk_core::dock` solved (`view`), and
//! `docked` is the Properties panel alone at today's default size, for the panel's own screens. A panel's view fills whatever
//! bounds it is given; only the core decides them.

mod probe;
mod view;
pub use view::{HEADER_HEIGHT, Params, STRIP_WIDTH, view};

use iced::widget::{Space, container, stack};
use iced::{Background, Color, Element, Length, Widget as _};
use styk_design::Theme;

/// The default panel width of today's right dock.
pub const DEFAULT_WIDTH: f32 = 320.0;

/// A hairline over the top edge of `content`, taking no room (`box-shadow: inset 0 1px 0 var(--line-1)`).
pub fn hairline_over<'a, Message: 'a>(content: Element<'a, Message>, theme: Theme) -> Element<'a, Message> {
    let palette = theme.palette();
    let line = container(Space::new().width(Length::Fill).height(1.0))
        .width(Length::Fill)
        .style(move |_| container::Style { background: Some(Background::Color(Color::from(palette.line_1))), ..container::Style::default() });
    stack![content, line].boxed()
}

/// `content` as today's docked panel, at the default width: the surface edge to edge under a hairline. The dock's own
/// rounded container (its corners) is the docking chunk's.
pub fn docked<'a, Message: 'a>(content: Element<'a, Message>, theme: Theme) -> Element<'a, Message> {
    let palette = theme.palette();
    let panel = container(content)
        .width(Length::Fixed(DEFAULT_WIDTH))
        .height(Length::Fill)
        .style(move |_| container::Style { background: Some(Background::Color(Color::from(palette.surface))), ..container::Style::default() });
    hairline_over(panel.boxed(), theme)
}

/// The docked window below the band: the Properties panel's view and the stage in their groups, every other panel as
/// today's empty state with its name. `inspector` is the Properties panel's view (the dock puts it in its group and the
/// hairline under the tabs); `stage` is the stage widget, absent while no project is open (the stage's field shows alone).
pub fn window<'a>(params: &Params<'_>, inspector: Option<crate::inspector::View<'_>>, stage: Option<Element<'a, crate::Message>>) -> Element<'a, crate::Message> {
    let theme = params.theme;
    let palette = theme.palette();
    let (mut inspector, mut stage) = (inspector, stage);
    let mut panel = |panel: &styk_core::layout::PanelId| -> Option<Element<'a, crate::Message>> {
        match panel.kind.as_str() {
            // The stage's field fills the group under its header; its bottom corners follow the island's.
            "stage" => {
                let field = palette.surface_field;
                let content: Element<'a, crate::Message> = stage.take().unwrap_or_else(|| Space::new().width(Length::Fill).height(Length::Fill).boxed());
                let radius = iced::border::Radius { top_left: 0.0, top_right: 0.0, bottom_right: styk_design::tokens::scale::RADIUS_XL, bottom_left: styk_design::tokens::scale::RADIUS_XL };
                Some(container(content).width(Length::Fill).height(Length::Fill).style(move |_| container::Style { background: Some(Background::Color(Color::from(field))), border: iced::Border { radius, ..iced::Border::default() }, ..container::Style::default() }).boxed())
            }
            "properties" => inspector.take().map(|view| hairline_over(crate::inspector::view(view), theme)),
            _ => None,
        }
    };
    let content = view(params, &mut panel);
    container(content).padding(iced::Padding { top: params.top, ..iced::Padding::ZERO }).width(Length::Fill).height(Length::Fill).boxed()
}

/// What the dock makes of a pointer event while a press or a drag is tracked (the application subscribes to the cursor and
/// the button only then): the pointer moved, or the primary button came up.
pub fn track(event: &iced::Event) -> Option<crate::Message> {
    use styk_core::commands::Command;
    use styk_core::dock::Event;
    let event = match event {
        iced::Event::Mouse(iced::mouse::Event::CursorMoved { position }) => Event::PointerMoved { x: f64::from(position.x), y: f64::from(position.y) },
        iced::Event::Mouse(iced::mouse::Event::ButtonReleased(iced::mouse::Button::Left)) => Event::PointerReleased,
        _ => return None,
    };
    Some(crate::Message::Command(Command::Dock(event)))
}

/// What the dock makes of a key press.
#[derive(Clone, Debug, PartialEq)]
pub enum Key {
    /// Not the dock's: the rest of the window has it.
    Pass,
    /// The dock has it and does nothing with it (a keyboard move swallows every other key).
    Swallow,
    /// The dock has it: this event.
    Send(styk_core::dock::Event),
    /// The dock notes it and the key goes on (Shift: a drop with it held floats).
    Note(styk_core::dock::Event),
}

/// The dock's keys: Escape over a gesture or a flyout, Shift, and while a panel moves its arrows, Enter and Escape. `focused` is the target that holds focus.
pub fn key(dock: &styk_core::dock::Dock, _focused: Option<styk_core::focus::FocusId>, key: &iced::keyboard::Key, _modifiers: iced::keyboard::Modifiers) -> Key {
    use iced::keyboard::Key as K;
    use iced::keyboard::key::Named;
    use styk_core::dock::Event;
    if dock.moving() {
        return match key.as_ref() {
            K::Named(Named::ArrowLeft | Named::ArrowUp) => Key::Send(Event::MoveStep(-1)),
            K::Named(Named::ArrowRight | Named::ArrowDown) => Key::Send(Event::MoveStep(1)),
            K::Named(Named::Enter) => Key::Send(Event::MoveCommit),
            K::Named(Named::Escape) => Key::Send(Event::Escape),
            _ => Key::Swallow,
        };
    }
    match key.as_ref() {
        K::Named(Named::Escape) if dock.wants_escape() => Key::Send(Event::Escape),
        K::Named(Named::Shift) => Key::Note(Event::Shift(true)),
        _ => Key::Pass,
    }
}
