//! The stage surface the widget uses: input policy through `Core::dispatch`, and the render path on a real device
//! (`docs/native/stage.md`, "The stage widget"). The widget itself is `styk-ui`'s; what it would otherwise decide is here.
#[path = "../../styk-platform/src/spawn.rs"]
mod platform_spawn;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use styk_core::app::Core;
use styk_core::commands::Command;
use styk_core::engine::{SceneOptions, wgpu};
use styk_core::screens;
use styk_core::stage::input::{Button, Pointer, PointerPhase};
use styk_core::stage::{Call, Cursor, Event, Gpu, PaintStatus, Place, Surface, SurfaceError, View, Viewport, Wheel, WheelDelta};
use styk_services::input::Modifiers;
use styk_services::{Clock, FixedClock, ManualSpawner, SystemClock};

const FIXTURE: &[u8] = include_bytes!("../../../tests/edit/startup.document.json");

/// A region as large as the canvas and no clearances: the fitted view is the identity.
fn region() -> Viewport {
    Viewport { size: [960.0, 540.0], insets: [0.0; 4], ..Viewport::default() }
}

fn core_with(spawner: Arc<dyn styk_services::Spawner>, clock: Arc<dyn Clock>) -> Core {
    screens::stage_in(spawner, clock, region()).expect("the stage fixture opens")
}

/// A core whose workers never run: input policy needs no frames.
fn quiet() -> (Core, Arc<Surface>, FixedClock) {
    let clock = FixedClock::new();
    let core = core_with(Arc::new(ManualSpawner::default()), Arc::new(clock.clone()));
    let surface = core.stage().expect("the active document has a stage");
    (core, surface, clock)
}

fn view(surface: &Surface) -> View {
    surface.view().expect("the surface is not busy")
}

fn pointer(id: u32, phase: PointerPhase, button: Button, x: f64, y: f64) -> Event {
    Event::Pointer(Pointer { id, phase, point: [x, y], button, modifiers: Modifiers::NONE })
}

fn wheel(delta: WheelDelta, modifiers: Modifiers) -> Event {
    Event::Wheel(Wheel { delta, point: [300.0, 200.0], modifiers })
}

#[test]
fn a_plain_wheel_pans_by_the_browsers_deltas_and_shift_swaps_the_axes() {
    let (mut core, surface, _) = quiet();
    assert_eq!((view(&surface).zoom, view(&surface).pan), (1.0, [0.0, 0.0]));
    // One notch down is a browser deltaY of +100: the view moves up by 100.
    core.dispatch(Command::Stage(wheel(WheelDelta::Lines([0.0, -1.0]), Modifiers::NONE)));
    assert_eq!(view(&surface).pan, [0.0, -100.0]);
    // Pixels pass as they are, in the browser's sign (down is positive there, up is positive in the toolkit).
    core.dispatch(Command::Stage(wheel(WheelDelta::Pixels([-7.0, -3.0]), Modifiers::NONE)));
    assert_eq!(view(&surface).pan, [-7.0, -103.0]);
    // Shift scrolls sideways: the vertical delta moves the view horizontally.
    core.dispatch(Command::Stage(wheel(WheelDelta::Lines([0.0, -1.0]), Modifiers::SHIFT)));
    assert_eq!(view(&surface).pan, [-107.0, -103.0]);
}

#[test]
fn ctrl_or_cmd_wheel_zooms_about_the_pointer_and_the_setting_makes_a_plain_wheel_zoom() {
    let (mut core, surface, _) = quiet();
    let point = [300.0, 200.0];
    let under = |view: &View| [(point[0] - view.pan[0]) / view.zoom, (point[1] - view.pan[1]) / view.zoom];
    let before = under(&view(&surface));
    // A continuous device (a delta under 30 pixels) zooms at once: exp(0.005 per pixel) forward.
    core.dispatch(Command::Stage(wheel(WheelDelta::Pixels([0.0, 19.0]), Modifiers::CTRL)));
    let zoomed = view(&surface);
    assert!((zoomed.zoom - (0.005f64 * 19.0).exp()).abs() < 1e-12, "{}", zoomed.zoom);
    for (a, b) in under(&zoomed).into_iter().zip(before) {
        assert!((a - b).abs() < 1e-9, "the document point under the pointer stays put");
    }
    core.dispatch(Command::Stage(wheel(WheelDelta::Pixels([0.0, -19.0]), Modifiers::META)));
    assert!((view(&surface).zoom - 1.0).abs() < 1e-12, "Cmd zooms too, and the other way");
    // Scroll to zoom: a plain wheel zooms, and Ctrl still does.
    surface.set_gestures(styk_core::stage::Gestures { scroll_zooms: true, ..Default::default() });
    core.dispatch(Command::Stage(wheel(WheelDelta::Pixels([0.0, 19.0]), Modifiers::NONE)));
    assert!(view(&surface).zoom > 1.09 && view(&surface).pan != [0.0, 0.0]);
}

