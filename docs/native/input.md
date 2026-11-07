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
- **The queue.** `InputQueue` holds at most 4096 events plus a reserve of 64, and never more. It keeps the gestures it has
  admitted: a press is admitted only if there is room and fewer than 63 gestures are open, and from then on the reserve
  holds exactly one end (a lift or an interrupt) for it, so an end always fits and nothing is ever evicted to make room. An
  end for a gesture that was never admitted is redundant and only counted. A press on a pointer whose gesture is still open is
  ignored (`ignored` in the stats), as today's controller ignores a second `pointerdown` while a gesture is open: it queues no
  notice and refuses nothing. When the queue is full a `Hover` sample is dropped
  (the oldest hover makes room for a new one), a `Move` is dropped and counted, a press is refused with the rest of its
  stroke (cheaper and more honest than a stroke with a hole in it), and the first loss since the last drain queues one
  `Overflowed` event. The consumer treats `Overflowed` as an interruption: the stroke in progress ends and keeps its ink, the
  lab shows the counts, and the next press starts a clean stroke.
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
- Times of history entries are made by `styk_services::input::HistoryClock`, one per pointer. **Identity** is the system's own stamp
  and what the entry says, never a time this clock made: entries come oldest first and time only moves forward, so an entry
  older than the newest one delivered is a replay and is rejected (not re-timed), and one as new as the newest is delivered
  unless the same content was (two entries of one millisecond are both kept). Only the entries of the newest stamp are remembered,
  so a history of any length, and a repeat that arrives after the mapping below was fixed again, are recognised. **Time**: an
  entry with a QPC keeps it; one with only the millisecond stamp (`dwTime`, wrapping at 2^32) is placed by a mapping fixed once
  for the pointer (the first message's newest entry is the moment it arrived, every other entry is that moment plus its distance
  in milliseconds); entries of one millisecond get distinct increasing times. The mapping is fixed again only if it drifts a
  quarter of a second from the arrival times. Pressure is `raw / 1024` for `penMask` pressure,
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

`BrushStroke::sample` generates every dab between two samples; one long gap with a fine brush is a long stretch of work. It
therefore never runs on the interface thread. The **drawing worker** is a thread owning, per stroke: one `BrushStroke` per
mirror (seeds `seed + index * 7919` as today), the engine's `StrokeEngine` and the cel's `TileStore`. The interface thread sends
`StrokeCommand`s and never waits.

- **Generation streams through bounded buffers.** The brush hands each dab to the worker as it makes it (it keeps no list of
  its points or dabs; the curve is cut into pieces as it goes). The worker gathers the dabs into a batch (the controller's dab
  limit, and at most 64 touched tiles unless one dab alone covers more) and rasterises the batch before the brush makes more.
  A 200,000 px gap holds one batch of dabs, not 800,000. Gathering is also the gate: past 4 unacknowledged batches the worker
  waits, inside the brush's own call, until the consumer catches up or the stroke is cancelled.
- **Bounded transfers.** A batch's tiles are sent in parts of at most 64 tiles (`Tiles { seq, part, last }`), the provisional
  tail of the stroke and a single huge dab included. The worker rasterises at most 4 batches ahead of what the consumer has
  acknowledged, and the acknowledgement is a **contiguous frontier**: acknowledging batch 4 first (a cancelled stroke does) frees
  nothing until 1 to 3 are acknowledged too. Undo, redo, clear and a cancelled stroke answer with tile *coordinates* and a stamp;
  the consumer asks for the pixels of the ones it shows, 64 at a time (`Request::Fetch`).
