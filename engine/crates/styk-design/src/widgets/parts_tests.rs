//! Headless tests of the panel's small parts and the overlay boxes, on the real widgets in the real tree ([`Driver`]): what a
//! press, a drag or a key reports, and that a disabled part reports nothing.

use super::dialog::{popover, sheet};
use super::layer::Layer;
use super::parts::{self, ListRow, SectionHead, Tab, Tabs};
use super::splitter::{Axis, Event_ as Splitter, splitter};
use super::testing::Driver;
use crate::Theme as DesignTheme;
use iced::keyboard::{Modifiers, key::Named};
use iced::widget::{Row, Space};
use iced::{Element, Event, Length, Point, Size, Widget as _, mouse};
use styk_core::focus::{FocusArea, FocusId};

#[derive(Clone, Debug, PartialEq)]
enum Msg {
    Step(i32),
    Tab(usize),
    Row,
    Toggle,
    Main,
    More,
    Bar(Splitter),
    Close,
}

fn palette() -> &'static crate::Palette {
    DesignTheme::Light.palette()
}

fn driver(element: Element<'_, Msg>) -> Driver<'_, Msg> {
    Driver::new(element, Size::new(420.0, 300.0), &crate::fonts::ALL)
}

fn centre(driver: &mut Driver<'_, Msg>, id: u64) -> Point {
    let bounds = driver.snapshot().bounds_of(FocusId(id)).expect("the target is laid out");
    Point::new(bounds.x + bounds.width / 2.0, bounds.y + bounds.height / 2.0)
}

#[test]
fn a_stepper_asks_for_one_step_either_way_and_a_disabled_one_asks_for_nothing() {
    let mut on = driver(parts::stepper(palette(), FocusId(1), FocusArea::Panels, "3", false, false, Msg::Step));
    let (minus, plus) = (centre(&mut on, 1), centre(&mut on, 2));
    on.click(minus);
    on.click(plus);
    assert_eq!(on.messages(), [Msg::Step(-1), Msg::Step(1)]);
    let mut off = driver(parts::stepper(palette(), FocusId(1), FocusArea::Panels, "3", true, false, Msg::Step));
    let plus = centre(&mut off, 2);
    off.click(plus);
    assert!(off.messages().is_empty());
}

#[test]
fn tabs_choose_by_press_and_by_arrow_key() {
    let tabs = Tabs::new(FocusId(10), FocusArea::Panels, palette(), vec![Tab { label: "Props".into(), icon: None }, Tab { label: "Effects".into(), icon: None }, Tab { label: "Library".into(), icon: None }], 0, Msg::Tab).into_element();
    let mut d = driver(tabs);
    let second = centre(&mut d, 11);
    d.click(second);
    assert_eq!(d.messages(), [Msg::Tab(1)]);
    d.focus(FocusId(10));
    d.press(Named::ArrowRight);
    assert_eq!(d.messages(), [Msg::Tab(1)], "an arrow key moves to the next tab and chooses it");
}

#[test]
fn a_list_row_and_a_collapsible_section_head_report_a_press() {
    let row = ListRow::new(FocusId(20), FocusArea::Panels, palette(), "Bubble", Msg::Row).lead("layers").selected(true).into_element();
    let head = SectionHead::new(palette(), "Camera").collapsible(FocusId(21), FocusArea::Panels, false, Msg::Toggle).into_element();
    let mut d = driver(iced::widget::Column::with_children(vec![row, head]).width(Length::Fixed(300.0)).boxed());
    let (row, head) = (centre(&mut d, 20), centre(&mut d, 21));
    d.click(row);
    d.click(head);
    assert_eq!(d.messages(), [Msg::Row, Msg::Toggle]);
    d.focus(FocusId(21));
    d.press(Named::Enter);
    assert_eq!(d.messages(), [Msg::Toggle], "Enter on the focused head toggles it as a press does");
}

#[test]
fn a_split_buttons_halves_report_their_own_press() {
    let split = parts::split_button(palette(), (FocusId(30), FocusId(31)), FocusArea::Panels, "grid", Msg::Main, Msg::More, false, false, false);
    let mut d = driver(split);
    let (main, more) = (centre(&mut d, 30), centre(&mut d, 31));
    d.click(more);
    d.click(main);
    assert_eq!(d.messages(), [Msg::More, Msg::Main]);
}

#[test]
fn a_splitter_reports_a_drag_with_how_far_it_went_and_its_keys() {
    let bar = splitter(palette(), FocusId(40), FocusArea::Panels, Axis::Vertical, false, Msg::Bar);
    let row = Row::with_children(vec![Space::new().width(Length::Fixed(100.0)).boxed(), bar, Space::new().width(Length::Fixed(100.0)).boxed()]);
    let mut d = driver(row.height(Length::Fixed(200.0)).boxed());
    let start = centre(&mut d, 40);
    d.point_at(start);
    d.events(&[Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left))]);
    d.events(&[Event::Mouse(mouse::Event::CursorMoved { position: Point::new(start.x + 24.0, start.y) })]);
    d.events(&[Event::Mouse(mouse::Event::ButtonReleased(mouse::Button::Left))]);
    assert_eq!(d.messages(), [Msg::Bar(Splitter::DragStart), Msg::Bar(Splitter::DragMove(24.0)), Msg::Bar(Splitter::DragEnd)]);
    d.focus(FocusId(40));
    d.press(Named::ArrowRight);
    d.modifiers(Modifiers::SHIFT);
    d.press(Named::ArrowLeft);
    d.modifiers(Modifiers::default());
    d.press(Named::End);
    d.press(Named::Home);
    assert_eq!(d.messages(), [Msg::Bar(Splitter::Step { direction: 1, shift: false }), Msg::Bar(Splitter::Step { direction: -1, shift: true }), Msg::Bar(Splitter::Largest), Msg::Bar(Splitter::Reset)]);
}

#[test]
fn a_popovers_close_button_is_a_focus_target_that_reports_a_press() {
    let body = Space::new().width(Length::Fixed(10.0)).height(Length::Fixed(10.0)).boxed();
    let popover = popover(palette(), "Onion skin".into(), body, None, Some((FocusId(50), Msg::Close)));
    let anchored = super::layer::Placed::new(popover, |_, _| super::layer::Position::at(40.0, 60.0));
    let mut d = driver(Layer::new(vec![anchored]).boxed());
    let close = centre(&mut d, 50);
    assert!(close.x > 40.0 + 200.0, "the close button sits at the popover's end: {close:?}");
    d.click(close);
    assert_eq!(d.messages(), [Msg::Close]);
}

#[test]
fn a_sheet_sits_at_the_top_right_under_the_band_and_takes_the_room_it_has() {
    let panel = sheet(palette(), Space::new().width(Length::Fixed(10.0)).height(Length::Fixed(40.0)).boxed(), 52.0);
    let mut d = driver(Layer::new(vec![panel]).boxed());
    let grey = iced::Color::from_rgb(0.5, 0.5, 0.5);
    let (pixels, size) = d.render(&iced::Theme::Light, grey, 1.0);
    let at = |x: u32, y: u32| &pixels[((y * size.width + x) * 4) as usize..][..4];
    assert_eq!(at(300, 62), [255, 255, 255, 255], "the sheet's raised surface is drawn at the right, under the band");
    assert_ne!(at(20, 62), [255, 255, 255, 255], "the left stays the page");
    assert_ne!(at(300, 20), [255, 255, 255, 255], "and nothing is above it");
}
