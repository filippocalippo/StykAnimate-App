//! The overlay screens: the menus, the select's list, a tooltip, the stage messages, a dialog and the panel parts
//! (`stykanimate --screen menu-root`, `select-open`, `tooltip`, `toasts`, `dialog`, `parts`, each in both themes).
//!
//! Each scene is a small page with the overlay in the state a person would see it. The state comes from the core's host
//! (`styk_core::overlay::host`): a menu is opened, hovered, ticked and keyed as the application would, so the screen draws
//! what the core holds and nothing is positioned by hand except the page's own anchors (the trigger's rectangle).
//! Nothing here is behaviour: every control sends [`Message::Noop`].

use crate::component_sheet::Message;
use iced::widget::{Column, Row, Space, container, stack};
use iced::{Alignment, Element, Length, Padding, Rectangle, Size, Widget as _};
use styk_core::commands::CommandId;
use styk_core::focus::{FocusArea, FocusId, FocusState, ScopeId};
use styk_core::overlay::host::{Hints, Host, Purpose, option_rows};
use styk_core::overlay::menu::{Anchor, Entry, Item};
use styk_core::overlay::messages::{Action, Message as Toast, Priority, Tone};
use styk_core::overlay::placement::Rect;
use styk_core::overlay::tooltip::Content;
use styk_design::typography::TextStyle;
use styk_design::widgets::badge::Tint;
use styk_design::widgets::button::{Button, IconButton, Variant};
use styk_design::widgets::control::{Preview, words};
use styk_design::widgets::dialog::{Dialog, DialogSize, modal};
use styk_design::widgets::layer::Layer;
use styk_design::widgets::menu;
use styk_design::widgets::parts::{self, DotKind, ListRow, SectionHead, Tab, Tabs};
use styk_design::widgets::progress::{Bar, Spinner};
use styk_design::widgets::select::{Choice, Select};
use styk_design::widgets::toast;
use styk_design::widgets::toggle::Switch;
use styk_design::{Palette, Theme, tokens};

/// The overlay screens.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OverlayScreen {
    /// A menu button's menu: group labels, every kind of row, a submenu row, a danger row; opened by the keyboard.
    MenuRoot,
    /// A menu with its submenu open beside the row that opened it.
    MenuSubmenu,
    /// A context menu at a point, a row under the pointer.
    MenuContext,
    /// A select with its list open under it.
    SelectOpen,
    /// A tooltip over the button it names.
    Tooltip,
    /// The stage's messages in each dress.
    Toasts,
    /// A dialog over its dimmed window.
    Dialog,
    /// The panel's small parts.
    Parts,
}

impl OverlayScreen {
    pub const ALL: [OverlayScreen; 8] = [OverlayScreen::MenuRoot, OverlayScreen::MenuSubmenu, OverlayScreen::MenuContext, OverlayScreen::SelectOpen, OverlayScreen::Tooltip, OverlayScreen::Toasts, OverlayScreen::Dialog, OverlayScreen::Parts];

    /// The ID of the light screen (the dark one adds `-dark`; the catalogue lists both as strings, `screens::Screen::id`).
    pub const fn id(self) -> &'static str {
        match self {
            OverlayScreen::MenuRoot => "menu-root",
            OverlayScreen::MenuSubmenu => "menu-submenu",
            OverlayScreen::MenuContext => "menu-context",
            OverlayScreen::SelectOpen => "select-open",
            OverlayScreen::Tooltip => "tooltip",
            OverlayScreen::Toasts => "toasts",
            OverlayScreen::Dialog => "dialog",
            OverlayScreen::Parts => "parts",
        }
    }

    /// The window the scene is drawn in, in logical pixels.
    pub const fn size(self) -> (u32, u32) {
        match self {
            OverlayScreen::MenuRoot => (360, 540),
            OverlayScreen::MenuSubmenu => (560, 300),
            OverlayScreen::MenuContext => (420, 300),
            OverlayScreen::SelectOpen => (320, 220),
            OverlayScreen::Tooltip => (320, 140),
            OverlayScreen::Toasts => (520, 430),
            OverlayScreen::Dialog => (520, 400),
            OverlayScreen::Parts => (938, 1270),
        }
    }
}

/// The page's trigger button: 32 px square, 24 px from the window's corner.
const TRIGGER: Rectangle = Rectangle { x: 24.0, y: 24.0, width: 32.0, height: 32.0 };
const INVOKER: FocusId = FocusId(7);

