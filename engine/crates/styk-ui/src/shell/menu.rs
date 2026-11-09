//! The placeholder a project tab's menu opens as, until the menu widget gives it its rows (`SH-071`): a popover with the
//! rows set as text, nothing in it a command yet. The mark's StykAnimate menu is the overlay host's (`styk_core::menus`,
//! `docs/native/menus.md`).

use super::controls::{color, elevation};
use super::{Message, Params, text as words};
use iced::widget::{column, container, pin, space, text};
use iced::{Background, Border, Element, Length, Padding, Widget as _};
use styk_core::shell::Menu;
use styk_design::typography::TextStyle;
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
    let Menu::Tab(id) = menu;
    let front = shell.tabs().iter().any(|tab| tab.id == id && tab.front);
    let anchor = layout.find(|item| matches!(item, styk_core::shell::band::Item::Tab(over, _) if *over == id));
    let rows: Vec<String> = if front { words::TAB_MENU_FRONT.iter().map(|label| params.presentation.label(label)).collect() } else { words::TAB_MENU_RESTING.iter().map(|label| params.presentation.label(label)).collect() };
    let Some(anchor) = anchor else { return space().boxed() };
    let ink = color(palette.text_1);
    let items: Vec<Element<'static, Message>> = rows
        .into_iter()
        .map(|label| {
            let label = text(label).font(style.font).size(style.size).line_height(style.line()).color(ink).width(Length::Fill);
            container(label).padding(Padding { left: tokens::scale::SPACE_3, right: tokens::scale::SPACE_2, ..Padding::ZERO }).height(tokens::scale::CONTROL_MD).center_y(tokens::scale::CONTROL_MD).boxed()
        })
        .collect();
    let raised = color(palette.surface_raised);
    let lift = elevation(palette.elevation_3).1;
    let panel = container(column(items).padding(tokens::scale::SPACE_1_5))
        .width(Length::Fixed(LEAST))
        .style(move |_| container::Style { background: Some(Background::Color(raised)), border: Border { radius: tokens::scale::RADIUS_XL.into(), ..Border::default() }, shadow: lift, ..container::Style::default() });
    pin(panel).x(anchor.x).y(anchor.y + anchor.height + OFFSET).boxed()
}
