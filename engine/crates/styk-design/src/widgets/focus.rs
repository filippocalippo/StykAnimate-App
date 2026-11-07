//! Keyboard focus in the iced tree (`docs/native/text-input.md` sections 3 and 4).
//!
//! iced makes only text widgets focusable and has no Tab order, focus ring or scopes. These wrappers add them:
//!
//! - [`Focusable`] wraps a control (button, toggle, slider, select, tab, scrub label): it can hold focus, shows the ring
//!   when focus came from the keyboard, and answers the keys of its control kind **only while it holds focus**, so a
//!   hovered control never consumes another control's keys.
//! - [`Anchor`] only describes a widget that already manages focus itself (a text field) to the focus model.
//! - [`Scope`] marks a modal subtree, whose targets Tab traverses on their own.
//! - [`snapshot`] is the operation that reads the tree: the targets in tree order, per scope, and what holds focus,
//!   **always** as an `Option` so a removed or disabled field clears the core's text-entry state.

use iced::advanced::layout::{self, Layout};
use iced::advanced::overlay;
use iced::advanced::renderer::{self, Quad};
use iced::advanced::widget::operation::{self, Outcome};
use iced::advanced::widget::{self, Operation, Tree, tree};
use iced::advanced::{Shell, Widget};
use iced::keyboard::{self, Key, key::Named};
use iced::{Border, Color, Element, Event, Length, Rectangle, Renderer, Size, Theme, Vector, mouse};
use std::any::Any;
use styk_core::focus::{FocusArea, FocusId, FocusState, FocusTarget, ScopeId, TargetKind};

/// The widget ID a focus target answers to.
pub fn widget_id(id: FocusId) -> widget::Id {
    widget::Id::from(format!("styk-focus-{}", id.0))
}

/// What a widget tells the focus model about itself (passed through `Operation::custom`).
#[derive(Clone, Copy, Debug)]
pub struct Meta {
    pub id: FocusId,
    pub area: FocusArea,
    pub kind: TargetKind,
    pub enabled: bool,
    pub tab_stop: bool,
}

struct ScopeMark {
    scope: ScopeId,
    enter: bool,
}

/// The state of the tree's focus, as one walk reads it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Snapshot {
    /// What holds focus; `None` when nothing does. Always reported, so stale focus clears.
    pub focused: Option<FocusId>,
    /// The targets of each scope in tree order (the root scope is [`ScopeId::ROOT`]).
    pub scopes: Vec<(ScopeId, Vec<FocusTarget>)>,
    /// Where each target is, in window coordinates.
    pub bounds: Vec<(FocusId, Rectangle)>,
}

impl Snapshot {
    /// The targets of a scope.
    pub fn targets(&self, scope: ScopeId) -> &[FocusTarget] {
        self.scopes.iter().find(|(s, _)| *s == scope).map_or(&[], |(_, targets)| targets.as_slice())
    }

    /// Where a target is.
    pub fn bounds_of(&self, id: FocusId) -> Option<Rectangle> {
        self.bounds.iter().find(|(known, _)| *known == id).map(|(_, bounds)| *bounds)
    }
}

/// Gives the core what a walk of the tree found: every open scope's targets, then what holds focus (an `Option`: nothing
/// clears a stale text-entry state).
pub fn sync(state: &mut FocusState, snapshot: &Snapshot) {
    for (scope, targets) in &snapshot.scopes {
        state.register(*scope, targets.clone());
    }
    state.reconcile(snapshot.focused);
}

/// What the core asks the interface to do after a navigation key.
pub fn navigate(state: &mut FocusState, event: &Event) -> Option<FocusId> {
    let Event::Keyboard(keyboard::Event::KeyPressed { key, modifiers, .. }) = event else {
        return None;
    };
    match key.as_ref() {
        Key::Named(Named::Tab) if !modifiers.control() && !modifiers.alt() && !modifiers.logo() => state.tab(!modifiers.shift()),
        Key::Named(Named::F6) if !modifiers.alt() && !modifiers.logo() => state.cycle_area(!modifiers.shift()),
        _ => None,
    }
}

