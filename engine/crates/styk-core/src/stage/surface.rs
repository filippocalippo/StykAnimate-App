//! The stage as its widget uses it (`docs/native/stage.md`, "The stage widget"): one document's [`Host`], its
//! [`Painter`] and the input policy that turns pointer, wheel, key, pen and size reports into navigation.
//!
//! The widget in `styk-ui` is glue. It reports what happened (a [`Event`], the size and density of its place) and
//! calls three entry points on the render path: [`Surface::prepare`] (after the previous frame's encoder was
//! submitted), [`Surface::present`] (recording into the widget's pass) and [`Surface::moving`]. Everything it
//! would otherwise decide lives here: pan or zoom for a wheel, line or pixel units, which presses the stage keeps,
//! when a frame is requested and what is shown while one is pending.
//!
//! **One thread.** A surface is shared by the core (which runs [`Event`]s from `Core::dispatch`) and the widget's
//! render path, both on the interface thread, so its lock is never contended; it is only ever taken with `try_lock`,
//! and a call that finds it taken does nothing (D7: the interface never waits on a lock). The paint worker never
//! touches it: it exchanges single owned pointers with the [`Painter`] (`docs/native/stage.md`).

use super::event::{Cursor, Error, Event, Gestures, GpuId, Outcome};
use super::input::{InputResult, Navigation};
use super::progress::Progress;
use super::{Host, PaintError, PaintLimits, PaintStatus, Painter, Viewport};
use crate::engine::{SceneOptions, wgpu};
use crate::frames;
use std::sync::{Arc, Mutex, MutexGuard, TryLockError};
use styk_services::input::{InputEvent, InputQueue, Modifiers};
use styk_services::{Clock, Spawner};

/// What `prepare`, `present` and the events did, in order, for the headless test of the contract.
#[cfg(feature = "testing")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Call {
    Observe,
    Attach,
    Request,
    Flush,
    Update,
    Present,
}

/// The shared state of one document's stage.
pub struct Surface {
    inner: Mutex<Inner>,
    progress: Arc<Progress>,
}

struct Inner {
    host: Host,
    painter: Option<Painter>,
    gpu: Option<GpuId>,
    spawner: Arc<dyn Spawner>,
    clock: Arc<dyn Clock>,
    progress: Arc<Progress>,
    input: Option<InputQueue>,
    /// Why the paint worker could not start. Kept until a new graphics context is the recovery (never retried by itself).
    fault: Option<PaintError>,
    limits: PaintLimits,
    gestures: Gestures,
    navigation: Navigation,
    tick: f64,
    quality: f64,
    samples: u8,
    scene: SceneOptions,
    /// The host's demand is not yet known to the painter (a view, size, tick or painter changed).
    dirty: bool,
    status: PaintStatus,
    closed: bool,
    #[cfg(feature = "testing")]
    calls: Vec<Call>,
}

impl Surface {
    /// `host` is composed by the document's owner (the frame scheduler, the injected spawner and clock); its scheduler
    /// wakes through `progress.wake()`, as do the painter and the input queue. The painter is created later, by
    /// [`Surface::prepare`], on the device the toolkit hands over.
    pub fn new(host: Host, spawner: Arc<dyn Spawner>, clock: Arc<dyn Clock>, progress: Arc<Progress>, limits: PaintLimits) -> Surface {
        Surface {
            progress: progress.clone(),
            inner: Mutex::new(Inner {
                host,
                painter: None,
                gpu: None,
                spawner,
                clock,
                progress,
                input: None,
                fault: None,
                limits,
                gestures: Gestures::default(),
                navigation: Navigation::default(),
                tick: 0.0,
                quality: 1.0,
                samples: 4,
                scene: SceneOptions::default(),
                dirty: true,
                status: PaintStatus::Pending,
                closed: false,
                #[cfg(feature = "testing")]
                calls: Vec::new(),
            }),
        }
    }

