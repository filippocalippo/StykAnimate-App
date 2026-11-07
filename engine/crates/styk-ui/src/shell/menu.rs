//! The placeholders the band's menus open as, until the menu widget and the command registry give them their rows
//! (`SH-057` the StykAnimate menu, `SH-071` a project tab's menu). They are a popover with the menu's rows set as text:
//! nothing in them is a command yet.

use super::controls::{color, elevation};
use super::{Message, Params, text as words};
use iced::widget::{column, container, pin, row, space, text};
use iced::{Alignment, Background, Border, Element, Length, Padding, Widget as _};
use styk_core::shell::Menu;
use styk_design::typography::TextStyle;
use styk_design::widgets::icon;
use styk_design::tokens;

/// A menu opens this far under the control that opened it.
const OFFSET: f32 = 6.0;
/// A menu is at least this wide (`.ui-popover`).
const LEAST: f32 = 248.0;


pub(crate) fn view(params: &Params<'_>, menu: Menu) -> Element<'static, Message> {
    let shell = params.shell;
    let palette = params.theme.palette();
    let layout = shell.layout();
    let style = TextStyle::from_role(&tokens::scale::TYPE_UI);
    let (anchor, rows, submenus): (_, Vec<&str>, bool) = match menu {
        Menu::Mark => (layout.find(|item| matches!(item, styk_core::shell::band::Item::Mark)), words::APPLICATION_MENUS.to_vec(), true),
        Menu::Tab(id) => {
            let front = shell.tabs().iter().any(|tab| tab.id == id && tab.front);
            (layout.find(|item| matches!(item, styk_core::shell::band::Item::Tab(over, _) if *over == id)), if front { words::TAB_MENU_FRONT.to_vec() } else { words::TAB_MENU_RESTING.to_vec() }, false)
        }
    };
    let Some(anchor) = anchor else { return space().boxed() };
    let ink = color(palette.text_1);
    let muted = color(palette.text_3);
    let items: Vec<Element<'static, Message>> = rows
        .into_iter()
        .map(|label| {
            let label = text(label).font(style.font).size(style.size).line_height(style.line()).color(ink).width(Length::Fill);
            let mut cells: Vec<Element<'static, Message>> = vec![label.boxed()];
            if submenus {
                cells.push(icon("chevronRight", 14.0, muted).boxed());
            }
            container(row(cells).align_y(Alignment::Center)).padding(Padding { left: tokens::scale::SPACE_3, right: tokens::scale::SPACE_2, ..Padding::ZERO }).height(tokens::scale::CONTROL_MD).center_y(tokens::scale::CONTROL_MD).boxed()
        })
        .collect();
    let raised = color(palette.surface_raised);
    let lift = elevation(palette.elevation_3).1;
    let panel = container(column(items).padding(tokens::scale::SPACE_1_5))
        .width(Length::Fixed(LEAST))
        .style(move |_| container::Style { background: Some(Background::Color(raised)), border: Border { radius: tokens::scale::RADIUS_XL.into(), ..Border::default() }, shadow: lift, ..container::Style::default() });
    pin(panel).x(anchor.x).y(anchor.y + anchor.height + OFFSET).boxed()
}