/// The operation that reads the focus state of the whole tree.
pub fn snapshot() -> impl Operation<Snapshot> {
    struct Collect {
        stack: Vec<ScopeId>,
        scopes: Vec<(ScopeId, Vec<FocusTarget>)>,
        ids: Vec<(widget::Id, FocusId)>,
        bounds: Vec<(FocusId, Rectangle)>,
        focused: Option<FocusId>,
    }

    impl Operation<Snapshot> for Collect {
        fn traverse(&mut self, operate: &mut dyn FnMut(&mut dyn Operation<Snapshot>)) {
            operate(self);
        }

        fn custom(&mut self, id: Option<&widget::Id>, bounds: Rectangle, state: &mut dyn Any) {
            if let Some(mark) = state.downcast_ref::<ScopeMark>() {
                if mark.enter {
                    self.stack.push(mark.scope);
                } else {
                    self.stack.pop();
                }
            } else if let Some(meta) = state.downcast_ref::<Meta>() {
                let scope = self.stack.last().copied().unwrap_or(ScopeId::ROOT);
                let target = FocusTarget { id: meta.id, area: meta.area, kind: meta.kind, enabled: meta.enabled, tab_stop: meta.tab_stop };
                match self.scopes.iter_mut().find(|(s, _)| *s == scope) {
                    Some((_, targets)) => targets.push(target),
                    None => self.scopes.push((scope, vec![target])),
                }
                self.bounds.push((meta.id, bounds));
                if let Some(id) = id {
                    self.ids.push((id.clone(), meta.id));
                }
            }
        }

        fn focusable(&mut self, id: Option<&widget::Id>, _bounds: Rectangle, state: &mut dyn operation::Focusable) {
            if state.is_focused()
                && let Some(id) = id
                && let Some((_, focus)) = self.ids.iter().find(|(known, _)| known == id)
            {
                self.focused = Some(*focus);
            }
        }

        fn finish(&self) -> Outcome<Snapshot> {
            Outcome::Some(Snapshot { focused: self.focused, scopes: self.scopes.clone(), bounds: self.bounds.clone() })
        }
    }

    Collect { stack: Vec::new(), scopes: Vec::new(), ids: Vec::new(), bounds: Vec::new(), focused: None }
}

/// The operation that gives focus to a target and takes it from every other.
pub fn focus(id: FocusId) -> impl Operation {
    operation::focusable::focus(widget_id(id))
}

/// The operation that takes focus from everything.
pub fn unfocus() -> impl Operation {
    operation::focusable::unfocus()
}

/// How a focused control answers keys.
pub enum Keys<'a, Message> {
    /// Enter activates on press, Space on release (a button).
    Button,
    /// Space toggles on release (a checkbox, switch).
    Toggle,
    /// The control's own keys (a slider, select, roving item): the first `Some` is published and captured.
    Custom(Box<dyn Fn(&keyboard::Event) -> Option<Message> + 'a>),
}

/// The ring drawn around the focused control (`outline: 2px solid var(--focus-ring); outline-offset: 2px`).
#[derive(Clone, Copy, Debug)]
pub struct Ring {
    pub color: Color,
    pub width: f32,
    pub offset: f32,
    pub radius: f32,
}

impl Ring {
    /// The design system's ring for the palette.
    pub fn of(palette: &crate::Palette, radius: f32) -> Ring {
        Ring {
            color: palette.focus_ring.into(),
            width: crate::tokens::scale::FOCUS_WIDTH,
            offset: crate::tokens::scale::FOCUS_OFFSET,
            radius,
        }
    }
}

#[derive(Debug, Default)]
struct State {
    focused: bool,
    /// Focus came from, or was used with, the keyboard: the ring shows.
    visible: bool,
    /// Space went down and its release will activate.
    armed: bool,
}

impl operation::Focusable for State {
    fn is_focused(&self) -> bool {
        self.focused
    }

    fn focus(&mut self) {
        // Focus given by an operation is focus from the keyboard (Tab, F6, a dialog opening).
        self.focused = true;
        self.visible = true;
    }

    fn unfocus(&mut self) {
        self.focused = false;
        self.visible = false;
        self.armed = false;
    }
}

/// Makes a control focusable.
pub struct Focusable<'a, Message> {
    id: FocusId,
    area: FocusArea,
    content: Element<'a, Message>,
    enabled: bool,
    tab_stop: bool,
    keys: Keys<'a, Message>,
    on_activate: Option<Message>,
    on_focus_change: Option<Box<dyn Fn(bool) -> Message + 'a>>,
    ring: Ring,
}

