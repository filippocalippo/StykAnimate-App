//! A headless driver for widget tests, with the runtime's effects made explicit.
//!
//! iced's own `Simulator` throws away what the runtime would do with a user interface's requests: a clipboard read
//! never gets a reply, a focus operation never runs. A test of "paste in field A, focus field B, reply arrives" needs the
//! requests visible and the replies under the test's control, in any order. [`Driver`] keeps the clipboard requests the
//! interface made, answers them when told (with the request's ID), and runs tree operations (focus, the focus snapshot)
//! on demand.

use super::focus::{self, Snapshot};
use iced::advanced::graphics;
use iced::keyboard::{self, Key, Modifiers, key::Named};
use iced::{Element, Event, Point, Size, Theme, mouse};
use iced_test::core::clipboard::{self, Content, RequestId};
use iced_test::core::renderer::Headless;
use iced_test::core::{event, input_method, shell, window};
use iced_test::runtime::user_interface::{self, State};
use iced_test::runtime::UserInterface;
use std::borrow::Cow;
use std::sync::Arc;
use styk_core::focus::FocusId;

/// A user interface under test.
pub struct Driver<'a, Message> {
    ui: UserInterface<'a, Message, Theme, iced::Renderer>,
    renderer: iced::Renderer,
    size: Size,
    cursor: mouse::Cursor,
    messages: shell::Bus<Message>,
    /// The clipboard reads the interface requested and nobody answered yet, oldest first.
    pub clipboard_reads: Vec<(clipboard::Kind, RequestId)>,
    /// The texts the interface asked to write to the clipboard.
    pub clipboard_writes: Vec<String>,
    /// The input method request of the last update.
    pub input_method: input_method::InputMethod,
    modifiers: Modifiers,
}

