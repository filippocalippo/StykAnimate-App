//! The Properties panel's colour and paint rows, the figure layer select and Edit together, driven through the mounted
//! widgets and the real handler: a press on the real widget at its laid-out place reaches the core as the message the
//! interface lists (`docs/native/plans/B1-inspector-rest.md`), and the core's answer is what the panel then holds.
use std::sync::Arc;

use iced::advanced::widget::operate;
use iced::event::Status;
use iced::keyboard::{Key, Modifiers, key::Named};
use iced::widget::stack;
use iced::{Event, Point, Size, Widget as _, mouse};
use styk_core::app::Core;
use styk_core::commands::Command;
use styk_core::focus::{FocusId, FocusState, InputRole};
use styk_core::inspector::model::{Choice, ColorTarget, Paint, Row, SelectRow, Swatch, Toggle};
use styk_core::inspector::{Event as Panel, PaintEvent};
use styk_core::overlay::host::Event as Overlay;
use styk_core::screens::InspectorScreen;
use styk_design::Theme;
use styk_design::widgets::focus;
use styk_design::widgets::testing::{Driver, key_event};
use styk_ui::inspector::{self, View};
use styk_ui::message::{self, Message, update};
use styk_ui::overlays;

const SIZE: Size = Size::new(styk_ui::dock::DEFAULT_WIDTH, 960.0);
const SHEET: &[u8] = include_bytes!("../../../tests/edit/property-sheet.document.json");

/// The core of a catalogue screen with its facts landed, as the screens wait for them.
fn screen_core(context: InspectorScreen) -> Core {
    let mut core = styk_core::screens::inspector(context, std::sync::Arc::new(styk_platform::spawn::ThreadSpawner), std::sync::Arc::new(|| {})).unwrap();
    for _ in 0..200_000 {
        core.refresh();
        if core.inspector().model().is_some() && !core.inspector().pending() {
            return core;
        }
        std::thread::yield_now();
    }
    panic!("the facts lane delivered what {context:?} shows");
}

fn mount(core: &Core) -> Driver<'static, Message> {
    let view = inspector::view(View::of(core, Theme::Light).unwrap());
    let mut driver = Driver::new(styk_ui::dock::docked(view, Theme::Light), SIZE, &styk_design::fonts::ALL);
    driver.redraw();
    driver
}

/// The place of a laid-out focus target.
fn centre(driver: &mut Driver<'static, Message>, id: FocusId) -> Point {
    let bounds = driver.snapshot().bounds_of(id).expect("the target is laid out");
    Point::new(bounds.x + bounds.width / 2.0, bounds.y + bounds.height / 2.0)
}

/// The focus targets of the panel in tree order with their input role.
fn targets(driver: &mut Driver<'static, Message>) -> Vec<(FocusId, InputRole)> {
    driver.snapshot().scopes.iter().flat_map(|(_, targets)| targets.iter().map(|target| (target.id, target.input_role))).collect()
}

/// A click on the target, every message the widgets published but the tooltip host's (hover and press events).
fn click(driver: &mut Driver<'static, Message>, id: FocusId) -> Vec<Message> {
    let at = centre(driver, id);
    driver.click(at);
    driver.messages().into_iter().filter(|message| !matches!(message, Message::Tooltip(_))).collect()
}

/// Delivers the messages as the application's `update` does.
fn deliver(core: &mut Core, messages: Vec<Message>) {
    for message in messages {
        let _ = update(core, message);
    }
    core.refresh();
}

fn palette(core: &Core) -> Vec<(ColorTarget, [u8; 3])> {
    let model = core.inspector().model().unwrap();
    model
        .sections
        .iter()
        .flat_map(|section| section.rows.iter())
        .filter_map(|row| match row {
            Row::Swatches { items, .. } => Some(items.iter().map(|item| (item.target, item.rgb)).collect::<Vec<_>>()),
            _ => None,
        })
        .flatten()
        .collect()
}