impl<'a, Message: Clone + 'a> Focusable<'a, Message> {
    /// Wraps `content` as the focus target `id` in `area`.
    pub fn new(id: FocusId, area: FocusArea, content: Element<'a, Message>, ring: Ring) -> Self {
        Focusable {
            id,
            area,
            content,
            enabled: true,
            tab_stop: true,
            keys: Keys::Button,
            on_activate: None,
            on_focus_change: None,
            ring,
        }
    }

    /// The message Enter/Space publish (with [`Keys::Button`] and [`Keys::Toggle`]).
    pub fn on_activate(mut self, message: Message) -> Self {
        self.on_activate = Some(message);
        self
    }

    /// Whether the control can be focused and operated; a disabled one is skipped by Tab.
    pub fn enabled(mut self, enabled: bool) -> Self {
        self.enabled = enabled;
        self
    }

    /// Whether Tab stops here (a roving group's inactive children do not).
    pub fn tab_stop(mut self, tab_stop: bool) -> Self {
        self.tab_stop = tab_stop;
        self
    }

    /// The keys the control answers while focused.
    pub fn keys(mut self, keys: Keys<'a, Message>) -> Self {
        self.keys = keys;
        self
    }

    /// The message published when the control gains (`true`) or loses (`false`) focus.
    pub fn on_focus_change(mut self, on_focus_change: impl Fn(bool) -> Message + 'a) -> Self {
        self.on_focus_change = Some(Box::new(on_focus_change));
        self
    }

    fn meta(&self) -> Meta {
        Meta { id: self.id, area: self.area, kind: TargetKind::Control, enabled: self.enabled, tab_stop: self.tab_stop }
    }
}

impl<Message> widget::Meta for Focusable<'_, Message> {}

impl<'a, Message: Clone + 'a> Widget<Message, Theme, Renderer> for Focusable<'a, Message> {
    fn tag(&self) -> tree::Tag {
        tree::Tag::of::<State>()
    }

    fn state(&self) -> tree::State {
        tree::State::new(State::default())
    }

    fn size(&self) -> Size<Length> {
        self.content.size()
    }

    fn diff(&mut self, tree: &mut Tree) {
        tree.diff_children(std::slice::from_mut(&mut self.content));
    }

    fn layout(&mut self, tree: &mut Tree, renderer: &Renderer, limits: &layout::Limits) {
        self.content.layout(&mut tree.children[0], renderer, limits);
        tree.size = tree.children[0].size;
    }

    fn operate(&mut self, tree: &mut Tree, layout: Layout, viewport: &Rectangle, renderer: &Renderer, operation: &mut dyn Operation) {
        let id = widget_id(self.id);
        let mut meta = self.meta();
        operation.custom(Some(&id), layout.bounds(), &mut meta);
        if self.enabled {
            let state = tree.state.downcast_mut::<State>();
            operation.focusable(Some(&id), layout.bounds(), state);
        }
        self.content.operate(&mut tree.children[0], layout, viewport, renderer, operation);
    }

    fn update(
        &mut self,
        tree: &mut Tree,
        event: &Event,
        layout: Layout,
        cursor: mouse::Cursor,
        renderer: &Renderer,
        shell: &mut Shell<'_, Message>,
        viewport: &Rectangle,
    ) {
        let was_focused = tree.state.downcast_ref::<State>().focused;

        self.content.update(&mut tree.children[0], event, layout, cursor, renderer, shell, viewport);

        if self.enabled {
            let bounds = layout.bounds();
            let state = tree.state.downcast_mut::<State>();

            match event {
                Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left)) => {
                    if cursor.is_over(bounds) {
                        // A click focuses, without the ring.
                        state.focused = true;
                        state.visible = false;
                    } else if state.focused {
                        state.focused = false;
                        state.visible = false;
                        state.armed = false;
                    }
                }
                Event::Window(iced::window::Event::Unfocused) => {
                    state.armed = false;
                }
                Event::Keyboard(key_event) if state.focused => {
                    state.visible = true;
                    let activate = match (&self.keys, key_event) {
                        (Keys::Button, keyboard::Event::KeyPressed { key: Key::Named(Named::Enter), .. }) => {
                            self.on_activate.clone()
                        }
                        (Keys::Button | Keys::Toggle, keyboard::Event::KeyPressed { key: Key::Named(Named::Space), repeat: false, .. }) => {
                            state.armed = true;
                            shell.capture_event();
                            None
                        }
                        (Keys::Button | Keys::Toggle, keyboard::Event::KeyReleased { key: Key::Named(Named::Space), .. }) if state.armed => {
                            state.armed = false;
                            self.on_activate.clone()
                        }
                        (Keys::Custom(keys), key_event) => keys(key_event),
                        _ => None,
                    };
                    if let Some(message) = activate {
                        shell.publish(message);
                        shell.capture_event();
                    }
                }
                _ => {}
            }
        }

        let state = tree.state.downcast_ref::<State>();
        if state.focused != was_focused {
            if let Some(on_focus_change) = &self.on_focus_change {
                shell.publish(on_focus_change(state.focused));
            }
            shell.request_redraw();
        }
    }

    fn mouse_interaction(
        &self,
        tree: &Tree,
        layout: Layout,
        cursor: mouse::Cursor,
        viewport: &Rectangle,
        renderer: &Renderer,
    ) -> mouse::Interaction {
        self.content.mouse_interaction(&tree.children[0], layout, cursor, viewport, renderer)
    }

    fn draw(
        &self,
        tree: &Tree,
        renderer: &mut Renderer,
        theme: &Theme,
        style: &renderer::Style,
        layout: Layout,
        cursor: mouse::Cursor,
        viewport: &Rectangle,
    ) {
        self.content.draw(&tree.children[0], renderer, theme, style, layout, cursor, viewport);

        let state = tree.state.downcast_ref::<State>();
        if state.focused && state.visible {
            use iced::advanced::Renderer as _;
            // An outline: `width` thick, `offset` away from the control's edge, drawn outside it.
            let grow = self.ring.offset + self.ring.width;
            let bounds = layout.bounds();
            let ring = Rectangle {
                x: bounds.x - grow,
                y: bounds.y - grow,
                width: bounds.width + 2.0 * grow,
                height: bounds.height + 2.0 * grow,
            };
            renderer.fill_quad(
                Quad {
                    bounds: ring,
                    border: Border { color: self.ring.color, width: self.ring.width, radius: (self.ring.radius + grow).into() },
                    ..Quad::default()
                },
                Color::TRANSPARENT,
            );
        }
    }

    fn overlay<'b>(
        &'b mut self,
        tree: &'b mut Tree,
        layout: Layout,
        renderer: &Renderer,
        viewport: &Rectangle,
        translation: Vector,
        window: Size,
    ) -> Vec<overlay::Element<'b, Message, Theme, Renderer>> {
        self.content.overlay(&mut tree.children[0], layout, renderer, viewport, translation, window)
    }
}

