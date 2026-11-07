//! The frameless window's behaviour that is not drawing: what each point of the window is for, the maximize button's
//! press, and the sizes the band draws its window controls at.
//!
//! The Windows implementation (`styk_platform::windows::chrome`) answers `WM_NCHITTEST` from [`hit_test`] and drives
//! [`MaxButton`] from the non-client mouse messages; everything decidable without a window is decided here.

use super::geometry::Rect;

/// `WM_NCHITTEST` results (winuser.h), as plain numbers so this crate needs no OS bindings.
pub mod ht {
    /// In the client area.
    pub const CLIENT: i32 = 1;
    /// On the title bar: the window moves.
    pub const CAPTION: i32 = 2;
    /// On the maximize button.
    pub const MAXBUTTON: i32 = 9;
    /// The left edge.
    pub const LEFT: i32 = 10;
    /// The right edge.
    pub const RIGHT: i32 = 11;
    /// The top edge.
    pub const TOP: i32 = 12;
    /// The top-left corner.
    pub const TOPLEFT: i32 = 13;
    /// The top-right corner.
    pub const TOPRIGHT: i32 = 14;
    /// The bottom edge.
    pub const BOTTOM: i32 = 15;
    /// The bottom-left corner.
    pub const BOTTOMLEFT: i32 = 16;
    /// The bottom-right corner.
    pub const BOTTOMRIGHT: i32 = 17;
}

/// The places the band publishes after each layout, in physical client pixels.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ChromeRegions {
    /// Where the window can be dragged by (the band).
    pub caption: Vec<Rect>,
    /// Inside the caption, the controls that must stay clickable (tabs, buttons, fields).
    pub no_drag: Vec<Rect>,
    /// The maximize button.
    pub maximize: Option<Rect>,
    /// The minimize and close buttons: they win over the top resize edge.
    pub buttons: Vec<Rect>,
}

/// What the window is doing now.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FrameState {
    /// Maximized: no resize edges.
    pub maximized: bool,
    /// Fullscreen: no resize edges and no caption.
    pub fullscreen: bool,
}

/// What the point is for. `width` and `height` are the client area's size; `border` the resize border in pixels.
pub fn hit_test(regions: &ChromeRegions, state: FrameState, border: i32, width: i32, height: i32, x: i32, y: i32) -> i32 {
    if state.fullscreen || x < 0 || y < 0 || x >= width || y >= height {
        return ht::CLIENT;
    }
    if !state.maximized && border > 0 {
        let corner = border * 2;
        let on_control = regions.buttons.iter().chain(regions.maximize.iter()).any(|r| r.contains(x, y));
        let (left, right) = (x < border, x >= width - border);
        let (near_left, near_right) = (x < corner, x >= width - corner);
        if left || right {
            let (near_top, near_bottom) = (y < corner, y >= height - corner);
            return match (left, near_top, near_bottom) {
                (true, true, _) => ht::TOPLEFT,
                (true, _, true) => ht::BOTTOMLEFT,
                (true, ..) => ht::LEFT,
                (false, true, _) => ht::TOPRIGHT,
                (false, _, true) => ht::BOTTOMRIGHT,
                _ => ht::RIGHT,
            };
        }
        if y >= height - border {
            return if near_left { ht::BOTTOMLEFT } else if near_right { ht::BOTTOMRIGHT } else { ht::BOTTOM };
        }
        // The top edge yields to the window buttons, so their top pixels are the buttons.
        if y < border && !on_control {
            return if near_left { ht::TOPLEFT } else if near_right { ht::TOPRIGHT } else { ht::TOP };
        }
    }
    if regions.maximize.is_some_and(|r| r.contains(x, y)) {
        return ht::MAXBUTTON;
    }
    if regions.caption.iter().any(|r| r.contains(x, y)) && !regions.no_drag.iter().any(|r| r.contains(x, y)) && !regions.buttons.iter().any(|r| r.contains(x, y)) {
        return ht::CAPTION;
    }
    ht::CLIENT
}

/// The width of one window control in logical pixels: 44, folding to 36 when the band folds `winctl` (`topbar.css`).
pub const fn control_width(folded: bool) -> u32 {
    if folded { 36 } else { 44 }
}

/// The glyph size of a window control, in logical pixels.
pub const CONTROL_GLYPH: u32 = 16;

/// The band's height in logical pixels (`--topbar-h`): 52, 44 in the compact chrome, never below 44 / ui-scale.
pub fn band_height(ui_scale: f32, compact: bool) -> f32 {
    let base = if compact { 44.0 } else { 52.0_f32 };
    base.max(44.0 / ui_scale)
}