/// The 24 px swatch buttons of the palette, in drawing order.
fn swatch_buttons(driver: &mut Driver<'static, Message>) -> Vec<FocusId> {
    let snapshot = driver.snapshot();
    snapshot.bounds.iter().filter(|(_, bounds)| (bounds.width - 24.0).abs() < 0.5 && (bounds.height - 24.0).abs() < 0.5).map(|(id, _)| *id).collect()
}

/// The 16 px chips of the fills' list rows, in drawing order.
fn chip_buttons(driver: &mut Driver<'static, Message>) -> Vec<FocusId> {
    let snapshot = driver.snapshot();
    snapshot.bounds.iter().filter(|(_, bounds)| (bounds.width - 16.0).abs() < 0.5 && (bounds.height - 16.0).abs() < 0.5).map(|(id, _)| *id).collect()
}

#[test]
fn a_press_on_a_fills_chip_opens_the_picker_on_that_fill() {
    let mut core = screen_core(InspectorScreen::Colours);
    let mut driver = mount(&core);
    let chips = chip_buttons(&mut driver);
    assert_eq!(chips.len(), 3, "one chip in each of the three fills' list rows");
    for (index, chip) in chips.iter().enumerate() {
        let messages = click(&mut driver, *chip);
        assert_eq!(messages, vec![Message::Command(Command::Inspector(Panel::Color(ColorTarget::Polygon(index as _))))], "fill {index}'s chip asks for its own fill");
    }
    let messages = click(&mut driver, chips[1]);
    deliver(&mut core, messages);
    let request = core.inspector().picker().expect("the press opened the picker");
    assert_eq!(request.target, ColorTarget::Polygon(1));
    assert!(!request.gradients, "a fill is a plain colour");
}

#[test]
fn a_press_on_a_palette_swatch_opens_the_picker_on_that_palette_colour() {
    let mut core = screen_core(InspectorScreen::Colours);
    let colours = palette(&core);
    assert_eq!(colours.len(), 7, "four segment colours and three fill colours");
    let mut driver = mount(&core);
    let buttons = swatch_buttons(&mut driver);
    assert_eq!(buttons.len(), colours.len(), "one 24 px button per palette colour");
    for (index, button) in buttons.iter().enumerate() {
        let messages = click(&mut driver, *button);
        assert_eq!(messages, vec![Message::Command(Command::Inspector(Panel::Color(ColorTarget::Palette(index as u32))))], "swatch {index} asks for its own palette index");
    }
    // The real handler opens the picker on the third swatch's colour: the request names it and starts from its colour.
    let messages = click(&mut driver, buttons[2]);
    deliver(&mut core, messages);
    let request = core.inspector().picker().expect("the press opened the picker");
    assert_eq!(request.target, colours[2].0);
    assert_eq!(request.paint.stops[0].rgb(), colours[2].1);
    assert!(!request.gradients && !request.alpha, "a palette colour is a plain colour");
}

#[test]
fn a_press_on_the_colour_field_asks_for_the_picker_on_its_row() {
    let mut core = screen_core(InspectorScreen::JointGradient);
    let model = core.inspector().model().unwrap().clone();
    let color = model
        .sections
        .iter()
        .flat_map(|section| section.rows.iter())
        .find_map(|row| match row {
            Row::Grid { rows, .. } => rows.iter().find_map(|row| match row {
                Row::Color(color) if color.target == ColorTarget::Segment => Some(color.clone()),
                _ => None,
            }),
            Row::Color(color) if color.target == ColorTarget::Segment => Some(color.clone()),
            _ => None,
        })
        .expect("a segment's colour row");
    let Paint::Gradient(spec) = &color.paint else { panic!("the torso is painted with a gradient: {:?}", color.paint) };
    assert_eq!(spec.stops.len(), 2);
    let mut driver = mount(&core);
    let field = targets(&mut driver).into_iter().find(|(_, role)| *role == InputRole::Other).map(|(id, _)| id).expect("the colour field is a focus target");
    let messages = click(&mut driver, field);
    assert_eq!(messages, vec![Message::Command(Command::Inspector(Panel::Color(ColorTarget::Segment)))], "a press asks for the picker on the segment colour");
    deliver(&mut core, messages);
    let request = core.inspector().picker().expect("the press opened the picker");
    assert_eq!(request.target, ColorTarget::Segment);
    assert_eq!(request.paint, *spec, "the picker starts from the gradient the row shows");
    assert!(request.gradients && request.alpha);
    // A close message for another opening changes nothing; the matching one closes it.
    let id = request.id;
    deliver(&mut core, vec![Message::Command(Command::Inspector(Panel::Paint(PaintEvent::Close { request: id + 1 })))]);
    assert!(core.inspector().picker().is_some());
    deliver(&mut core, vec![Message::Command(Command::Inspector(Panel::Paint(PaintEvent::Close { request: id })))]);
    assert!(core.inspector().picker().is_none());
}