/// Describes a widget that manages its own focus (a text field) to the focus model.
pub struct Anchor<'a, Message> {
    meta: Meta,
    content: Element<'a, Message>,
}

impl<'a, Message: 'a> Anchor<'a, Message> {
    /// Wraps `content`, whose own focusable state uses [`widget_id`]`(id)`.
    pub fn new(id: FocusId, area: FocusArea, kind: TargetKind, enabled: bool, content: Element<'a, Message>) -> Self {
        Anchor { meta: Meta { id, area, kind, enabled, tab_stop: true }, content }
    }
}

impl<Message> widget::Meta for Anchor<'_, Message> {}

impl<'a, Message: 'a> Widget<Message, Theme, Renderer> for Anchor<'a, Message> {
    fn size(&self) -> Size<Length> {
        self.content.size()
    }

    fn diff(&mut self, tree: &mut Tree) {
        tree.diff_children(std::slice::from_mut(&mut self.content));
    }

    fn layout(&mut self, tree: &mut Tree, renderer: &Renderer, limits: &layout::Limits) {
        self.content.layout(&mut tree.children[0], renderer, limits);
        tree.size = tree.children[0].size;
    }

    fn operate(&mut self, tree: &mut Tree, layout: Layout, viewport: &Rectangle, renderer: &Renderer, operation: &mut dyn Operation) {
        let id = widget_id(self.meta.id);
        let mut meta = self.meta;
        operation.custom(Some(&id), layout.bounds(), &mut meta);
        self.content.operate(&mut tree.children[0], layout, viewport, renderer, operation);
    }

    fn update(
        &mut self,
        tree: &mut Tree,
        event: &Event,
        layout: Layout,
        cursor: mouse::Cursor,
        renderer: &Renderer,
        shell: &mut Shell<'_, Message>,
        viewport: &Rectangle,
    ) {
        self.content.update(&mut tree.children[0], event, layout, cursor, renderer, shell, viewport);
    }

    fn mouse_interaction(
        &self,
        tree: &Tree,
        layout: Layout,
        cursor: mouse::Cursor,
        viewport: &Rectangle,
        renderer: &Renderer,
    ) -> mouse::Interaction {
        self.content.mouse_interaction(&tree.children[0], layout, cursor, viewport, renderer)
    }

    fn draw(
        &self,
        tree: &Tree,
        renderer: &mut Renderer,
        theme: &Theme,
        style: &renderer::Style,
        layout: Layout,
        cursor: mouse::Cursor,
        viewport: &Rectangle,
    ) {
        self.content.draw(&tree.children[0], renderer, theme, style, layout, cursor, viewport);
    }

    fn overlay<'b>(
        &'b mut self,
        tree: &'b mut Tree,
        layout: Layout,
        renderer: &Renderer,
        viewport: &Rectangle,
        translation: Vector,
        window: Size,
    ) -> Vec<overlay::Element<'b, Message, Theme, Renderer>> {
        self.content.overlay(&mut tree.children[0], layout, renderer, viewport, translation, window)
    }
}

