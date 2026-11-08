//! The design system's controls page: every control of `styk_design::widgets` in every state, in a table of fixed cells
//! (`stykanimate --screen controls`, `controls-dark`).
//!
//! The rows are the same as the reference's (`engine/crates/styk-app/automation/controls-reference/screens.mjs`): a label
//! column of 150 px, then state columns of 148 px, each cell 52 px high with its control 8 px in and centred. States a
//! pointer or the keyboard would give are held with the widgets' `preview`, so the page is a still picture of them all.
//! Nothing here is behaviour: every control sends [`Message::Noop`].

use crate::component_sheet::Message;
use iced::widget::{Column, Row, container};
use iced::{Alignment, Element, Length, Padding, Widget as _};
use std::cell::Cell;
use styk_design::typography::TextStyle;
use styk_design::widgets::badge::{Chip, Tint, badge};
use styk_design::widgets::button::{Button, IconButton, IconSize, Variant};
use styk_design::widgets::color::ColorField;
use styk_design::widgets::control::{Preview, words};
use styk_design::widgets::number_field::NumberField;
use styk_design::widgets::segmented::{Segment, SegmentSize, Segmented};
use styk_design::widgets::select::{Choice, Select};
use styk_design::widgets::slider::Slider;
use styk_design::widgets::toggle::{Checkbox, Checked, Radio, Switch};
use styk_design::{Palette, Theme, tokens};
use styk_core::focus::{FocusArea, FocusId};

/// The table's metrics, as the reference's.
const LABEL: f32 = 150.0;
const CELL: f32 = 148.0;
const ROW: f32 = 52.0;
const HEAD: f32 = 36.0;
const PAD: f32 = 24.0;
/// A field in a cell is 132 px wide.
const FIELD: f32 = 132.0;

/// The page's size: the padding, the label column and five state columns.
pub const WIDTH: f32 = 2.0 * PAD + LABEL + 5.0 * CELL;

/// A state of a control as a column shows it.
#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Rest,
    Hover,
    Pressed,
    Focus,
    Disabled,
}

const STATES: [State; 5] = [State::Rest, State::Hover, State::Pressed, State::Focus, State::Disabled];

impl State {
    fn preview(self) -> Option<Preview> {
        match self {
            State::Hover => Some(Preview::Hover),
            State::Pressed => Some(Preview::Pressed),
            State::Focus => Some(Preview::Focus),
            State::Rest | State::Disabled => None,
        }
    }

    fn off(self) -> bool {
        self == State::Disabled
    }
}

struct Page {
    palette: &'static Palette,
    next: Cell<u64>,
}

type Cells = Vec<Element<'static, Message>>;

impl Page {
    /// A fresh focus ID, a block of `count` of them for a group.
    fn id(&self, count: u64) -> FocusId {
        let id = self.next.get();
        self.next.set(id + count);
        FocusId(id)
    }

    fn states(&self, make: impl Fn(&Page, State) -> Element<'static, Message>) -> Cells {
        STATES.into_iter().map(|state| make(self, state)).collect()
    }