#[test]
fn a_wheel_notch_glides_on_the_application_clock_and_settles_where_a_notch_lands() {
    let (mut core, surface, clock) = quiet();
    core.dispatch(Command::Stage(wheel(WheelDelta::Lines([0.0, 1.0]), Modifiers::CTRL)));
    let first = view(&surface).zoom;
    assert!(first > 1.0 && first < 1.3, "the event itself moves the view one frame's worth: {first}");
    assert!(surface.moving(), "the glide continues");
    // Each redraw sends a tick; the clock is the application's, so a fixed clock makes the glide exact.
    for _ in 0..15 {
        clock.advance(Duration::from_millis(16));
        core.dispatch(Command::Stage(Event::Tick));
    }
    let settled = view(&surface).zoom;
    assert!((settled - (0.3f64).exp()).abs() < 1e-9, "a 100 px notch is about 1.35x: {settled}");
    clock.advance(Duration::from_millis(120));
    core.dispatch(Command::Stage(Event::Tick));
    assert!(!surface.moving(), "the input idle window of 100 ms is over");
    // Reduced motion zooms directly.
    surface.set_gestures(styk_core::stage::Gestures { reduced_motion: true, ..Default::default() });
    core.dispatch(Command::Stage(wheel(WheelDelta::Lines([0.0, -1.0]), Modifiers::CTRL)));
    assert!((view(&surface).zoom - settled * (-0.3f64).exp()).abs() < 1e-9);
}

#[test]
fn middle_space_and_pan_tool_drags_pan_and_other_presses_go_back_to_the_tool_owner() {
    let (mut core, surface, _) = quiet();
    let drag = |core: &mut Core, button| {
        core.dispatch(Command::Stage(pointer(1, PointerPhase::Down, button, 100.0, 100.0)));
        core.dispatch(Command::Stage(pointer(1, PointerPhase::Move, button, 130.0, 90.0)));
        core.dispatch(Command::Stage(pointer(1, PointerPhase::Up, button, 130.0, 90.0)));
    };
    drag(&mut core, Button::Middle);
    assert_eq!(view(&surface).pan, [30.0, -10.0]);
    // A left press is no navigation: it is the tool owner's, and the view stays.
    let outcome = surface.event(pointer(1, PointerPhase::Down, Button::Left, 100.0, 100.0)).unwrap();
    assert_eq!(outcome.routed.len(), 1);
    surface.event(pointer(1, PointerPhase::Up, Button::Left, 100.0, 100.0)).unwrap();
    assert_eq!(view(&surface).pan, [30.0, -10.0]);
    assert_eq!(surface.cursor(), Cursor::Default);
    // Space held: the hand, and a left drag pans.
    core.dispatch(Command::Stage(Event::Space(true)));
    assert_eq!(surface.cursor(), Cursor::Grab);
    drag(&mut core, Button::Left);
    assert_eq!(view(&surface).pan, [60.0, -20.0]);
    core.dispatch(Command::Stage(Event::Space(false)));
    // The Pan tool does the same, and a drag shows the closed hand until it ends or is cancelled by name.
    core.dispatch(Command::Stage(Event::PanTool(true)));
    core.dispatch(Command::Stage(pointer(7, PointerPhase::Down, Button::Left, 10.0, 10.0)));
    assert_eq!(surface.cursor(), Cursor::Grabbing);
    core.dispatch(Command::Stage(pointer(7, PointerPhase::Move, Button::Left, 20.0, 10.0)));
    assert_eq!(view(&surface).pan, [70.0, -20.0]);
    core.dispatch(Command::Stage(pointer(8, PointerPhase::Cancel, Button::Left, 0.0, 0.0)));
    assert_eq!(surface.cursor(), Cursor::Grabbing, "another pointer's cancel does not end it");
    core.dispatch(Command::Stage(pointer(7, PointerPhase::Cancel, Button::Left, 0.0, 0.0)));
    assert_eq!(surface.cursor(), Cursor::Grab);
}

