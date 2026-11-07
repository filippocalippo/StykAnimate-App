//! The shell's views: the window with its top band, the project tabs, the workspace switch, the Ctrl+Tab board and the
//! placeholders the menus open as (`docs/native/shell-band.md`).
//!
//! A view here shows what `styk_core::shell` holds and sends it events; it decides nothing. Where the band's items go
//! and which of them fold is `styk_core::shell::band::solve`: the views place each item at the frame it gives.

mod bar;
mod board;
mod controls;
mod menu;
mod strip;
mod text;

use iced::advanced::graphics::text::Paragraph;
use iced::advanced::text::{Alignment, Ellipsis, Paragraph as _, Shaping, Text, Wrapping};
use iced::widget::{column, container, mouse_area, space, stack};
use iced::{Element, Fill, Length, Size, Widget as _, alignment};
use styk_core::shell::band::{Labels, Metrics};
use styk_core::shell::{Event, Shell};
use styk_design::typography::TextStyle;
use styk_design::warm_up::Ready;
use styk_design::{Theme, tokens};
use styk_core::services::shell::chrome::MaxButtonState;

/// What the shell's views send.
#[derive(Clone, Debug)]
pub enum Message {
    /// An event for `Shell::handle`.
    Shell(Event),
    /// The window's minimize button.
    Minimize,
    /// The window's close button.
    CloseWindow,
}

impl From<Event> for Message {
    fn from(event: Event) -> Message {
        Message::Shell(event)
    }
}

/// The tokens the band's layout reads, from the design system: a changed token moves the band.
pub fn metrics() -> Metrics {
    use tokens::scale;
    Metrics {
        space_0_5: scale::SPACE_0_5,
        space_1: scale::SPACE_1,
        space_1_5: scale::SPACE_1_5,
        space_2: scale::SPACE_2,
        space_2_5: scale::SPACE_2_5,
        space_3: scale::SPACE_3,
        control_sm: scale::CONTROL_SM,
        control_md: scale::CONTROL_MD,
        control_lg: scale::CONTROL_LG,
    }
}

/// The text style of the workspace names (`--type-ui-strong`).
pub(crate) fn name_style() -> TextStyle {
    TextStyle::from_role(&tokens::scale::TYPE_UI_STRONG)
}

/// The text style of the band's buttons (`--type-button`, `letter-spacing: -0.005em`).
pub(crate) fn button_style() -> TextStyle {
    TextStyle::from_role(&tokens::scale::TYPE_BUTTON).tracking_em(-0.005)
}

/// How wide the band's words are set, measured with the font system. Asking for the proof keeps it off the interface
/// thread until the fonts are ready.
pub fn measure_labels(_ready: Ready) -> Labels {
    let width = |content: &str, style: TextStyle| {
        Paragraph::with_text(Text {
            content,
            bounds: Size::new(f32::INFINITY, f32::INFINITY),
            size: style.pixels(),
            line_height: style.line(),
            font: style.font,
            align_x: Alignment::Default,
            align_y: alignment::Vertical::Top,
            shaping: Shaping::Advanced,
            wrapping: Wrapping::None,
            ellipsis: Ellipsis::None,
            hint_factor: None,
        })
        .min_width()
    };
    let (name, button) = (name_style(), button_style());
    Labels {
        animate: width(text::ANIMATE, name),
        draw: width(text::DRAW, name),
        build: width(text::BUILD, name),
        export: width(text::EXPORT, button),
        cancel: width(text::CANCEL, button),
        test_rig: width(text::TEST_RIG, button),
        done: width(text::DONE, button),
    }
}

/// Everything the window's view needs besides the shell.
pub struct Params<'a> {
    /// The shell.
    pub shell: &'a Shell,
    /// The theme.
    pub theme: Theme,
    /// Proof the fonts are ready.
    pub ready: Ready,
    /// How the maximize button looks (it is the window's, in the non-client area).
    pub maximize: MaxButtonState,
}