#[test]
fn the_edit_together_switch_sends_its_toggle_and_the_scope_follows() {
    let mut core = screen_core(InspectorScreen::Colours);
    core.view_state_mut().set_range(vec![2, 3, 4]);
    core.refresh();
    let model = core.inspector().model().unwrap().clone();
    let section = model.section("range").expect("two or more frames chosen: Edit together shows");
    let Row::Grid { rows, .. } = &section.rows[0] else { panic!("the switch sits in a grid") };
    assert!(matches!(&rows[0], Row::Switch(switch) if switch.toggle == Toggle::ApplyRange && !switch.checked));
    assert!(model.scope.is_none(), "with Edit together off the scope line is not shown");
    let mut driver = mount(&core);
    let switches: Vec<FocusId> = targets(&mut driver).into_iter().filter(|(_, role)| *role == InputRole::Checkbox).map(|(id, _)| id).collect();
    assert_eq!(switches.len(), 1, "Edit together's switch is the figure panel's one switch");
    let messages = click(&mut driver, switches[0]);
    assert_eq!(messages, vec![Message::Command(Command::Inspector(Panel::Toggle(Toggle::ApplyRange, true)))]);
    deliver(&mut core, messages);
    assert!(core.view_state_mut().apply_range(), "the real handler turned Edit together on");
    let model = core.inspector().model().unwrap();
    let Row::Grid { rows, .. } = &model.section("range").unwrap().rows[0] else { panic!("the switch sits in a grid") };
    assert!(matches!(&rows[0], Row::Switch(switch) if switch.checked), "the switch shows it on");
    assert!(model.scope.is_some(), "the scope line names the frames an edit now reaches");
}

/// The colour row's swatch draws the gradient the row holds: its left is the first stop's blue, its right the last
/// stop's pink (half transparent, over the checkerboard), not the first stop's colour throughout.
#[test]
fn a_gradient_segment_draws_its_gradient_in_the_colour_field() {
    let core = screen_core(InspectorScreen::JointGradient);
    let mut driver = mount(&core);
    let field = targets(&mut driver).into_iter().find(|(_, role)| *role == InputRole::Other).map(|(id, _)| id).expect("the colour field is a focus target");
    let bounds = driver.snapshot().bounds_of(field).expect("laid out");
    let (pixels, size) = driver.render(&styk_ui::base_theme(Theme::Light), iced::Color::from(Theme::Light.palette().surface_field), 1.0);
    let at = |x: f32, y: f32| {
        let offset = ((y as u32 * size.width + x as u32) * 4) as usize;
        [i32::from(pixels[offset]), i32::from(pixels[offset + 1]), i32::from(pixels[offset + 2])]
    };
    // The swatch is the first thing drawn in the field: its inked pixels run from its blue end to its pink one.
    let y = bounds.y + bounds.height / 2.0;
    let background = at(bounds.x + bounds.width - 4.0, y);
    let inked: Vec<[i32; 3]> = (0..40).map(|dx| at(bounds.x + dx as f32, y)).filter(|pixel| pixel.iter().zip(background).any(|(a, b)| (a - b).abs() > 40)).collect();
    assert!(inked.len() >= 12, "the swatch drew {} inked pixels across its row", inked.len());
    let (first, last) = (inked[1], inked[11]);
    assert!(first[2] > first[0] + 100 && first[0] < 90, "the swatch starts blue: {first:?}");
    assert!(last[0] > first[0] + 50, "the swatch heads for pink, not the first stop's colour throughout: {first:?} then {last:?}");
}