/// The regions of a band that spans the window's width at the top: the whole band drags, the three window controls sit
/// flush with the right edge (`topbar.css`), minimize and close are plain buttons, maximize is the snap-layouts button,
/// and `no_drag` is what else in the band takes the pointer (tabs, buttons, fields). `scale` is physical pixels per
/// logical pixel.
pub fn band_regions(client_width: i32, scale: f32, band_height: f32, folded: bool, no_drag: &[Rect]) -> ChromeRegions {
    let control = (control_width(folded) as f32 * scale).round() as i32;
    let height = (band_height * scale).round() as i32;
    let right = client_width;
    ChromeRegions {
        caption: vec![Rect::new(0, 0, client_width, height)],
        no_drag: no_drag.to_vec(),
        maximize: Some(Rect::new(right - 2 * control, 0, control, height)),
        buttons: vec![Rect::new(right - 3 * control, 0, control, height), Rect::new(right - control, 0, control, height)],
    }
}

/// Why a press was given up on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cancel {
    /// The mouse capture was taken away (`WM_CAPTURECHANGED`).
    CaptureLost,
    /// The window was deactivated.
    Deactivated,
    /// The window went fullscreen, or the band hid.
    ChromeGone,
    /// The window is being destroyed.
    Destroyed,
}

/// What the maximize button looks like and is doing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MaxButtonState {
    /// Nothing.
    Idle,
    /// The pointer is over it.
    Hover,
    /// The button is down; `armed` while the pointer is still over it.
    Pressed {
        /// Releasing now would activate.
        armed: bool,
    },
}

impl MaxButtonState {
    /// A small number for an atomic the interface reads: 0 idle, 1 hover, 2 pressed and armed, 3 pressed and not armed.
    pub fn as_u8(self) -> u8 {
        match self {
            MaxButtonState::Idle => 0,
            MaxButtonState::Hover => 1,
            MaxButtonState::Pressed { armed: true } => 2,
            MaxButtonState::Pressed { armed: false } => 3,
        }
    }

    /// The state a number stands for; anything unknown is idle.
    pub fn from_u8(value: u8) -> MaxButtonState {
        match value {
            1 => MaxButtonState::Hover,
            2 => MaxButtonState::Pressed { armed: true },
            3 => MaxButtonState::Pressed { armed: false },
            _ => MaxButtonState::Idle,
        }
    }
}

/// The input the button reacts to. `over` says whether the pointer is over the button.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ButtonInput {
    /// The pointer moved.
    Move {
        /// Over the button.
        over: bool,
    },
    /// The pointer left the window's non-client area.
    Leave,
    /// The primary button went down.
    Down {
        /// Over the button.
        over: bool,
    },
    /// The primary button came up.
    Up {
        /// Over the button.
        over: bool,
    },
    /// The press must be given up.
    Cancel(Cancel),
}

/// What the window should do after an input.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ButtonAction {
    /// Nothing.
    None,
    /// Take the mouse capture, so the release arrives wherever the pointer is.
    Capture,
    /// Release the mouse capture (the press ended, one way or the other).
    Release,
    /// Maximize or restore the window, and release the capture.
    Toggle,
}

/// The maximize button's press: down over it arms it, leaving disarms, coming back re-arms, releasing over it toggles,
/// and releasing elsewhere, losing the capture, deactivation, fullscreen or destruction cancel without toggling.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MaxButton {
    state: MaxButtonState,
}

impl Default for MaxButton {
    fn default() -> Self {
        MaxButton { state: MaxButtonState::Idle }
    }
}

impl MaxButton {
    /// The current state.
    pub fn state(&self) -> MaxButtonState {
        self.state
    }