#[test]
fn the_artboard_follows_the_view_and_bad_input_is_refused_without_moving_the_view() {
    let (_, surface, _) = quiet();
    assert_eq!(surface.artboard(), Some([0.0, 0.0, 960.0, 540.0]));
    surface.event(Event::Pan([5.0, 7.0])).unwrap();
    surface.event(Event::Zoom { factor: 2.0, at: [0.0, 0.0] }).unwrap();
    assert_eq!(surface.artboard(), Some([10.0, 14.0, 1920.0, 1080.0]));
    let before = view(&surface);
    assert_eq!(surface.event(Event::Pan([f64::NAN, 0.0])), Err(SurfaceError::Invalid));
    assert_eq!(surface.event(Event::Frame(-1.0)), Err(SurfaceError::Invalid));
    assert_eq!(surface.event(Event::Zoom { factor: f64::NAN, at: [0.0, 0.0] }), Err(SurfaceError::Invalid));
    assert_eq!(view(&surface), before);
    surface.close();
    assert_eq!(surface.event(Event::Pan([1.0, 1.0])), Err(SurfaceError::Unavailable));
    assert_eq!(surface.status(), PaintStatus::Closed);
}

fn gpu() -> styk_render::native_gpu::NativeGpu {
    // Exact frame comparisons use Vulkan: docs/native/frame-parity.md#dx12-msaa-repeatability-driver-floor.
    use styk_render::native_gpu::{Attempt, NativeGpu, open_attempt};
    let attempt = Attempt { name: "Vulkan repeatability test".into(), backends: wgpu::Backends::VULKAN, fxc: false, from_env: false };
    let (instance, adapter, device, queue) = open_attempt(
        &attempt,
        "stage surface test",
        &|a| wgpu::Limits::default().using_resolution(a.limits()),
    )
    .expect("Vulkan required for exact frame comparisons");
    NativeGpu { instance, adapter, device, queue, attempt }
}

fn target(gpu: &styk_render::native_gpu::NativeGpu, size: [u32; 2]) -> wgpu::Texture {
    gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("surface target"),
        size: wgpu::Extent3d { width: size[0], height: size[1], depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    })
}

/// One toolkit frame: `prepare`, then a pass over `target` that `present` records into. Returns whether a picture was drawn.
fn frame(gpu: &styk_render::native_gpu::NativeGpu, surface: &Surface, id: u64, target: &wgpu::Texture, size: [u32; 2]) -> bool {
    surface.prepare(
        Place { origin: [0.0, 0.0], size: size.map(f64::from), dpr: 1.0 },
        Gpu { id, device: &gpu.device, queue: &gpu.queue, format: wgpu::TextureFormat::Rgba8Unorm },
    );
    let view = target.create_view(&Default::default());
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    let drawn = {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: None,
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        surface.present(&mut pass)
    };
    gpu.queue.submit([encoder.finish()]);
    drawn
}