/// The panel in the window's own path: the real widgets mounted under the overlay layer, every message through
/// `message::update_at` and the core, the walk of the rebuilt tree forwarded to the band's focus state and the core's as the
/// app forwards it, and keys that nothing took go to the band's Tab navigation. Time is the test's.
struct Window {
    core: Core,
    /// The band's focus state (`TopBand` navigates Tab on its own).
    shell: FocusState,
    driver: Option<Driver<'static, Message>>,
    now: u64,
    /// What the core's effects came back as.
    effects: Vec<Message>,
}

impl Window {
    fn new(core: Core) -> Window {
        let mut window = Window { core, shell: FocusState::new(), driver: None, now: 0, effects: Vec::new() };
        window.rebuild();
        window.walk();
        window
    }

    fn view(&self) -> iced::Element<'static, Message> {
        let theme = Theme::Light;
        let panel = styk_ui::dock::docked(inspector::view(View::of(&self.core, theme).expect("the panel has a model")), theme);
        let host: &'static styk_core::overlay::host::Host = Box::leak(Box::new(self.core.overlays().clone()));
        // The window's owned overlays, as the band mounts them: the Inspector's layer-move dialog.
        let owned = inspector::owned(&self.core, theme.palette(), SIZE);
        stack![panel, overlays::layer_of(host, self.core.focus().focus_visible(), theme.palette(), 0.0, None, owned)].boxed()
    }

    fn rebuild(&mut self) {
        let view = self.view();
        self.driver = Some(match self.driver.take() {
            Some(driver) => driver.rebuild(view),
            None => Driver::new(view, SIZE, &styk_design::fonts::ALL),
        });
    }

    fn driver(&mut self) -> &mut Driver<'static, Message> {
        self.driver.as_mut().expect("the driver exists")
    }

    /// The walk of the tree reaches the band's focus state and the core.
    fn walk(&mut self) {
        let snapshot = self.driver().snapshot();
        focus::sync(&mut self.shell, &snapshot);
        let task = message::update_at(&mut self.core, Message::Snapshot(snapshot), self.now);
        self.finish(task);
    }

    /// The runtime's order: the state was updated, the view is rebuilt, then the task's actions run on the new tree.
    fn finish(&mut self, task: iced::Task<Message>) {
        self.rebuild();
        let outputs = self.driver().run(task);
        self.effects.extend(outputs);
        self.driver().redraw();
    }

    fn send(&mut self, message: Message) {
        let task = message::update_at(&mut self.core, message, self.now);
        self.finish(task);
        let snapshot = self.driver().snapshot();
        focus::sync(&mut self.shell, &snapshot);
        let task = message::update_at(&mut self.core, Message::Snapshot(snapshot), self.now);
        self.finish(task);
    }

    /// Delivers what the widgets published.
    fn settle(&mut self) {
        for _ in 0..16 {
            let messages = self.driver().messages();
            if messages.is_empty() {
                return;
            }
            for message in messages {
                self.send(message);
            }
        }
        panic!("the widgets kept publishing");
    }

    /// One raw input: the widgets see it, then the window routes it as the band does.
    fn input(&mut self, event: Event) {
        if let Event::Mouse(mouse::Event::CursorMoved { position }) = &event {
            self.driver().point_at(*position);
        }
        let status = self.driver().events(std::slice::from_ref(&event))[0];
        self.settle();
        let ignored = status == Status::Ignored;
        if let Some(task) = message::raw_at(&mut self.core, &event, ignored, self.now) {
            self.finish(task);
            self.walk();
        } else if ignored && let Some(id) = focus::navigate(&mut self.shell, &event) {
            self.finish(operate(focus::focus(id)).discard());
            self.walk();
        }
        self.walk();
        self.settle();
        self.agree();
    }

    /// The toolkit's focus is the band's and the core's.
    fn agree(&mut self) {
        let focused = self.driver().snapshot().focused;
        assert_eq!(focused, self.core.focus().focused(), "the toolkit and the core hold the same focus");
        // An open list is the core's scope: the band's own state follows the page only.
        if self.core.overlays().top().is_none() {
            assert_eq!(focused, self.shell.focused(), "and so does the band");
        }
    }

    fn key(&mut self, named: Named) {
        self.key_with(named, Modifiers::default());
    }

    fn key_with(&mut self, named: Named, modifiers: Modifiers) {
        self.input(key_event(Key::Named(named), None, modifiers, true));
        self.input(key_event(Key::Named(named), None, modifiers, false));
    }

    fn move_to(&mut self, point: Point) {
        self.input(Event::Mouse(mouse::Event::CursorMoved { position: point }));
    }

    fn click(&mut self, point: Point) {
        self.move_to(point);
        self.input(Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left)));
        self.input(Event::Mouse(mouse::Event::ButtonReleased(mouse::Button::Left)));
    }

    /// Focus given programmatically (a Tab's landing), reconciled as the app does.
    fn focus(&mut self, id: FocusId) {
        self.finish(operate(focus::focus(id)).discard());
        self.walk();
    }

    /// The runtime's wake at `ms` later: the core's overlay clock.
    fn advance(&mut self, ms: u64) {
        self.now += ms;
        self.send(Message::Command(Command::Overlay { event: Overlay::Tick, now: self.now }));
    }

    fn centre(&mut self, id: FocusId) -> Point {
        let bounds = self.driver().snapshot().bounds_of(id).expect("the target is laid out");
        Point::new(bounds.x + bounds.width / 2.0, bounds.y + bounds.height / 2.0)
    }

    /// The focus targets laid out `side` px square, in tree order (24: palette swatches, 16: a fill's chip).
    fn squares(&mut self, side: f32) -> Vec<FocusId> {
        let snapshot = self.driver().snapshot();
        snapshot.bounds.iter().filter(|(_, bounds)| (bounds.width - side).abs() < 0.5 && (bounds.height - side).abs() < 0.5).map(|(id, _)| *id).collect()
    }
}