/// Marks a subtree (a dialog, menu or popover) as a focus scope: its targets are walked by Tab on their own.
pub struct Scope<'a, Message> {
    scope: ScopeId,
    content: Element<'a, Message>,
}

impl<'a, Message: 'a> Scope<'a, Message> {
    /// Wraps `content` as the scope `scope`.
    pub fn new(scope: ScopeId, content: Element<'a, Message>) -> Self {
        Scope { scope, content }
    }
}

impl<Message> widget::Meta for Scope<'_, Message> {}

impl<'a, Message: 'a> Widget<Message, Theme, Renderer> for Scope<'a, Message> {
    fn size(&self) -> Size<Length> {
        self.content.size()
    }

    fn diff(&mut self, tree: &mut Tree) {
        tree.diff_children(std::slice::from_mut(&mut self.content));
    }

    fn layout(&mut self, tree: &mut Tree, renderer: &Renderer, limits: &layout::Limits) {
        self.content.layout(&mut tree.children[0], renderer, limits);
        tree.size = tree.children[0].size;
    }

    fn operate(&mut self, tree: &mut Tree, layout: Layout, viewport: &Rectangle, renderer: &Renderer, operation: &mut dyn Operation) {
        let mut enter = ScopeMark { scope: self.scope, enter: true };
        operation.custom(None, layout.bounds(), &mut enter);
        self.content.operate(&mut tree.children[0], layout, viewport, renderer, operation);
        let mut exit = ScopeMark { scope: self.scope, enter: false };
        operation.custom(None, layout.bounds(), &mut exit);
    }

    fn update(
        &mut self,
        tree: &mut Tree,
        event: &Event,
        layout: Layout,
        cursor: mouse::Cursor,
        renderer: &Renderer,
        shell: &mut Shell<'_, Message>,
        viewport: &Rectangle,
    ) {
        self.content.update(&mut tree.children[0], event, layout, cursor, renderer, shell, viewport);
    }

    fn mouse_interaction(
        &self,
        tree: &Tree,
        layout: Layout,
        cursor: mouse::Cursor,
        viewport: &Rectangle,
        renderer: &Renderer,
    ) -> mouse::Interaction {
        self.content.mouse_interaction(&tree.children[0], layout, cursor, viewport, renderer)
    }

    fn draw(
        &self,
        tree: &Tree,
        renderer: &mut Renderer,
        theme: &Theme,
        style: &renderer::Style,
        layout: Layout,
        cursor: mouse::Cursor,
        viewport: &Rectangle,
    ) {
        self.content.draw(&tree.children[0], renderer, theme, style, layout, cursor, viewport);
    }

    fn overlay<'b>(
        &'b mut self,
        tree: &'b mut Tree,
        layout: Layout,
        renderer: &Renderer,
        viewport: &Rectangle,
        translation: Vector,
        window: Size,
    ) -> Vec<overlay::Element<'b, Message, Theme, Renderer>> {
        self.content.overlay(&mut tree.children[0], layout, renderer, viewport, translation, window)
    }
}
