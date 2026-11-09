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