fn rect(bounds: Rectangle) -> Rect {
    menu::rect_of(bounds)
}

fn item(command: CommandId, label: &str, icon: Option<&str>) -> Entry {
    Entry::Item(Item { icon: icon.map(str::to_owned), ..Item::new(command, label) })
}

fn check(command: CommandId, label: &str, on: bool) -> Entry {
    Entry::Item(Item { checked: Some(on), keep_open: true, ..Item::new(command, label) })
}

fn radio(command: CommandId, label: &str, on: bool) -> Entry {
    Entry::Item(Item { checked: Some(on), radio: true, group: Some("zoom".into()), keep_open: true, ..Item::new(command, label) })
}

fn submenu(label: &str, icon: Option<&str>, children: Vec<Entry>) -> Entry {
    Entry::Item(Item { icon: icon.map(str::to_owned), submenu: Some(children), ..Item::new(CommandId::Menu, label) })
}

/// The menu button's menu: every kind of row once.
fn app_menu() -> Vec<Entry> {
    vec![
        Entry::Label("Edit".into()),
        item(CommandId::Undo, "Undo", Some("undo")),
        item(CommandId::Redo, "Redo", Some("redo")),
        Entry::Separator,
        Entry::Item(Item { icon: Some("duplicate".into()), disabled: true, reason: "Select a figure first".into(), ..Item::new(CommandId::Copy, "Copy") }),
        item(CommandId::Paste, "Paste", Some("clipboard")),
        item(CommandId::Duplicate, "Duplicate", Some("dup")),
        Entry::Separator,
        Entry::Label("View".into()),
        check(CommandId::ToggleGrid, "Grid", true),
        radio(CommandId::Zoom100, "Zoom 100%", true),
        radio(CommandId::Zoom200, "Zoom 200%", false),
        Entry::Separator,
        submenu("More", Some("more"), vec![item(CommandId::SelectAll, "Select all", None)]),
        Entry::Separator,
        Entry::Item(Item { icon: Some("trash".into()), danger: true, ..Item::new(CommandId::Delete, "Delete") }),
    ]
}

fn submenu_root() -> Vec<Entry> {
    vec![
        item(CommandId::Undo, "Undo", Some("undo")),
        item(CommandId::Redo, "Redo", Some("redo")),
        Entry::Separator,
        submenu("Transform", Some("move"), vec![item(CommandId::Mirror, "Flip horizontal", None), item(CommandId::MirrorVertical, "Flip vertical", None), Entry::Separator, item(CommandId::Rotate, "Rotate 90\u{b0}", None)]),
        submenu("Export as", Some("export"), vec![item(CommandId::Save, "Video", None)]),
    ]
}

fn context_menu() -> Vec<Entry> {
    vec![
        item(CommandId::Copy, "Copy", Some("duplicate")),
        item(CommandId::Paste, "Paste", Some("clipboard")),
        item(CommandId::Duplicate, "Duplicate", Some("dup")),
        Entry::Separator,
        Entry::Item(Item { icon: Some("trash".into()), danger: true, ..Item::new(CommandId::Delete, "Delete") }),
    ]
}

/// The height one entry takes at the default type: a row, a rule, a group label.
fn entry_height(entry: &Entry, first: bool) -> f32 {
    match entry {
        Entry::Separator => 1.0 + 2.0 * tokens::scale::SPACE_1_5,
        Entry::Label(_) => (if first { tokens::scale::SPACE_1 } else { tokens::scale::SPACE_2_5 }) + tokens::scale::LEADING_11 + tokens::scale::SPACE_1,
        Entry::Item(item) if item.reason.is_empty() => tokens::scale::CONTROL_MD,
        Entry::Item(_) => 2.0 * tokens::scale::SPACE_1 + tokens::scale::LEADING_13 + tokens::scale::SPACE_1_5 + tokens::scale::LEADING_11,
    }
}

/// A menu's padding and border on each side.
const EDGE: f32 = tokens::scale::SPACE_1_5 + 1.0;

fn menu_height(entries: &[Entry]) -> f32 {
    2.0 * EDGE + entries.iter().enumerate().map(|(at, entry)| entry_height(entry, at == 0)).sum::<f32>()
}