/// Frames until the picture on show answers the newest demand (the worker finishes in its own time).
fn settle(gpu: &styk_render::native_gpu::NativeGpu, surface: &Surface, id: u64, target: &wgpu::Texture, size: [u32; 2]) {
    let clock = SystemClock::new();
    let start = clock.now();
    loop {
        frame(gpu, surface, id, target, size);
        match surface.status() {
            PaintStatus::Ready => return,
            PaintStatus::Failed(error) => panic!("the stage failed: {error:?}"),
            _ => {}
        }
        assert!(clock.now() - start < Duration::from_secs(45), "the stage did not settle");
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// The brief's automated interaction: the script is run step by step through `Core::dispatch`, and the frame it ends on is
/// the one `styk export` draws, byte for byte (the view is back at the identity).
#[test]
fn the_automated_interaction_ends_on_the_frame_export_makes() {
    use styk_core::automation::{Script, Step};
    let gpu = gpu();
    let clock = Arc::new(FixedClock::new());
    let mut core = core_with(Arc::new(platform_spawn::ThreadSpawner), clock.clone());
    core.start_timeline(&platform_spawn::ThreadSpawner, Arc::new(|| {})).unwrap();
    let surface = core.stage().expect("a stage");
    let size = [960, 540];
    let target = target(&gpu, size);
    let script = Script::parse(include_str!("../../../../docs/native/scenarios/stage-interaction.styk-auto")).unwrap();
    let mut shown = 0;
    for (line, step) in &script.steps {
        match step {
            Step::Open(alias) => assert_eq!(alias.to_str(), Some("fixture")),
            step => {
                let event = Event::from_step(step).unwrap_or_else(|| panic!("line {line}: the stage takes this step"));
                core.dispatch(Command::Stage(event));
                if let Step::Frame(tick) = step {
                    let until = std::time::Instant::now() + Duration::from_secs(30);
                    loop {
                        while core.poll_document().is_some() {}
                        core.dispatch(Command::Wake { now: 0 });
                        if core.documents.active().unwrap().view().is_ok_and(|v| v.tick == *tick) { break; }
                        assert!(std::time::Instant::now() < until, "the session seek must land"); std::thread::yield_now();
                    }
                    settle(&gpu, &surface, 1, &target, size);
                    assert_eq!(surface.shown_key().unwrap().prepared.tick, *tick);
                    shown += 1;
                }
            }
        }
    }
    assert_eq!(shown, 2);
    let view = view(&surface);
    assert_eq!((view.zoom, view.pan, view.rotation, view.flip), (1.0, [0.0, 0.0], 0.0, false), "the interaction brought the view back");
    assert_eq!(surface.shown_key().expect("a picture").view.zoom, 1.0);
    // The oracle: the export path's frame of the same document at tick 0.
    let engine = styk_engine::Engine::new(|| 0.0, styk_engine::Budgets::for_device(None));
    engine.open(FIXTURE, "json", "stage surface").unwrap();
    let generation = engine.generation().unwrap();
    let mut builder = styk_engine::frame_builder::FrameBuilder::default();
    let frame_list = builder.prepare(&generation, 0.0, &SceneOptions::default(), || 0.0, || false).unwrap();
    let settings = styk_export::Settings::new(size[0], size[1], styk_export::Smoothing::Edges, styk_export::settings::MAX_PIXELS).unwrap();
    let mut export = styk_export::GpuExport::new(&gpu.device, &gpu.queue, settings, 2048);
    export.prepare_sprites(generation.lineage, &generation.assets);
    let expected = export.frame_blocking(&generation.prepared.doc, &frame_list.list, frame_list.camera.as_ref(), false).unwrap();
    let (_, _, premul) = styk_render::read_frame(&gpu.device, &gpu.queue, &target);
    let mut actual = Vec::new();
    styk_export::pixels::resolve(&premul, size[0] as usize * 4, size, 1, false, &mut actual);
    assert!(actual.chunks_exact(4).any(|p| p[3] > 0 && p[..3] != [0, 0, 0]), "the fixture paints artwork");
    assert_eq!(actual, expected, "the stage's last frame and styk export's must be the same pixels");
    surface.close();
    let start = SystemClock::new();
    let began = start.now();
    while !surface.painter_exited() {
        assert!(start.now() - began < Duration::from_secs(10), "the paint worker did not reclaim its resources");
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn the_render_path_orders_its_calls_never_waits_and_keeps_the_last_picture_while_a_frame_is_pending() {
    let gpu = gpu();
    let mut core = core_with(Arc::new(platform_spawn::ThreadSpawner), Arc::new(FixedClock::new()));
    let surface = core.stage().expect("a stage");
    let size = [960, 540];
    let target = target(&gpu, size);
    // Before any picture: the frame is prepared and drawn, nothing is presented, nothing waited on.
    assert!(!frame(&gpu, &surface, 1, &target, size));
    assert_eq!(surface.status(), PaintStatus::Pending);
    let calls = surface.take_calls();
    let position = |call: Call| calls.iter().position(|c| *c == call).unwrap_or_else(|| panic!("{call:?} in {calls:?}"));
    assert!(position(Call::Observe) < position(Call::Attach), "the place first, then the painter on the toolkit's device");
    assert!(position(Call::Attach) < position(Call::Request), "the painter exists before the demand reaches it");
    assert!(position(Call::Request) < position(Call::Flush) && position(Call::Flush) < position(Call::Update), "scheduler progress, then the painter's newest picture");
    assert!(position(Call::Update) < position(Call::Present), "update after the previous encoder, present into this frame's pass");
    settle(&gpu, &surface, 1, &target, size);
    surface.take_calls();
    assert!(frame(&gpu, &surface, 1, &target, size), "a complete picture is presented");
    let shown = surface.shown_key().expect("a picture on show");
    // A new demand: pending, and the last complete picture is still what the frame presents.
    core.dispatch(Command::Stage(Event::Pan([50.0, 0.0])));
    assert_eq!(surface.status(), PaintStatus::Pending);
    assert_eq!(surface.shown_key().as_ref(), Some(&shown), "a pending demand leaves the picture on show");
    assert_eq!(surface.artboard().map(|a| a[0]), Some(0.0), "the backing stays with the picture on show, not with the newer view");
    let calls = {
        surface.take_calls();
        // Only the demand, then prepare and present in order, however long the worker takes.
        let drawn = frame(&gpu, &surface, 1, &target, size);
        assert!(drawn, "the last complete picture is presented while the new one is pending");
        surface.take_calls()
    };
    let updates = calls.iter().filter(|c| **c == Call::Update).count();
    let presents = calls.iter().filter(|c| **c == Call::Present).count();
    assert_eq!((updates, presents), (1, 1), "one update and one present per frame: {calls:?}");
    // A recreated toolkit context (a new GPU identity) makes a new painter; the old one is closed, never joined here.
    settle(&gpu, &surface, 1, &target, size);
    surface.take_calls();
    frame(&gpu, &surface, 2, &target, size);
    assert!(surface.take_calls().contains(&Call::Attach), "a new context needs a new painter");
    assert_eq!(surface.status(), PaintStatus::Pending);
    settle(&gpu, &surface, 2, &target, size);
    assert_eq!(surface.shown_key().expect("the new painter's picture").view.pan, [50.0, 0.0]);
    assert_eq!(surface.artboard().map(|a| a[0]), Some(50.0), "the backing follows the picture once it lands");
    surface.close();
}

#[test]
fn losing_focus_ends_space_and_drags_so_nothing_navigates_afterwards() {
    let (mut core, surface, _) = quiet();
    // Space held, the window loses focus, Space is released elsewhere: coming back, a left drag is the tool owner's.
    core.dispatch(Command::Stage(Event::Space(true)));
    assert_eq!(surface.cursor(), Cursor::Grab);
    core.dispatch(Command::Stage(Event::Blur));
    assert_eq!(surface.cursor(), Cursor::Default, "the held Space was forgotten");
    let outcome = surface.event(pointer(1, PointerPhase::Down, Button::Left, 100.0, 100.0)).unwrap();
    assert_eq!(outcome.routed.len(), 1, "the press is no pan any more");
    surface.event(pointer(1, PointerPhase::Move, Button::Left, 140.0, 100.0)).unwrap();
    assert_eq!(view(&surface).pan, [0.0, 0.0]);
    // A pan drag in progress ends where it stands, and the Pan tool (a tool, not a key) stays.
    surface.event(Event::PanTool(true)).unwrap();
    surface.event(pointer(2, PointerPhase::Down, Button::Left, 10.0, 10.0)).unwrap();
    surface.event(pointer(2, PointerPhase::Move, Button::Left, 20.0, 10.0)).unwrap();
    assert_eq!(surface.cursor(), Cursor::Grabbing);
    core.dispatch(Command::Stage(Event::Blur));
    assert_eq!(surface.cursor(), Cursor::Grab);
    assert_eq!(view(&surface).pan, [10.0, 0.0], "the drag kept what it had moved");
    surface.event(pointer(2, PointerPhase::Move, Button::Left, 90.0, 10.0)).unwrap();
    assert_eq!(view(&surface).pan, [10.0, 0.0], "later moves of the captured pointer pan nothing");
}

struct Count(AtomicUsize);
impl std::task::Wake for Count {
    fn wake(self: Arc<Self>) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

#[test]
fn queued_pen_samples_wake_the_stage_and_reach_the_host_on_the_next_progress() {
    use styk_services::input::{InputEvent, InputQueue, PenSample, Phase, Tool};
    let (mut core, surface, _) = quiet();
    let queue = InputQueue::new();
    surface.set_input(queue.clone());
    surface.event(Event::PanTool(true)).unwrap();
    let progress = surface.progress();
    let count = Arc::new(Count(AtomicUsize::new(0)));
    let waker = std::task::Waker::from(count.clone());
    assert!(!progress.poll(&waker), "nothing queued, nothing to do");
    let sample = |phase, x, y| {
        let mut sample = PenSample::at(0, 5, Tool::Pen, x, y);
        sample.phase = phase;
        InputEvent::Sample(sample)
    };
    assert!(queue.push(sample(Phase::Down, 100.0, 100.0)));
    assert!(queue.push(sample(Phase::Move, 130.0, 90.0)));
    assert_eq!(count.0.load(Ordering::SeqCst), 1, "the queue woke the stage once, with no other event");
    assert_eq!(view(&surface).pan, [0.0, 0.0], "nothing has reached the host yet");
    assert!(progress.poll(&waker));
    core.dispatch(Command::Stage(Event::Progress));
    assert_eq!(view(&surface).pan, [30.0, -10.0], "the samples reached the host with their provenance");
    core.dispatch(Command::Stage(Event::Progress));
    assert_eq!(view(&surface).pan, [30.0, -10.0], "a drained queue gives nothing twice");
}

/// A spawner that refuses the stage's paint worker while told to, and counts how often it was asked.
struct PaintWorker {
    threads: platform_spawn::ThreadSpawner,
    refuse: std::sync::atomic::AtomicBool,
    asked: AtomicUsize,
}
impl styk_services::Spawner for PaintWorker {
    fn spawn(&self, name: &str, job: styk_services::Job) -> Result<(), styk_services::SpawnError> {
        if name == "styk-stage" {
            self.asked.fetch_add(1, Ordering::SeqCst);
            if self.refuse.load(Ordering::SeqCst) {
                return Err(styk_services::SpawnError("no thread for the paint worker".into()));
            }
        }
        self.threads.spawn(name, job)
    }
}

#[test]
fn a_paint_worker_that_cannot_start_is_reported_and_retried_only_with_a_new_graphics_context() {
    let gpu = gpu();
    let spawner = Arc::new(PaintWorker { threads: platform_spawn::ThreadSpawner, refuse: true.into(), asked: AtomicUsize::new(0) });
    let core = core_with(spawner.clone(), Arc::new(FixedClock::new()));
    let surface = core.stage().expect("a stage");
    let size = [960, 540];
    let target = target(&gpu, size);
    for _ in 0..5 {
        assert!(!frame(&gpu, &surface, 1, &target, size));
    }
    assert_eq!(spawner.asked.load(Ordering::SeqCst), 1, "five frames, one attempt");
    assert!(matches!(surface.status(), PaintStatus::Failed(styk_core::stage::PaintError::Device(message)) if message.contains("did not start")));
    assert_eq!(surface.fault(), Some(styk_core::stage::PaintError::Device("the paint worker did not start: no thread for the paint worker".into())));
    // Input and demands never retry it either.
    surface.event(Event::Pan([3.0, 0.0])).unwrap();
    surface.event(Event::Frame(1.0)).unwrap();
    frame(&gpu, &surface, 1, &target, size);
    assert_eq!(spawner.asked.load(Ordering::SeqCst), 1);
    // A new context is a recovery, and is refused again while the spawner still refuses.
    frame(&gpu, &surface, 2, &target, size);
    assert_eq!(spawner.asked.load(Ordering::SeqCst), 2);
    assert!(surface.fault().is_some());
    // Once the worker can start, the next context recovers: the fault is gone and the picture arrives.
    spawner.refuse.store(false, Ordering::SeqCst);
    frame(&gpu, &surface, 3, &target, size);
    assert_eq!(spawner.asked.load(Ordering::SeqCst), 3);
    assert_eq!(surface.fault(), None);
    settle(&gpu, &surface, 3, &target, size);
    assert_eq!(surface.shown_key().expect("a picture").view.pan, [3.0, 0.0]);
    surface.close();
}

#[test]
fn a_closed_document_takes_its_stage_with_it() {
    use styk_core::documents::{DocumentsError, Effect, HostError, Request};
    let mut core = core_with(Arc::new(platform_spawn::ThreadSpawner), Arc::new(FixedClock::new()));
    let surface = core.stage().expect("a stage");
    let first = core.documents.active().expect("a document").id();
    let clock = SystemClock::new();
    let send = |core: &mut Core, mut request: Request| {
        let start = clock.now();
        loop {
            match core.documents.dispatch(request) {
                Ok(effect) => return effect,
                Err((HostError::Documents(DocumentsError::Busy), returned)) => {
                    assert!(clock.now() - start < Duration::from_secs(5));
                    request = returned;
                    std::thread::yield_now();
                }
                Err((error, _)) => panic!("dispatch: {error}"),
            }
        }
    };
    assert!(matches!(send(&mut core, Request::OpenBytes { bytes: Arc::from(FIXTURE), name: "Second.styk".into() }), Effect::Started(_)));
    let start = clock.now();
    let second = loop {
        match core.documents.poll() {
            Some(Effect::Opened(id)) => break id,
            Some(other) => panic!("unexpected {other:?}"),
            None => {
                assert!(clock.now() - start < Duration::from_secs(20), "the open must finish");
                std::thread::sleep(Duration::from_millis(5));
            }
        }
    };
    core.refresh();
    assert_ne!(surface.status(), PaintStatus::Closed, "its document is open: the stage lives, though it is not the active one");
    assert!(core.stage().is_none(), "the active document has no stage of its own");
    assert!(matches!(send(&mut core, Request::Close(first)), Effect::Closed(id) if id == first));
    core.refresh();
    assert_eq!(surface.status(), PaintStatus::Closed, "the stage went with its document: painter and host are closed");
    assert!(surface.event(Event::Pan([1.0, 1.0])).is_err());
    assert!(core.documents.get(second).is_some());
}

#[test]
fn transport_acknowledges_the_matching_rendered_submission_once_and_rejects_replaced_demands() {
    use styk_core::timeline::transport::Demand;
    let gpu=gpu(); let core=core_with(Arc::new(platform_spawn::ThreadSpawner),Arc::new(FixedClock::new()));
    let surface=core.stage().unwrap(); let size=[960,540]; let output=target(&gpu,size);
    let first=Demand {token:1,tick:0.}; surface.transport_frame(first);
    assert_eq!(surface.take_submission(),None);
    settle(&gpu,&surface,1,&output,size);
    assert_eq!(surface.take_submission(),None,"a newly encoded picture is not an observed submission");
    // Replace before the post-submit observation: the old acknowledgement must never satisfy the new request.
    let second=Demand {token:2,tick:0.}; surface.transport_frame(second);
    frame(&gpu,&surface,1,&output,size); assert_eq!(surface.take_submission(),None);
    settle(&gpu,&surface,1,&output,size);
    frame(&gpu,&surface,1,&output,size); assert_eq!(surface.take_submission(),Some(second));
    assert_eq!(surface.take_submission(),None);
    surface.end_transport(); frame(&gpu,&surface,1,&output,size); assert_eq!(surface.take_submission(),None);
}

#[path = "support/audio.rs"]
mod audio_support;
#[test]
fn audible_playback_starts_only_after_real_picture_submission_and_pause_stops_it() {
    use styk_core::{commands::CommandId, timeline::{Event as Timeline,Payload,transport::State}};
    use styk_services::audio::fake::{FakeOutput,FakeConfig};
    let wav=audio_support::decoded_wav(0.25);
    let audio=styk_doc::json::parse(format!(r#"{{"version":1,"assets":{{"a":{{"id":"a","name":"tone.wav","size":{},"duration":0.25,"chunks":[{{"data_base64":"{}"}}],"peaks":[0.5]}}}},"tracks":[{{"id":"t","name":"Track","gain":1,"mute":false,"solo":false,"clips":[{{"id":"c","assetId":"a","start":0,"offset":0,"duration":0.25,"gain":1,"fadeIn":0,"fadeOut":0}}]}}]}}"#,wav.len(),audio_support::base64(&wav)).as_bytes()).unwrap();
    let mut document=styk_doc::json::parse(FIXTURE).unwrap();let mut styk=document.get("_styk").cloned().unwrap_or_else(|| styk_doc::Value::object(styk_doc::Obj::new()));
    styk.make_obj().unwrap().set("audio",audio);document.make_obj().unwrap().set("_styk",styk);
    let bytes=styk_doc::json::to_string(&document);
    let spawner=Arc::new(platform_spawn::ThreadSpawner);let clock=Arc::new(FixedClock::new());let progress=styk_core::stage::Progress::new();
    let (mut core,publication)=screens::core_with_document(bytes.as_bytes(),"Audio.styk",spawner.clone(),progress.wake()).unwrap();
    let doc=core.documents.active().unwrap();let id=doc.id();
    let source:Arc<dyn styk_core::frames::FrameDocument>=publication;
    let frames=styk_core::frames::Frames::new(doc.lineage(),doc.revision(),0,&source,Default::default(),spawner.as_ref(),clock.clone(),progress.wake()).unwrap();
    let host=styk_core::stage::Host::new(frames,[960,540],region()).unwrap();
    let surface=Arc::new(Surface::new(host,spawner.clone(),clock,progress.clone(),Default::default()));core.set_stage(id,surface.clone());
    core.start_timeline(spawner.as_ref(),progress.wake()).unwrap();
    let until=std::time::Instant::now()+Duration::from_secs(30);
    while core.timeline().model().pending {core.refresh();assert!(std::time::Instant::now()<until);std::thread::yield_now();}
    let (output,fake)=FakeOutput::new(FakeConfig::default(),false);
    let audio=styk_core::audio::AudioTransport::new_notifying(spawner,Box::new(output),fake.host_clock(),audio_support::TestDecoder::new(audio_support::Behavior::Silence),styk_core::audio::CACHE_BYTES,progress.wake()).unwrap();
    core.set_audio(Ok(audio));
    core.dispatch(Command::Settings(styk_core::settings::Event::Set { id: styk_core::settings::SettingId::FitViewOnPlayback, value: styk_doc::Value::Bool(false), now: 0 }));
    surface.event(Event::Pan([73.,29.])).unwrap();
    let manual_view = surface.view();
    core.dispatch(Command::Timeline(Timeline::Action {id:CommandId::Play,payload:Payload::None,now:0}));
    assert_eq!(surface.view(),manual_view,"disabled fit preserves the user's view at playback start");
    assert_eq!(fake.starts(),0,"preparing a plan cannot start sound before a picture is submitted");
    let gpu=gpu();let size=[960,540];let output=target(&gpu,size);
    let until=std::time::Instant::now()+Duration::from_secs(30);
    while core.timeline().model().transport.state!=State::Playing {
        while core.poll_document().is_some() {}
        core.dispatch(Command::Wake {now:0});
        frame(&gpu,&surface,1,&output,size);
        assert!(std::time::Instant::now()<until,"prepared audio and a real submitted picture must start playback");std::thread::yield_now();
    }
    fake.advance_ms(1);assert_eq!(fake.starts(),1,"the first actual picture starts the S4 output once");
    core.dispatch(Command::Timeline(Timeline::Action {id:CommandId::Play,payload:Payload::None,now:1}));
    fake.advance_ms(1);assert_eq!(core.timeline().model().transport.state,State::Paused);
    assert_eq!(core.timeline().deadline(),None);
    core.dispatch(Command::Settings(styk_core::settings::Event::Set { id: styk_core::settings::SettingId::FitViewOnPlayback, value: styk_doc::Value::Bool(true), now: 2 }));
    core.dispatch(Command::Timeline(Timeline::Action {id:CommandId::Play,payload:Payload::None,now:2}));
    assert_ne!(surface.view(),manual_view,"enabled fit uses the existing stage navigation owner");
    core.dispatch(Command::Timeline(Timeline::Action {id:CommandId::Play,payload:Payload::None,now:3}));
    let until=std::time::Instant::now()+Duration::from_secs(30);
    while core.timeline().model().pending { while core.poll_document().is_some() {} core.dispatch(Command::Wake {now:3}); assert!(std::time::Instant::now()<until); std::thread::yield_now(); }
    // A real preparation refusal is an error, not a silent completed audio plan.
    let (output,refused)=FakeOutput::new(FakeConfig::default(),false);
    let limited=styk_core::audio::AudioTransport::new_notifying(Arc::new(platform_spawn::ThreadSpawner),Box::new(output),refused.host_clock(),audio_support::TestDecoder::new(audio_support::Behavior::Silence),0,progress.wake()).unwrap();
    core.set_audio(Ok(limited));
    core.dispatch(Command::Timeline(Timeline::Action {id:CommandId::Play,payload:Payload::None,now:4}));
    let until=std::time::Instant::now()+Duration::from_secs(30);
    loop {
        while core.poll_document().is_some() {}
        let effects=core.dispatch(Command::Wake {now:4});
        if effects.iter().any(|effect|matches!(effect,styk_core::commands::Effect::Notice(notice) if notice.message.key.starts_with("native.timeline.audio"))) { break; }
        assert!(std::time::Instant::now()<until,"preparation refusal reaches the Core caller"); std::thread::yield_now();
    }
    assert_eq!(core.timeline().model().transport.state,State::Paused,"failed preparation pauses as today's app does");
    assert_eq!(refused.starts(),0); assert_eq!(core.timeline().deadline(),None);
}
