# StykAnimate components (revision 4.3, "Simple at a glance, powerful underneath")

The complete component vocabulary. Every component below is implemented in `design/app-ui/components.css` (the app splits it into `src/styles/components/`) and rendered in the component gallery (`gallery.html`, internal design material, not in the repository); the reference editor (`design/app-ui/reference/`) composes them. Tokens and rules come from `visual-system.md`; the calm rules (one shadow at rest, no keycaps at rest, dots-only accents, one ink primary, quiet sections, quiet view toggles) are enforced by the components themselves, so a feature cannot break them without writing new CSS.

**What revision 4 changes.** Revision 3 made the editor calm by hiding things behind one generic "More". Revision 4 keeps every function one click away where today has it, and stays calm through structure. The vocabulary gains seven components that carry context to where the eye already is: the **quick actions** row, **titled sections** (collapsible, remembered, with one title action), the **tool options bar**, the **split button**, the **crumb**, the **scope line** and the visible **menubar**; the view toggles get a **quiet pressed** state; the frame card shows its **inbetweens count** when it is current. The generic `.ui-more` disclosure and the stage corner group (`.ui-corner`) are retired. **Revision 4.2** settles one pattern per kind of field (the field switch, the stepper field, the bare select), gives scrub labels a visible cue, lets the one message take its own line instead of being cut, and draws effect and brush collections with real previews (no two tiles of a collection alike). **Revision 4.3** gives the quick actions one grammar (a label with its glyphs is one **quick tile**, `.ui-quick-tile`; word and glyph buttons share their gap and hover tile), lets a titled section carry its feature's switch right after its title (`.ui-section-head[data-switch]`), gives the Order stepper its inline label, and draws the crumb's background chip as a filled swatch.

## 0. Conventions

### 0.1 Class API

| Part | Pattern | Example |
|---|---|---|
| Block | `.ui-<name>` | `.ui-button`, `.ui-field`, `.ui-quick` |
| Element | `.ui-<name>-<part>` | `.ui-section-toggle`, `.ui-field-label`, `.ui-menu-shortcut` |
| Variant | `[data-variant]` | `.ui-button[data-variant="primary"]` |
| Size | `[data-size="sm" \| "lg"]` | Fields and selects are 32 by default, 28 at `sm` |
| Tone / tint | `[data-tone]` (status), `[data-tint]` (concept dots only) | `.ui-dot[data-tint="draw"]` |
| Private tokens | `--_x` on the block | `--_h`, `--_bg`, `--_w` |
| Data-driven values | custom properties through CSSOM | `--swatch`, `--_p`, `--hold-w`, `--level`, `--dot` |

Features keep their prefixes (`sheet-`, `audio-`, `vfx-`, `library-`, `builder-`, `draw-`, `export-`) and compose `.ui-*` blocks.

### 0.2 State

Native and ARIA state first (`:disabled`, `:checked`, `[open]`, `:popover-open`, `[aria-pressed]`, `[aria-selected]`, `[aria-checked]`, `[aria-expanded]`, `[aria-current]`, `[aria-invalid]`, `[aria-busy]`), then `data-*` enums (`data-scrubbing`, `data-drop`, `data-on`, `data-open`, `data-quiet`, `data-inline`, `data-collapsible`, `data-floating`, `data-dock`), then `is-*` for transient flags. Components never style `[aria-label]` or `[data-action]`. `[data-force~="hover|active|focus"]` renders a state for documentation only.

### 0.3 Budgets

Components stay at specificity (0,2,n); features at (0,3,n); qualifiers go inside `:where()` (`specificity.mjs`, internal design tooling, not in the repository: 0 over budget). No IDs, no `!important` outside reset/states/utilities, no colour fallbacks in `var()`. Spacing, gaps and radii use tokens (CSS17).

### 0.4 Layers and stacking

Menus, popovers and sheets use `popover`; the tooltip uses `popover="hint"`; modals are native `<dialog>` with `showModal()`. In-flow z-index uses only `--z-sticky`, `--z-canvas-overlay`, `--z-canvas-hud`, `--z-floating`. Every overlay root is `-webkit-app-region: no-drag`.

### 0.5 Contracts preserved