/// Where the `index`th item of a menu placed at `(x, y)` is, for anchoring its submenu.
fn row_rect(x: f32, y: f32, entries: &[Entry], index: usize) -> Rect {
    let mut top = y + EDGE;
    let mut seen = 0;
    for (at, entry) in entries.iter().enumerate() {
        let height = entry_height(entry, at == 0);
        if let Entry::Item(_) = entry {
            if seen == index {
                return Rect { x: f64::from(x + EDGE), y: f64::from(top), width: f64::from(240.0 - 2.0 * EDGE), height: f64::from(height) };
            }
            seen += 1;
        }
        top += height;
    }
    Rect::default()
}

/// The tooltip's content: its name and shortcut.
fn tip() -> Content {
    Content { label: "Undo".into(), shortcut: "Ctrl+Z".into() }
}

fn focus_page() -> FocusState {
    let mut focus = FocusState::new();
    focus.register(ScopeId::ROOT, vec![styk_core::focus::FocusTarget::new(INVOKER.0, FocusArea::TopBand, styk_core::focus::TargetKind::Control)]);
    focus.focus(INVOKER);
    focus
}

/// The state of an overlay screen.
pub struct Page {
    screen: OverlayScreen,
    theme: Theme,
    host: Host,
    focus: FocusState,
}

impl Page {
    pub fn new(screen: OverlayScreen, theme: Theme) -> Page {
        let mut host = Host::new(Hints::default(), false);
        let mut focus = focus_page();
        match screen {
            OverlayScreen::MenuRoot => {
                host.open(app_menu(), Anchor::Root(rect(TRIGGER)), Purpose::Commands, Some(INVOKER), true, None, &mut focus);
            }
            OverlayScreen::MenuSubmenu => {
                let root = submenu_root();
                host.open(root.clone(), Anchor::Root(rect(TRIGGER)), Purpose::Commands, Some(INVOKER), false, None, &mut focus);
                let id = host.menus()[0].id();
                // The root menu sits under the trigger, left edges aligned, 6 px below it.
                let placed = styk_core::overlay::menu::Menu::place(Anchor::Root(rect(TRIGGER)), styk_core::overlay::placement::Size { width: 240.0, height: f64::from(menu_height(&root)) }, styk_core::overlay::placement::Size { width: f64::from(OverlayScreen::MenuSubmenu.size().0), height: f64::from(OverlayScreen::MenuSubmenu.size().1) }, 0.0, false);
                let row = row_rect(placed.rect.x as f32, placed.rect.y as f32, &root, 2);
                host.hover(id, 2, &mut focus, 1000);
                host.tick(1150, &move |_| Some(row), &mut focus);
            }
            OverlayScreen::MenuContext => {
                host.open(context_menu(), Anchor::Point { x: 150.0, y: 90.0 }, Purpose::Commands, None, false, None, &mut focus);
                let id = host.menus()[0].id();
                host.hover(id, 2, &mut focus, 0);
            }
            OverlayScreen::SelectOpen => {
                let rows = option_rows([("Linear", false), ("Hold", false), ("Ease in", false), ("Bounce", true)]);
                host.open(rows, Anchor::Root(Rect { x: 24.0, y: 24.0, width: 200.0, height: 36.0 }), Purpose::Select { invoker: INVOKER }, Some(INVOKER), false, Some(1), &mut focus);
                let id = host.menus()[0].id();
                host.hover(id, 1, &mut focus, 0);
            }
            OverlayScreen::Tooltip | OverlayScreen::Toasts | OverlayScreen::Dialog | OverlayScreen::Parts => {}
        }
        Page { screen, theme, host, focus }
    }