/// The Tab stops of a focus state in the order Tab visits them from nothing, one lap.
fn tab_stops(state: &FocusState) -> Vec<FocusId> {
    let mut state = state.clone();
    state.reconcile(None);
    let mut stops = Vec::new();
    while let Some(id) = state.tab(true) {
        if stops.contains(&id) {
            break;
        }
        stops.push(id);
    }
    stops
}

/// The model's palette swatches.
fn palette_swatches(core: &Core) -> Vec<Swatch> {
    core.inspector().model().unwrap().sections.iter().flat_map(|section| section.rows.iter()).find_map(|row| if let Row::Swatches { items, .. } = row { Some(items.clone()) } else { None }).expect("the palette")
}

#[test]
fn the_palette_is_one_tab_stop_that_follows_the_swatch_focus_last_held() {
    let mut window = Window::new(screen_core(InspectorScreen::Colours));
    let swatches = window.squares(24.0);
    assert_eq!(swatches.len(), 7);
    let within = |stops: Vec<FocusId>| stops.into_iter().filter(|id| swatches.contains(id)).collect::<Vec<_>>();
    assert_eq!(within(tab_stops(&window.shell)), vec![swatches[0]], "the band tabs through one stop of the palette");
    assert_eq!(within(tab_stops(window.core.focus())), vec![swatches[0]], "and so does the core");
    // The right arrow moves focus itself, not only a message: the toolkit holds the second swatch, and so do the core and the band.
    window.focus(swatches[0]);
    window.key(Named::ArrowRight);
    assert_eq!(window.driver().snapshot().focused, Some(swatches[1]), "the toolkit's focus moved to the second swatch");
    assert_eq!(window.core.focus().focused(), Some(swatches[1]));
    assert_eq!(within(tab_stops(&window.shell)), vec![swatches[1]], "the stop follows the swatch the arrow focused");
    // Tab leaves the palette; Shift+Tab comes back to the second swatch, not the first.
    window.key(Named::Tab);
    let away = window.core.focus().focused().expect("Tab landed on a control");
    assert!(!swatches.contains(&away), "Tab left the palette, one stop of it");
    window.key_with(Named::Tab, Modifiers::SHIFT);
    assert_eq!(window.driver().snapshot().focused, Some(swatches[1]), "Shift+Tab returns to the swatch that last held focus");
    assert_eq!(window.core.focus().focused(), Some(swatches[1]));
    // The pointer moves the stop the same way: press the fourth swatch, tab away and back.
    let at = window.centre(swatches[3]);
    window.click(at);
    assert_eq!(window.driver().snapshot().focused, Some(swatches[3]), "a press focuses the swatch");
    window.key(Named::Tab);
    assert!(!swatches.contains(&window.core.focus().focused().expect("Tab landed on a control")));
    window.key_with(Named::Tab, Modifiers::SHIFT);
    assert_eq!(window.driver().snapshot().focused, Some(swatches[3]), "Shift+Tab returns to the pressed swatch");
    // Home and End are the group's too.
    window.key(Named::End);
    assert_eq!(window.driver().snapshot().focused, Some(swatches[6]));
    assert_eq!(within(tab_stops(&window.shell)), vec![swatches[6]]);
}