/// The window: the band over `content`, with the Ctrl+Tab board and the open menu's placeholder on top.
pub fn window<'a>(params: Params<'a>, content: Element<'a, Message>) -> Element<'a, Message> {
    let band = bar::view(&params);
    let height = params.shell.layout().height;
    let mut layers: Vec<Element<'a, Message>> = vec![column![band, content].boxed()];
    if let Some(menu) = params.shell.menu() {
        // A press anywhere below the band dismisses it; the band itself stays live (the mark's second press closes).
        let scrim = container(mouse_area(space().width(Fill).height(Fill)).on_press(Message::Shell(Event::CloseMenu))).padding(iced::Padding { top: height, ..iced::Padding::ZERO }).width(Fill).height(Fill);
        layers.push(scrim.boxed());
        layers.push(menu::view(&params, menu));
    }
    if let Some(cards) = params.shell.board() {
        layers.push(board::view(&params, &cards));
    }
    stack(layers).width(Length::Fill).height(Length::Fill).boxed()
}

#[cfg(test)]
mod tests {
    use super::*;
    use iced::Size;
    use styk_core::documents::DocumentId;
    use styk_core::shell::band::{Item, Labels};
    use styk_core::shell::session::Session;
    use styk_core::shell::strip::TabState;
    use styk_core::shell::{TabView, Window};
    use styk_design::widgets::testing::Driver;

    const LABELS: Labels = Labels { animate: 52.140625, draw: 32.8125, build: 31.453125, export: 38.875, cancel: 40.9375, test_rig: 43.375, done: 31.03125 };

    fn shell(width: f32, session: Session, tabs: usize) -> Shell {
        let mut shell = Shell::new(Window { width, height: 900.0, ui_scale: 1.0, controls: true }, metrics(), LABELS);
        let views = (1..=tabs as u64).map(|n| TabView { id: DocumentId::preview(n), name: format!("Project {n}"), front: n == 2.min(tabs as u64), state: (n == 2).then_some(TabState::Edited), dragging: false, drop: None }).collect();
        shell.preview(Some(views));
        shell.handle(&mut styk_core::documents::Documents::new(), Event::Session(session));
        shell
    }

    /// The interface puts every control where the layout says: the views never place anything themselves.
    #[test]
    fn every_control_is_where_the_layout_put_it() {
        for (width, session, tabs) in [(1560.0, Session::None, 3), (879.0, Session::None, 3), (700.0, Session::None, 3), (1000.0, Session::Build, 3), (1560.0, Session::Movieclip, 12), (400.0, Session::None, 1)] {
            let shell = shell(width, session, tabs);
            let ready = styk_design::warm_up::install_bundled(styk_platform::font_smoothing::current());
            let element = window(Params { shell: &shell, theme: Theme::Light, ready, maximize: MaxButtonState::Idle }, container(space()).width(Fill).height(Fill).boxed());
            let mut driver = Driver::new(element, Size::new(width, 900.0), &styk_design::fonts::ALL);
            let snapshot = driver.snapshot();
            for placed in &shell.layout().items {
                let Some(focus) = shell.focus_of(&placed.item) else { continue };
                let bounds = snapshot.bounds_of(focus).unwrap_or_else(|| panic!("{:?} is not in the tree at {width}", placed.item));
                let frame = placed.frame;
                let same = |a: f32, b: f32| (a - b).abs() < 0.6;
                assert!(same(bounds.x, frame.x) && same(bounds.width, frame.width), "{:?} at {width} ({session:?}): the layout says x {} width {}, the interface x {} width {}", placed.item, frame.x, frame.width, bounds.x, bounds.width);
                assert!(matches!(placed.item, Item::Tab(..)) || same(bounds.height, frame.height), "{:?} height {} against {}", placed.item, bounds.height, frame.height);
            }
        }
    }
}