- Every `data-action`, `data-shift-action`, `data-tool` and `data-workspace-mode` value stays on the element that owns the behaviour; the component class is added beside it. Revision 4's quick actions, tool options and view toggles carry the same `data-action` values as today's buttons.
- Ids that core modules and tests look up stay on the same functional element (`#viewport`, `#scene`, `#overlay`, `#play-button`, `#time-display`, `#fps`, `#range-edit`, `#onion-button`, `#onion-settings-button`, `#loop-button`, `#timeline-audio`, `#timeline-zoom`, `#expand-timeline`, `#save-state`, `#object-actions`, `#open-insert`, `#handles-button`, `#paths-button`, `#canvas-guides-button`, `#vfx-preview`, `#builder-branch`, `#builder-snap`, `#rig-mode`, …; architecture §4).
- Accessible names kept verbatim: tabs Properties, VFX, Library; grid "Layer frames"; listbox "Animation frames"; button "Add Frame"; "Onion skin settings" (the Onion split button's chevron), "Audio" (a header toggle), slider "Timeline zoom" and button "Fit timeline" (the ruler's end); buttons "Play", "Undo", "Redo", "Save", and "Pose" and "Rotate" (the 3D rig's `aria-pressed` pair); slider "Frame N inbetweens"; searchbox "Find layers"; separator "Resize timeline". Roles follow `ui-architecture.md` §4.3.

### 0.6 Component index

| Group | Components |
|---|---|
| Primitives | Icon, Dot, Colour chip |
| Actions | Button, Icon button (and its quiet toggle), Tool button, Rail, Toolbar, Segmented, **Split button**, **Quick actions** |
| Inputs | Field (and its **inline** size), Form row, Field grid, Row, Slider row, Select, Stepper, Switch, Checkbox, Radio, Swatch, Chip (catalogues only), Kbd (shortcuts dialog only) |
| Inspector | Target, **Scope line**, Section (core and **titled**) |
| Status | Document button, Readout, Message (toast host), Progress, Spinner, **Crumb** |
| Bars | **Menubar**, **Tool options bar** |
| Overlays | Tooltip, Menu, Popover, Dialog (sm, md, lg, export), Sheet, Command palette |
| Containers | Island, Strip, Tabs, List row, Group label, Empty state |
| Timeline and layout | Filmstrip and frame card, Range strip, Curve, Timeline sheet (canvas), Drop zone, Splitter, Choice and dock map |

**Retired in revision 4:** More (`.ui-more`: a generic disclosure; titled sections replace it) and Corner (`.ui-corner`: the zoom now lives in the stage header). **Still removed from revision 3:** Key diamond (`.ui-key`), Badge (`.ui-badge`), HUD pill (`.ui-hud`), Scope readout (`.ui-scope` of revision 2; the revision 4 scope line is a new, quieter component), Selection pill, Lane message, Coach mark and pulse, Range chip, Steps, Easing tile, Card, Bar slider, the export lime pane, inverse button variants, the ink `mode` variants of Segmented and Choice. Do not reintroduce them.

---

## 1. Primitives

**Icon `.ui-icon`.** `<svg class="ui-icon" aria-hidden="true"><use href="#i-onion"/></svg>`; size from the parent's `--icon-size` (12–24), stroke from `--icon-stroke-w`; `currentColor`; always `aria-hidden`. One glyph per concept (visual-system §10): quick actions, tool options, view toggles and menu rows are held to it by the reference build, **by name and by SVG content** (revision 4.1: the app set's byte-identical pairs, `rotate` = `reset`, `sliders` = `settings`, `chevron-up` = `up`, may not stand for two concepts). Every icon control carries `data-concept`, its command family; the audit fails a rest state where one symbol stands for two families.

**Dot `.ui-dot`.** A 7px circle (`--_s` sets 6 or 8) filled with `--dot`. `[data-tint]` for concepts, `[data-tone]` for status, `[data-hollow]` for a ring ("Not saved"). Always paired with text or a name. **The only way a concept colour appears at rest** (the has-audio mark on Audio is a 6px mint dot).

**Colour chip `.ui-color-chip`.** A 10px rounded square with `--swatch-ring`; the layer colour menu only.

## 2. Actions

### Button `.ui-button`

Pill, gap 6, an optional leading icon, `.ui-label`, an optional `.ui-button-chev`. Sizes: sm 24, regular 28, lg 32.

| Variant | Rest | Use |
|---|---|---|
| `primary` | `--primary` (ink; a white pill in dark), flat, Inter Tight 650 | **At most one per surface**: Export, a session's Done (with a check icon), a dialog confirm. The audit fails on a second. |
| (secondary) | `--control-soft` | Secondary commands |
| `ghost` | transparent | Add frame, Cancel, Add to library (the inspector footer), labelled toggles in the tool options (Whole branch, Snapping, Flip view) |
| `outline` | surface + a 1px `--line-2` ring | Add effect, Edit clip, Connect joints…, Library… |
| `danger` | `--danger-strong` | Destructive dialog confirm |
| `ghost` + `data-tone="danger"` | danger text | "Don't save" |