    fn button(&self, state: State, variant: Variant, text: &str) -> Button<'static, Message> {
        Button::new(self.id(1), FocusArea::Panels, self.palette, text, Message::Noop).variant(variant).disabled(state.off()).preview(state.preview())
    }

    fn icon_button(&self, state: State, name: &'static str) -> IconButton<'static, Message> {
        IconButton::new(self.id(1), FocusArea::Panels, self.palette, name, Message::Noop).disabled(state.off()).preview(state.preview())
    }

    fn segmented(&self, state: State, size: SegmentSize, items: Vec<Segment>) -> Element<'static, Message> {
        let first = self.id(items.len() as u64);
        let held = |index: usize| match (state, index) {
            (State::Focus, 0) => Some((0, Preview::Focus)),
            (State::Hover, 1) => Some((1, Preview::Hover)),
            (State::Pressed, 1) => Some((1, Preview::Pressed)),
            _ => None,
        };
        let items: Vec<Segment> = items.into_iter().enumerate().map(|(index, item)| item.disabled(state.off() && index == 1)).collect();
        let mut segmented = Segmented::new(first, FocusArea::Panels, self.palette, items, 0, |_| Message::Noop).size(size);
        if let Some((item, preview)) = held(0).or_else(|| held(1)) {
            segmented = segmented.preview(item, preview);
        }
        segmented.into_element()
    }

    fn slider(&self, state: State, value: f64, quiet: bool) -> Element<'static, Message> {
        Slider::new(self.id(1), FocusArea::Panels, self.palette, value, (0.0, 100.0), 1.0, |_| Message::Noop)
            .width(FIELD)
            .quiet(quiet)
            .disabled(state.off())
            .preview(state.preview().filter(|preview| *preview == Preview::Focus))
            .into_element()
    }

    fn field_state(state: State) -> Option<Preview> {
        state.preview().filter(|preview| matches!(preview, Preview::Hover | Preview::Focus))
    }

    fn number(&self, state: State, invalid: bool) -> Element<'static, Message> {
        let field = NumberField::new(self.id(1), self.id(1), FocusArea::Panels, "X", "128.5", self.palette)
            .unit("px")
            .enabled(!state.off())
            .invalid(invalid)
            .preview(Self::field_state(state))
            .on_scrub(|_| Message::Noop);
        container(field.into_element()).width(FIELD).boxed()
    }

    fn select(&self, state: State) -> Element<'static, Message> {
        let options = vec![Choice { label: "Linear".into(), disabled: false }, Choice { label: "Hold".into(), disabled: false }];
        let select = Select::new(self.id(1), FocusArea::Panels, self.palette, options, Some(0), |_| Message::Noop, |_| Message::Noop).label("Easing").disabled(state.off()).preview(Self::field_state(state));
        container(select.into_element()).width(FIELD).boxed()
    }

    fn color(&self, state: State) -> Element<'static, Message> {
        let field = ColorField::new(self.id(1), FocusArea::Panels, self.palette, [200, 80, 40], "C85028", Message::Noop).centered(true).disabled(state.off()).preview(Self::field_state(state));
        container(field.into_element()).width(FIELD).boxed()
    }

    fn switch_field(&self, state: State) -> Element<'static, Message> {
        let switch = Switch::new(self.id(1), FocusArea::Panels, self.palette, false, |_| Message::Noop).disabled(state.off()).preview(state.preview().filter(|preview| matches!(preview, Preview::Hover | Preview::Focus)));
        container(switch.field("Pin joint".into(), false)).width(FIELD).boxed()
    }

    fn chip(&self, state: State, on: bool) -> Element<'static, Message> {
        Chip::new(self.id(1), FocusArea::Panels, self.palette, "Figures", Message::Noop).on(on).disabled(state.off()).preview(state.preview()).into_element()
    }
}