    pub fn view(&self) -> Element<'_, Message> {
        let palette = self.theme.palette();
        let size = self.screen.size();
        let window = Size::new(size.0 as f32, size.1 as f32);
        match self.screen {
            OverlayScreen::MenuRoot | OverlayScreen::MenuSubmenu => self.over(palette, trigger(palette, true), Vec::new()),
            OverlayScreen::MenuContext => self.over(palette, Space::new().boxed(), Vec::new()),
            OverlayScreen::SelectOpen => {
                let options = vec![Choice { label: "Linear".into(), disabled: false }, Choice { label: "Hold".into(), disabled: false }, Choice { label: "Ease in".into(), disabled: false }, Choice { label: "Bounce".into(), disabled: true }];
                let select = Select::new(FocusId(8), FocusArea::Panels, palette, options, Some(1), |_| Message::Noop, |_| Message::Noop).label("Easing").into_element();
                self.over(palette, container(select).width(Length::Fixed(200.0)).boxed(), Vec::new())
            }
            OverlayScreen::Tooltip => {
                let button = IconButton::new(FocusId(9), FocusArea::TopBand, palette, "undo", Message::Noop).preview(Some(Preview::Hover)).into_element();
                let anchor = Rectangle { x: 144.0, y: 70.0, width: 32.0, height: 32.0 };
                let base = container(button).padding(Padding { top: anchor.y, left: anchor.x, ..Padding::ZERO }).width(Length::Fill).height(Length::Fill).boxed();
                let placed = styk_design::widgets::tooltip::placed(palette, &tip(), anchor, false, 0.0);
                page(palette, stack![base, Layer::new(vec![placed]).boxed()].boxed())
            }
            OverlayScreen::Toasts => page(palette, toasts(palette)),
            OverlayScreen::Dialog => {
                let base = container(
                    Column::with_children(vec![words("Rooftop fight", TextStyle::from_role(&tokens::scale::TYPE_TITLE), palette.text_1), words("24 fps, 3 s, 960 \u{d7} 540", TextStyle::from_role(&tokens::scale::TYPE_BODY), palette.text_2)]).spacing(tokens::scale::SPACE_1),
                )
                .padding(Padding { top: 32.0, left: 32.0, ..Padding::ZERO })
                .width(Length::Fill)
                .height(Length::Fill);
                let options = vec![Choice { label: "MP4 video".into(), disabled: false }, Choice { label: "GIF".into(), disabled: false }];
                let format = container(Select::new(FocusId(21), FocusArea::Panels, palette, options, Some(0), |_| Message::Noop, |_| Message::Noop).label("Format").into_element()).width(Length::Fill);
                let audio = Switch::new(FocusId(22), FocusArea::Panels, palette, true, |_| Message::Noop).field("Include audio".into(), false);
                let spec = Dialog {
                    size: DialogSize::Sm,
                    title: "Export".into(),
                    description: Some("Choose how to save this animation.".into()),
                    body: Column::with_children(vec![format.boxed(), audio]).spacing(tokens::scale::SPACE_2).boxed(),
                    actions: vec![
                        Button::new(FocusId(23), FocusArea::Panels, palette, "Cancel", Message::Noop).variant(Variant::Ghost).into_element(),
                        Button::new(FocusId(24), FocusArea::Panels, palette, "Export", Message::Noop).variant(Variant::Primary).into_element(),
                    ],
                    meta: Some("24 fps \u{b7} 3 s".into()),
                    error: None,
                    close: Some((FocusId(25), Message::Noop)),
                };
                page(palette, stack![base.boxed(), Layer::new(vec![modal(palette, 1, spec, window)]).boxed()].boxed())
            }
            OverlayScreen::Parts => page(palette, parts_page(palette)),
        }
    }

    /// The page with the trigger (or nothing) and the layer of open menus over it.
    fn over<'a>(&'a self, palette: &'static Palette, base: Element<'a, Message>, extra: Vec<styk_design::widgets::layer::Placed<'a, Message>>) -> Element<'a, Message> {
        let base = container(base).padding(Padding { top: TRIGGER.y, left: TRIGGER.x, ..Padding::ZERO }).width(Length::Fill).height(Length::Fill);
        let layer = menu::layer(palette, &self.host, self.focus.focus_visible(), 0.0, extra, |_| Message::Noop);
        page(palette, stack![base.boxed(), layer].boxed())
    }
}

/// The window the scenes sit in: the raised surface, filling it.
fn page<'a>(palette: &'static Palette, content: Element<'a, Message>) -> Element<'a, Message> {
    let fill = palette.surface;
    container(content).width(Length::Fill).height(Length::Fill).style(move |_| container::Style { background: Some(iced::Background::Color(fill.into())), ..container::Style::default() }).boxed()
}