    fn with<R>(&self, run: impl FnOnce(&mut Inner) -> R) -> Option<R> {
        let mut inner: MutexGuard<'_, Inner> = match self.inner.try_lock() {
            Ok(inner) => inner,
            Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
            Err(TryLockError::WouldBlock) => return None,
        };
        Some(run(&mut inner))
    }

    pub fn set_gestures(&self, gestures: Gestures) {
        self.with(|inner| inner.gestures = gestures);
    }

    /// Runs one event. Navigation changes the view and demands the frame it needs.
    pub fn event(&self, event: Event) -> Result<Outcome, Error> {
        self.with(|inner| inner.event(event)).ok_or(Error::Unavailable)?
    }

    /// The render path, first half: the size and density of the widget's place, the graphics context, then the
    /// scheduler's progress and the painter's newest picture. Called after the previous frame's encoder was
    /// submitted, so the picture it takes in is never one the GPU is still drawing.
    pub fn prepare(&self, place: Place, gpu: Gpu<'_>) {
        self.with(|inner| inner.prepare(place, gpu));
    }

    /// The render path, second half: records the last complete picture into the widget's pass (the widget set its
    /// viewport and scissor). Nothing is drawn, and `false` is returned, until a first picture is complete.
    pub fn present(&self, pass: &mut wgpu::RenderPass<'_>) -> bool {
        self.with(|inner| inner.present(pass)).unwrap_or(false)
    }

    /// The coalesced wake: its answers become [`Event::Progress`] (the subscription in `styk_ui::stage`).
    pub fn progress(&self) -> Arc<Progress> {
        self.progress.clone()
    }

    /// The platform's input queue for this stage: pen samples reach the host when [`Event::Progress`] drains it, and the
    /// queue wakes the stage when it stops being empty.
    pub fn set_input(&self, queue: InputQueue) {
        queue.set_waker(self.progress.wake());
        self.with(|inner| inner.input = Some(queue));
    }

    /// Whether the view is easing or a gesture's idle window is open: the widget sends [`Event::Tick`] on each redraw.
    pub fn moving(&self) -> bool {
        self.with(|inner| inner.host.interacting()).unwrap_or(false)
    }

    /// The hand over the stage: open while Space is held or the Pan tool is the tool, closed while a pan drag is
    /// captured (today's `panning` and `dragging` classes).
    pub fn cursor(&self) -> Cursor {
        self.with(|inner| inner.cursor()).unwrap_or(Cursor::Default)
    }

    /// The artboard's rectangle in the stage's logical pixels (left, top, width, height) for the backing drawn beneath
    /// the picture (`placeArtboard`): where the canvas lies in the picture on show, so the two never disagree while a
    /// newer picture is on its way; the current view before a first picture.
    pub fn artboard(&self) -> Option<[f64; 4]> {
        self.with(|inner| {
            let canvas = inner.host.canvas().map(f64::from);
            match inner.painter.as_ref().and_then(Painter::shown_key) {
                Some(key) => {
                    let shown = &key.view;
                    [shown.pan[0] / shown.density, shown.pan[1] / shown.density, canvas[0] * shown.zoom / shown.density, canvas[1] * shown.zoom / shown.density]
                }
                None => {
                    let view = inner.host.view();
                    [view.pan[0], view.pan[1], canvas[0] * view.zoom, canvas[1] * view.zoom]
                }
            }
        })
    }

    pub fn view(&self) -> Option<super::View> {
        self.with(|inner| inner.host.view())
    }

    pub fn viewport(&self) -> Option<Viewport> {
        self.with(|inner| inner.host.viewport())
    }

    /// Why the paint worker could not start, if it could not: a new graphics context is the only retry.
    pub fn fault(&self) -> Option<PaintError> {
        self.with(|inner| inner.fault.clone()).flatten()
    }

    /// The painter's last report: `Pending` until a picture is complete, `Failed` when the newest request was refused
    /// (the previous picture stays), `Closed` after [`Surface::close`].
    pub fn status(&self) -> PaintStatus {
        self.with(|inner| inner.status.clone()).unwrap_or(PaintStatus::Closed)
    }

    /// Whether the picture on show answers the newest demand.
    pub fn ready(&self) -> bool {
        self.status() == PaintStatus::Ready
    }

    /// Closes the painter and the host. Neither joins a worker (`docs/native/stage.md`).
    pub fn close(&self) {
        self.with(Inner::close);
    }

    #[cfg(feature = "testing")]
    pub fn take_calls(&self) -> Vec<Call> {
        self.with(|inner| std::mem::take(&mut inner.calls)).unwrap_or_default()
    }

    #[cfg(feature = "testing")]
    pub fn painter_exited(&self) -> bool {
        self.with(|inner| inner.painter.as_ref().is_none_or(Painter::worker_exited)).unwrap_or(false)
    }

    #[cfg(feature = "testing")]
    pub fn shown_key(&self) -> Option<super::PaintKey> {
        self.with(|inner| inner.painter.as_ref().and_then(|p| p.shown_key().cloned())).flatten()
    }

    /// Screenshot and test seam: the shown picture's texture (never mapped on the interface thread).
    #[cfg(feature = "testing")]
    pub fn with_texture<R>(&self, read: impl FnOnce(&wgpu::Texture) -> R) -> Option<R> {
        self.with(|inner| inner.painter.as_ref().and_then(|p| p.texture().map(read))).flatten()
    }
}