    /// Applies one input.
    pub fn step(&mut self, input: ButtonInput) -> ButtonAction {
        use MaxButtonState::*;
        match (self.state, input) {
            (Pressed { .. }, ButtonInput::Move { over }) => {
                self.state = Pressed { armed: over };
                ButtonAction::None
            }
            (Pressed { .. }, ButtonInput::Leave) => {
                self.state = Pressed { armed: false };
                ButtonAction::None
            }
            (Pressed { armed }, ButtonInput::Up { over }) => {
                self.state = Idle;
                if armed && over { ButtonAction::Toggle } else { ButtonAction::Release }
            }
            (Pressed { .. }, ButtonInput::Cancel(_)) => {
                self.state = Idle;
                ButtonAction::Release
            }
            (Pressed { .. }, ButtonInput::Down { .. }) => ButtonAction::None,
            (_, ButtonInput::Down { over: true }) => {
                self.state = Pressed { armed: true };
                ButtonAction::Capture
            }
            (_, ButtonInput::Down { over: false }) => ButtonAction::None,
            (_, ButtonInput::Move { over }) => {
                self.state = if over { Hover } else { Idle };
                ButtonAction::None
            }
            (_, ButtonInput::Leave) | (_, ButtonInput::Cancel(_)) => {
                self.state = Idle;
                ButtonAction::None
            }
            (_, ButtonInput::Up { .. }) => ButtonAction::None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: i32 = 1560;
    const H: i32 = 1000;
    const BORDER: i32 = 8;

    fn regions() -> ChromeRegions {
        ChromeRegions {
            caption: vec![Rect::new(0, 0, W, 52)],
            no_drag: vec![Rect::new(200, 0, 300, 52)],
            maximize: Some(Rect::new(W - 88, 0, 44, 52)),
            buttons: vec![Rect::new(W - 132, 0, 44, 52), Rect::new(W - 44, 0, 44, 52)],
        }
    }

    fn at(x: i32, y: i32) -> i32 {
        hit_test(&regions(), FrameState::default(), BORDER, W, H, x, y)
    }

    #[test]
    fn the_edges_and_corners_resize() {
        assert_eq!(at(2, 500), ht::LEFT);
        assert_eq!(at(W - 3, 500), ht::RIGHT);
        assert_eq!(at(700, H - 3), ht::BOTTOM);
        assert_eq!(at(2, 2), ht::TOPLEFT);
        assert_eq!(at(W - 3, H - 3), ht::BOTTOMRIGHT);
        assert_eq!(at(2, H - 3), ht::BOTTOMLEFT);
        assert_eq!(at(700, 2), ht::TOP);
        assert_eq!(at(2, 12), ht::TOPLEFT, "the corner is two borders long");
        assert_eq!(at(2, 40), ht::LEFT);
    }

    #[test]
    fn the_band_moves_the_window_except_where_a_control_is() {
        assert_eq!(at(700, 20), ht::CAPTION);
        assert_eq!(at(300, 20), ht::CLIENT, "a no-drag rectangle (tabs, buttons) is client");
        assert_eq!(at(W - 20, 30), ht::CLIENT, "close is client");
        assert_eq!(at(W - 110, 30), ht::CLIENT, "minimize is client");
        assert_eq!(at(W - 66, 30), ht::MAXBUTTON);
        assert_eq!(at(700, 500), ht::CLIENT);
    }

    #[test]
    fn the_top_edge_yields_to_the_window_buttons() {
        assert_eq!(at(W - 66, 2), ht::MAXBUTTON, "the maximize button keeps its top pixels for the snap flyout");
        assert_eq!(at(W - 110, 2), ht::CLIENT, "so does minimize");
        assert_eq!(at(W - 25, 2), ht::CLIENT, "and close");
        assert_eq!(at(W - 3, 2), ht::TOPRIGHT, "but the window's corner is still the corner");
    }

    #[test]
    fn maximized_has_no_edges_and_its_band_still_works() {
        let state = FrameState { maximized: true, fullscreen: false };
        for (x, y) in [(0, 500), (W - 1, 500), (700, H - 1), (0, 0), (W - 1, H - 1), (700, 0)] {
            let code = hit_test(&regions(), state, BORDER, W, H, x, y);
            assert!(!(ht::LEFT..=ht::BOTTOMRIGHT).contains(&code) || code == ht::MAXBUTTON, "({x},{y}) gave {code}");
        }
        assert_eq!(hit_test(&regions(), state, BORDER, W, H, 700, 0), ht::CAPTION);
        assert_eq!(hit_test(&regions(), state, BORDER, W, H, W - 66, 0), ht::MAXBUTTON);
    }

    #[test]
    fn fullscreen_is_all_client_with_no_edges_even_with_stale_regions() {
        let state = FrameState { maximized: false, fullscreen: true };
        for (x, y) in [(0, 0), (700, 20), (W - 66, 20), (2, 500), (W - 1, H - 1)] {
            assert_eq!(hit_test(&regions(), state, BORDER, W, H, x, y), ht::CLIENT);
        }
    }

    #[test]
    fn a_hidden_band_publishes_nothing_and_leaves_only_the_edges() {
        let none = ChromeRegions::default();
        assert_eq!(hit_test(&none, FrameState::default(), BORDER, W, H, 700, 20), ht::CLIENT);
        assert_eq!(hit_test(&none, FrameState::default(), BORDER, W, H, 700, 2), ht::TOP);
    }

    #[test]
    fn outside_the_client_area_is_client() {
        assert_eq!(at(-1, 5), ht::CLIENT);
        assert_eq!(at(W, 5), ht::CLIENT);
        assert_eq!(at(5, H), ht::CLIENT);
    }

    #[test]
    fn the_band_publishes_its_controls_flush_right_at_both_widths_and_every_scale() {
        for (scale, folded, control) in [(1.0, false, 44), (1.0, true, 36), (1.5, false, 66), (2.0, true, 72)] {
            let width = 1560;
            let regions = band_regions(width, scale, band_height(1.0, false), folded, &[]);
            let height = (52.0 * scale).round() as i32;
            assert_eq!(regions.maximize, Some(Rect::new(width - 2 * control, 0, control, height)), "{scale} {folded}");
            assert_eq!(regions.buttons, vec![Rect::new(width - 3 * control, 0, control, height), Rect::new(width - control, 0, control, height)]);
            assert_eq!(regions.caption, vec![Rect::new(0, 0, width, height)]);
            let rightmost = regions.buttons[1];
            assert_eq!(rightmost.right(), width, "close is flush with the window edge");
        }
    }

    #[test]
    fn control_sizes_are_todays() {
        assert_eq!((control_width(false), control_width(true), CONTROL_GLYPH), (44, 36, 16));
        assert_eq!(band_height(1.0, false), 52.0);
        assert_eq!(band_height(1.0, true), 44.0);
        assert_eq!(band_height(0.5, true), 88.0, "never below 44 / ui-scale");
    }

    fn press(inputs: &[ButtonInput]) -> (MaxButton, Vec<ButtonAction>) {
        let mut button = MaxButton::default();
        let actions = inputs.iter().map(|input| button.step(*input)).collect();
        (button, actions)
    }

    #[test]
    fn hover_press_and_release_over_the_button_toggles_once() {
        let (button, actions) = press(&[ButtonInput::Move { over: true }, ButtonInput::Down { over: true }, ButtonInput::Up { over: true }]);
        assert_eq!(actions, vec![ButtonAction::None, ButtonAction::Capture, ButtonAction::Toggle]);
        assert_eq!(button.state(), MaxButtonState::Idle);
    }

    #[test]
    fn dragging_off_and_back_rearms() {
        let (button, actions) = press(&[ButtonInput::Down { over: true }, ButtonInput::Move { over: false }, ButtonInput::Move { over: true }, ButtonInput::Up { over: true }]);
        assert_eq!(actions.last(), Some(&ButtonAction::Toggle));
        assert_eq!(button.state(), MaxButtonState::Idle);
        let (_, off) = press(&[ButtonInput::Down { over: true }, ButtonInput::Move { over: false }]);
        assert_eq!(off, vec![ButtonAction::Capture, ButtonAction::None]);
    }

    #[test]
    fn release_outside_never_toggles() {
        let (button, actions) = press(&[ButtonInput::Down { over: true }, ButtonInput::Move { over: false }, ButtonInput::Up { over: false }]);
        assert_eq!(actions.last(), Some(&ButtonAction::Release));
        assert_eq!(button.state(), MaxButtonState::Idle);
        let (_, leave) = press(&[ButtonInput::Down { over: true }, ButtonInput::Leave, ButtonInput::Up { over: true }]);
        assert_eq!(leave.last(), Some(&ButtonAction::Release), "a release after the pointer left the area, though reported over, was not armed");
    }

    #[test]
    fn a_press_that_started_elsewhere_does_nothing() {
        let (button, actions) = press(&[ButtonInput::Down { over: false }, ButtonInput::Up { over: true }]);
        assert_eq!(actions, vec![ButtonAction::None, ButtonAction::None]);
        assert_eq!(button.state(), MaxButtonState::Idle);
    }

    #[test]
    fn every_cancellation_ends_the_press_without_toggling() {
        for cancel in [Cancel::CaptureLost, Cancel::Deactivated, Cancel::ChromeGone, Cancel::Destroyed] {
            let (mut button, _) = press(&[ButtonInput::Down { over: true }]);
            assert_eq!(button.step(ButtonInput::Cancel(cancel)), ButtonAction::Release, "{cancel:?}");
            assert_eq!(button.state(), MaxButtonState::Idle);
            assert_eq!(button.step(ButtonInput::Up { over: true }), ButtonAction::None, "the release after a cancel is nothing");
        }
    }

    #[test]
    fn a_leave_while_hovering_clears_the_hover() {
        let (button, _) = press(&[ButtonInput::Move { over: true }, ButtonInput::Leave]);
        assert_eq!(button.state(), MaxButtonState::Idle);
    }

    #[test]
    fn the_state_survives_an_atomic_round_trip() {
        for state in [MaxButtonState::Idle, MaxButtonState::Hover, MaxButtonState::Pressed { armed: true }, MaxButtonState::Pressed { armed: false }] {
            assert_eq!(MaxButtonState::from_u8(state.as_u8()), state);
        }
        assert_eq!(MaxButtonState::from_u8(200), MaxButtonState::Idle);
    }
}