impl<'a, Message: 'a> Driver<'a, Message> {
    /// Builds the interface for `element` in a window of `size`, drawn by the software renderer.
    pub fn new(element: Element<'a, Message>, size: Size, fonts: &[&'static [u8]]) -> Self {
        for font in fonts {
            graphics::text::font_system().write().expect("write the font system").load_font(Cow::Borrowed(font));
        }
        let mut renderer = iced_test::futures::futures::executor::block_on(<iced::Renderer as Headless>::new(
            iced_test::core::renderer::Settings {
                font: iced::Font::default(),
                text_size: iced::Pixels(16.0),
                line_height: iced::advanced::text::LineHeight::default(),
                metrics_hinting: false,
            },
            Some("tiny-skia"),
        ))
        .expect("the software renderer");
        let ui = UserInterface::build(element, size, user_interface::Cache::default(), &mut renderer);
        Driver {
            ui,
            renderer,
            size,
            cursor: mouse::Cursor::Unavailable,
            messages: shell::Bus::new(),
            clipboard_reads: Vec::new(),
            clipboard_writes: Vec::new(),
            input_method: input_method::InputMethod::Disabled,
            modifiers: Modifiers::default(),
        }
    }

    /// Rebuilds the interface from a new view, keeping the state of widgets that keep their identity.
    pub fn rebuild(mut self, element: Element<'a, Message>) -> Self {
        let cache = self.ui.into_cache();
        self.ui = UserInterface::build(element, self.size, cache, &mut self.renderer);
        self
    }

    /// Points the cursor at `position` (no event).
    pub fn point_at(&mut self, position: impl Into<Point>) {
        self.cursor = mouse::Cursor::Available(position.into());
    }

    /// Delivers events to the interface and records the effects it asked for.
    pub fn events(&mut self, events: &[Event]) -> Vec<event::Status> {
        let (state, statuses) = self.ui.update(&window::Headless, &shell::Waker::noop(), events, self.cursor, &mut self.renderer, &mut self.messages);
        if let State::Updated { clipboard, input_method, .. } = state {
            self.clipboard_reads.extend(clipboard.reads);
            if let Some(Content::Text(text)) = clipboard.write {
                self.clipboard_writes.push(text);
            }
            self.input_method = input_method;
        }
        statuses
    }

    /// Delivers one redraw request, as the runtime does each frame (the input method is requested then).
    pub fn redraw(&mut self) {
        self.events(&[Event::Window(window::Event::RedrawRequested(std::time::Instant::now()))]);
    }

    /// Presses and releases a key with the modifiers currently held.
    pub fn tap(&mut self, key: Key, text: Option<&str>) -> Vec<event::Status> {
        let modifiers = self.modifiers;
        self.events(&[key_event(key.clone(), text, modifiers, true), key_event(key, None, modifiers, false)])
    }

    /// Presses a named key (no text) with the modifiers currently held.
    pub fn press(&mut self, named: Named) -> Vec<event::Status> {
        let modifiers = self.modifiers;
        self.events(&[key_event(Key::Named(named), None, modifiers, true)])
    }

    /// Releases a named key.
    pub fn release(&mut self, named: Named) -> Vec<event::Status> {
        let modifiers = self.modifiers;
        self.events(&[key_event(Key::Named(named), None, modifiers, false)])
    }

    /// Types `text` character by character, each as a key that produces that text.
    pub fn typewrite(&mut self, text: &str) {
        for c in text.chars() {
            let s = c.to_string();
            self.tap(Key::Character(s.clone().into()), Some(&s));
        }
    }

    /// A key whose single press produces `text` (which may be several characters).
    pub fn key_text(&mut self, text: &str) {
        self.tap(Key::Character(text.into()), Some(text));
    }

    /// Holds or releases modifier keys (control, shift, alt).
    pub fn modifiers(&mut self, modifiers: Modifiers) {
        self.modifiers = modifiers;
        self.events(&[Event::Keyboard(keyboard::Event::ModifiersChanged(modifiers))]);
    }

    /// Presses and releases `Ctrl` + the letter key `letter` (with `shift` if asked).
    pub fn chord(&mut self, letter: char, shift: bool) {
        let mut modifiers = Modifiers::CTRL;
        if shift {
            modifiers |= Modifiers::SHIFT;
        }
        self.modifiers(modifiers);
        self.tap(Key::Character(letter.to_string().into()), None);
        self.modifiers(Modifiers::default());
    }

    /// Like [`Driver::chord`], returning the status of the key press: whether the field handled it.
    pub fn chord_status(&mut self, letter: char, shift: bool) -> event::Status {
        let mut modifiers = Modifiers::CTRL;
        if shift {
            modifiers |= Modifiers::SHIFT;
        }
        self.modifiers(modifiers);
        let statuses = self.tap(Key::Character(letter.to_string().into()), None);
        self.modifiers(Modifiers::default());
        statuses.first().copied().unwrap_or(event::Status::Ignored)
    }

    /// A left click at `position`.
    pub fn click(&mut self, position: impl Into<Point>) {
        self.point_at(position);
        self.events(&[Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left)), Event::Mouse(mouse::Event::ButtonReleased(mouse::Button::Left))]);
    }

    /// Answers the oldest clipboard read with `text`, carrying its request ID.
    pub fn reply_clipboard(&mut self, text: &str) {
        let (_, id) = self.clipboard_reads.remove(0);
        self.reply_clipboard_to(id, text);
    }

    /// Answers the clipboard request `id` with `text`.
    pub fn reply_clipboard_to(&mut self, id: RequestId, text: &str) {
        self.reply_clipboard_with(id, Arc::new(Content::Text(text.to_owned())));
    }

    /// Answers the clipboard request `id` with content that is already built (so a test can time only the interface's
    /// own work on a very large paste).
    pub fn reply_clipboard_with(&mut self, id: RequestId, content: Arc<Content>) {
        self.events(&[Event::Clipboard(clipboard::Event::Read(Ok(content), id))]);
    }

    /// Runs the operation that focuses a target, as the runtime runs a focus task.
    pub fn focus(&mut self, id: FocusId) {
        let mut operation = focus::focus(id);
        self.ui.operate(&self.renderer, &mut operation);
    }

    /// Runs a task as the runtime does against this tree: widget operations run on it (and chain), messages the task produced
    /// are returned. A test calls this after it rebuilt the tree from the state the task's message produced, as the runtime
    /// does (update, rebuild, then the task's actions).
    pub fn run(&mut self, task: iced::Task<Message>) -> Vec<Message>
    where
        Message: 'static,
    {
        use iced_test::futures::futures::StreamExt;
        use iced_test::runtime::Action;
        let Some(mut stream) = iced_test::runtime::task::into_stream(task) else { return Vec::new() };
        let mut produced = Vec::new();
        iced_test::futures::futures::executor::block_on(async {
            while let Some(action) = stream.next().await {
                match action {
                    Action::Output(message) => produced.push(message),
                    Action::Widget(operation) => {
                        let mut current = Some(operation);
                        while let Some(mut operation) = current.take() {
                            self.ui.operate(&self.renderer, operation.as_mut());
                            if let iced::advanced::widget::operation::Outcome::Chain(next) = operation.finish() {
                                current = Some(next);
                            }
                        }
                    }
                    _ => {}
                }
            }
        });
        produced
    }

    /// Runs the operation that takes focus from everything.
    pub fn unfocus(&mut self) {
        let mut operation = focus::unfocus();
        self.ui.operate(&self.renderer, &mut operation);
    }

    /// The focus state of the tree, as one walk reads it.
    pub fn snapshot(&mut self) -> Snapshot {
        let mut operation = focus::snapshot();
        self.ui.operate(&self.renderer, &mut iced::advanced::widget::operation::black_box(&mut operation));
        match iced::advanced::widget::Operation::finish(&operation) {
            iced::advanced::widget::operation::Outcome::Some(snapshot) => snapshot,
            _ => Snapshot::default(),
        }
    }

    /// The messages the interface published since the last call.
    pub fn messages(&mut self) -> Vec<Message> {
        self.messages.drain().map(|(message, _)| message).collect()
    }

    /// Draws the interface and returns its RGBA pixels at `scale`, and their size.
    pub fn render(&mut self, theme: &Theme, background: iced::Color, scale: f32) -> (Vec<u8>, Size<u32>) {
        self.redraw();
        let style = iced_test::core::renderer::Style { text_color: iced::Color::BLACK };
        self.ui.draw(&mut self.renderer, theme, &style, self.cursor);
        let physical = Size::new((self.size.width * scale).round() as u32, (self.size.height * scale).round() as u32);
        (self.renderer.screenshot(physical, scale, background), physical)
    }
}

pub fn key_event(key: Key, text: Option<&str>, modifiers: Modifiers, pressed: bool) -> Event {
    let physical_key = keyboard::key::Physical::Unidentified(keyboard::key::NativeCode::Unidentified);
    if pressed {
        Event::Keyboard(keyboard::Event::KeyPressed {
            key: key.clone(),
            modified_key: key,
            physical_key,
            location: keyboard::Location::Standard,
            modifiers,
            repeat: false,
            text: text.map(Into::into),
        })
    } else {
        Event::Keyboard(keyboard::Event::KeyReleased { key: key.clone(), modified_key: key, physical_key, location: keyboard::Location::Standard, modifiers })
    }
}