fn trigger(palette: &'static Palette, open: bool) -> Element<'static, Message> {
    IconButton::new(INVOKER, FocusArea::TopBand, palette, "more", Message::Noop).expanded(open).into_element()
}

/// The stage's messages in each dress, as the visible slot would draw them.
fn toasts(palette: &'static Palette) -> Element<'static, Message> {
    let make = |id: u64, tone: Tone, task: bool, actions: Vec<Action>, title: &str, text: &str, priority: Option<Priority>| {
        let mut message = Toast::new(id, format!("k{id}"), tone, task, actions);
        message.title = title.into();
        message.text = text.into();
        if let Some(priority) = priority {
            message.priority = priority;
        }
        message
    };
    let undo = Action { command: CommandId::Undo, label: "Undo".into(), dismiss: true };
    let messages = [
        make(1, Tone::Success, false, vec![], "Saved", "Rooftop fight", None),
        make(2, Tone::Warning, false, vec![undo], "Deleted", "3 figures", None),
        make(3, Tone::Error, false, vec![], "Couldn\u{2019}t save", "The disk is full.", None),
        make(4, Tone::Info, true, vec![], "", "Exporting video\u{2026}", None),
        make(5, Tone::Info, false, vec![], "", "Click a joint to pick it", Some(Priority::Mode)),
        make(6, Tone::Warning, false, vec![], "", "Slow \u{b7} 14 of 24 fps", Some(Priority::Hint)),
    ];
    let rows: Vec<Element<'static, Message>> = messages.iter().map(|message| toast::toast(palette, message, |_| Message::Noop)).collect();
    container(Column::with_children(rows).spacing(tokens::scale::SPACE_3).align_x(Alignment::Start)).padding(24.0).boxed()
}

// ---------------------------------------------------------------------------------------------------------------------
// The panel parts

const LABEL: f32 = 150.0;
const CELL: f32 = 148.0;
const PAD: f32 = 24.0;
const HEAD: f32 = 36.0;

fn row<'a>(palette: &'static Palette, label: &str, height: f32, cells: Vec<Element<'a, Message>>) -> Element<'a, Message> {
    let label = container(words(label, TextStyle::from_role(&tokens::scale::TYPE_SMALL), palette.text_3)).width(Length::Fixed(LABEL)).height(Length::Fixed(height)).center_y(Length::Fixed(height));
    let mut parts: Vec<Element<'a, Message>> = vec![label.boxed()];
    parts.extend(cells.into_iter().map(|cell| container(cell).width(Length::Fixed(CELL)).height(Length::Fixed(height)).padding(Padding { left: 8.0, ..Padding::ZERO }).center_y(Length::Fixed(height)).boxed()));
    Row::with_children(parts).boxed()
}

/// A row with one cell as wide as the table's five.
fn wide_row<'a>(palette: &'static Palette, label: &str, height: f32, content: Element<'a, Message>) -> Element<'a, Message> {
    let label = container(words(label, TextStyle::from_role(&tokens::scale::TYPE_SMALL), palette.text_3)).width(Length::Fixed(LABEL)).height(Length::Fixed(height)).center_y(Length::Fixed(height));
    let cell = container(content).width(Length::Fill).height(Length::Fixed(height)).padding(Padding { left: 8.0, ..Padding::ZERO }).center_y(Length::Fixed(height));
    Row::with_children(vec![label.boxed(), cell.boxed()]).boxed()
}

fn heading<'a>(palette: &'static Palette, text: &str) -> Element<'a, Message> {
    container(words(text, TextStyle::from_role(&tokens::scale::TYPE_EMPHASIS), palette.text_1)).width(Length::Fill).height(Length::Fixed(HEAD)).align_bottom(Length::Fixed(HEAD)).padding(Padding { bottom: 4.0, ..Padding::ZERO }).boxed()
}

