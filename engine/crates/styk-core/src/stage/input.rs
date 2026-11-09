//! The in-process navigation/input seam used by the widget and automation.
#[cfg(feature = "engine")]
use super::Host;
#[cfg(feature = "engine")]
use crate::frames;
use styk_services::input::{Modifiers, PenSample};
#[cfg(feature = "engine")]
use styk_services::input::{InputEvent, Phase};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PointerPhase {
    Down,
    Move,
    Up,
    Cancel,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Button {
    Left,
    Middle,
    Right,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pointer {
    pub id: u32,
    pub phase: PointerPhase,
    /// Logical stage coordinates, matching styk-auto/1 (not screen input).
    pub point: [f64; 2],
    pub button: Button,
    pub modifiers: Modifiers,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct Navigation {
    pub pan_tool: bool,
    pub space: bool,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum InputResult {
    ViewChanged,
    Captured,
    Route(Pointer),
    Cancel(Option<u32>),
}

/// Pen data is never reduced to a mouse event: the original pressure, provenance,
/// timestamps and terminal events reach the Draw workspace's existing input owner.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StagePen {
    pub original: PenSample,
    pub stage: [f64; 2],
    pub document: [f64; 2],
}

#[cfg(feature = "engine")]
impl Host {
    pub fn pointer(
        &mut self,
        pointer: Pointer,
        navigation: Navigation,
    ) -> Result<InputResult, frames::Error> {
        if !pointer.point.iter().all(|x| x.is_finite()) {
            return Err(frames::Error::InvalidRequest);
        }
        if pointer.phase == PointerPhase::Down {
            self.wheel.cancel();
        }
        if pointer.phase == PointerPhase::Cancel {
            if self.pan_gesture.is_some_and(|g| g.0 == pointer.id) {
                self.pan_gesture = None;
            }
            return Ok(InputResult::Cancel(Some(pointer.id)));
        }
        if pointer.phase == PointerPhase::Down
            && self.pan_gesture.is_none()
            && (pointer.button == Button::Middle || navigation.space || navigation.pan_tool)
        {
            self.pan_gesture = Some((pointer.id, pointer.point, self.view.pan));
            return Ok(InputResult::Captured);
        }
        if let Some((id, start, pan)) = self.pan_gesture
            && id == pointer.id
        {
            if pointer.phase == PointerPhase::Move {
                let mut view = self.view;
                view.pan = [
                    pan[0] + pointer.point[0] - start[0],
                    pan[1] + pointer.point[1] - start[1],
                ];
                self.set_view(view)?;
                return Ok(InputResult::ViewChanged);
            }
            if pointer.phase == PointerPhase::Up {
                self.pan_gesture = None;
            }
            return Ok(InputResult::Captured);
        }
        Ok(InputResult::Route(pointer))
    }

    /// The window lost focus: a captured pan drag ends where it stands (the view keeps what it had).
    pub fn cancel_gestures(&mut self) {
        self.pan_gesture = None;
    }

    pub fn pen_sample(
        &self,
        sample: PenSample,
        camera: Option<&crate::engine::doc::Camera>,
    ) -> StagePen {
        let window = [sample.x / self.viewport.dpr, sample.y / self.viewport.dpr];
        let stage = self.viewport.window_to_stage(window);
        StagePen {
            original: sample,
            stage,
            document: self.view.stage_to_document(stage, self.canvas, camera),
        }
    }

    /// An automation pen sample already in logical stage coordinates takes the
    /// same physical-window route as the platform's fake and real input sources.
    pub fn automation_pen(&self, mut sample: PenSample) -> InputEvent {
        let window = self.viewport.stage_to_window([sample.x, sample.y]);
        sample.x = window[0] * self.viewport.dpr;
        sample.y = window[1] * self.viewport.dpr;
        InputEvent::Sample(sample)
    }

    pub fn pen_navigation(
        &mut self,
        event: InputEvent,
        navigation: Navigation,
    ) -> Result<InputResult, frames::Error> {
        match event {
            InputEvent::Sample(sample) => {
                let point = self.pen_sample(sample, None).stage;
                self.pointer(
                    Pointer {
                        id: sample.pointer,
                        phase: match sample.phase {
                            Phase::Down => PointerPhase::Down,
                            Phase::Hover | Phase::Move => PointerPhase::Move,
                            Phase::Up => PointerPhase::Up,
                        },
                        point,
                        button: Button::Left,
                        modifiers: sample.modifiers,
                    },
                    navigation,
                )
            }
            InputEvent::Interrupted { pointer, .. } => {
                if self.pan_gesture.is_some_and(|g| g.0 == pointer) {
                    self.pan_gesture = None;
                }
                Ok(InputResult::Cancel(Some(pointer)))
            }
            InputEvent::Overflowed { .. } => {
                self.pan_gesture = None;
                Ok(InputResult::Cancel(None))
            }
        }
    }
}