#[test]
fn a_pending_panel_draws_its_swatches_and_chips_disabled_and_nothing_can_focus_or_press_them() {
    let mut core = screen_core(InspectorScreen::Colours);
    let colours = palette_swatches(&core);
    styk_core::testing::call_unsettled(&mut core, "setFPS", "[30]").unwrap();
    for _ in 0..3 {
        core.refresh();
    }
    assert!(core.inspector().pending(), "the frame on show is not ready: the panel is the pending copy");
    assert!(palette_swatches(&core).iter().all(|swatch| swatch.disabled), "the model disables the palette");
    let mut window = Window::new(core);
    let swatches = window.squares(24.0);
    let chips = window.squares(16.0);
    assert_eq!((swatches.len(), chips.len()), (colours.len(), 3), "the palette and the three fills' chips are drawn");
    let snapshot = window.driver().snapshot();
    let targets: Vec<_> = snapshot.scopes.iter().flat_map(|(_, targets)| targets.iter()).collect();
    for id in swatches.iter().chain(&chips) {
        assert!(!targets.iter().find(|target| target.id == *id).expect("a disabled swatch is still a registered target").enabled, "{id:?} is disabled");
    }
    let stops = tab_stops(&window.shell);
    assert!(swatches.iter().chain(&chips).all(|id| !stops.contains(id)), "Tab skips them: {stops:?}");
    for id in swatches.iter().chain(&chips) {
        window.driver().focus(*id);
        assert_ne!(window.driver().snapshot().focused, Some(*id), "{id:?} cannot take focus");
        let at = window.centre(*id);
        window.click(at);
        assert_ne!(window.driver().snapshot().focused, Some(*id), "a press does not focus {id:?}");
    }
    assert!(window.core.inspector().picker().is_none(), "no press opened a picker");
    // The design system's disabled look: the swatch's own colour at 42 % over the panel's surface.
    let surface = Theme::Light.palette().surface;
    let (pixels, size) = window.driver().render(&styk_ui::base_theme(Theme::Light), iced::Color::from(surface), 1.0);
    let bounds = window.driver().snapshot().bounds_of(swatches[0]).expect("laid out");
    let (x, y) = ((bounds.x + bounds.width / 2.0) as u32, (bounds.y + bounds.height / 2.0) as u32);
    let at = ((y * size.width + x) * 4) as usize;
    for (channel, (swatch, ground)) in colours[0].rgb.iter().zip([surface.r, surface.g, surface.b]).enumerate() {
        let expected = f32::from(*swatch) * 0.42 + f32::from(ground) * 0.58;
        assert!((f32::from(pixels[at + channel]) - expected).abs() <= 4.0, "channel {channel}: {} against the disabled blend {expected}", pixels[at + channel]);
    }
}