- **Every queue is bounded.** Samples past 131,072 waiting are refused (the stroke ends); at most 16 strokes are open at once
  (a press past that is refused and counted); a stroke ends once (a second end, and an end or a cancel for a stroke never
  admitted, are dropped where they are made); other requests past 1,024 waiting are refused. A stroke's working memory in the
  engine is capped (512 MiB, which a brush's own `workingBytes` may only lower); past it the stroke fails visibly.
- **Cancellation is by stroke, and by name.** Each stroke has its own abort flag, raised by its `Cancel` the moment the command
  is sent and by shutdown; the brush's loops read it (every curve step and every 4096 dabs), as do the batch loop and the gate. A
  cancel for an id that is not the open stroke changes nothing, and never touches another stroke's queued work.
- **Versions.** Every tile the worker reports carries a stamp that only grows: a stroke batch's, or the one an undo, redo, clear,
  cancel, failure or commit gave it. A fetch answers with the tile as the cel will hold it once the open stroke is kept (the
  stroke's own pixels where it touched the tile), its stamp, and `upto`, the newest batch rasterised when it was made, so a view
  that moves over ink drawn out of sight shows it.
- **A history change during an open stroke cancels the stroke first**, as today's controller does (`drawing-controller.mjs`: a
  `history` change cancels the gesture): the stroke was rasterised over pixels the undo, redo or clear is about to replace, and
  ending it afterwards would bring the undone ink back. The cancel is announced (`Cancelled`, with its stamp) before the change.
- **A failed stroke is restored like a cancelled one.** `Failed` names the tiles the stroke had reached and a stamp; batches of it
  may already be in the view, and the consumer fetches the cel's own pixels back. A press that fails to begin is forgotten, so it
  does not hold one of the 16 places.
- **History the worker refuses is kept.** `HistoryOutbox` keeps an undo, redo or clear the worker refused (its request queue is
  full) and sends it, in order, first thing in the next `prepare`; one that does not fit the outbox (64) is counted and shown in
  the inspector. A fetch the worker refused is given back, so its tiles are asked for again.
- **Shutdown never joins.** Dropping the handle raises every abort flag, wakes the gate and the channel and returns; the
  thread ends by itself, within a curve step of the call it was in.
- **Generation time** is the time spent inside the brush's calls, less the time spent rasterising within them, reported with each
  batch.

### 3.5 Tiles and wet ink on the GPU (`styk-ui::ink_pad`)

The pad is an iced `shader` widget on iced's device. Its primitive's `prepare` is budgeted as a whole (3 ms of the pad's own
work; the time inside the graphics API's queue calls is measured apart): it takes the worker's replies one at a time, writes
tiles a few at a time, asks for what the view needs, and builds the preview from a ledger capped at 32,768 dabs. `render`
draws the cel's tiles and then the **wet ink** in the same render pass: instances for the dabs the worker has not yet returned
joined by the raw pointer and the predicted point of the stroke being drawn (and only of a stroke that may be previewed: its
eligibility was decided when it began, from its own tool), with today's eligibility rules. There is no desynchronised canvas and
no second surface. A uniform block that did not change is not written again.

**Residency (`styk_core::drawing::tile_sync`)** follows today's model (`src/drawing-resources.mjs` `reserve`): the tiles the view shows and
the batch being staged are the *required set*; the atlas holds it above its soft budget by growing and refuses visibly above the
hard budget. The atlas is a texture array of pages of 2048 tiles (32 MiB a page); the first page is the soft budget and it grows
a page at a time (the texture is copied into a larger one) up to 4 pages (128 MiB, 8192 tiles). A tile the view shows is never
evicted, nothing is written in place over a tile the view shows, and there is no "declined" state to outlive its cause.

- *No gate on replies.* Every reply is taken as it comes: what waits is bounded by the worker's 4-batch window, and a cancel or an
  undo is never held behind tile data (a full queue used to hide the very reply that would have emptied it).
- *Hidden tiles are dropped on arrival.* A batch keeps only the tiles the view shows or that are already resident; a tile that
  scrolls into view later is fetched from the worker, which answers from the open stroke.
- *Atomic within a budget.* A stroke batch appears all at once, so the atlas never shows part of a batch while the preview still
  shows all of it. Its tiles are written into **new** slots, a few a call within the frame's 96 tiles and time (every call places
  at least one), and the batch is flipped into the view in the call that writes its last tile; a tile it replaces keeps showing
  its old pixels until then. The tiles of a staged batch are protected from eviction.
- *Slots.* A tile needs a slot when it is shown and not resident: a free one, else the one of the least recently used tile out of
  view (and not in the staged batch), else a new page. Above the hard budget the tile is refused: counted (`refused`), reported in
  the inspector as "drawing memory is full", and not asked for again until a slot is freed or the view changes. The batch is
  acknowledged all the same, so the worker never waits on a full atlas.
- *Versions by order.* The worker answers in order and numbers what it changes, so everything queued here is older than the reply
  being accepted: an undo, redo, clear, cancel, failure or fetched tile removes its tiles from every queued and half-written
  batch. A late batch can never cover newer pixels and a changed tile is always fetched again.
- *A fetched tile of the open stroke waits for its batches.* It holds the ink of every batch up to `upto`, whose preview is still
  shown until those batches are in the view; it is installed in the frame the last of them is, so the preview is never painted
  over it. Today's controller overlaps the preview and the tiles for one presented frame on purpose; here the preview leaves in
  the frame its tiles arrive, so no frame is darker than the finished cel (tested on the GPU by comparing every frame).
- Tiles that enter the view and tiles changed by undo, redo, clear or a cancelled or failed stroke are fetched from the worker, 64
  at a time; a tile known to be empty is not asked for again.

**Retirement is tied to the real asynchronous tile path, by sequence.** Every dab carries the batch sequence it was sent in.
A wet segment retires in the frame whose `prepare` installed the tile batch with a sequence at least its own, and only
then, so the exact pixels are in the same frame as the last preview of them; a segment older than 30 frames retires too
(today's rule). Cancelled strokes retire all their ink and acknowledge what they had queued. Delayed replies, staged
installs, versions, eviction and stale replies are tested without a GPU (`tile_sync`, `wet`), and the pad is drawn on a real
GPU device in a test (`ink_pad::gpu::tests`) and compared pixel for pixel with the cel the worker holds, through clear, undo,
a moved view and a view that moves over a stroke's ink mid-stroke. A rendered check of double painting at a translucent soft edge is not made: wet ink is limited to full-opacity
strokes and installs are whole, so the case cannot occur today.

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

Decision N6 forbids system-level input injection, so nothing here is tested with a synthetic pen. Each criterion is tested by
scripted samples pushed into the pad's queue from an in-process thread (the lab's self-test, which exercises the queue, the
stroke rules, the worker, the tile path and the GPU), by the fake source in plain Rust tests where the criterion is about
logic, by pure-function tests of the platform source (`pen_sample`, `phase_of`, `cancels`, `promotion`, `scale_himetric`,
`HistoryClock`), and by hand with a tablet where only the operating system's own path can answer (hover reaching a toolkit
widget, press-and-hold, the eraser flags a driver reports). Every latency number is printed with the display's refresh rate
and the present mode.

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