Toggled `[aria-pressed="true"]`: `--accent-soft` with `--accent-text` (a mode that changes what edits do: Whole branch, Together, Isolate); with `data-quiet`, the quiet toggle below. Disabled: .42 opacity (prefer a visible reason). Busy `[aria-busy]`: a spinner replaces the icon. The visible label is (or contains) the accessible name; an icon-only button that keeps a label node for localization hides it with `.ui-visually-hidden` (the band's Save).

### Icon button `.ui-icon-button`

28 (radius 8, icon 16), sm 24, lg 32. Variants: ghost (default, `--text-2`), `soft` (`--control-soft`; with `data-shape="round"` and `lg` it is Play, `#play-button`). States: hover `--surface-hover`, open `[aria-expanded]` `--surface-pressed`, disabled .42. Always an `aria-label`; the tooltip adds the shortcut as text.

**Quiet toggle `[data-quiet][aria-pressed="true"]`** (revision 4). A view toggle in a header row (Joints, Motion paths, Grid, Effects preview, Loop, Onion, Audio, Mirror, Pen pressure, Snapping, Static handles, Highlight part, Tall timeline): on is a quiet soft tile (`--control-soft`) with an ink glyph, so a default that is on never adds colour at rest. Blue stays for selection, the current frame, the active tool, and toggles that change what edits do. The audit counts accent-pressed toggles at rest (at most one; none at first glance).

### Tool button `.ui-tool-button` and Rail `.ui-rail`

A 36px square, radius 10, icon 20, `--text-2`. **Active** `[aria-pressed="true"]`: a white tile (`--control-thumb`) with `--lift` and a blue glyph. **Revision 4.1 keeps today's corner tick** on a tool with variants (the Tweener, Select pixels, Shapes): a 5px triangle at the button's lower corner (`--text-3`, `--accent-text` while active), decorative (`aria-hidden`); a click on the tick, a right-click or a long press lists the variants, and while the tool is active they are a segmented control in its tool options. The rail is a vertical stack, 4px gaps, anchored to the top, `.ui-rail-sep` between groups, `.ui-rail-end` pinned to the bottom for a future extra control (revision 4.1 moves Build's Test rig to the band, beside Done). Contents: the current workspace's tools (≤ 7), and in Build a two-column layout with creation actions (`.rail-quick`: Whole branch, Split part, Duplicate branch, horizontal and vertical branch flips, Delete part) under a hairline, toggles that are on as soft accent tiles; Draw's colour moves into the tool options. `nav` "Editor tools"; roving tabindex.

### Toolbar `.ui-toolbar`

A named container for stretched bars; `data-label-priority="2"` labels drop below 520px of the bar's container. Header rows fold by the tool options bar's rule instead (below).

### Segmented `.ui-segmented`

A pill track on `--surface-well` (2px padding), items 13/600 `--text-2`. **Selected:** a white thumb with a 1px `--thumb-line` hairline (3:1 against the well) and `--lift`. `data-size="sm"`, `lg` (32px track), `data-fill` (equal items). 2–4 options; five or more is a Select. Icon items (the pixel-selection and shape variants) carry an `aria-label` and a tooltip. Radio semantics, except the tested button groups (`aria-pressed` buttons, same look): the workspace switch, the timeline mode and the 3D rig's Pose │ Rotate. **The workspace switch** (revision 4.1) shows its concept dot and name, and when the band is tight its glyph instead (`.rf-ws-ic`: a figure in motion, a pen line, a rig; each item keeps its `aria-label` and tooltip): it is never folded into a pill.

### Split button `.ui-split` (revision 4)

```html
<div class="ui-split" role="group" aria-label="Onion skin">
  <button class="ui-icon-button" id="onion-button" data-quiet aria-pressed="false" aria-label="Onion skin">…</button>
  <button class="ui-split-more" id="onion-settings-button" aria-haspopup="dialog" aria-label="Onion skin settings">…</button>
</div>
```

A toggle or command and, attached to it, a 24-wide chevron that opens its settings or its variants: Onion (the settings popover), Motion paths (their settings), New layer (the drawing layer). The two halves share one hover so they read as one control; each has its own name, tooltip and focus ring. It replaces today's 14–22px chevrons with a 24px target.

### Quick actions `.ui-quick` (revision 4)

```html
<div class="ui-quick" role="toolbar" aria-label="Figure actions">
  <button class="ui-icon-button" data-action="mirror" aria-label="Flip horizontally" data-tip="Flip horizontally · Shift+H">…</button>
  <span class="ui-quick-sep" aria-hidden="true"></span>
  <button class="ui-button" data-size="sm" data-variant="ghost" data-action="layer-front" data-shift-action="layer-up" data-tip="Bring to front · Shift: one step"><span class="ui-label">Front</span></button>
  …
</div>
```

The selection's most used commands, one quiet row of 28px buttons under the inspector's name: **at most five defaults, the sixth slot kept for a pin, in at most three groups** separated by 10px of space (no dividers). **Words where glyphs are hard to tell apart** (revision 4.1): small labelled ghost buttons (12/600 `--text-2`, 8px padding) for Front and Back, Build's Split and Duplicate and the range's Remove keys; a label that belongs to glyphs shares **one sunken tile** with them (revision 4.3, `.ui-quick-tile` with `.ui-quick-label`, 12 `--text-3`: "Match ◀ ▶", like a stepper, so it never reads as a word button beside loose glyphs); word buttons have the same gap and hover tile as glyph buttons (revision 4.3); the row never wraps or scrolls at any inspector width (a command that would not fit becomes a section's title action, as the camera's Guides in its Preview section); icons stay for the unmistakable (Flip, Duplicate, Delete) and for the context's main verb a labelled button (Edit clip, Motion ▾). Glyphs in one row must differ at 16px (the build compares their drawings). The row is the same component in every context (figure, text, image, several figures, joint, frame range, movieclip, Build part, drawing layer, layer, camera, motion clip); each button is a registry entry whose context menus list it too (the visible home plus menu aliases rule, experience §8). Shift variants are in the tooltip ("Bring to front · Shift: one step"). A toolbar: one tab stop, arrow keys between buttons. **Room to grow:** a person can pin a command to a context's row (the free sixth slot; a second pin takes the last default's place, which stays in the context's menu); a feature adds a registry entry with `quick: true`, not a layout change.

## 3. Inputs

### Field `.ui-field`

```html
<div class="ui-field" data-property-row>
  <label class="ui-field-label" data-property-scrub>Angle</label>
  <input class="ui-field-input" type="text" inputmode="decimal" data-property="angle" value="172°" aria-label="Angle (degrees)">
</div>
```

- 32px (28 at `sm`), radius 8, `--surface-sunken`, **no ring at rest**. Hover shows a `--line-3` ring; focus fills `--surface` with a 1.5px `--accent-line` ring and a 3px halo; scrubbing rings in blue; invalid rings in danger; disabled .5.
- The inline label (12/500 `--text-3`) names the field and scrubs it (drag; Shift ×0.1; Alt ×0.01). **Revision 4.2: a label that scrubs has a quiet dotted underline at rest** (`--line-3`, 3px offset; `currentColor` and the ↔ cursor on hover), and the first scrub-able field a person focuses shows the one-time hint "Drag a label to scrub · Shift ×0.1 · Alt ×0.01" in the message slot. The value is `--type-value` (regular 450, tabular). **The unit is part of the value** ("172°", "100%"); `.ui-field-unit` is only for file extensions (".mp4"). Revision 4 adds simple expressions (`+10`, `*2`) and a "Mixed" value for several figures.
- **No key diamond, no key state.** Keys are made by posing at a frame (or Add frame) and managed in the timeline.
- Keeps every `PropertyControls` hook (`data-property-row`, `data-property-scrub`, `data-property`, `data-property-value`, `-precision`, `-display-precision`, `-step`) and the body class `styk-property-scrubbing`.
- Variants: a colour field (`button.ui-field` with a 16px `.ui-swatch` and `.ui-field-hex`; opens the picker via `[data-paint-picker]`; "Mixed" shows a split swatch); a search field (`data-shape="pill"`); **an inline field** (`data-size="sm" data-inline`, revision 4): 28px, for header rows (the tool options' Size, Opacity, Flow, Smooth; the timeline's frame rate "24 fps", which has no label and a quiet surface until hover). **Revision 4.1:** it sizes to its label and value: the input is `field-sizing: content` with one spare `ch` of end padding and a minimum of `--_vch` characters, so "100%" or "1 px" never clips (revision 4's fixed `--_w` widths did). **A labelled select** (revision 4.1): `label.ui-field` holding `.ui-field-label` and a `select.ui-field-input` with a 12px chevron (`.ui-field-chev`) ("Blend  Normal ▾", "Layer  Bubble ▾"), so no select sits unlabelled beside another. **Revision 4.2: a bare select** (`data-bare`): when its value already names its kind ("Layer 1"), the inline label drops and stays the tooltip and the accessible name, so it never reads "Layer Layer 1". **The field switch** (`label.ui-field` holding `.ui-field-label` and `.ui-switch`, the switch at its end): the one switch pattern in the inspector's sections and the Simple frame bar (Static, Angle lock, Use IK, Pin joint, Stretch, Lock alpha, Two-tone, Edit together, Ease new keys, Sample all layers, Behind the figure), laid out in the same grid as the fields. **The stepper field** (`.ui-field[data-steps]`): a value between two 24px step buttons, the figure's Z-index with *Send backward* and *Bring forward* (today's one-step Stacking buttons, visible). **In a field grid** a field's label sits 4px from its value (padding 6/4), so a two-column grid keeps "Opacity 100%" and a spare character in a 256px inspector with its scrollbar; `data-ratio="3:2"` gives a labelled select room beside a short field (Layer and Z-index); `data-stack-narrow` stacks a pair with a labelled select or switch below 240px. The audit measures every input and select.
- Accessible name: human, with the unit in brackets: "X (px)", "Angle (degrees)".

### Value field `.ui-field[data-range]` and its companions (revision 4.5, the effects panel)

One control for a number a person shapes by feel (`src/inspector-kit.mjs` renders it from a `number` row; `src/property-controls.mjs` drives it; `docs/VFX-DESIGN.md` shows it in use). Rows opt in, so today's Properties fields keep their markup.

- **`range: true`** (a bounded value): the whole field is its slider. A quiet fill from the start shows where the value sits on its travel (`--_p`; from zero, `--_z`, for a value that runs both ways), a 2px line marks the fill's end, where the value is, the label reads from the start and the value with its unit sits at the end. The value and its unit never shrink: a label that does not fit beside them (a narrow panel, a longer language) wraps under itself and the field grows. **`scale`** (`log` with an optional `knee`, or `pow` with an `exponent`; `src/ui/value-scale.mjs`) gives a wide range's useful part most of the travel. Tokens: `--value-fill` at rest, `--value-fill-hover`, `--value-fill-active` (the accent's soft tint) while dragged or typed, `--value-edge` for the end line (the accent line while dragged or typed); in forced colours the travel is a line along the bottom.
- **`default`**: a 2×4px tick at the default's place (`--_d`, `[data-default]`) and the reset: a second tap on the field, or `PropertyControls.reset(input)` from a menu's *Reset value*. One undo step.
- **Gestures.** A drag anywhere on the field scrubs from where the value is, accumulating an unrounded position so it never jumps or sticks; it snaps to the field's step (finer under Shift ×0.1 and Alt ×0.01), Ctrl or ⌘ is coarse (×10 for a plain field, a quarter of the width crosses a slider field's range). A tap without a drag types the value; the label holds focus while dragging so arrow keys keep stepping. Keys: ArrowUp/Down step (Shift and Alt finer), Page Up/Down move a tenth of the travel (or ten steps), Home/End on the label go to the limits, Enter commits, Escape cancels. Every gesture is one undo step (`begin`, `preview`, `commit`, `cancel`).
- **`scrubAnywhere: true`** (an unbounded value: a seed, a start frame): scrubs from any point of the field, step by pixel, with the same layout.
- **`angle: true`**: a 16px dial at the field's start whose line points the value's way; dragging it turns the value to the pointer (Shift snaps to 15°).
- **`help`**: the value's one-line description, the field's tooltip and the input's `aria-description`. The input speaks its value with its unit (`aria-valuetext`); only the value is a tab stop.
- **`trail`**: up to two small buttons at the field's end (an effect value's key; a seed's shuffle), placed beside the field in the markup (`.ui-field-wrap[data-trail]`, never inside its `<label>`), drawn over its end, which keeps their room so the value never moves when they show. Every field kind keeps that room (its own end padding is written inside `:where()`, so the trail's wins) and a choice's chevron sits before it, so nothing runs under a key button on hover or on touch, where they always show.
- **Choice in a field** (`segmented` with `field: true`): the label and two or three short options in one tile; on a card narrower than 236px the label goes above the segments. Four or more, or long words, are a labelled select.
- **Labelled colour** (`color` with `showLabel: true`): label, swatch (a wide pill for a gradient) and hex or "Gradient"; `owned: true` when the owner opens its own picker.
- **Visual picker** (`picker`): label, the chosen option's picture and name, a chevron; the owner opens its grid of stills. Without a picture (`art: ''`) and with `popup: 'menu'` it is a choice that opens a menu: the effects panel uses it for a choice whose options are too long for a native menu in the person's language (`choiceHTML` in `src/vfx-effect-view.mjs`, the select kept hidden beside it); `bare` drops the visible label. The name wraps, and when label and name do not fit on one line the name and its chevron take the line under the label, never cut.
- **Pair** (`pair`): two fields stacked, each whole, with their link (`aria-pressed`) spanning both at their side; while linked, one field edits both.

### Form row, field grid, row

`.ui-form-row` stacks a label over a text field. `.ui-field-grid` is two columns with 8px gaps, one column below 200px. `.ui-row` is a label on the left (`.ui-row-label`, 12 `--text-2`) and one control on the right (a select up to 62%, a stepper, a segmented control), 32px tall. Dialogs use `.ui-dialog-row`. A switch that belongs in a field grid is a field-shaped label with the switch at its end (the field switch, revision 4.2: the one switch pattern in the inspector). **One pattern per kind** (revision 4.2, the gallery's *Field patterns* card): selects carry their label inside; a stepper or a segmented control takes a row label; the audit fails a `.ui-row` holding a `.ui-select` in the inspector.

### Slider row `.ui-slider-row` and `.ui-slider`

A 56px label, a 4px track (`--slider-fill` on `--slider-track`, 4:1), a 14px thumb with a `--line-control` ring and `--lift`, a 44px regular value. Bounded values only. `data-quiet` gives a view slider (the timeline zoom, the filmstrip zoom) a neutral fill.

### Select, Stepper, Switch, Checkbox, Radio, Swatch

- **Select `.ui-select`**: a native `<select>` styled like a field (32px, regular value, no ring at rest, a chevron). Always labelled.
- **Stepper `.ui-stepper`**: a 32px sunken group: a 24px −, a regular tabular `<output>` (typeable), a 24px +. Inbetweens, IK chain, onion counts and sampling.
- **Switch `.ui-switch`**: 32×18; off is a `--line-control` ring (3.6:1) with a 10px knob; on is `--accent-strong` with a 14px knob. **In the inspector it is a field switch** (above); in popovers and dialogs inside `.ui-switch-row` (the label left, the switch right; the whole 32px row is the target); on a titled section's title row when the section's feature can be off (Parallax, Smart Stretch): revision 4.3, `.ui-section-head[data-switch]` puts the switch (`.ui-section-switch`) right after the title text, visibly attached to it, while the whole row still opens the section (the chevron at its end); only the switch switches. Today's defaults stay (Use IK off, Pin joint off); **Pin joint shows the real pin** (Use IK pins, as today, and Pin joint turns on with it; revision 4.2).
- **Swatch `.ui-swatch`**: 20px (16 sm, 28 lg, 24 in `.ui-swatch-grid`), radius 6, always `--swatch-ring`; the tool options' recent colours are 24px round targets with a 20px colour inside (one collection). Keeps `[data-paint-picker]`, `#figure-color`, `#segment-color`.
- **Chip `.ui-chip`** (catalogues and popovers only) and **Kbd `.ui-kbd`** (the Keyboard shortcuts dialog only): never at rest.

## 4. Inspector

### Target `.ui-target`

`<div class="ui-target"><h2 class="ui-target-name">Bubble</h2><button class="ui-icon-button" data-size="sm" aria-label="Selection actions">…</button></div>`: the name (Inter Tight 16/650, ellipsis; double-click renames: a figure, a layer, a joint's name `#builder-joint-name`) and **at most one menu button** (`#object-actions` and its siblings). An optional 16px kind glyph before the name (`.ui-target-kind`: text, image, movieclip, scene, camera, layer) in `--text-3`, never a tile or a badge.

### Scope line `.ui-scope` (revision 4)

`<div class="ui-scope"><span class="ui-dot" data-tint="select"></span><span>Editing frames 22–28</span><button class="ui-button" data-variant="ghost" data-size="sm">Stop</button></div>`: a 28px blue-soft line under the name, **shown only while an edit reaches beyond the selection** (Edit together is on). It names the scope and gives the way back. It is text, not chrome, and is never shown at the default.

### Section `.ui-section`

```html
<!-- a core section: always open -->
<section class="ui-section" data-section="appearance">
  <div class="ui-section-head"><h3 class="ui-section-title">Appearance</h3><button class="ui-icon-button ui-section-action" data-size="sm" data-action="reset-color" aria-label="Reset colours">…</button></div>
  <div class="ui-section-body">…</div>
</section>
<!-- a titled section: collapsible, remembered -->
<section class="ui-section" data-section="colours" data-collapsible>
  <div class="ui-section-head"><button class="ui-section-toggle" aria-expanded="false" aria-controls="sec-9"><span class="ui-section-title">Colours</span><svg class="ui-icon ui-section-chev">…</svg></button></div>
  <div class="ui-section-body" id="sec-9" hidden>…</div>
</section>
```

- **Core sections** (2–3 per context: Transform, Appearance, Arrange; Joint, IK, Style; …) are a quiet title (12/600 `--text-3`) and a grid of controls (8px gaps); whitespace separates them (no dividers). **At most two title actions** on the right of the title row (revision 4.1 makes the two explicit: several figures' Selection has Rotate 15° and Centre; the camera's Transform has Copy and Paste camera; every other section has at most one): a 24px icon (Reset colours, Copy appearance, Background image, Join to figure on Arrange), a small text action (*Save preset*), or a switch (Parallax, Smart Stretch).
- **Titled sections** (`data-collapsible`) fold behind their own title, which says what is inside (Colours, Second colour, Motion clips, Framing, Tip, Stroke, Cel, Parallax, Filters, Advanced…). A closed one is one 28px line with a chevron at its end; it opens in place, one click, and **its open state is remembered per context kind**, so a person who uses it keeps it open. A section opens by itself when its content matters now (Connection while the figure is joined; Parallax while parallax is on; Connector on a connector joint).
- Never a generic "More"; never a summary, a key state or a divider. `data-section` is the identity key for `inspector-dom.mjs`.
- The audit counts, at rest: open sections (≤ 4) and titled sections (≤ 7) per context, and the controls in the whole inspector (≤ 28).

## 5. Status

### Document button `.ui-doc`

A 32px ghost button with one line: `.ui-doc-name` (13/600) and `.ui-doc-state` (a 6px dot and 12 `--text-3`): Edited (neutral), Saved 12:04 (success), Saving… (spinner), Not saved (hollow), Backup paused (warning). Opens the Document popover (name, location, Save as…). Compact: name and dot; minimal: the name truncated after at least 8 characters, and the dot. Keeps `#project-name`, `#dirty-dot`, `#save-state`.

### Readout `.ui-readout`

`<button class="ui-readout" id="time-display"><b>Frame 28</b><span>/ 48</span></button>`: the numeral (Inter Tight 14/600 tabular) and 13 `--text-3`. **One per timeline header.** Its tooltip carries the time; a click opens Go to frame, which can switch the readout to time. One of the only nodes written during playback.

### Crumb `.ui-crumb` (revision 4)

`<nav class="ui-crumb" aria-label="Location"><button class="ui-crumb-item" data-action="scene-settings">▭ Scene 1 <span class="ui-crumb-meta">960 × 540</span></button></nav>`: where you are, in the stage header's start when the tool has no options: the Scene with its size (a click selects the Scene, today's canvas crumb), or the scope path inside a session ("Scene 1 › Punch", "Scene 1 › Camera"; the first part leaves the session). 13/500 `--text-2`, the current part `--text-1` 600, `›` separators in `--text-3`. The Library's folder path uses it too. **Revision 4.1:** the Scene crumb ends with the scene's **background chip** (`#crumb-background`), one click from the colour picker. **Revision 4.2:** the chip is a 22×14 small artboard (a `--line-control` hairline frame, the scene's colour inside, a tiny `--text-3` figure on its ground), never an empty square; its tooltip names it and the colour ("Background colour · #FFFFFF"). The crumb never wraps.

### Message `.ui-toast` (the toast host keeps `#toast`)

A 28px white pill (`--surface-raised`, `--lift`), pill radius, 13/500 `--text-2` with the verb in `<b>` (`--text-1`). Parts: `.ui-toast-dot` (the first-run hint), `.ui-toast-icon` (`--accent-text`; success and danger tones), `.ui-toast-text`, up to two sm buttons, a dismiss. Variants: `task` (a small `.ui-progress`), **`mode`** (revision 4: a one-line instruction while a pick mode is active, "Click the joint to join to · Cancel"), **`quiet`** ("Slow · 14 of 24 fps · Details" while playback misses its target). One at a time (error > recovery > mode > update > toast > first-run hint), **centred in the stage header**, never meeting the view cluster; **revision 4.2: it has priority over the location and the tool options (it covers them while it shows) and it is never cut**: no width cap and no ellipsis; its room is the header up to the view cluster (zoom and Fit at compact width), and **when its whole text does not fit there it takes a line of its own** just under the stage header (`[data-msg-drop]`: the same pill with the one lift, centred over the stage's top margin for its moment). `role=status`, `role=alert` for errors.

### Progress and spinner

`.ui-progress`: 6px, `--accent-strong` on `--surface-well`, `[data-indeterminate]`; `role=progressbar`. `.ui-spinner`: 14px, `currentColor`.

## 6. Bars (revision 4)

### Menubar `.ui-menubar`

`<nav class="ui-menubar" role="menubar"><button class="ui-menubar-item" role="menuitem" data-app-menu="file" aria-haspopup="menu"><u>F</u>ile</button>…</nav>`: File, Edit, View, Animation (Figure in Build), Help as quiet 28px text items (13/500 `--text-2`, hover `--surface-hover`), **docked at every width down to the minimal tier** (revision 4.1), as today. Access keys are underlined only while Alt is down (`:root[data-alt]`). At the minimal tier it folds into the mark (the StykAnimate menu gains the five as submenus) and Alt shows it in place of the document name, as an overlay. Every item keeps `data-app-menu`.

### Tool options bar `.ui-optbar`

```html
<div class="ui-optbar" role="group" aria-label="Brush options">
  <div class="ui-optbar-group">colour pair · swap · recent colours</div>
  <div class="ui-optbar-group">[Size 8 px] [Opacity 100%] [Flow 100%] [Smooth 20%]</div>
  <div class="ui-optbar-group">Mirror · Pen pressure</div>
  <button class="rf-fold" aria-label="More options" hidden>…</button>
</div>
```

One row of the active tool's everyday options in the stage header's start: groups 12px apart (`--cluster-gap`), inline fields whose labels scrub, icon toggles (quiet pressed) and segmented variants. The tool's complete settings stay in the inspector as titled sections under the target. **Folding:** when the stage header is too narrow, labels on labelled toggles drop first, then items move, in their declared order (`data-fold`, lowest first), into "More options" (a chevron at the bar's end that lists them): never silently lost. **Room to grow:** a new tool declares its options (fields, toggles, a segmented variant) and their fold order; no layout change. Tools without options show the location crumb instead.

## 7. Overlays

All overlays live in the top layer, managed by one `OverlayManager` (outside-click and Esc owner, focus return, hotkey gate, prompt queue).

- **Tooltip `.ui-tooltip`**: an ink pill, radius 8, 12/500, no shadow: the name, a middle dot and the shortcut in `.ui-tooltip-key` ("Undo Move Bubble · Ctrl+Z"). 500ms delay, instant between neighbours, never interactive.
- **Menu `.ui-menu`**: 232–320 wide, padding 4, radius 10, `--elevation-3`, scrolls, flips and shifts inside the window. Items 28px, radius 6, 13/500, with **an icon, a check or a pad on every row**, `.ui-menu-shortcut` (plain text), `.ui-menu-sub`, `.ui-menu-label`, `.ui-menu-sep`, `.ui-menu-row` (an inline control). A submenu opens beside its row and flips left near the window's edge. An item that makes no sense in the current state is hidden, not disabled. **Placement:** the top is clamped to the band's bottom + 6px. Revision 4 flattens the frequent rows (Flip horizontally, Flip vertically, Rotate 15°, Centre, Reset pose, Reset colours, Paste in place are rows, not submenus).
- **Popover `.ui-popover`**: 248–380 wide, radius 12, `--elevation-3`; `.ui-popover-head`, `.ui-popover-body` (grid, gap 8, scrolls), `.ui-popover-foot`. Group titles inside a popover use `.ui-more-title` (Onion: Range, Look; Grid and guides: Grid, Guides). Uses: onion settings, Document, Go to frame, Layout, Layers (Simple), colour picker, the VFX catalogue, Grid and guides, Motion path settings, a key's easing.
- **Dialog `.ui-dialog`**: native `<dialog>` + `showModal()`. sm 420, md 640, lg 880 × min(540, window − 32); radius 16; `--elevation-4`; the veil `--surface-backdrop` (declared on `::backdrop`). Head, body (scrolls), foot (`.ui-dialog-meta`, Cancel, the one primary). Initial focus on `[autofocus]`, the first field or the primary, never × and never a tab; pointer-opened dialogs keep a text field's ring off until the first key (`data-pointer-open`). Compact and minimal: md and lg become full-window sheets.
- **Export** (`[data-variant="export"]`, 880 × 452): the preview with a `.ui-range-strip` and, beside its caption, **From and To fields** (typed frames); the form: Name, Format (segmented) **and Type (a visible select)**, Size (1080p, 720p, 4K, Original, Custom…), Quality, Sound, Picture (Edges, Transparent); the foot with the size estimate and "Export MP4". Keeps `#export-submit`, `#output-format`, `[data-category]`, `#export-start`, `#export-end`, `#export-progress`, `#cancel-export`.
- **Sheet `.ui-sheet`**: a non-modal island (`popover`), 320 wide (bottom: full width, 50dvh), radius 12, `--elevation-3`; never resizes `#viewport`. The inspector at compact and minimal width, folded panels, the timeline body at the low height tier.
- **Command palette `.ui-palette`**: a top-anchored md dialog: a 52px search row, groups (Commands, In this project, Learn, Settings) and 36px rows. Combobox + listbox with `aria-activedescendant`.

## 8. Containers

**Island `.ui-island`.** `--surface`, radius 12, **no shadow and no ring**. `.ui-island-head` (40px), `.ui-island-title`, `.ui-island-body` (scrolls). **Revision 4: every island's first row is 40px and the rows line up** — the stage header, the inspector's tabs, the timeline header and Structure's head — separated from the body by a 1px `--line-1` hairline; the audit checks that the stage header and the tabs share their top and bottom lines.

**Collections `[data-count-one]`.** A listbox or grid with a single tab stop (the Library's cards, the VFX effect list and suggested tiles, the camera's motion clip list, the brush presets, the recent colours): arrow keys inside, Enter or double-click acts, a right-click opens the item's menu. The budget counts it once. **Revision 4.2: a collection of tiles draws what each item is** (`[data-thumbs]`: a brush's stroke texture, an effect's still on a figure or its own glyph on a tile in its category's colour, a look's still with the number of effects it adds), one line of name per tile of one height, and **no two tiles of a collection draw the same thumbnail** (audited, with every label kept inside its tile). **An effect row** (the VFX list): the effect's glyph tile, its name, its on/off switch and its ⋯ (quiet at rest, as a row's eye; full on hover and when selected), a grip on hover.

**Strip `.ui-strip`.** A folded region: a 40px column of icon buttons; a click opens the panel as a sheet over the stage. Build's Structure folds wherever docking it would leave the stage under 400px wide.

**Tabs `.ui-tabs`, `.ui-tab`.** Line tabs: 40px, 13/600 `--text-3`, the selected tab `--text-1` with a 2px underline inset to the label. The names Properties, VFX and Library are never dropped. `role=tablist`, arrow keys.

**List row `.ui-list-row`.** 32px (`--outliner-row` 30 in Structure), radius 6, `--level` indents 14px. `.ui-list-row-lead`, `.ui-list-row-label`, `.ui-list-row-meta`, `.ui-list-row-actions` (eye and lock; Visible keys on an effect row). **Revision 4.1:** eye and lock sit on every row at rest in their own column (no overlay, so they never cover a name), as quiet `--text-3` glyphs (today's rows show them at 35%), and at `--text-1` when not at their default (a hidden layer's eye-off, a locked layer's lock); secondary row actions marked `data-reveal` (an effect row's Visible keys) wait for hover or focus, and all are visible under `(hover: none)`. A grip appears at the row's start on hover for reordering; a new row opens its name for typing (`.rf-rename` style: a blue-ringed inline field). Structure rows add a 12px twisty (revision 4.2: at rest in a quiet tone, full contrast on hover and focus). Drop indicators: a 2px accent line or a soft ring.

**Group label `.ui-group-label`.** 12/600 `--text-3`. **Empty state `.ui-empty`.** A title and at most one action, and in the VFX tab the suggested tiles.

## 9. Timeline and layout

### Filmstrip `.ui-filmstrip` and frame card `.ui-frame-card`

Cards `--filmstrip-card` wide (104–168px, sized to the timeline's height minus the strip's zoom row), a thumbnail framed as today, the number (11/600 `--text-3`; the current in `--accent-text`), and **one duration bar** (3px, `--hold`, the current frame's in `--accent-line`), whose 25px hit area is the "Frame N inbetweens" slider. **Revision 4.1:** the current card says its count in words after the number (`.ui-frame-count`, "6 · 5 inbetweens"); a hovered card and a dragged bar show theirs too; the others show their number only. Double-click a card: its easing (as today). No easing pins, partial-frame marks, tags or ghost add card.

The **Simple frame bar** (a feature composing Row, Stepper, Select, Icon button and Button): the column at the filmstrip's start (212px, the label column's place in Advanced) with "Frame 6 of 8 · 0.25 s", Inbetweens (every selected card), Easing, Copy · Paste · Delete, Together (Edit together) and the layer Simple edits ("Layer · ● Bubble ▾", opening the Layers popover). The strip's zoom and Fit sit above its top-right end.

### Range strip, Curve

- **Range strip `.ui-range-strip`**: mini thumbnails with two `.ui-range-handle` sliders (24px targets around an 8px ink bar); cells outside the range dim. The export trim (`#export-start`, `#export-end`), with typed From and To beside it.
- **Curve `.ui-curve`**: a sunken well holding the easing curve in `--easing-ink`; in a key's easing popover it shows the two Bezier handles (5px rings on `--line-control` stems) and their numbers.

### Timeline sheet (Advanced, canvas)

Canvas-drawn by `layer-timeline.mjs` from the `--sheet-*` tokens: the ruler (11px numerals every 5 frames across the visible span; the playhead tab white on `--sheet-playhead-tab`); rows 32px; round keys in the row colour with a 1px outline; soft spans and thin tween arrows; neutral cels and effect clips; the quiet area past the end; onion ranges on the ruler whenever onion is on (today's colours). **Revision 4 additions, all drawn only where the pointer or the selection is:** the selected exposure's **end handle** (a 3px `--accent-line` grip in a 24px target: drag to hold longer); a live "12 → 14" on the ruler while keys are dragged; a drawing's thumbnail inside a wide cel; fade handles on a selected effect clip. The label column: a quiet title and **its header controls** (New layer as a split button, Find layers); **the ruler's right end** holds the timeline zoom, Fit timeline and Tall timeline over a fade (never over cells). Grid "Layer frames".

### Drop zone, Splitter, Choice and dock map

- **Drop zone `.ui-drop-zone`**: while dragging a tab: a soft `--accent-soft` fill, a 1.5px `--accent-line` ring and a small label pill ("Dock left", "Dock right", "Add as a tab", "Float here").
- **Splitter `.ui-splitter`**: an 8px hit area; a 2px `--accent-line` bar on hover, drag or focus. `role=separator`; arrow keys, Home/End, double-click resets. The label column has one too (revision 4).
- **Choice `.ui-choice` and dock map `.ui-dock-map`**: a layout preset card in the Layout popover.