fn parts_page(palette: &'static Palette) -> Element<'static, Message> {
    let noop = Message::Noop;
    let area = FocusArea::Panels;
    let mut next = 3000_u64;
    let mut id = move || {
        next += 1;
        FocusId(next)
    };
    let mut rows: Vec<Element<'static, Message>> = vec![heading(palette, "Small parts")];
    rows.push(row(palette, "Keycaps", 52.0, vec![parts::chord(palette, &["Ctrl", "Shift", "Z"]), parts::kbd(palette, "Esc")]));
    rows.push(row(
        palette,
        "Dots",
        52.0,
        vec![
            Row::with_children(vec![parts::dot(palette, DotKind::Neutral, false), parts::dot(palette, DotKind::Success, false), parts::dot(palette, DotKind::Warning, false), parts::dot(palette, DotKind::Danger, false)]).spacing(8.0).align_y(Alignment::Center).boxed(),
            Row::with_children(vec![parts::dot(palette, DotKind::Select, false), parts::dot(palette, DotKind::Library, false), parts::dot(palette, DotKind::Draw, false), parts::dot(palette, DotKind::Danger, true)]).spacing(8.0).align_y(Alignment::Center).boxed(),
        ],
    ));
    rows.push(row(palette, "Divider", 52.0, vec![container(parts::divider(palette)).width(Length::Fixed(132.0)).boxed()]));
    let first = Row::with_children(vec![parts::crumb_item(palette, id(), area, "Scene 1", None, None, noop.clone(), None), parts::crumb_sep(palette), parts::crumb_here(palette, "Punch", None)]).align_y(Alignment::Center);
    let second = Row::with_children(vec![parts::crumb_item(palette, id(), area, "Scene", Some("layers"), Some("960 × 540".into()), noop.clone(), Some(Preview::Hover)), parts::crumb_chip(palette, [255, 255, 255])]).align_y(Alignment::Center);
    rows.push(wide_row(palette, "Crumb", 52.0, Row::with_children(vec![first.boxed(), Space::new().width(Length::Fixed(40.0)).boxed(), second.boxed()]).boxed()));
    rows.push(heading(palette, "Lists and sections"));
    let list = |label: &str, selected: bool, hidden: bool, level: u32, preview: Option<Preview>, id: FocusId| container(ListRow::new(id, area, palette, label, noop.clone()).lead("layers").selected(selected).hidden(hidden).level(level).preview(preview).meta("1").into_element()).width(Length::Fixed(132.0)).boxed();
    rows.push(row(palette, "List row", 52.0, vec![list("Bubble", false, false, 0, None, id()), list("Bubble", false, false, 0, Some(Preview::Hover), id()), list("Bubble", true, false, 0, None, id()), list("Bubble", false, true, 1, None, id())]));
    rows.push(row(
        palette,
        "Section head",
        52.0,
        vec![
            container(SectionHead::new(palette, "Looks").badge("layers", Tint::Effects).into_element()).width(Length::Fixed(132.0)).boxed(),
            container(SectionHead::new(palette, "Camera").collapsible(id(), area, false, noop.clone()).into_element()).width(Length::Fixed(132.0)).boxed(),
            container(SectionHead::new(palette, "Camera").collapsible(id(), area, true, noop.clone()).into_element()).width(Length::Fixed(132.0)).boxed(),
        ],
    ));
    rows.push(row(palette, "Island", 108.0, vec![container(parts::island(palette, parts::island_head(palette, "Library", vec![]), false)).width(Length::Fixed(132.0)).height(Length::Fixed(88.0)).boxed()]));
    rows.push(heading(palette, "Switches and steppers"));
    let tabs = |rule: bool, id: FocusId| Tabs::new(id, area, palette, vec![Tab { label: "Props".into(), icon: None }, Tab { label: "Effects".into(), icon: None }], 0, |_| Message::Noop).rule(rule).into_element();
    rows.push(row(palette, "Tabs", 52.0, vec![tabs(false, id()), tabs(true, id())]));
    rows.push(row(
        palette,
        "Stepper",
        52.0,
        vec![
            parts::stepper(palette, id(), area, "3", false, false, |_| Message::Noop),
            parts::stepper(palette, id(), area, "3", false, true, |_| Message::Noop),
            parts::stepper(palette, id(), area, "3", true, false, |_| Message::Noop),
        ],
    ));
    rows.push(row(
        palette,
        "Split button",
        52.0,
        vec![
            parts::split_button(palette, (id(), id()), area, "grid", noop.clone(), noop.clone(), false, false, false),
            parts::split_button(palette, (id(), id()), area, "grid", noop.clone(), noop.clone(), false, true, false),
            parts::split_button(palette, (id(), id()), area, "grid", noop.clone(), noop.clone(), true, false, false),
            parts::split_button(palette, (id(), id()), area, "grid", noop.clone(), noop.clone(), false, false, true),
        ],
    ));
    rows.push(heading(palette, "Progress"));
    rows.push(row(
        palette,
        "Bar",
        52.0,
        vec![
            container(Bar::new(palette, Some(0.4)).boxed()).width(Length::Fixed(132.0)).boxed(),
            container(Bar::new(palette, None).boxed()).width(Length::Fixed(132.0)).boxed(),
            container(Bar::new(palette, Some(0.7)).danger(true).boxed()).width(Length::Fixed(132.0)).boxed(),
        ],
    ));
    rows.push(row(palette, "Spinner", 52.0, vec![Spinner::new(palette.text_2).boxed()]));
    rows.push(wide_row(
        palette,
        "Empty state",
        200.0,
        container(parts::empty_state(palette, Some("layers"), "No effects", Some("Add one from the list below.".into()), Some(Button::new(id(), area, palette, "Add effect", noop.clone()).variant(Variant::Outline).into_element()), false)).width(Length::Fill).boxed(),
    ));
    container(Column::with_children(rows).width(Length::Fixed(938.0 - 2.0 * PAD))).padding(PAD).boxed()
}

#[cfg(test)]
mod tests {
    use super::*;
    use iced::Size as WindowSize;
    use styk_design::widgets::testing::Driver;

    #[test]
    fn every_scene_draws_in_both_themes() {
        for screen in OverlayScreen::ALL {
            for theme in [Theme::Light, Theme::Dark] {
                let page = Page::new(screen, theme);
                let (width, height) = screen.size();
                let mut driver = Driver::new(page.view(), WindowSize::new(width as f32, height as f32), &styk_design::fonts::ALL);
                let (pixels, size) = driver.render(&iced::Theme::Light, iced::Color::from(theme.palette().surface), 1.0);
                assert_eq!(pixels.len(), (size.width * size.height * 4) as usize);
                let distinct = pixels.chunks(4).map(|p| [p[0], p[1], p[2]]).take(400_000).collect::<std::collections::HashSet<_>>().len();
                assert!(distinct > 6, "{} {theme:?} drew something: {distinct} colours", screen.id());
            }
        }
    }

    #[test]
    fn the_catalogue_names_each_scene_in_both_themes() {
        for scene in OverlayScreen::ALL {
            assert_eq!(crate::screens::Screen::Overlay(scene, false).id(), scene.id());
            assert_eq!(crate::screens::Screen::Overlay(scene, true).id(), format!("{}-dark", scene.id()));
            assert_eq!(crate::screens::Screen::from_id(scene.id()), Some(crate::screens::Screen::Overlay(scene, false)));
            assert_eq!(crate::screens::Screen::Overlay(scene, true).theme(), Theme::Dark);
        }
    }

    #[test]
    fn the_scenes_are_in_the_state_the_core_holds() {
        let root = Page::new(OverlayScreen::MenuRoot, Theme::Light);
        assert_eq!(root.host.menus().len(), 1);
        assert!(root.focus.focus_visible(), "the keyboard opened it, so the ring shows");
        let sub = Page::new(OverlayScreen::MenuSubmenu, Theme::Light);
        assert_eq!(sub.host.menus().len(), 2, "hovering the row opened its submenu after the hover intent");
        assert_eq!(sub.host.menus()[1].parent(), Some(sub.host.menus()[0].id()));
        let select = Page::new(OverlayScreen::SelectOpen, Theme::Light);
        assert!(matches!(select.host.menus()[0].purpose(), Purpose::Select { .. }));
    }

    #[test]
    fn the_reference_menus_show_the_registrys_shortcut_hints() {
        let page = Page::new(OverlayScreen::MenuRoot, Theme::Light);
        let menu = &page.host.menus()[0];
        let hints: Vec<&str> = (0..9).map(|index| menu.hint(index).text.as_str()).collect();
        // Undo, Redo, Copy, Paste, Duplicate, Grid, Zoom 100%, Zoom 200%, More: the strings the reference harness writes.
        assert_eq!(hints, ["Ctrl+Z", "Ctrl+Shift+Z", "Ctrl+C", "Ctrl+V", "Ctrl+D", "Ctrl+'", "", "", ""]);
        assert_eq!(menu.hint(9).text, "Delete");
        let transform = Page::new(OverlayScreen::MenuSubmenu, Theme::Light);
        let child = &transform.host.menus()[1];
        assert_eq!((child.hint(0).text.as_str(), child.hint(1).text.as_str(), child.hint(2).text.as_str()), ("Shift+H", "Shift+V", ""));
    }
}
