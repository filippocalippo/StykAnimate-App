# Pen and tablet input

How the native app reads a pen, a tablet, a touch screen and a mouse, turns them into strokes on the engine's brush, and
puts the ink on the screen. This is the design of spike S1 as corrected by its independent review (every finding
accepted); the spike's code follows it and its numbers are recorded in [input-results.md](input-results.md).

Owners: `styk-services::input` (plain types, the queue, a fake source, the script replayer), `styk-platform::windows::input`
(the `WM_POINTER` source and the injection helper), `styk-core::drawing` (`stroke_input`: today's rules; `worker`: the
drawing worker thread), `styk-ui::ink_pad` (the drawing surface widget with wet ink), `styk-devtools::pen_lab` (the test
surface, later the developer tools' Input panel).

## 1. What today's app does (the behaviour to keep)

All of it is in `src/drawing-controller.mjs`, `src/pen-input.mjs`, `src/drawing-wet-ink.mjs` and the Rust `styk-drawing`
brush; `docs/DRAWING.md`, `docs/TOUCH.md` and `docs/engine/drawing.md` are the contracts.

- **Samples.** Pointer events on the overlay, with `getCoalescedEvents()` (history), `pointerrawupdate` where it exists, and
  the timestamp as the de-duplication key: a sample whose `timeStamp <= lastTime` is skipped. Predicted events feed only
  the wet ink, never the brush or the document.
- **Per sample.** `pressure = pen ? (pressure || .05) : 1`. Tilt is a screen-space lean: the point
  `(x + sin(tiltX)*16, y + sin(tiltY)*16)` mapped through the view and the cel pose, then `(ax, ay)` is the unit vector from
  the mapped position to the mapped lean (zero when shorter than 1e-9), used by `angleMode: tilt` tips. The eraser end is
  `tool == eraser || button == 5 || buttons & 32`. A right press (barrel) with a paint tool and no gesture opens the
  palette at the pointer instead of drawing. A middle press, Space or the pan tool pan. At most 65 536 samples queue per
  stroke; one more is an error.
- **Modifiers at press.** Alt samples a colour, Ctrl or Meta resizes the brush, Shift continues the stroke from the
  previous stroke's end point on the same cel.
- **Gestures.** Tap slop: pen 5 px, touch 10 px (`dragSlop`). Windows turns a stationary pen press into a right click
  (press and hold); the editor ignores that menu while the tip is down and for 700 ms after lift. A touch is ignored while a
  pen is down or within 700 ms of the last pen event (palm rejection); a finger draws only by the setting.
- **Interruption.** A pointer that is interrupted (`pointercancel`, `lostpointercapture`, the window losing focus) ends
  the stroke and keeps the ink; only Escape discards.
- **Pressure and smoothing** are the Rust brush's: the curve (a 257-entry table), `dabRadius`, the stabiliser, dab spacing.
  The native app calls the same `BrushStroke`.
- **Wet ink.** A canvas between the scene and the overlay shows the dabs the worker has not yet returned, the raw pointer
  (only without stabilisation) and the newest predicted point. Eligible only for normal blend, round tip, no alpha lock, no
  selection, `flow >= .5`, `hardness >= .5`, `roundness >= .9`, `scatter <= .2`. It leaves one frame after the stage
  presents the tiles that replace it, or at age 30 frames. It never reaches the document, history or exports.
- **Dab batching.** One batch outstanding; a batch is at most `max(512, min(8192, floor(262144 / (2.2*r*2+2)^2)))` dabs;
  the dabs are generated on the interface thread (a defect the native design removes), rasterised in a worker, tiles come
  back.
- **Not certified today** (`docs/DRAWING.md`): physical drivers, input to photon, every GPU.

## 2. What the toolkit and the platform give (checked against the vendored sources)

- winit (the vendored fork) delivers a pen as `WindowEvent::Touch` with `force` only: no tilt, barrel, eraser, pointer
  kind, timestamp or history to the application. Its `WM_POINTER` handler returns 0 and never calls `DefWindowProc`, so
  a pen produces no mouse events through winit. iced converts `Touch` to finger events and drops `force`.
- iced applies a batch of events per event-loop turn and draws after; its events carry no time and no device. The shader
  widget receives events and runs `prepare`/`render` inside the renderer's pass on iced's wgpu device. The compositor
  uses a flip-discard swap chain with a maximum frame latency of 1 and `Fifo` unless `ICED_PRESENT_MODE` says otherwise.
- Windows reports, for a pen, through `GetPointerPenInfoHistory`: pressure 0..1024, tilt −90..90, rotation, `penFlags`
  (barrel, inverted, eraser), `PerformanceCount` (QPC), the history of the samples since the last message, and the contact
  and range flags. `DefWindowProc` of a pointer message promotes it to mouse messages whose `GetMessageExtraInfo()` carries
  the signature `0xFF515700` (bit `0x80` set for touch).
- There is no wgpu present-timing API; the time a frame reaches the screen cannot be read from wgpu.

## 3. The native design

### 3.1 One sample type, one queue, one provenance

`styk_services::input` holds plain data:

- `PenSample { time_ns, pointer, tool (Pen, Eraser, Mouse, Touch), x, y (window client physical px, sub-pixel),
  pressure (0..1), raw_pressure, pressure_max, tilt_x, tilt_y, twist, valid (which of pressure, tilt, twist the device
  reported), buttons (tip, barrel, eraser), phase (Hover, Down, Move, Up), flags (history entry, predicted), modifiers }`.
- `InputEvent`: `Sample(PenSample)`, `Interrupted { pointer, time_ns, reason: CaptureLost | Canceled | FocusLost }`,
  `Overflowed { dropped }`. Capture loss and cancel are events of their own; they never depend on a sample being
  present in the history.
- **Modifiers travel with the event.** The source reads Shift, Ctrl, Alt and Meta when it builds the sample, on the thread
  and in the order of the messages, so a modifier released before the batch is drained is still what the press saw.
- **Provenance, not timing.** Every sample names its `tool` as the operating system reported it (`Pen`, `Eraser`, `Touch`,
  `Mouse`), and a mouse message that Windows promoted from a pen is never a stroke source: the source classifies each mouse
  message by its extra-info signature and emits samples only for real mice. The stage draws only from `InputEvent`s; it never uses iced's mouse
  events for a stroke. Windows still sends the promoted mouse messages on to iced, so hover and buttons work for a pen,
  and a short pen tap cannot also start a mouse stroke however the event-loop turn batches them.
- **The queue.** `InputQueue` is bounded (4096 events, plus 64 reserved for terminals). When it is full: a `Hover` sample
  is dropped (oldest hover first); a `Move` is dropped and counted; the first drop since the last drain queues one
  `Overflowed` event; a terminal event (pen up, `Interrupted`, mouse up, touch up) is always accepted, evicting the oldest
  queued hover or move if it must. A `Down` that finds the queue full is refused with the rest of its stroke, which is
  cheaper and more honest than a stroke with a hole in it. The consumer treats `Overflowed` as an interruption: the stroke
  in progress ends and keeps its ink, the lab shows the drop count in red, and the next press starts a clean stroke.
- **The source trait.** `InputSource { caps(), attach(window, sink), detach() }` with `Windows (WM_POINTER)`, `WinTab`
  (later), the fake source and the script replayer behind it. `InputCaps` states whether a source has tilt, rotation,
  eraser, barrel, hover, the pressure range and its name; a source without pressure is a capability, not a failure.

### 3.2 The Windows source

`styk_platform::windows::input` installs a window subclass (comctl32 `SetWindowSubclass`) on the main window's HWND. The
subclass runs on the interface thread, before winit's procedure, and does the following.

- `WM_POINTERDOWN/UPDATE/UP/ENTER/LEAVE` with `pointerType == PT_PEN`: reads the whole history with
  `GetPointerPenInfoHistory`, oldest entry first, builds one sample per entry (position from `ptHimetricLocation` through
  `GetPointerDeviceRects`, kept sub-pixel, then to client coordinates; `PerformanceCount` converted to nanoseconds; tilt
  and pressure only where `penMask` says valid; entries but the newest carry the history flag), pushes them to the queue
  and wakes iced. It then calls `DefWindowProc` itself, not winit: that is what makes Windows promote the pen to mouse
  messages for iced's hover and buttons. The pointer is not forwarded to winit, which would swallow the promotion.
- `PT_TOUCH` goes to winit unchanged for iced's touch handling, and also becomes a `Touch` sample for palm rejection and
  finger drawing. `PT_MOUSE` pointer messages are not requested (`EnableMouseInPointer` stays off); real mouse messages
  (`WM_LBUTTONDOWN`, `WM_MOUSEMOVE` with a button, `WM_LBUTTONUP`, extra-info signature absent) become `Mouse` samples
  and pass on to winit.
- `WM_POINTERCAPTURECHANGED`, `POINTER_FLAG_CANCELED`, `WM_CANCELMODE`, `WM_KILLFOCUS` and `WM_ACTIVATE(inactive)` become
  `Interrupted` events with the pointer id and a reason.
- Press-and-hold, flicks and the pen tap feedback are switched off for the window with the tablet-service window property,
  so Windows does not turn a held tip into a right click at all.
- A history entry whose QPC is 0 is stamped with the time of the message. Pressure is `raw / 1024` for `penMask` pressure,
  tilt is the reported degrees, and the pointer id is the OS pointer id.
- Time is QPC. `QpcClock` implements `styk_services::Clock` and stamps the sample queue; the input thread and the stroke
  worker use the same clock.

Fallbacks that stay native (decided by measurement, not built here): patching the vendored winit's `WM_POINTER` branch to
carry the full sample, a WinTab source for drivers that clamp pressure or lack an eraser (`wintab32.dll` loaded at
runtime; packets read after a wake from the driver's message notification, not from a redraw that an idle window never
produces; selected by an explicit capability or a setting, never by `pressure_max <= 1`), and patching the vendored
`iced_wgpu` to change the present mode at runtime. `EnableMouseInPointer` and `RegisterPointerInputTarget` are not
fallbacks: the first does not provide pen history, the second needs UIAccess and redirects globally.

macOS, Linux (design only). macOS: a `NSView` tablet-event hook (the fork does not expose one) producing the same
`PenSample` (`pressure`, `tilt`, `rotation`, `pointingDeviceType` for the eraser, `buttonMask`, proximity, `timestamp`;
mouse-class tablet events with coalescing off). Wayland: `zwp_tablet_v2` must be bound on winit's own connection and seat
(tablet focus is per `wl_surface` of that connection), so it goes into the vendored winit's Wayland backend, with the `frame`
event ending a batch. X11: XInput2 valuators on the window, the eraser as its own slave device. Each arrives with a fake
injected test and one manual device pass.

### 3.3 Strokes from samples (`styk-core::drawing`)

`StrokeInput` is a plain state machine over `InputEvent`s and the stage's mapping; it contains today's rules and nothing
else:

- de-duplication by `(pointer, time)` (`time <= last` is skipped), the `.05` pressure floor for a pen, pressure 1 for a
  mouse, a pen without pressure reports 0.5 in contact as the browser does;
- tilt lean through the mapping to `(ax, ay)`; eraser by tool or the inverted/eraser bits; barrel press in hover or at
  contact with no gesture raises `Action::OpenPalette` instead of a stroke; Space, middle press and the pan tool come from
  the caller's tool state;
- palm rejection (a touch is ignored while a pen is down or within 700 ms of the last pen event; a touch before any pen
  draws only if the finger-draw setting says so); tap slop (pen 5, touch 10);
- modifiers from the press: Alt colour pick, Ctrl or Meta resize, Shift continue-from-end;
- the 65 536-sample bound per stroke;
- `Interrupted` and `Overflowed` finish the stroke and keep the ink; `discard()` (Escape) cancels it and restores the cel.

Output is a list of `StrokeCommand`s (`Begin`, `Sample`, `End`, `Cancel`, `Action`); `Sample` carries the world-space
position, the lean vector (screen-space, mapped by the worker per mirror and per cel pose), pressure and time in
milliseconds.

### 3.4 Dab generation and rasterisation on the drawing worker

`BrushStroke::sample` generates every dab between two samples with no yield; one long gap with a fine brush can run for a
long time. It therefore never runs on the interface thread. The **drawing worker** is a thread owning, per stroke: one
`BrushStroke` per mirror (seeds `seed + index * 7919` as today), the engine's `StrokeEngine` and the cel's `TileStore`.
The interface thread sends `StrokeCommand`s over a bounded channel (the 65 536-sample bound is the bound) and never waits;
the worker generates dabs, seeds the tiles the dabs can reach from the cel, calls `StrokeEngine::dabs`, and posts
`WorkerReply::Tiles { stroke, seq, tiles, dirty }` (one batch outstanding, as today) and `Finished { changes }` or
`Cancelled`. The reply queue is drained in the stage's `update` and in `prepare` without blocking. Cancelling a stroke
wakes the worker (the channel receive is the only wait) and a stale reply (older `seq`, cancelled stroke, a later revision)
is dropped by sequence.

### 3.5 Tiles and wet ink on the GPU (`styk-ui::ink_pad`)

The pad is an iced `shader` widget on iced's device. Its primitive's `prepare` takes the worker's replies and uploads the
dirty tiles with `queue.write_texture` into a tile atlas texture (one 64×64 region per tile, sparse, bounded in bytes), in
the same frame; `render` draws the cel's tiles and then the **wet ink** in the same render pass: capsule instances for the
dabs the worker has not yet returned (those sent but not yet in an uploaded tile) joined by the raw pointer and the
predicted point, with today's eligibility rules and today's merge rule (points closer than 1 CSS px). There is no
desynchronised canvas and no second surface.

**Retirement is tied to the real asynchronous tile path, by sequence.** Every dab carries the batch sequence it was sent in.
A wet segment retires in the frame whose `prepare` uploaded the tile batch with a sequence at least its own, and only
then, so the exact pixels are in the same frame as the last preview of them; a segment older than 30 frames retires too
(today's rule). Cancelled strokes retire all their ink. Delayed replies, partial uploads (the per-frame upload budget
splits a batch) and stale replies are tested, and a rendered check looks for gaps (a dab that is in neither a tile nor the
wet layer) and double-painted segments (a dab in both, visible as a darker overlap for a translucent brush).

Prediction is our own: the newest two samples extrapolated by `min(1.5 * mean period, 8 ms)`, clamped to 24 px, flagged
predicted, dropped at pen up; it feeds the wet ink only. It can be switched off (the wet ink then ends at the newest raw
sample).

### 3.6 The pen lab

`styk-devtools::pen_lab` (feature `devtools`, `stykanimate --pen-lab`) is a window with the pad on the real path (source →
queue → `StrokeInput` → worker → tiles and wet ink) and a live inspector: pressure, tilt, twist, buttons, tool,
timestamps and gaps, history counts, queue depth, drops, the worker's queue and last batch time, wet and tile counts,
frame times. Controls: brush size and hardness, pressure curve preset, stabilisation, prediction on and off, wet ink on and
off, clear, undo, redo, and the recorder (`samples.csv`, `frames.csv`). It becomes the developer tools' Input panel.

## 4. Acceptance criteria (as corrected by the review)

Each is tested by an injected synthetic pen (`CreateSyntheticPointerDevice` / `InjectSyntheticPointerInput`, `xtask`'s
`pen-inject` and the lab's self-test) at 240 Hz with scripted pressure ramps, tilt sweeps, an eraser half and a barrel
pulse, or by the fake source in plain Rust tests where the criterion is about logic. Every latency number is printed with
the display's refresh rate and the present mode.

- **A1 Fields.** 100 % of delivered samples carry `Eraser` exactly in the eraser half and the barrel bit exactly in the
  barrel pulse; `|tilt − injected| <= 1°`; `|pressure − injected / 1024| <= 1/1024`.
- **A2 Rate and history.** 240 Hz for 5 s delivers 1200 ± 2 samples with no duplicate `(pointer, time)`, a median delta of
  4.17 ± 0.3 ms; with the interface thread blocked for 50 ms twenty times, every sample still arrives, those recovered from
  history flagged, in monotonic order.
- **A3 Parity with today's app.** The *same original event script* is run into today's app (Playwright from
  `node_modules`, `STYK_BACKGROUND_WINDOW=1`, pointer events through CDP) and into the native path. Compared, each against
  an **old-versus-old baseline** (today's app run twice on the same script; only fields that differ there may differ
  natively): the stroke's cel pixels, then after undo, after redo, after save and reopen; strokes on a transformed cel
  (moved, scaled, rotated, mirrored); an interrupted stroke (capture lost) that keeps its ink; Escape discarding.
  Per-sample pressure after the same curve and per-sample dab radius agree within `1/1024` and `0.01 px`. Position
  agrees within 0.5 physical px (the rounding policy is recorded, not tuned).
- **A4 Latency, reported not gated on one number.** Input (injection QPC) to the frame's `prepare` (the nearest point to
  `queue.submit` that is observable), for the wet ink and for the exact tile pixels separately, p50 / p95 / p99 / max in
  frame periods. The browser row uses the same stroke script, the same CDP injection path and observation endpoints
  (preview canvas and exact scene) in `tests/drawing-latency.browser.mjs`'s style. Display latency (DWM vblank) is **not**
  a gate: nothing ties a vblank to the frame that held a sample, and the null-HWND form of `DwmGetCompositionTimingInfo` is
  recorded only as context.
- **A5 No blocking (D7).** While injecting, the longest interface-thread slice (event handling, `update`, `view`,
  `prepare`) is measured with the worst inputs: a large coordinate gap with a fine brush, deep zoom, mirrored strokes,
  all of which run on the worker; the slice stays under 4 ms and no frame is skipped except at the forced 50 ms block.
- **A6 Stroke logic.** `StrokeInput` against the frozen `styk-drawing` stroke fixtures is not enough (the same code both
  sides): the logic tests state each rule (dedup, pressure floor, lean, eraser, barrel, palm, slop, queue bound, modifiers
  released before the drain, interrupt versus discard) and A3 provides the independent comparison.
- **A7 Behaviour.** A pen hovering over an iced button moves its hover state (the promotion works); a barrel press raises
  the palette action; a stationary 1.5 s press raises no context-menu event; a touch within 700 ms of a pen is ignored; a
  short pen tap never also starts a mouse stroke, and a real mouse used while the pen is down is not lost or doubled.
- **A8 Queue.** Saturation (no drain for the whole queue plus more), then release, then a new stroke: terminal events
  survive, `Overflowed` is queued once, the stroke ends and keeps its ink, and the next stroke is whole.
- **A9 Retirement.** Delayed worker replies, partial uploads, cancellation and stale replies leave no gap and no
  double-painted segment.
- **A10 Hardware.** If a tablet is attached, a second pass with the same recorder; otherwise reported as not run.

## 5. Out of scope here

The pressure-curve editor, the Draw workspace, macOS and Linux sources (designed above), WinTab (designed above).