impl Drop for Surface {
    fn drop(&mut self) {
        self.close();
    }
}

/// Where the widget is: logical window pixels and the window's density.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Place {
    pub origin: [f64; 2],
    pub size: [f64; 2],
    pub dpr: f64,
}

/// The toolkit's graphics context, the same device, queue and target format it draws with.
#[derive(Clone, Copy)]
pub struct Gpu<'a> {
    pub id: GpuId,
    pub device: &'a wgpu::Device,
    pub queue: &'a wgpu::Queue,
    pub format: wgpu::TextureFormat,
}

impl Inner {
    fn now_ms(&self) -> f64 {
        self.clock.now().as_secs_f64() * 1000.0
    }

    fn event(&mut self, event: Event) -> Result<Outcome, Error> {
        if self.closed {
            return Err(Error::Unavailable);
        }
        let mut outcome = Outcome::default();
        let now = self.now_ms();
        let before = self.host.view();
        let result = match event {
            Event::Pointer(pointer) => match self.host.pointer(pointer, self.navigation) {
                Ok(InputResult::Route(routed)) => {
                    outcome.routed.push(routed);
                    Ok(())
                }
                Ok(_) => Ok(()),
                Err(error) => Err(error),
            },
            Event::Wheel(wheel) => {
                let [dx, dy] = wheel.delta.browser();
                let zooms = self.gestures.scroll_zooms || wheel.modifiers.contains(Modifiers::CTRL) || wheel.modifiers.contains(Modifiers::META);
                if zooms {
                    self.host.wheel(dy, wheel.point, now, self.gestures.smooth, self.gestures.reduced_motion)
                } else {
                    self.host.wheel_pan([dx, dy], wheel.modifiers.contains(Modifiers::SHIFT), now)
                }
            }
            Event::Space(held) => {
                self.navigation.space = held;
                Ok(())
            }
            Event::PanTool(on) => {
                self.navigation.pan_tool = on;
                Ok(())
            }
            Event::Pen(events) => self.pen(events, &mut outcome),
            Event::Pan(delta) => self.host.pan_by(delta),
            Event::Zoom { factor, at } => self.host.zoom_by(factor, Some(at)),
            Event::FitCanvas => self.host.fit_canvas(),
            Event::Tick => self.host.advance(now).map(drop),
            Event::Progress => {
                self.host.frames_mut().flush();
                let mut events = Vec::new();
                if let Some(queue) = &self.input {
                    queue.drain(&mut events);
                }
                self.pen(events, &mut outcome)
            }
            Event::Blur => {
                self.navigation.space = false;
                self.host.cancel_gestures();
                Ok(())
            }
            Event::Frame(tick) => {
                if !tick.is_finite() || tick < 0.0 {
                    return Err(Error::Invalid);
                }
                self.tick = tick;
                self.dirty = true;
                outcome.changed = true;
                Ok(())
            }
        };
        result.map_err(|_| Error::Invalid)?;
        if self.host.view() != before {
            self.dirty = true;
            outcome.changed = true;
        }
        if self.dirty {
            self.request();
        }
        Ok(outcome)
    }

    fn pen(&mut self, events: Vec<InputEvent>, outcome: &mut Outcome) -> Result<(), frames::Error> {
        let mut result = Ok(());
        for event in events {
            match self.host.pen_navigation(event, self.navigation) {
                Ok(InputResult::Route(routed)) => outcome.routed.push(routed),
                Ok(_) => {}
                Err(error) => result = Err(error),
            }
        }
        result
    }