#[test]
fn a_swatch_shows_its_description_as_a_tooltip_through_the_hosts_delay() {
    let mut window = Window::new(screen_core(InspectorScreen::Colours));
    let swatches = window.squares(24.0);
    let colours = palette_swatches(&window.core);
    window.now = 1000;
    let at = window.centre(swatches[2]);
    window.move_to(at);
    assert_eq!(window.core.overlay_deadline(), Some(1500), "the host's 500 ms delay");
    assert!(window.core.overlays().tooltip_anchor().is_none(), "nothing shows before the delay");
    window.advance(500);
    let (tip, _) = window.core.overlays().tooltip_anchor().expect("the tooltip shows");
    assert_eq!(tip.target, swatches[2].0, "it names the hovered swatch");
    assert_eq!(tip.content.label, window.core.presentation().text(&colours[2].description), "its words are the swatch's description");
    let hex = format!("{:02X}{:02X}{:02X}", colours[2].rgb[0], colours[2].rgb[1], colours[2].rgb[2]);
    assert!(tip.content.label.to_uppercase().contains(&hex), "today's hex text: {}", tip.content.label);
}

/// The figure's layer select from the choice in the list to the core's layer: the press opens the list, the arrow keys and
/// Enter choose, and the figure is on the chosen layer, which is active, with one history entry.
#[test]
fn choosing_a_layer_in_the_select_moves_the_figure_through_to_the_core() {
    let mut core = styk_core::testing::core_with_document(SHEET, "Test.styk", Arc::new(styk_platform::spawn::ThreadSpawner)).unwrap();
    styk_core::testing::call(&mut core, "select", "[1,-1]").unwrap();
    let layer_select = |core: &Core| -> SelectRow {
        core.inspector()
            .model()
            .unwrap()
            .sections
            .iter()
            .flat_map(|section| section.rows.iter())
            .find_map(|row| match row {
                Row::Grid { rows, .. } => rows.iter().find_map(|row| match row {
                    Row::Select(select) if select.choice == Choice::FigureLayer => Some(select.clone()),
                    _ => None,
                }),
                Row::Select(select) if select.choice == Choice::FigureLayer => Some(select.clone()),
                _ => None,
            })
            .expect("the figure's layer select")
    };
    let before = layer_select(&core);
    let from = before.options.iter().position(|option| Some(&option.value) == before.value.as_ref()).expect("the figure is on a layer");
    let to = before.options.iter().position(|option| &*option.value == "layer-2" && !option.disabled).expect("the sheet's second layer");
    assert_ne!(from, to, "the figure starts on another layer than the one chosen");
    let chosen: String = before.options[to].value.to_string();
    let history = styk_core::testing::undo_depth(&core);
    let mut window = Window::new(core);
    let select = window.driver().snapshot().scopes.iter().flat_map(|(_, targets)| targets.iter()).find(|target| target.input_role == InputRole::Select).map(|target| target.id).expect("the select is a focus target");
    let at = window.centre(select);
    window.click(at);
    assert_eq!(window.core.overlays().menus().len(), 1, "the press opened the list");
    window.advance(300);
    for _ in 0..from.abs_diff(to) {
        window.key(if to > from { Named::ArrowDown } else { Named::ArrowUp });
    }
    window.key(Named::Enter);
    assert!(window.core.overlays().menus().is_empty(), "choosing closes the list");
    assert!(window.effects.contains(&Message::OverlayChoice { invoker: select, index: to }), "the host reported the choice: {:?}", window.effects);
    // The move runs on the session's worker: the documents host answers through the app's adapter until the panel's move has ended.
    let mut ended = false;
    for _ in 0..15_000 {
        while window.core.poll_document().is_some() {}
        window.core.refresh();
        if window.core.inspector().layer_move().is_none() {
            ended = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    assert!(ended, "the layer move did not end");
    styk_core::testing::settle_facts(&mut window.core).unwrap();
    let core = &window.core;
    assert_eq!(layer_select(core).value.as_deref(), Some(chosen.as_str()), "the panel shows the figure on the chosen layer");
    assert_eq!(core.view_state().layers(), &[chosen.as_str()], "its track is the selected one");
    let records = core.documents.active().unwrap().records().unwrap().clone();
    assert_eq!(records.path(&["_styk", "layers", "activeId"]).and_then(|id| id.as_str()), Some(chosen.as_str()), "the chosen layer is the document's active one");
    assert_eq!(styk_core::testing::undo_depth(core), history + 1, "one history entry");
}

/// A spawner whose documents worker waits at a gate before it takes its first job: the test decides when the move runs.
struct Gated(Arc<(std::sync::Mutex<bool>, std::sync::Condvar)>);

impl styk_core::services::Spawner for Gated {
    fn spawn(&self, name: &str, job: styk_core::services::Job) -> Result<(), styk_core::services::SpawnError> {
        let gate = (name == "styk-documents").then(|| self.0.clone());
        std::thread::Builder::new()
            .name(name.to_owned())
            .spawn(move || {
                if let Some(gate) = gate {
                    let mut open = gate.0.lock().unwrap();
                    while !*open {
                        open = gate.1.wait(open).unwrap();
                    }
                }
                job()
            })
            .map(|_| ())
            .map_err(|error| styk_core::services::SpawnError(error.to_string()))
    }
}

/// How the person ends the layer move's dialog.
#[derive(Clone, Copy, Debug)]
enum Ending {
    Cancel,
    Close,
    Escape,
}

/// The progress dialog mounted in the window: after 150 ms it shows with Cancel focused; Cancel, its close button and
/// Escape (each through the real widgets and the window's adapter) stop the move with the document as it was, the
/// dialog goes and the toolkit's focus is back on the layer select.
#[test]
fn the_layer_move_dialog_is_mounted_and_cancel_close_and_escape_end_it_through_the_widgets() {
    use styk_core::inspector::ids;
    for ending in [Ending::Cancel, Ending::Close, Ending::Escape] {
        let gate = Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new()));
        let mut core = styk_core::testing::core_with_document(SHEET, "Test.styk", Arc::new(Gated(gate.clone()))).unwrap();
        styk_core::testing::call(&mut core, "select", "[1,-1]").unwrap();
        let before = core.documents.active().unwrap().records().unwrap().clone();
        let mut window = Window::new(core);
        let select = window.driver().snapshot().scopes.iter().flat_map(|(_, targets)| targets.iter()).find(|target| target.input_role == InputRole::Select).map(|target| target.id).expect("the layer select");
        window.focus(select);
        window.send(Message::Command(Command::Wake { now: 1_000 }));
        window.send(Message::Command(Command::Inspector(Panel::Choose(Choice::FigureLayer, Arc::from("layer-2")))));
        assert!(window.core.inspector().layer_move().is_some(), "{ending:?}: the move waits on the worker");
        window.send(Message::Command(Command::Wake { now: 1_150 }));
        window.walk();
        assert!(window.core.inspector().layer_dialog().is_some(), "{ending:?}: the dialog shows after 150 ms");
        assert_eq!(window.driver().snapshot().focused, Some(ids::CANCEL), "{ending:?}: Cancel holds the toolkit's focus");
        window.agree();
        match ending {
            Ending::Cancel => {
                let at = window.centre(ids::CANCEL);
                window.click(at);
            }
            Ending::Close => {
                let at = window.centre(ids::CLOSE);
                window.click(at);
            }
            Ending::Escape => window.key(Named::Escape),
        }
        *gate.0.lock().unwrap() = true;
        gate.1.notify_all();
        // The documents host answers through the app's adapter (`poll_document`, then `document_effect`).
        let mut ended = false;
        for _ in 0..15_000 {
            if let Some(effect) = window.core.poll_document() {
                let task = message::run(window.core.document_effect(&effect));
                window.finish(task);
            }
            if window.core.inspector().layer_move().is_none() && window.core.inspector().layer_dialog().is_none() {
                ended = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        assert!(ended, "{ending:?}: the move and its dialog ended");
        window.walk();
        assert!(*window.core.documents.active().unwrap().records().unwrap() == before, "{ending:?}: the document is as it was");
        assert_eq!(styk_core::testing::undo_depth(&window.core), 0, "{ending:?}: no history entry");
        assert_eq!(window.driver().snapshot().focused, Some(select), "{ending:?}: the toolkit's focus is back on the layer select");
        window.agree();
    }
}
