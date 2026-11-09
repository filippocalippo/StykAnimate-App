# B1: the Inspector's remaining properties, interface for the views

Base `origin/native-app` `c7612738`. Core in `styk_core::inspector` (`paint.rs` new; `model.rs`, `mod.rs`,
`contexts.rs`); the views are `styk-ui::inspector` and, for the picker's popover, the colour picker chunk (B3).
This lists, against today's view code for the same rows, every value the views show and every intent they send,
with the field or message that carries it. Nothing below needs a view to decide behaviour.

## Rows

ST-085 (paint model), IN-022 and IN-030 (Edit together and edits across frames), IN-032 (background colour over the
range), IN-039 (figure layer select), IN-041 (figure colour and palette swatches), IN-043 (fill colour), IN-051
(segment colour paint, second colour), IN-058 (colour field opens the app's picker), IN-060's data (the gradient
editor's draft), IN-061 (release commits, inline errors). Number fields over several frames (IN-030) were the slice's
and are checked here.

## Values the views show

| Today (`src/…`) | What | Native field |
| --- | --- | --- |
| `inspector-kit.mjs` colour row, `paintCSS(paint)` | the swatch: a solid, or a gradient's kind, angle and stops with their opacity | `model::ColorRow::paint`: `Paint::Solid(rgb)` or `Paint::Gradient(paint::PaintSpec)` (`kind`, `angle` degrees, `stops[].offset/color/opacity`, normalised) |
| `jointDescriptor` `colour.caption` | "Linear gradient" (the paint's own type, a full colour override shows solid) | `ColorRow::caption` (`inspectorView.valueValue1Gradient` with `colorPicker.<type>`) |
| `figureDescriptor` palette swatches | each colour, its accessible name, which colour a press replaces, whether it can be pressed or focused | `Row::Swatches { items: Vec<model::Swatch> }`: `rgb`, `description`, `target` (`ColorTarget::Palette(index in the whole palette)`), `disabled` (set while the panel is pending) |
| `fillGroup` (`.inspector-group`, `.ui-list-row`) | a fill's list row: glyph, name, its colour chip, Delete; then its other rows | `Row::Group { label, head: model::ListRow { glyph, label, swatch: Option<Swatch>, actions }, rows }` (the chip's `target` is `ColorTarget::Polygon(i)`, its `disabled` as above) |
| `changeFigureLayer` progress dialog | after 150 ms of a layer move: the title, "Preserving animation…" over an indeterminate bar, Cancel; Escape or its close button cancel; focus returns when it closes | `Panel::layer_dialog() -> Option<(overlay, LayerMoveView)>`: a dialog the core opens and closes on the overlay host (Cancel focused, `inspector::ids::{CANCEL, CLOSE}`; the bar's loop is `Host::phase(ids::PROGRESS)`), mounted by `styk_ui::inspector::owned` |
| `color-picker.mjs` `openColorPicker({paint, gradients, alpha})` | what the open picker starts from and allows; the inline error | `Panel::picker() -> Option<&PaintRequest>`: `id`, `target`, `paint`, `gradients` (Solid │ Gradient tabs), `alpha` (opacity slider and field), `error` |
| `color-picker.mjs` draft and `draw()` | the gradient editor: type, angle, stops on the ramp, the selected stop, Add and Remove enabled | `paint::Draft` (the picker's own state, made from `PaintRequest::paint`): `draft()` (unsorted, as drawn), `selected()`, `stop()`, `can_add()`, `can_remove()` |
| `paint.mjs` `hexColor`, `parseColor` | the hex field's text and what it accepts | `paint::hex`, `paint::parse_color` (refusal `errors.paint.useAValidHexColorOptionallyIncludingAlpha`) |
| `inspectorDescriptor` scope line, Edit together section | "Editing frames 22–28 · Stop", "Edit N frames together" | `Inspector::scope`, section `range` (`Toggle::ApplyRange`) (the slice's) |
| `layerSelect` | layer options, locked ones disabled, Mixed, bare label | `Choice::FigureLayer` `SelectRow` (the slice's) |

## Intents the views send

| Today | Intent | Native message |
| --- | --- | --- |
| any click on a colour field or a palette swatch (`installColorPickers`) | open the picker on that row | `Event::Color(ColorTarget)`; the panel finishes an open edit, fills `Panel::picker()` and returns `Effect::PickColor(target)` (the shell anchors the popover on that row) |
| `commit()` on a release, a swatch, the hex field, a stop added or removed, Solid │ Gradient, type, angle, Rotate, Reverse | apply the picked paint (one undo entry; the picker stays open) | `Event::Paint(PaintEvent::Commit { request, paint })` with `Draft::paint()`; a refusal lands in `PaintRequest::error` |
| close (Escape, press outside, ×) | close the picker | `Event::Paint(PaintEvent::Close { request })` |
| drag a stop, the square, hue or alpha | draw only (non-live pickers commit on release) | `Draft::drag_stop`, `set_color`, `set_opacity` (no message) |
| `#figure-layer` change | move the selected figures to a layer | `Event::Choose(Choice::FigureLayer, id)`: runs on the session's worker; when it lands it is one entry, the layer becomes active and its track is selected |
| the progress dialog's Cancel | stop the move (nothing changes) | `Event::CancelLayerMove` |
| `#apply-range-movement` | Edit together | `Event::Toggle(Toggle::ApplyRange, on)` (the slice's) |

A message whose `request` is not the open picker's id changes nothing (a stale picker, an A-B-A reopen).

## What each commit does (one session command each)

| Row | Picker opens with | Commit |
| --- | --- | --- |
| Background | the frame's colour override, else its background's paint (`backgroundPaint`); gradients, opacity | solid: `setSceneColor(argb, {indices})`; gradient: `importSceneBackground({…paintBackground, name: "<type> gradient"}, {indices})` |
| Figure (one or several) | the row's colour, opacity `1 - field28/255`; no gradients | `setFigureColor(hex or null when only the opacity changed, {indices, opacity})` |
| Segment | `displayedSegmentPaint`; gradients, opacity | `updateBuilderSegmentStyle({paint}, {branch: false})` |
| Second colour | the secondary colour, opaque; no gradients, no opacity | `updateBuilderSegmentStyle({gradient: {color}}, {branch: false})` |
| Fill N | the fill's colour and opacity; no gradients | `updatePolygon(N, {color: [r, g, b], opacity})` |
| Palette swatch | that colour, opaque; no gradients, no opacity; its palette row captured (`targets`) | `replaceFigureColor(from, [r, g, b], {targets, indices})`, the same targets on every commit of that opening |

`{indices}` is present only while Edit together reaches two or more frames (`Range::value`). A palette or figure
commit after the selection, the playhead or the figure changed is refused with today's message
(`errors.app.selectionChangedReopenThePalette` / `…TheColorPicker`); a segment one after the joint changed. The
picker closes when another document becomes active.


## Review follow-up: session and facts ownership

Segment pickers capture the immutable definition, stable handle, selected UID/index and playhead.
The exclusive session validates these operands before applying a release, and returns the next
expected definition after its own commit. Undo or definition replacement cannot redirect an open picker.
`updateBuilderSegmentStyle` and `replaceFigureColor` require the session worker; the native picker
uses the guarded `@inspectorPaint` envelope over those same commands and transaction/history owners.
Accepted releases stay ordered (one active job, at most 32 queued releases); excess admission is refused.

Facts are keyed by document, lineage, revision, playhead and selection. A successful key is independent
of publication receipts. Receipts permit retries only for unpublished misses. While the lane is busy,
only the newest key/receipt waits; document handles are acquired on admission. Retirement has two
interface-side slots and one bounded exchange batch. A blocked retirement prevents further heavy
admission. Replaced panel payloads, including captured picker operands, go back to this lane; teardown
hands over the remaining owners before the lane shuts down. A ready frame with no selection withdraws
obsolete work even though it needs no replacement request.

The same cancellation reaches record composition (including pose-key parsing and track binding), typed evaluation, bounds geometry/measurement and
palette preparation. Palette target metadata reads the evaluated instances (including attached figures)
instead of resolving their styles again. A committed property preview is a session-stamped read of the
validated pose; unchanged definition views remain usable by identity. Ordinary numeric edits therefore
publish their authoritative values immediately. Instance-derived paint and unavailable bounds can wait
without blanking unrelated pose, layer or project controls.

Remaining synchronous walks reserved for G2: `contexts::build` per rebuild and
`figure_of_selection`/rotation reads per numeric gesture. The existing palette, draw-order and layer projections inside `contexts::build` still walk their inputs. Other existing Inspector routes still walk
synchronously: `setFigureColor`, scene colour/background range edits, `updatePolygon`, definition-name
edits (`updateFigureStyle`) and layer-name edits (`renameLayer`). This round moves the two reviewed
paint routes; it does not silently reclassify the rest of the slice.

Regression coverage for this follow-up:

| Finding | Behavioral test |
| --- | --- |
| 1 | `a_picker_cannot_retarget_a_replaced_handle_after_undo` reproduces handle 500 reverting to handle 2; `queued_paint_releases_keep_order_history_and_the_picker_identity` advances the guard after accepted commits. |
| 2 | `paint_range_walks_run_on_the_worker_and_cancellation_keeps_history_atomic` counts 64 frame plans off the interface thread and verifies cancellation, undo and redo. |
| 3 | `record_evaluation_observes_cancellation_inside_composition`, `inspector_bounds_cancel_inside_measurement_and_keep_exact_uncancelled_values`, palette cancellation, and `clearing_selection_with_ready_records_withdraws_older_facts`. |
| 4 | `shown_last_owner_retires_on_the_lane_after_ready_has_gone` holds reclamation after the ready owner has gone, then replaces the actual panel's Shown. |
| 5 | `admission_keeps_only_one_lightweight_intent_while_reclamation_is_held` makes 9,999 superseding requests with the lane held and checks retained owners. |
| 6 | `a_committed_number_and_unaffected_rows_stay_authoritative_while_facts_wait` and `a_committed_segment_value_stays_enabled_while_appearance_facts_wait` hold facts through commits; the latter checks unchanged colour controls too. |
| 7 | `successful_keys_ignore_receipts_and_discard_a_same_key_retry` counts one snapshot despite receipt changes. |
| 8 | `resolved_palettes_preserve_gradient_style_and_mesh_targets` compares the resolved route to the existing record owner, including fractional sampling. |
| 9 | `several_figures_show_their_bounds_align_and_mixed_values` now gates its pending assertion; `bounds_are_prepared_on_the_facts_thread` checks the separate lane and completed geometry. |