## 6. What building it showed (corrections to the design above)

- **The pen reaches the toolkit without winit.** The subclass handles every pen pointer message itself (`WM_POINTERENTER`,
  `DOWN`, `UPDATE`, `UP`) and calls `DefWindowProc`; Windows then promotes the pen to mouse messages (extra-info signature
  `0xFF515700`), which reach winit and iced so hover and buttons work. A pen hovering over a toolkit widget raises its
  hover event, and no promoted message ever becomes a stroke sample. A small number of mouse messages arrive without the
  signature while a pen is in use (the system's own, at capture changes); they are `Hover` samples of the mouse and never
  start a stroke.
- **History is real and needed.** Even with the interface thread running freely, about 40 % of the samples of a 240 Hz
  stroke arrive as history entries of a later message (the system coalesces pointer updates like mouse moves). The history
  of a message sometimes repeats an entry already delivered; the source remembers the last 64 reports and drops a repeat.
- **The stage is in `styk-core`'s `Mapping`,** which holds the stage's offset and size ratio and the camera matrix
  and inverts them in `screenToWorld`'s order, then the cel's inverse pixel matrix and the symmetry mirrors. Deriving a
  window-to-world affine by probing two points, as an earlier version did, differs from the JavaScript in the last bits,
  which changes a few pixels.
- **Pen events as the browser delivers them are not the events a script sends:** Chrome rounds positions and pressure to
  single precision and stamps its own times. The parity capture records the events the page received.
- **Wet ink is limited to full-opacity strokes** (`BrushConfig::wet_eligible`): the preview draws discs, which would
  double-darken a translucent stroke. Translucent strokes show exact pixels only until the preview has a union layer.
- **The wet ink and the tiles share one pass but not one frame by construction:** the ledger (`styk_core::drawing::wet`)
  makes it one frame: a batch leaves the preview in the frame whose `prepare` uploaded the last of its tiles, a rule tested
  against random reply delays and a small upload budget (no dab missing, none painted twice).
- **The lab draws every frame** (the frame subscription keeps the window redrawing), so the queue is drained at least
  once a frame without a wake-up; the queue's waker is for the real application, whose stage draws only on demand.
- **What an earlier, injected spike run showed, kept because it still shapes the design** (that run is dropped by N6): about
  40 % of a 240 Hz stroke's samples arrived as history entries; injected reports are stamped to the millisecond, so a
  recovered history must not be rejected as duplicate timestamps (`HistoryClock`); a lift reports the position of the last
  contact; the system reports a pen entering range as a report of its own; and the barrel button arrives in `penFlags`.