    /// Demands the frame for the view and tick as they are now: the host's scheduler key, then the painter's ticket.
    /// Metadata only; the painter's worker does the work.
    fn request(&mut self) {
        if self.closed {
            return;
        }
        #[cfg(feature = "testing")]
        self.calls.push(Call::Request);
        if self.fault.is_some() || self.host.request(self.tick, self.quality, self.samples, self.scene.clone()).is_err() {
            return;
        }
        match self.painter.as_mut() {
            Some(painter) => {
                if painter.request(&self.host).is_ok() {
                    self.dirty = false;
                    // A newer demand than the picture on show: pending until the painter reports its own.
                    self.status = PaintStatus::Pending;
                }
            }
            // Without a painter the demand waits for the one `prepare` creates.
            None => self.dirty = true,
        }
    }

    fn prepare(&mut self, place: Place, gpu: Gpu<'_>) {
        if self.closed {
            return;
        }
        #[cfg(feature = "testing")]
        self.calls.push(Call::Observe);
        let viewport = Viewport { origin: place.origin, size: place.size, dpr: place.dpr, ..self.host.viewport() };
        if viewport.valid() && viewport != self.host.viewport() && self.host.resize(viewport).is_ok() {
            self.dirty = true;
        }
        if !viewport.valid() {
            return;
        }
        if self.gpu != Some(gpu.id) {
            #[cfg(feature = "testing")]
            self.calls.push(Call::Attach);
            // A new context needs a new painter; the old one's pictures belong to the old device. This is the one
            // place a painter is made, so a worker that cannot start is tried once per context, never every frame.
            if let Some(mut old) = self.painter.take() {
                old.close();
            }
            self.gpu = Some(gpu.id);
            self.fault = None;
            match Painter::new(gpu.device, gpu.queue, gpu.format, self.spawner.as_ref(), self.clock.clone(), self.progress.wake(), self.limits) {
                Ok(painter) => {
                    self.painter = Some(painter);
                    self.status = PaintStatus::Pending;
                }
                Err(error) => {
                    let fault = PaintError::Device(format!("the paint worker did not start: {}", error.0));
                    self.status = PaintStatus::Failed(fault.clone());
                    self.fault = Some(fault);
                }
            }
            self.dirty = true;
        }
        if self.dirty {
            self.request();
        }
        #[cfg(feature = "testing")]
        self.calls.push(Call::Flush);
        self.host.frames_mut().flush();
        if let Some(painter) = self.painter.as_mut() {
            #[cfg(feature = "testing")]
            self.calls.push(Call::Update);
            self.status = painter.update();
        }
    }

    fn present(&mut self, pass: &mut wgpu::RenderPass<'_>) -> bool {
        #[cfg(feature = "testing")]
        self.calls.push(Call::Present);
        self.painter.as_ref().is_some_and(|painter| painter.present(pass))
    }

    fn cursor(&self) -> Cursor {
        if self.host.pan_gesture.is_some() {
            Cursor::Grabbing
        } else if self.navigation.space || self.navigation.pan_tool {
            Cursor::Grab
        } else {
            Cursor::Default
        }
    }

    fn close(&mut self) {
        if self.closed {
            return;
        }
        self.closed = true;
        if let Some(painter) = self.painter.as_mut() {
            painter.close();
        }
        self.host.close();
        self.status = PaintStatus::Closed;
    }
}

impl Event {
    /// The stage event an automation step (`styk_core::automation`) is: the steps the stage takes, in the same
    /// logical stage pixels, run through the same dispatch as the widget's own events. Other steps are the runner's.
    pub fn from_step(step: &crate::automation::Step) -> Option<Event> {
        use crate::automation::Step;
        match step {
            Step::Pan(delta) => Some(Event::Pan(*delta)),
            Step::Zoom { factor, at } => Some(Event::Zoom { factor: *factor, at: *at }),
            Step::Pointer(pointer) => Some(Event::Pointer(*pointer)),
            Step::Frame(tick) => Some(Event::Frame(*tick)),
            _ => None,
        }
    }
}