/// A row: the label, then one fixed cell per control.
fn row(palette: &'static Palette, label: &str, cells: Cells) -> Element<'static, Message> {
    let label = container(words(label, TextStyle::from_role(&tokens::scale::TYPE_SMALL), palette.text_3)).width(Length::Fixed(LABEL)).height(Length::Fixed(ROW)).center_y(Length::Fixed(ROW));
    let mut parts: Vec<Element<'static, Message>> = vec![label.boxed()];
    parts.extend(cells.into_iter().map(|cell| container(cell).width(Length::Fixed(CELL)).height(Length::Fixed(ROW)).padding(Padding { left: 8.0, ..Padding::ZERO }).center_y(Length::Fixed(ROW)).boxed()));
    Row::with_children(parts).align_y(Alignment::Start).boxed()
}

fn heading(palette: &'static Palette, text: &str) -> Element<'static, Message> {
    container(words(text, TextStyle::from_role(&tokens::scale::TYPE_EMPHASIS), palette.text_1))
        .width(Length::Fill)
        .height(Length::Fixed(HEAD))
        .align_bottom(Length::Fixed(HEAD))
        .padding(Padding { bottom: 4.0, ..Padding::ZERO })
        .boxed()
}

/// The page for `theme`.
pub fn page(theme: Theme) -> Element<'static, Message> {
    let palette = theme.palette();
    let page = Page { palette, next: Cell::new(1000) };
    let mut rows: Vec<Element<'static, Message>> = Vec::new();
    let mut section = |title: &str, items: Vec<(&str, Cells)>| {
        rows.push(heading(palette, title));
        rows.extend(items.into_iter().map(|(label, cells)| row(palette, label, cells)));
    };
    let plain = |variant| move |page: &Page, state: State| page.button(state, variant, "Button").into_element();
    section(
        "Buttons",
        vec![
            ("Soft", page.states(plain(Variant::Soft))),
            ("Primary", page.states(plain(Variant::Primary))),
            ("Accent", page.states(plain(Variant::Accent))),
            ("Ghost", page.states(plain(Variant::Ghost))),
            ("Outline", page.states(plain(Variant::Outline))),
            ("Danger", page.states(plain(Variant::Danger))),
            ("Ghost, danger tone", page.states(|page, state| page.button(state, Variant::Ghost, "Delete").danger(true).into_element())),
            ("Toggled on", page.states(|page, state| page.button(state, Variant::Ghost, "Guides").toggled(true).into_element())),
            ("With a glyph", page.states(|page, state| page.button(state, Variant::Soft, "Export").icon("image").into_element())),
            ("Sizes", [styk_design::widgets::button::Size::Sm, styk_design::widgets::button::Size::Md, styk_design::widgets::button::Size::Lg].into_iter().map(|size| page.button(State::Rest, Variant::Soft, "Button").size(size).into_element()).collect()),
        ],
    );
    section(
        "Icon buttons",
        vec![
            ("Ghost", page.states(|page, state| page.icon_button(state, "plus").into_element())),
            ("Soft", page.states(|page, state| page.icon_button(state, "plus").soft(true).into_element())),
            ("Danger tone", page.states(|page, state| page.icon_button(state, "trash").danger(true).into_element())),
            ("Toggled on", page.states(|page, state| page.icon_button(state, "grid").toggled(true).into_element())),
            ("Expanded", page.states(|page, state| page.icon_button(state, "settings").expanded(true).into_element())),
            (
                "Sizes, round",
                vec![
                    page.icon_button(State::Rest, "plus").size(IconSize::Xs).into_element(),
                    page.icon_button(State::Rest, "plus").size(IconSize::Sm).into_element(),
                    page.icon_button(State::Rest, "plus").into_element(),
                    page.icon_button(State::Rest, "plus").size(IconSize::Lg).into_element(),
                    page.icon_button(State::Rest, "plus").round(true).into_element(),
                ],
            ),
        ],
    );
    let switch = |on: bool| move |page: &Page, state: State| Switch::new(page.id(1), FocusArea::Panels, page.palette, on, |_| Message::Noop).disabled(state.off()).preview(state.preview()).into_element();
    let check = |checked: Checked| move |page: &Page, state: State| Checkbox::new(page.id(1), FocusArea::Panels, page.palette, checked, |_| Message::Noop).disabled(state.off()).preview(state.preview()).into_element();
    let radio = |on: bool| move |page: &Page, state: State| Radio::new(page.id(1), FocusArea::Panels, page.palette, on, Message::Noop).disabled(state.off()).preview(state.preview()).into_element();
    section(
        "Switch, checkbox and radio",
        vec![
            ("Switch off", page.states(switch(false))),
            ("Switch on", page.states(switch(true))),
            ("Checkbox", page.states(check(Checked::No))),
            ("Checkbox checked", page.states(check(Checked::Yes))),
            ("Checkbox mixed", page.states(check(Checked::Mixed))),
            ("Radio", page.states(radio(false))),
            ("Radio chosen", page.states(radio(true))),
        ],
    );
    let words_items = || vec![Segment::text("Transform"), Segment::text("Motion")];
    section(
        "Segmented",
        vec![
            ("Words", page.states(|page, state| page.segmented(state, SegmentSize::Md, words_items()))),
            ("Small", page.states(|page, state| page.segmented(state, SegmentSize::Sm, words_items()))),
            ("Glyphs", page.states(|page, state| page.segmented(state, SegmentSize::Md, vec![Segment::icon("grid"), Segment::icon("layers"), Segment::icon("image")]))),
            ("Large", page.states(|page, state| page.segmented(state, SegmentSize::Lg, vec![Segment::text("One"), Segment::text("Two")]))),
        ],
    );
    section(
        "Slider",
        vec![
            ("Value 0, 50, 100", vec![page.slider(State::Rest, 0.0, false), page.slider(State::Rest, 50.0, false), page.slider(State::Rest, 100.0, false)]),
            ("Focus, off, quiet", vec![page.slider(State::Focus, 50.0, false), page.slider(State::Disabled, 50.0, false), page.slider(State::Rest, 50.0, true)]),
        ],
    );
    section(
        "Fields",
        vec![
            ("Number", vec![page.number(State::Rest, false), page.number(State::Hover, false), page.number(State::Focus, false), page.number(State::Rest, true), page.number(State::Disabled, false)]),
            ("Select", vec![page.select(State::Rest), page.select(State::Hover), page.select(State::Focus), page.select(State::Disabled)]),
            ("Colour", vec![page.color(State::Rest), page.color(State::Hover), page.color(State::Focus), page.color(State::Disabled)]),
            ("Switch", vec![page.switch_field(State::Rest), page.switch_field(State::Hover), page.switch_field(State::Focus), page.switch_field(State::Disabled)]),
        ],
    );
    section(
        "Chips and badges",
        vec![
            ("Chip", vec![page.chip(State::Rest, false), page.chip(State::Hover, false), page.chip(State::Focus, false), page.chip(State::Rest, true), page.chip(State::Disabled, false)]),
            ("Badges", [Tint::Select, Tint::Draw, Tint::Time, Tint::Library, Tint::Camera].into_iter().map(|tint| badge(palette, "layers", tint)).collect()),
        ],
    );
    let surface = palette.surface;
    container(Column::with_children(rows).width(Length::Fixed(WIDTH - 2.0 * PAD)))
        .padding(PAD)
        .width(Length::Fill)
        .height(Length::Fill)
        .style(move |_| container::Style { background: Some(iced::Background::Color(surface.into())), ..container::Style::default() })
        .boxed()
}

#[cfg(test)]
mod tests {
    use super::*;
    use iced::Size;
    use styk_core::focus::{InputRole, ScopeId};
    use styk_design::widgets::testing::Driver;

    #[test]
    fn the_page_draws_in_both_themes_and_every_control_is_a_distinct_focus_target() {
        for theme in [Theme::Light, Theme::Dark] {
            let mut driver = Driver::new(page(theme), Size::new(WIDTH, 2120.0), &styk_design::fonts::ALL);
            let targets = driver.snapshot().targets(ScopeId::ROOT).to_vec();
            let mut ids: Vec<u64> = targets.iter().map(|target| target.id.0).collect();
            let count = ids.len();
            ids.sort_unstable();
            ids.dedup();
            assert_eq!(ids.len(), count, "no two controls share a focus ID");
            assert!(count > 150, "the page holds every control in every state: {count} targets");
            // Each input-like kind is on the page with its role.
            for role in [InputRole::Text, InputRole::Select, InputRole::Checkbox, InputRole::Radio, InputRole::Other] {
                assert!(targets.iter().any(|target| target.input_role == role), "{role:?} appears on the page");
            }
            let (pixels, size) = driver.render(&iced::Theme::Light, iced::Color::from(theme.palette().surface), 1.0);
            assert_eq!(pixels.len(), (size.width * size.height * 4) as usize);
            let distinct = pixels.chunks(4).map(|p| [p[0], p[1], p[2]]).take(400_000).collect::<std::collections::HashSet<_>>().len();
            assert!(distinct > 20, "{theme:?} drew its controls");
        }
    }
}
