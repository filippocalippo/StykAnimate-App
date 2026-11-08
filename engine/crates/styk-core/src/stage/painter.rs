//! One paint worker, one engine renderer, the interface's last complete picture.
//! No renderer preparation, CPU frame ownership or GPU wait crosses to the UI.
use super::{Host, PaintKey};
use crate::frames::{self, WorkerFrame, WorkerTicket};
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicPtr, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;
use styk_render::{RenderedFrame, Renderer, ViewParams, wgpu};
use styk_services::{Clock, SpawnError, Spawner};

mod pictures;
#[cfg(test)]
mod tests;

#[derive(Clone, Copy, Debug)]
pub struct PaintLimits {
    /// All output pictures together: shown, unpublished and recycled (three).
    pub output_bytes: u64,
    /// Resident sprite pixels; a whole visible working set is admitted or refused.
    pub sprite_bytes: u64,
    /// Layer, effect, glyph and geometry resources, including replacement overlap.
    pub working_bytes: u64,
}
impl Default for PaintLimits {
    fn default() -> Self {
        Self {
            output_bytes: 192 << 20,
            sprite_bytes: 512 << 20,
            working_bytes: 1024 << 20,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum PaintError {
    Frame(frames::Error),
    Budget { required: u64, limit: u64 },
    Device(String),
    Decode,
    Closed,
}

#[derive(Clone, Debug, PartialEq)]
pub enum PaintStatus {
    Pending,
    Ready,
    Failed(PaintError),
    Closed,
}

// One owning pointer per slot. An exchange transfers exclusive ownership; no
// dereference occurs while a pointer is still published. No ABA/CAS loop.
struct Slot<T>(AtomicPtr<T>);
impl<T> Slot<T> {
    fn new() -> Self {
        Self(AtomicPtr::new(ptr::null_mut()))
    }
    fn replace(&self, value: Option<Box<T>>) -> Option<Box<T>> {
        let old = self.0.swap(
            value.map_or(ptr::null_mut(), Box::into_raw),
            Ordering::AcqRel,
        );
        if old.is_null() {
            None
        } else {
            // SAFETY: swap removed the sole published owner of this allocation.
            Some(unsafe { Box::from_raw(old) })
        }
    }
    fn take(&self) -> Option<Box<T>> {
        self.replace(None)
    }
}
// SAFETY: the slot transfers T, it never provides a shared reference to T.
unsafe impl<T: Send> Send for Slot<T> {}
unsafe impl<T: Send> Sync for Slot<T> {}
impl<T> Drop for Slot<T> {
    fn drop(&mut self) {
        drop(self.take());
    }
}

#[derive(Clone)]
struct Ticket {
    frame: WorkerTicket,
    key: PaintKey,
    navigation: Arc<std::sync::atomic::AtomicU64>,
    serial: u64,
}
impl Ticket {
    fn current(&self) -> bool {
        self.frame.current() && self.navigation.load(Ordering::Acquire) == self.serial
    }
    fn identity(&self) -> (u64, u64, u64, u64) {
        let (document, epoch, stamp) = self.frame.identity();
        (document, epoch, stamp, self.serial)
    }
    fn key(&self) -> &PaintKey {
        &self.key
    }
    fn read(&self) -> Result<Option<WorkerFrame>, frames::Error> {
        self.frame.read()
    }
}

struct Picture {
    ticket: Ticket,
    frame: RenderedFrame,
    paint_ms: f64,
}
struct Delivery {
    ticket: Option<Ticket>,
    picture: Result<Picture, PaintError>,
}
struct Shared {
    request: Slot<Ticket>,
    ready: Slot<Delivery>,
    returned: Slot<Delivery>,
    shutdown_frame: Slot<Delivery>,
    closed: AtomicBool,
    exited: AtomicBool,
    changed: Condvar,
    idle: Mutex<()>,
    wake: frames::Wake,
}
impl Shared {
    // Only the worker waits; the timeout covers notify-before-wait and scheduler
    // progress without adding a callback/lock to every scheduler completion.
    fn wait(&self) {
        if let Ok(guard) = self.idle.lock() {
            drop(self.changed.wait_timeout(guard, Duration::from_millis(4)));
        }
    }
}

pub struct Painter {
    shared: Arc<Shared>,
    shown: Option<Box<Delivery>>,
    requested: Option<(u64, u64, u64, u64)>,
    status: PaintStatus,
}

impl Painter {
    /// Handles must be iced's own device/queue. Creation, decoding and draw
    /// preparation all run through the application's spawner, never here.
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        format: wgpu::TextureFormat,
        spawner: &dyn Spawner,
        clock: Arc<dyn Clock>,
        wake: frames::Wake,
        limits: PaintLimits,
    ) -> Result<Self, SpawnError> {
        let shared = Arc::new(Shared {
            request: Slot::new(),
            ready: Slot::new(),
            returned: Slot::new(),
            shutdown_frame: Slot::new(),
            closed: AtomicBool::new(false),
            exited: AtomicBool::new(false),
            changed: Condvar::new(),
            idle: Mutex::new(()),
            wake,
        });
        let worker = shared.clone();
        let device = device.clone();
        let queue = queue.clone();
        spawner.spawn(
            "styk-stage",
            Box::new(move || run(worker, device, queue, format, clock, limits)),
        )?;
        Ok(Self {
            shared,
            shown: None,
            requested: None,
            status: PaintStatus::Pending,
        })
    }

    /// Replace an unread request with the newest scheduler ticket. Metadata only.
    pub fn request(&mut self, host: &Host) -> Result<(), PaintError> {
        if self.shared.closed.load(Ordering::Acquire) {
            return Err(PaintError::Closed);
        }
        let ticket = host
            .frames()
            .stage_ticket()
            .ok_or(PaintError::Frame(frames::Error::InvalidRequest))?;
        let ticket = Ticket {
            key: PaintKey {
                prepared: ticket.key().clone(),
                view: host
                    .presentation
                    .clone()
                    .ok_or(PaintError::Frame(frames::Error::InvalidRequest))?,
            },
            frame: ticket,
            navigation: host.navigation.clone(),
            serial: host.navigation.load(Ordering::Acquire),
        };
        if self.requested.is_some_and(|id| id.0 != ticket.identity().0) {
            return Err(PaintError::Device(
                "a painter belongs to one document lifetime".into(),
            ));
        }
        if self.requested == Some(ticket.identity()) && !matches!(self.status, PaintStatus::Failed(_)) {
            return Ok(());
        }
        self.requested = Some(ticket.identity());
        self.status = PaintStatus::Pending;
        drop(self.shared.request.replace(Some(Box::new(ticket))));
        self.shared.changed.notify_one();
        Ok(())
    }

    /// At most one handoff per update. Returning the old frame also acknowledges
    /// this delivery: the worker cannot queue another until it consumes it.
    /// Call after the preceding present's encoder has been submitted.
    pub fn update(&mut self) -> PaintStatus {
        if self.shared.closed.load(Ordering::Acquire) {
            return PaintStatus::Closed;
        }
        let Some(mut delivery) = self.shared.ready.take() else {
            return self.status.clone();
        };
        let current = delivery
            .ticket
            .as_ref()
            .is_some_and(|ticket| ticket.current() && self.requested == Some(ticket.identity()));
        if current && delivery.picture.is_ok() {
            let old = self.shown.replace(delivery);
            delivery = old.unwrap_or_else(|| {
                Box::new(Delivery {
                    ticket: None,
                    picture: Err(PaintError::Closed),
                })
            });
            self.status = PaintStatus::Ready;
        } else if let Err(error) = &delivery.picture
            && current
        {
            self.status = PaintStatus::Failed(error.clone());
        }
        // Single producer; one delivery outstanding until this acknowledgement.
        // No previous return can be here: the worker must take it to publish.
        debug_assert!(self.shared.returned.0.load(Ordering::Acquire).is_null());
        drop(self.shared.returned.replace(Some(delivery)));
        self.shared.changed.notify_one();
        self.status.clone()
    }

    /// Three commands to the host's pass; viewport and scissor are the widget's.
    /// Pending frames keep the last complete picture; nothing reads the engine.
    pub fn present(&self, pass: &mut wgpu::RenderPass<'_>) -> bool {
        let Some(picture) = self.shown.as_ref().and_then(|d| d.picture.as_ref().ok()) else {
            return false;
        };
        picture.frame.present(pass);
        true
    }
    pub fn shown_key(&self) -> Option<&PaintKey> {
        self.shown
            .as_ref()
            .and_then(|d| d.picture.as_ref().ok())
            .map(|p| p.ticket.key())
    }
    pub fn paint_ms(&self) -> Option<f64> {
        self.shown
            .as_ref()
            .and_then(|d| d.picture.as_ref().ok())
            .map(|p| p.paint_ms)
    }
    /// Screenshot/test seam. Never map or poll this texture on an interface thread.
    pub fn texture(&self) -> Option<&wgpu::Texture> {
        self.shown
            .as_ref()
            .and_then(|d| d.picture.as_ref().ok())
            .map(|p| p.frame.texture())
    }
    pub fn worker_exited(&self) -> bool {
        self.shared.exited.load(Ordering::Acquire)
    }
    pub fn close(&mut self) {
        if self.shared.closed.load(Ordering::Acquire) {
            return;
        }
        // The worker may own an outstanding return. A separate final slot moves
        // the displayed frame back too, keeping GPU reclamation on the worker.
        if let Some(shown) = self.shown.take() {
            drop(self.shared.shutdown_frame.replace(Some(shown)));
        }
        self.shared.closed.store(true, Ordering::Release);
        self.shared.changed.notify_one();
        self.status = PaintStatus::Closed;
    }
}
impl Drop for Painter {
    fn drop(&mut self) {
        self.close();
    }
}

fn run(
    shared: Arc<Shared>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    format: wgpu::TextureFormat,
    clock: Arc<dyn Clock>,
    limits: PaintLimits,
) {
    let mut renderer = Renderer::new(&device, &queue, format);
    // Exact sizes also make a stage frame independent of prior views, like export.
    renderer.set_exact_sizes(true);
    let mut pictures = pictures::Pictures::default();
    let mut request = None;
    let mut awaiting_ack = false;
    while !shared.closed.load(Ordering::Acquire) {
        if let Some(delivery) = shared.returned.take() {
            if let Ok(picture) = delivery.picture {
                renderer.recycle_frame(picture.frame);
            }
            awaiting_ack = false;
        }
        if let Some(latest) = shared.request.take() {
            request = Some(*latest);
        }
        if awaiting_ack {
            shared.wait();
            continue;
        }
        let Some(ticket) = request.as_ref() else {
            shared.wait();
            continue;
        };
        if !ticket.current() {
            request = None;
            continue;
        }
        let ready = match ticket.read() {
            Ok(Some(ready)) => ready,
            Ok(None) => {
                shared.wait();
                continue;
            }
            Err(error) => {
                publish(&shared, ticket.clone(), Err(PaintError::Frame(error)));
                awaiting_ack = true;
                request = None;
                continue;
            }
        };
        let start = clock.now();
        let mut result = paint(
            &mut renderer,
            &mut pictures,
            &ready,
            ticket,
            limits,
            &shared,
        )
        .map(|frame| Picture {
            ticket: ticket.clone(),
            frame,
            paint_ms: clock.now().saturating_sub(start).as_secs_f64() * 1000.0,
        });
        // An interrupted/refused decode may already have enqueued sprite writes.
        // Flush and complete them too, so failures cannot accumulate staging data.
        if result.is_err() && !shared.closed.load(Ordering::Acquire) {
            renderer.queue().submit([]);
            if let Err(error) = finish_gpu(&renderer, &shared) {
                result = Err(error);
            }
        }
        if ticket.current() && !shared.closed.load(Ordering::Acquire) {
            publish(&shared, ticket.clone(), result);
            awaiting_ack = true;
        }
        request = None;
    }
    // Every close/error/drop path frees the pictures, CPU list and device handles
    // here. There is no join and no destructor of these payloads on the UI path.
    drop(request);
    drop(shared.request.take());
    drop(shared.ready.take());
    drop(shared.returned.take());
    drop(shared.shutdown_frame.take());
    drop(renderer);
    drop(pictures);
    drop(queue);
    drop(device);
    shared.exited.store(true, Ordering::Release);
    (shared.wake)();
}

fn publish(shared: &Shared, ticket: Ticket, picture: Result<Picture, PaintError>) {
    debug_assert!(shared.ready.0.load(Ordering::Acquire).is_null());
    drop(shared.ready.replace(Some(Box::new(Delivery {
        ticket: Some(ticket),
        picture,
    }))));
    (shared.wake)();
}

fn paint(
    renderer: &mut Renderer,
    pictures: &mut pictures::Pictures,
    ready: &WorkerFrame,
    ticket: &Ticket,
    limits: PaintLimits,
    shared: &Shared,
) -> Result<RenderedFrame, PaintError> {
    let input = &ticket.key.view;
    let scene = &ready.key.inputs.scene;
    let bytes = u64::from(input.size[0]) * u64::from(input.size[1]) * 4;
    let required = bytes.saturating_mul(3);
    if required > limits.output_bytes {
        return Err(PaintError::Budget {
            required,
            limit: limits.output_bytes,
        });
    }
    if input
        .size
        .iter()
        .any(|&x| x > renderer.device().limits().max_texture_dimension_2d)
    {
        return Err(PaintError::Device(
            "stage size exceeds the device texture limit".into(),
        ));
    }
    let doc = &ready.generation.prepared.doc;
    let camera = ready.frame.camera.as_ref().filter(|_| scene.camera);
    let upright = styk_eval::view::camera_matrix(doc, camera, input.zoom, input.pan);
    let orient = styk_eval::view::orientation(
        input.rotation,
        input.flip,
        [
            input.pan[0] + doc.canvas[0] as f64 * input.zoom / 2.0,
            input.pan[1] + doc.canvas[1] as f64 * input.zoom / 2.0,
        ],
    );
    let view = ViewParams {
        matrix: orient.map_or(upright, |o| styk_eval::view::compose(o, upright)),
        artboard: [
            input.pan[0],
            input.pan[1],
            input.pan[0] + doc.canvas[0] as f64 * input.zoom,
            input.pan[1] + doc.canvas[1] as f64 * input.zoom,
        ],
        clip_to_artboard: scene.clip_to_canvas,
        clear: [0.0; 4],
        zoom: input.zoom,
        pan: input.pan,
        stretch: 1.0,
        camera_view: camera.is_some(),
        camera_limit: styk_render::CAMERA_PREVIEW_LIMIT,
    };
    renderer.set_orientation(orient);
    renderer.set_multisampled(input.samples == 4);
    let plan = renderer.plan_frame(&ready.frame.list, &view, input.size);
    let required = renderer.working_set_bound(&plan);
    if required > limits.working_bytes {
        return Err(PaintError::Budget {
            required,
            limit: limits.working_bytes,
        });
    }
    pictures.begin();
    loop {
        if !ticket.current() || shared.closed.load(Ordering::Acquire) {
            return Err(PaintError::Closed);
        }
        let complete = pictures.prepare(
            renderer,
            &ready.generation,
            ready.pictures.as_ref(),
            &ready.frame.list,
            PaintLimits {
                working_bytes: limits.working_bytes - required,
                ..limits
            },
        )?;
        if complete {
            break;
        }
        // Bound upload staging while decodes run on the engine's workers. The
        // admitted rendering plan stays owned here throughout resource readiness.
        renderer.queue().submit([]);
        finish_gpu(renderer, shared)?;
        shared.wait();
    }
    if !ticket.current() || shared.closed.load(Ordering::Acquire) {
        return Err(PaintError::Closed);
    }
    renderer.set_list(&ready.frame.list);
    let mut encoder = renderer
        .device()
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("styk stage"),
        });
    renderer.render_planned(&mut encoder, plan);
    renderer.queue().submit([encoder.finish()]);
    // One cached successor, in the scheduler's playback order. Decode workers
    // already run independently. Use only the time this submitted frame needs;
    // speculation must not delay its publication waiting for a future decode.
    if let Some(next_ticket) = ticket.frame.next_playback()
        && let Ok(Some(next)) = next_ticket.read()
    {
        let drawn = Arc::new(AtomicBool::new(false));
        let signal = drawn.clone();
        renderer.queue().on_submitted_work_done(move || { signal.store(true,Ordering::Release); });
        pictures.begin();
        loop {
            if !ticket.current() || shared.closed.load(Ordering::Acquire) { return Err(PaintError::Closed); }
            if !next_ticket.current() { break; }
            let more = matches!(pictures.prefetch(renderer,&next.generation,next.pictures.as_ref(),&ready.frame.list,&next.frame.list,
                PaintLimits { working_bytes:limits.working_bytes-required,..limits }), Ok(false));
            // Budget/decode refusal belongs to that future frame, not this one.
            renderer.queue().submit([]);
            renderer.device().poll(wgpu::PollType::Poll).map_err(|e|PaintError::Device(e.to_string()))?;
            if !more || drawn.load(Ordering::Acquire) { break; }
            shared.wait();
        }
    }
    finish_gpu(renderer, shared)?;
    renderer
        .take_frame()
        .ok_or_else(|| PaintError::Device("renderer produced no frame".into()))
}

fn finish_gpu(renderer: &Renderer, shared: &Shared) -> Result<(), PaintError> {
    let completed = Arc::new(AtomicBool::new(false));
    let done = completed.clone();
    renderer.queue().on_submitted_work_done(move || {
        done.store(true, Ordering::Release);
    });
    // Only this worker services GPU completion. No blocking poll, no growing
    // submission queue, no partial/deadline publication.
    while !completed.load(Ordering::Acquire) {
        if shared.closed.load(Ordering::Acquire) {
            return Err(PaintError::Closed);
        }
        renderer
            .device()
            .poll(wgpu::PollType::Poll)
            .map_err(|e| PaintError::Device(e.to_string()))?;
        if !completed.load(Ordering::Acquire) {
            shared.wait();
        }
    }
    Ok(())
}
