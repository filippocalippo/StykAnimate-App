//! The Properties panel's colour and paint rows, the figure layer select and Edit together, driven through the mounted
//! widgets and the real handler: a press on the real widget at its laid-out place reaches the core as the message the
//! interface lists (`docs/native/plans/B1-inspector-rest.md`), and the core's answer is what the panel then holds.
use iced::{Point, Size};
use styk_core::app::Core;
use styk_core::commands::Command;
use styk_core::focus::{FocusId, InputRole};
use styk_core::inspector::model::{Choice, ColorTarget, Paint, Row, Toggle};
use styk_core::inspector::{Event as Panel, PaintEvent};
use styk_core::screens::InspectorScreen;
use styk_design::Theme;
use styk_design::widgets::testing::Driver;
use styk_ui::inspector::{self, View};
use styk_ui::message::{Message, update};

const SIZE: Size = Size::new(styk_ui::dock::DEFAULT_WIDTH, 960.0);

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

/// A click on the target, every message the widgets published.
fn click(driver: &mut Driver<'static, Message>, id: FocusId) -> Vec<Message> {
    let at = centre(driver, id);
    driver.click(at);
    driver.messages()
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
fn the_palette_is_one_tab_stop_and_the_arrows_move_inside_it() {
    let core = screen_core(InspectorScreen::Colours);
    let mut driver = mount(&core);
    let buttons = swatch_buttons(&mut driver);
    let stops: Vec<bool> = driver.snapshot().scopes.iter().flat_map(|(_, targets)| targets.iter()).filter(|target| buttons.contains(&target.id)).map(|target| target.tab_stop).collect();
    let mut only_the_first = vec![false; buttons.len()];
    only_the_first[0] = true;
    assert_eq!(stops, only_the_first, "only the first swatch takes Tab");
    driver.focus(buttons[0]);
    driver.press(iced::keyboard::key::Named::ArrowRight);
    driver.release(iced::keyboard::key::Named::ArrowRight);
    let messages = driver.messages();
    assert_eq!(messages, vec![Message::Focusing(Box::new(Message::Idle), buttons[1])], "the right arrow moves focus to the next swatch");
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
fn the_figure_layer_select_sends_each_layer_as_its_choice() {
    let core = screen_core(InspectorScreen::Colours);
    let model = core.inspector().model().unwrap().clone();
    let select = model
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
        .expect("the figure's layer select");
    let mut driver = mount(&core);
    let target = targets(&mut driver).into_iter().find(|(_, role)| *role == InputRole::Select).map(|(id, _)| id).expect("the select is a focus target");
    let messages = click(&mut driver, target);
    let [Message::OpenSelect(request)] = messages.as_slice() else { panic!("a press opens the select's list: {messages:?}") };
    let expected: Vec<Message> = select.options.iter().map(|option| Message::Command(Command::Inspector(Panel::Choose(Choice::FigureLayer, option.value.clone())))).collect();
    assert_eq!(request.picks, expected, "every layer is a choice for the figure's layer");
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
