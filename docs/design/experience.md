# StykAnimate experience spec (revision 4.3, "Simple at a glance, powerful underneath")

This is the experience specification for the StykAnimate redesign. It says **what is visible at rest, where every function lives and how many clicks away it is (today and in revision 4), how big things are, how they behave and how people organise them**. Revision 4 replaces revision 3's "calm by hiding" with **calm through structure**: every function of today's app keeps a home at most as many clicks away as today (3 low-frequency trades are documented since revision 4.3; revision 4.2 had 16), frequent functions are visible where the eye already is, and the first glance stays quiet. **Revision 4.1** makes that hold at the window sizes people use, not only at 1440×900: from 801 px wide the menubar, the inspector, the view toggles, the workspace switch, *Simple │ Advanced* and the frame rate stay where today's app keeps them, and the task and function gates run again at 1280×720, 1152×720, 1100×700, 1024×700, 960×600 and 900×700. **Revision 4.2** makes the gates honest (a control a scroll container must scroll to, or one covered by another, is not "visible"; every function is counted by itself, never by its group's best case; any drop in visibility fails for a high- or medium-frequency function) and fixes what they then found: the selected effect's own settings follow the effect list (T38 is 6 steps at every size again), the joint menu starts with today's joint right-click list, Build shows *Fit figure* and names the figure it edits, *Use IK* shows the pin it makes, the one message is never cut and never meets the view cluster, the workspace switch keeps its names longest, Draw's brushes and the effects draw what they are, and one pattern per kind of field. **Revision 4.3** measures what the gates still could not see and fixes it: the default Advanced timeline gives **at least today's layer capacity at every tier size** (Camera and Scene are two compact pinned rows; four whole content rows from 600px tall, four and a half above 800px; a drawn scrollbar and an "N more" cue when rows are clipped), the ruler's tools get their own column so no frame, number, playhead tab or onion end sits under them, the camera session keeps the figures' joint handles (dimmed, draggable) and every session keeps **Export** in the band, **segment surgery runs in Animate again** (the joint menu's *Edit part ▸*, 3 clicks as today, saying which figures change and offering Undo), Draw's rail starts with **+** as today, Draw on a new file is a designed first glance, the timeline header folds *Edit together*'s word first and slides the transport before *Add frame* loses its word, the ink primary keeps its word at every tier size, one easing vocabulary (today's six names), the drop feedback leaves the canvas alone, and the counts are honest (every visible target counted, frozen ceilings per workspace). `README.md` lists every change and why.

| Read with | What it owns |
|---|---|
| `README.md` | Index, the owner's feedback, what changed in revision 4, the measured budget |
| `visual-system.md`, `src/styles/tokens.css`, `src/styles/base/fonts.css` (revision 4.3's values: `design/app-ui/tokens.css`) | Colour, type, spacing, depth, motion, icons and the structural calm rules |
| `components.md`, `design/app-ui/components.css` | The `.ui-*` vocabulary and its states |
| **`experience.md` (this file)** | Every surface and interaction, the balanced budget, the first-glance and task rules, the command-home table with clicks today and in revision 4, the user-facing layout model |
| `function-ledger.md` | All 852 functions of today's app, row by row: today's home and clicks, revision 4's home, clicks and visibility; the documented trades; the tier check (generated, checked) |
| `ui-architecture.md` | **Canonical** for the stored layout schema, the solver, `window.styk.workspace`, contracts and the build order |
| `design/app-ui/reference/editor.html` | The high-fidelity reference: 200 audited states, 104 of them at rest, all shot from one build (its hash is in `audit.json`), a sweep of 3,828 window sizes, the message pass, the 53-task gate at 1440×900 and at six tier sizes (section 9) |

**The owner's standard.** After the dense revision 2: "keep it clean, easy to use and beautiful to look at in every way. Users should feel at home when looking at the app, even at a first glance everything must feel perfect and not overwhelming in any way." After the calm revision 3: **"make sure that we don't lose any functionality or ease of use or hide good buttons just to get a clean UI. The UI must be clean but everything should still be there and not completely hidden. The redesign shouldn't just make it cleaner but also improve UX across the board, improve interactions and layout in general. This isn't achieved by just not showing stuff or losing ease of use of functionalities. I want this to be perfect. A modern UI and UX that is simple to use but super powerful. It should feel simple at a glance but have all the functionality we have now and room for even more."** Three vetoes still hold: no keyframe diamonds, key-state indicators or "Keyed at frame N" chips in the inspector (the Advanced timeline keeps showing keys as today, better drawn; editing stays "like it is now but with better design"); no selection ring, hover halo or joint name tags on the canvas; no default changes (new installs keep the Advanced timeline, onion off with today's colours, IK off, and the first figure selected at launch; there is no set-length command).

**Fixed constraints honoured everywhere.** The document model, editor commands, renderer (including joint handles and their colours), IK default, file formats and IPC are untouched. Every `data-action`, `data-shift-action`, `data-tool` and `data-workspace-mode` value, every id that core modules or tests look up, `window.styk`, and the tested accessible names stay (architecture §4); the tab names are Properties, VFX and Library. Modals are native `<dialog>`; menus, popovers and messages use the top layer. `#viewport` is one rectangle with `#scene` and `#overlay` covering it, no transform on its ancestors and no animated resizing next to it. The shell stays left-to-right. Text and controls meet WCAG AA, targets are at least 24px, the UI scale runs 75–200% down to a 500×340 minimum tier, playback only updates the readout and the playheads, and people organise their own layouts (docking, presets, the Layout popover).

---

## 0. The experience in one page

```
 44 ┌ top band ──────────────────────────────────────────────────────────────────────────────────────────────┐
    │ ✶▾ File Edit View Animation Help  Kick combo · Edited  (●Animate ●Draw ●Build)  ↶ ↷  💾 Save [⇧ Export] –□× │
    └────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 rail 48   stage island                                                         inspector island 288
  +     ┌──────────────────────────────────────────────────────────┐ ┌──────────────────────────────┐
  ▸     │ ▭ Scene 1 960 × 540 ▭   (one message)   ◉ ⌒▾ #▾ fx 95%▾ ⤢ │ │ Properties  VFX  Library     │  ← one line:
  ⌒•◢   ├──────────────────────────────────────────────────────────┤ ├──────────────────────────────┤    the island
  ✋    │  ┌──────────────────── artboard (fit) ─────────────────┐  │ │ Bubble                     ⋯ │    headers
        │  │         Bubble and Rival: nothing over them          │  │ │ ⇋  To front To back  ⧉+ 🗑    │  ← quick actions (5 + a pin slot)
        │  └──────────────────────────────────────────────────────┘  │ │ Transform                    │
        │                                                             │ │ [X 474 ] [Y 300 ]            │
        └──────────────────────────────────────────────────────────┘ │ [Angle 0°] [Scale 100%]      │
                                                                     │ Appearance                 ↺ │
                                                                     │ [■ 0D99FF] [Opacity 100%]    │
                                                                     │ Arrange                 Join…│  ← its title action (a word)
                                                                     │ [Layer Bubble ▾] [Order ↓ 2 ↑]│  ← the Order (Z-index) stepper: its label, one step back, forward
                                                                     │ Colours                    › │  ← titled section
                                                                     │ ─────────────── ▭ Add to library │
        ┌ timeline: spans the stage and the inspector, as today ──────────────────────────────────────┐
        │ [Simple│Advanced] ⧉+ Add frame  ⊡      ⏮ ◀ (▶) ▶ ⟲  00:01:03  24 fps           ◎▾  ♪•  ⋯  │  ← Edit together: a glyph at rest,
        │ Layers    ≋ +▾ 🔍 │ 1    5    10   15   20   25 [28] 30   35   40   45    │ − ━●━ ⤢ ⇡  │    its word while available
        │ ▭ Camera       👁🔓 │ ●──────────────────→●──────────────────→●             │            │  ← Camera and Scene: 24px
        │ ▤ Scene        👁🔓 │ ●                                                     │            │    pinned rows
        │ ● Bubble       👁🔓 │ ●──→●──→●─→●──→●──→●──→●──→●                          │            │  ← 4½ content slots of 32px
        │ ● Rival        👁🔓 │ ●───────→●──────────→●──────────→●───────────→●       │            │    (4 from 600 to 800px tall)
        │ ● Sketch ✎     👁🔒 │ (○        )(○            )(○   )(○               )   │  ↓ 2 more ▐│  ← clipped rows: the fade, a drawn
        └───────────────────────────────────────────────────────────────────────────┴────────────┘    scrollbar and "N more"
                                                            the ruler tools' own column ┘ (the ruler and grid end before it)
```

**Simple at a glance, powerful underneath.** Everything the app can do today has a home at most as many clicks away as today, at 1440×900 and at the tier sizes people use, and from inside the sessions (Build, a camera or movieclip session, Draw) as well as from rest, except 3 low-frequency functions whose trades are documented (section 8.7 and `function-ledger.md`: the status bar's performance icon and figure count); none of the high- and medium-frequency ones is less visible than today; what is used every minute is visible, and what belongs to the thing you are working on appears **where you already look**: the tool's options in the stage header, the selection's commands in one quiet row under its name, the timeline's own view controls at the ruler's end. What is used rarely sits in **titled** sections, named menus and popovers, never in a generic "More". The first glance stays calm because of **structure**: three islands whose header rows share one line, at most three clusters per row, one type of button per row, one accent, one ink primary, one shadow, no keycaps, badges or helper prose at rest, generous spacing.

### 0.1 The balanced budget (per region, at rest), with headroom

Measured by the reference audit (Playwright, Chrome, device scale 1) in all **104 rest states** (every workspace and tool, both timeline modes, light and dark, 1920 to 500 wide, the short windows, the tier gate's sizes, every inspector context, the sessions, the VFX and Library tabs, first launch, Draw on a new file, a six-layer file, an empty scene) and in the **budget state** (Animate, a figure selected, light, 1440×900, Advanced with Camera, Scene and three layers). A control is a visible interactive element; a one-tab-stop collection (a card grid, the effect list, the recent colours, the brush presets) counts once; timeline cells, layer and tree rows (with their eye and lock), canvas joints and window controls do not count. Nothing interactive may sit inside `#viewport` or over the artboard. **Revision 4.3 also counts every visible target** (each tile of a collection by itself, every row's eye and lock, tree rows), the honest count a person meets, beside this budget count (section 0.2).

**Revision 4.1 set every budget with headroom; revision 4.3 freezes them**: no ceiling is raised again. Each region names the slot the next feature takes and the fold rule it uses, so a new visible command never has to displace an old one (the owner's "room for even more"), and where revision 4.3 used a reserved slot (Export beside a session's Done; Draw's +) the table says which slot is next.

| Region | Budget | Budget state | Most at rest | Reserved slot and fold rule for the next feature |
|---|---|---|---|---|
| Top band (excluding window controls) | ≤ 16 | 14 | 16 (Build: Save, Export, Test rig and Done; a movieclip session: Save, Export, Cancel and Done) | At rest (Animate, Draw) two slots in the actions cluster before Export; in a session the band is full (its reserved slot is Export, beside Done, as today's title bar keeps it), so a session's next command is a row of its menu. The band's fold order (labels and spacing first, the primary's word and the menubar last) |
| Rail: tools | ≤ 8 | 4 | 8 (Draw: today's + and seven tools), 7 (Build) | Draw's reserved slot is its + (revision 4.3, as today's Draw rail); a new Draw tool becomes a variant of one (the corner tick). Animate keeps four free; at the low height tier tools drop to 32px |
| Stage header: start / end | ≤ 11 / ≤ 9 | 2 / 8 | 9 / 8 | One tool option (twins, homes, then *More options*) / one view toggle (at compact and minimal a message may cover the toggles) |
| Inside `#viewport` / over the artboard | 0 / 0 | 0 / 0 | 0 / 0 | None: nothing floats over the drawing |
| Inspector (the whole island) | ≤ 30 | 23 | 28 (Build's part: the builder bar's commands and today's Rig section) | A pinned quick action and one titled line |
| Quick actions per context / open sections / titled sections | ≤ 6 / ≤ 5 / ≤ 8 | 5 / 3 / 1 | 5 / 4 / 4 | **The sixth quick-action slot is kept for a pin** (every context has at most five defaults); one open section; new features' titled sections (closed, one line) |
| Timeline header: toolbar / layer list's header | ≤ 17 / ≤ 5 | 15 / 4 (*Edit together* a glyph at rest; its word only while it is available, revision 4.3) | 16 (Draw: the Next copy split) / 4 | One slot in the start cluster (the transport slides into free space first, then labels fold to glyphs before the clusters touch) / one header slot |
| Timeline body chrome (not rows or cells) | ≤ 12 | 3 (the ruler tools' column) | 10 (Simple: the frame bar and the strip's zoom) | Two (the frame bar scrolls at the short tier); the "N more" cue appears only while rows are clipped |
| Whole window | ≤ 80 | **73** | 77 (a joint with IK's options open) | Revision 2 had 73, revision 3 had 34 but hid 258 functions, revision 4.0 had 67, revision 4.1 70; revision 4.2 added *Edit together* in the header and the stepper's one-step buttons; revision 4.3 adds nothing to this state. (Revisions 4.0–4.2 compared this with "today's 94", a number from a different count; section 0.2 has the honest comparison) |
| Readouts in the timeline header | 1 | 1 | 1 | "00:01:03", today's MM:SS:FF |
| **The default inspector fits at 1440×900** (Animate in both modes, first launch, Draw with the Brush, Draw on a new file, Build with a part), **Animate's at 1280×720 and first launch at 960×600** (revision 4.3: 1440×900 at 150%; at 800px tall and below the inspector's rhythm tightens, 26px fields; at the short tier 24px) | 0px of scroll | 0 | 0 | A rule for every workspace's default |
| **Draw at the narrow tier** (1152×720, 1024×700, 900×700): the Brush section and the drawing layer's settings in view | 0px below the fold | — | 0 | Revision 4.2 (the titled sections below scroll under the fade) |

**Draw, counted both ways.** The budget counts a collection once: Draw at rest has 74 controls. Counting every visible target (each of today's 15 presets and 6 recent colours, every row's eye and lock), Draw has 105 and Draw on a new file 93; today's app, counted the same way, shows 72 on a new file (section 0.2). Draw is calmer by structure (the cel commands in the timeline header where today's button is, Mirror as one control, Tip, Stroke, Texture and Dynamics as one titled line, a default inspector that fits), not by fewer targets: its presets, recent colours, Hardness, Brush blend and Lock alpha are visible at rest where today's need a scroll.

### 0.2 The first-glance rule

Structure, not absence, keeps the first look calm. The audit checks each rule in every rest state; **every workspace's default at first glance** (revision 4.3: the budget state and first launch in Animate, Draw with a drawing layer and on a new file, Build with a part) is held to a frozen ceiling of its own, in the budget count **and** in an honest count of every visible target.

**The honest count** (revision 4.3; `alltargets.mjs`, internal research, not in the repository; the same rule in today's app and in the reference): every visible button, field, select, slider, tab, switch, option (a card, a tile, a swatch, a brush) and tree row inside the window, each tile of a collection by itself, every row's eye and lock; window controls and the canvas are left out.

| Default state | Budget count (ceiling) | Every visible target (ceiling) | Today's app, the same honest count | Words (ceiling) |
|---|---|---|---|---|
| Animate, a figure selected (the budget state, 1440×900) | 73 (≤ 76) | 85 (≤ 86) | — (the demo file is not today's default) | 26 (≤ 30) |
| First launch (1440×900) | 70 (≤ 76) | 77 (≤ 78) | 66 | 24 (≤ 30) |
| Draw with a drawing layer | 74 (≤ 78) | 105 (≤ 106) | — | 24 (≤ 30) |
| Draw on a new file | 68 (≤ 76) | 93 (≤ 94) | 72 | 23 (≤ 30) |
| Build with a part | 61 (≤ 64) | 86 (≤ 88) | 88 | 31 (≤ 32) |

**What the honest count says.** Revision 4 shows more targets than today's app at first launch (77 against 66) and in Draw (93 against 72 on a new file): the functions today's app keeps below the fold or behind its quick bar's end (the brush's Hardness, Blend and Lock alpha, the recent colours, the quick actions, Join…, one-step order) are visible at rest, which is what the owner asked for ("everything should still be there and not completely hidden"). The first look stays calm through structure, measured by the rules below (three clusters per row, one header line, three type sizes, one accent, one ink primary, no keycaps or badges, words only where glyphs are not recognisable), and a blur comparison reads close to revision 3's visual weight and far lighter than revision 2's. Revisions 4.0–4.2 reported "73 controls (today 94)"; that compared a budget count with a different count of today's app and is withdrawn.

| Rule | Limit | Measured |
|---|---|---|
| Clusters per header row (band, stage header, timeline header) and per quick-actions row | ≤ 3, one line, never wrapping | 3 everywhere; 0 rows wrap or overflow |
| The island header line: the stage header and the inspector's tabs share their top and bottom (±1px) | 0 misaligned | 0 |
| Header rows: no two controls overlap, and each is the element at its own centre (revision 4.3: the band and the timeline header, every state) | 0 | 0 |
| Controls that carry words (weight comes from words, not icons) | ≤ 32; **≤ 30 at first glance** (revision 4.2: words where glyphs were not recognisable) | 26 in the budget state, 24 at first launch, 31 at most (Build: the part's Split and Duplicate, the Attachment buttons and Structure's foot) |
| Controls in the window at first glance | **≤ 76** (frozen, revision 4.3) | 73 (budget state), 70 (first launch: *Edit together* shows once a file has two frames, Focus once it has two layers) |
| One symbol stands for one command family (glyphs also compared by SVG content at build time; revision 4.2: across the union of every state, menus included; revision 4.3: no alias lets a frame step and a key jump share a glyph) | 0 clashes | 0 in every rest state; 0 across all 200 states |
| Values: every input and select keeps its whole text (inputs with a spare character); control labels never cut | 0 | 0 in every state |
| First launch shows no state marks (a has-audio dot, onion, a toggled layer, a scope line) | 0 | 0 |
| **Fields** (revision 4.2): an outside-labelled select in the inspector; a label wider than its tile or button; two tiles of a collection drawing the same thumbnail; a menu checkmark that disagrees with its toggle; a scope line without its range drawn; Build not naming the figure it edits; **revision 4.3: two controls of one entry showing two states** (Edit together's header toggle, the range inspector's switch, the Simple frame bar's switch and its menu row) | 0 | 0 in every state |
| **The ruler** (revision 4.3): every frame of the painted range, the playhead tab and both onion ends are hit on the ruler (never under a tool); an onion end never reaches into the Camera row | 0 | 0 in every state |
| Accent-pressed toggles at rest (modes that change what edits do); view toggles are quiet when on | ≤ 1; **0 at first glance** | 0 |
| Type sizes in the chrome at rest | ≤ 5 | 3 in the budget state, 4 at most |
| Ink primaries / keycaps / chips, badges, helper sentences / drop-shadow levels | 1 / 0 / 0 / 1 | 1 / 0 / 0 / 1 |
| Labels | ≤ 3 words (≤ 2 in the header rows) | 0 longer |

### 0.3 The task rule and the function rule, at 1440×900 and at the tier sizes

**How "visible" and "clicks" are counted (revision 4.2).** A target counts as visible only where a person can click it: drawn, inside every clipping ancestor (a large target such as the timeline grid or the canvas needs a visible part) and the element at its centre (a control under the timeline header is not visible); **a target a scroll container must scroll to, or one under the inspector's fade, costs one more step**. Today's side is measured the same way in the live app. Every function is counted by itself: a group's "2–3" never stands for its best case. The reviewers showed that revision 4.1's checks (display, visibility and opacity only; group ranges scored on their lower end; only "visible at rest" → hidden failing) could not see T38's clipped Halo colour, Build's lost *Fit figure* or the paste variants behind a submenu.

- **No task takes more steps than today.** The representative tasks of the task study (internal research, not in the repository) are data in `design/app-ui/reference/tools/tasks.json` (today's measured steps, P + K + T + F, and revision 4's route with a selector and a state for every step; a task may declare an alternative route of its own, `rev4.alt`, and the cheaper counts at each size). The audit checks that each route adds up, that every named target is visible in its state (clip-aware, above), and that no task is longer than today. **Revision 4.3 adds eight tasks the first 45 could not see** (T46–T53): hide the fourth layer, lock the fifth, and select the fifth and add a frame, in a six-layer file (the timeline's row capacity); adjust the camera and then pose a figure; Export in Build and in a camera session; start a drawing in a new file; split a limb while animating. **Result, counted without the two behaviours awaiting sign-off (section 11: the view popovers that pass the next click through, T28; *Ease new keys*, T39): the 52 tasks reachable today take 159 steps today and 150 in revision 4.3, 7 shorter (T08, T11, T12, T19, T25, T29, T34), 45 the same, 0 longer; with those two behaviours 148, 9 shorter.** On the desktop build, where T25 is already 3 today (MP4 is first), today takes 157. Reset pose (T16), unreachable today, takes 2. At 1440×900 the only scrolls are T47 and T48's, which today's app needs too (its fifth row shows 12px).
- **The tier gate.** Every task runs again at **1280×720, 1152×720 and 960×600 (1440×900 at 125% and 150% UI scale), 1100×700, 1024×700 and 900×700**, clip-aware on both sides: a step whose target is folded or needs a scroll at that size costs one more step, and today's own route gains one where today's control is hidden or needs a scroll (Save below 1101px, First frame below 961px, and, measured in revision 4.2, the figure's colour field and the joint's Width field at all six sizes). **Result: 0 tasks longer at any of the six sizes, the six-layer tasks included** (today's fourth row is whole and its fifth needs a scroll at every size; revision 4.3 keeps four whole content rows in view at every tier size; measured by `today-six`, internal research, not in the repository). Where revision 4's own route needs a scroll it is counted: T14 and T15 at 960×600 (as today's), T39 at 960×600 (the camera's switch: 5, as today), T20 at 960×600 through its declared alternative, the selection menu's *Join to figure* (3, as today), T23 at 960 and 900px (Save folds into File there, as today's app hides it below 1101px), and T47 and T48 everywhere (as today). T38 is 6 at every size, as today. **Words where today's app shows them** (revision 4.3, checked at every tier size): *Add frame* keeps its word wherever today's does (from 1101px), *Export* at every tier size, and a session's *Done* too.
- **No function is further away than today.** `design/app-ui/reference/tools/ledger.mjs` maps all 852 rows of the three inventories to revision 4's home, clicks and visibility, from the same rest state, **per function**, and fails on any row with more clicks than today unless it is a documented trade. **Result: 96 rows are closer or newly reachable, 753 the same; 3 further, all low-frequency documented trades** (the status bar's performance icon, HE-02 and SB-04, and its figure count, SB-03, move to the slow-playback message, Help and the Scene's meta line). **Revision 4.3 removes the 13 segment-surgery trades** (R31): the joint menu's *Edit part ▸* runs today's Editor-menu commands in Animate, 3 clicks as today, saying which figures change and offering Undo (revision 4.2 counted its round trip through Build as 6 or 7). Revision 4.1 reported 201 closer and 15 further because group ranges were scored on their best case; counted per function, 111 rows needed their own count and three were further (the paste variants, now flat in the Scene and selection menus, 2 as today; SB-04, a trade).
- **The same, from inside the sessions** (revision 4.3). The rows above count from rest; the ledger also counts from inside Build, a camera session, a movieclip session and Draw, where today's app keeps its title bar (Save, Export, the menubar, Undo), the figures' joint handles with the Camera selected, and Draw's +. **Result: 13 checked, 0 further or less visible** (Export beside Done; a joint drag in the camera session poses and ends it, as today; Draw's + is today's New drawing layer and its corner tick adds an image to trace in 2 clicks, today 3).
- **The same, at the tier sizes.** The ledger reads which of revision 4's surfaces are folded or need a scroll at each tier size (measured in the reference) and which of today's are hidden or need a scroll at the same size (measured in today's app, `design/app-ui/reference/tools/today-tiers.json`), and fails on any row further than today there. **Result: 0 rows further at any of the six sizes.** The folds at those sizes: Draw's recent colours at the narrow tier (into the colour picker's *Recent*; today's inspector swatches need a scroll at every one of those sizes), Pen pressure (its home, Brush details › Dynamics, as today) and Smooth at 900px (into *More options*, where today's quick bar cuts it off), Draw's Mirror as its twin in the Brush grid (at 960×600 the twin needs a scroll, as today's vertical mirror toggle does at every size), Build's Highlight part and Static handles (at 900–960px, into *View › Build*, today's builder View ▾ is a third click too), and Save at 960 and 900px (into File; today's app hides it below 1101px).
- **No function is less visible than today.** Each row's visibility is one of yes (drawn at rest), ctx (drawn once its context is selected or opened), hover and no (a menu, key, modifier or gesture). **Revision 4.2: any step down fails a high- or medium-frequency row**, and "yes" → hover or no fails every row; today's visibility is re-measured where the inventory was wrong (P207: the effect card's ⋯ is drawn at full contrast). **Result: 0** without a documented reason; the documented ones are the status bar (R26: Performance, HE-02, and its idle message, SB-01) and a library card's ⋯, on the selected card and on hover (P237), where today shows the card actions only after a selection.
- **Every visible home is drawn.** The ledger checks that each home it calls visible names a control (or a selector) that exists in the reference: **60 checked, 0 missing.** The full table is `function-ledger.md`; section 8 is the command-level view.

### 0.4 Ten rules the whole experience obeys

1. **Nothing lost, nothing further, nothing less visible.** Every function keeps a home at most as many clicks away as today, at 1440×900 and at the tier sizes, from rest and from inside the sessions (3 low-frequency trades are documented, section 8.7), **counted per function** (a group's range never stands for its best case) and **clip-aware** (a control that needs a scroll costs one more step); high-frequency functions are visible and one click (or one direct gesture) away in their context; medium ones at most two clicks along a **labelled** path; a generic `⋯` or "More" is never the only path to a medium-frequency function; **a high- or medium-frequency function never becomes less visible than today** (visible at rest → in context → on hover → behind a menu, key or modifier: any step down fails the ledger unless it is a documented trade); nothing visible at rest today becomes hover-only.
2. **Context where you already look.** The tool's options in the stage header; the selection's commands under its name; a section opens by itself when its content matters now (Connection while joined, Parallax while on, IK's options while Use IK is on).
3. **Calm through structure.** One 40px header row per island, on one line; at most three clusters per row; one control size per row; titles instead of boxes; whitespace instead of dividers.
4. **Visible state.** Every mode or overlay that is not at its default shows it where it lives: the scope line (Edit together), the pressed Whole branch, Mirror, Isolate and Loop, the has-audio dot (only when there is sound), a hidden layer's eye-off and a locked layer's lock (at full contrast), the grid toggle's pressed state, VFX's Apply to and a filter that hides effects.
5. **The artboard is the hero.** Nothing floats over it; the stage header sits above `#viewport`; an empty scene is an empty artboard.
6. **Feel at home.** Today's arrangement (tools left, stage centre, Properties right, timeline across the bottom), today's menubar and Save, today's canvas crumb, today's readout, today's keys drawn better, today's defaults, at the window sizes people use.
7. **One registry.** Every command is one registry entry; a visible home and the context menus that list the same command are one entry, not two homes; the palette, hotkeys and the menubar are indexes (section 8).
8. **One primary, one message, one accent.** Export in the band (a session's Done, with Export a quiet button beside it); the primary keeps its word at every tier size; one message at a time in the stage header's centre; blue for selection, the current frame and the active tool.
9. **Recognise, then read.** Icons carry tooltips with the shortcut ("Bring to front · Shift: one step"); **words where glyphs are hard to tell apart** (To front, To back, Save, Join…, Isolate, Level, Centre, Edit together, Split, Duplicate, Remove keys, the Match pair's label, Test rig, Next copy, Order); **one grammar** (revision 4.3): a label that belongs to glyphs shares one tile with them (*Match ◀ ▶*, *Order ↓ 2 ↑*), a word button has the same gap and hover tile as a glyph button; one symbol stands for one command family (the audit fails a clash across every state, and the build compares glyphs by their drawing, not their names); labels only where they carry the promise, three words at most.
10. **Quiet during playback, room to grow.** Only the readout and the playheads change while playing. New features add a registry entry, a quick action (the free sixth slot, or a pin), a tool option or a titled section, never a layout change; every region's budget keeps a named slot free, and where a reserved slot is used (revision 4.3: a session's Export; Draw's +) it names the next path (a session menu row; a tool variant); ceilings are frozen, never raised.

---

## 1. Shell and layout model

The *stored* model (schema fields, merge rules, solver inputs and outputs, `window.styk.workspace`) is written once, in `ui-architecture.md` §3.11. This section describes what people see and do. Revision 4 keeps revision 3's model (panels Shown / Strip / Hidden, at most two floating panels, per-workspace arrangements with shared sizes, the rail left or right, `dock-host` as the single owner of visibility) and changes the stage island's inside.

### 1.1 Regions

| Region | Element (hook kept) | Contents | Wide-tier size |
|---|---|---|---|
| Top band | `header.titlebar` | Mark (the StykAnimate menu), **the menubar** (File, Edit, View, Animation or Figure, Help), document button; the workspace switch; Undo, Redo, **Save**, Export (or a session's Cancel and Done; Build's *Test rig* and Done), window controls | 44 at every tier, on the mist field |
| Rail | `nav.studio-rail > .tool-dock` | The current workspace's tools (a tool with variants keeps today's small corner tick) | 48 (40 with 32px tools at minimal width or the low height tier) |
| Left dock | `aside.shell-left` | Empty in Animate and Draw; Structure in Build (it narrows to 200, then becomes a 40px strip, wherever docking it would leave `#viewport` under its 360px floor) | 232 |
| Stage | `main.shell-stage` → **`.stage-head`** + `#viewport` | **The stage header** (40px): the tool's options or the location, the one message, the view toggles, zoom and Fit. Below it `#viewport`: the artboard, `#scene`, `#overlay` | All remaining space |
| Right dock | `aside.right-panel` | Properties, VFX, Library tabs; Properties ends with the Add to library footer | 288 (272 regular, 256 narrow, docked down to 801px; user 256–360) |
| Bottom dock | `section.timeline-panel#animation-timeline` | The timeline header; the Simple frame bar and filmstrip, or the Advanced sheet with the layer list's header and the ruler's tools | One user-owned height (section 1.9); spans the stage and the right dock |
| Overlay layer | top layer | Menus, popovers, sheets, palette, dialogs | — |

Workspace grid (`.workspace`, keeps `data-mode=animate|draw|rig`): columns `[rail 48] [left 0|232 (40 as a strip)] [stage 1fr] [right 288 (0 at compact and minimal)]`, gap 6, padding `0 8 8 0`; rows `[main 1fr] [timeline]`; areas `"rail left stage right" / "rail tl tl tl"`. With *Timeline width: Under stage* the right dock runs full height. Build has no timeline row by default (its timeline is Hidden, as today; the Timeline toggle among Build's view toggles shows it).

**The island header line.** The stage header, the inspector's tabs, Structure's head and the timeline header are all 40px with a 1px hairline under them, and the first three share one line across the window (the audit checks it). This single line is the most important structural cue of revision 4: whatever changes with context changes inside that line or under it, never around it.

### 1.2 Measured geometry (reference build)

Artboard zoom = `min((W − l − r) / 960, (H − t − b) / 540, 2)` on `#viewport` (below the stage header) with the insets of section 1.9. Rows are written "pinned + content slots"; revision 4.3's slots are 4½ above 800px tall, 4 from 600 to 800px and 3 from 569 to 599px, with Camera and Scene as 24px pinned rows (section 1.9). Today's app, for comparison: 236px of timeline rows at every size (Camera, Scene and 4.38 content rows), and an artboard of 81% at 1440×900, 47% at 1280×720 and 1152×720, 44% at 1024×700, 25% at 960×600.

| Window | Tier (width / height) | Timeline | Artboard zoom | `#viewport` |
|---|---|---|---|---|
| 1440×900, Advanced (2 + 4½ slots) | Wide / tall | 264 | **91%** (revision 4.2: 95% with 2 + 3 slots; today 81%) | 1084×538 |
| 1440×900, Simple (the same height) | Wide / tall | 264 | **91%** | 1084×538 |
| 1440×900, first launch | Wide / tall | 264 | 91% | 1084×538 |
| 1280×720, Advanced (2 + 4) | Regular / tall | 248 | **66%** (revision 4.2: 68% with 2 + 2; today 47%) | 940×374 |
| 1152×720 (1440×900 at 125%) | Narrow / tall | 248 | **66%** (everything docked) | 828×374 |
| 1100×700 | Narrow / tall | 248 | **62%** | 776×354 |
| 1024×700, Advanced (2 + 4) | Narrow / tall | 248 | **62%** (today 44%) | 700×354 |
| 960×600 (1440×900 at 150%) | Narrow / short | 224 (4 rows of 28 under a 24px ruler) | **49%** (everything docked; today 25%) | 636×278 |
| 900×700 | Narrow / tall | 248 | **56%** (everything docked) | 576×354 |
| 800×600, Advanced (2 + 4) | Compact / short | 224 | **49%** (the inspector a sheet) | 744×278 |
| 700×600 | Compact / short | 224 | **49%** (the menubar still docked) | 644×278 |
| 1920×520 (top-half Snap on 1080p) | Wide / low | 40 (header; the body opens as a sheet) | **69%** | 1572×388 |
| 960×520 | Narrow / low | 40 | **63%** | 644×388 |
| 911×485 (1366×768 at 150%) | Narrow / low | 40 | **58%** | 595×353 |
| 1000×450 | Narrow / low | 40 | **56%** | 684×318 |
| 853×453 | Narrow / low | 40 | **52%** | 537×321 |
| 823×514 (1440×900 at 175%) | Narrow / low | 40 | **49%** (today: 17%) | 507×382 |
| 640×480 | Minimal / low | 40 | **60%** | 596×348 |
| 601×441 | Minimal / low | 40 | **54%** | 557×309 |
| 500×340 (1000×680 at 200%) | Minimal / low | 40 | **36%** | 456×208 |
| 1440×900, Build | Wide / tall | Hidden | 82% (fit canvas, as today) | 846×808 |
| 1024×700, Build | Narrow / tall | Hidden | 44% | 462×608 |
| 962×700, Build (Structure docked, 232) | Narrow / tall | Hidden | 38% | 400×608 |
| 900×700, Build (Structure docked, 200; today's outliner 236 and a 29% artboard) | Narrow / tall | Hidden | 33% | 360×608 |
| 800×600, Build (Structure strip) | Compact / short | Hidden | 69% | 704×508 |
| 500×340, Build (Structure strip) | Minimal / low | Hidden | 41% | 416×252 |

The stage header costs 40px of `#viewport`, and the insets it frees (nothing sits inside `#viewport` any more) pay for it: the bottom inset drops from 52px to 24px because the message and the zoom moved to the header. Revision 4.3 spends part of that gain on today's layer capacity: the budget state's artboard is 91% (revision 4.2 95%), still above its 90% floor and far above today's 81%. Revision 4.1 keeps the inspector docked from 801px (as today), so the narrow windows' shares are a few points lower than revision 4.0's at 853px and a few higher at 911 and 960px (narrow insets 20); every one stays above its floor.

### 1.3 Panels

Every panel is described once in the panel registry (architecture §3.11.1). Existing roots move between hosts with `append()`; they are never re-created.

| Panel | Default home | Allowed regions | Float | Workspaces | Folds to |
|---|---|---|---|---|---|
| Properties | Right, tab 1 | left, right | no | all | strip |
| VFX | Right, tab 2 | left, right, float | yes | all (Build shows it too, as today) | strip |
| Library | Right, tab 3 | left, right, float | yes | all | strip |
| Structure | Left | left, right | no | Build only | 200 wide, then a strip, wherever docking it would leave `#viewport` under 360px (below about 890px with the inspector docked) |
| Timeline | Bottom, full width | bottom only; full width or under the stage | no | all (Hidden in Build by default, as today) | Strip (the header row) |

- **The rail and the stage are not panels.** The rail's side is part of the arrangement; the stage never moves.
- **No separate Layers panel.** Advanced shows layers in the timeline's label column, whose header holds New layer (a split button) and Find layers. Simple shows the layer it edits in its frame bar (*Layer · ● Bubble ▾*), which opens the Layers popover: the same rows, eye and lock, drag to reorder, New layer and New drawing layer in its foot. Clicking a row selects the layer (the Layer inspector); a right-click or Shift+F10 opens the row menu.
- **Tab reset.** Entering Draw or Build activates Properties; returning to Animate restores Animate's last tab. Build keeps today's three tabs.

### 1.4 Dock model (deliberately limited)

| Concept | Rule |
|---|---|
| Regions | Left, right, bottom, plus at most two floating panels (VFX, Library) per workspace. |
| Panel state | Shown, Strip or Hidden (stored `docked`, `strip`, `hidden`); *Hidden* is the one user-facing word; the tab menu's command is *Hide*. The timeline is Full or Strip outside Build (Play must stay on screen); in Build it is Hidden by default, as today, and the Timeline toggle among Build's view toggles, `Ctrl+4` or *View › Panels › Timeline* shows it. |
| Strip | A folded region is a 40px column of icon buttons; a click opens the panel as a sheet over the stage (never resizing `#viewport`). |
| Floating | VFX and Library only, inside the stage rectangle, snapped to a dock zone within 24px, clamped on resize without rewriting the saved position. At compact and minimal width they open as sheets. |
| Size changes | Splitters (between the islands, and the label column's own edge), docking and folding commit instantly, coalesced to one layout per frame. Nothing next to `#viewport` animates its size. |

### 1.5 How people organise their layout

Three paths; every drag has a menu and a keyboard path (WCAG 2.5.7). No path adds chrome at rest.

**1. The Layout popover** (*View › Layout…*, `Ctrl+Alt+L`): presets as small dock maps (Animate, Timing, Focus, Review, then saved ones), one position select per panel (Properties: Right │ Left │ Hidden; VFX and Library: With Properties │ Left │ Floating │ Hidden; Timeline: Full width │ Under stage; Tools: Left │ Right), and a foot with *Reset* and *Save as preset…*.

**2. Direct manipulation**: drag a tab (or a strip icon) out of its island. One calm target appears where the pointer is (a soft accent fill with a small label: *Dock left*, *Dock right*, *Add as a tab*, *Float here* with Shift). Release commits; Esc or a window blur cancels.

**3. The tab's context menu and keyboard.** Right-click a tab (or Shift+F10): *Dock left*, *Dock right*, *Float* (VFX, Library), *Fold to strip*, *Hide*. Keys:

| Keys | Command id | Effect |
|---|---|---|
| `F6` / `Ctrl+F6` | `focus-next-region` / `focus-previous-region` | Cycle regions: band → rail → left dock → stage header → stage → right dock → timeline → floating panels |
| `Ctrl+1` / `Ctrl+2` / `Ctrl+3` | `panel-toggle-properties` / `-vfx` / `-library` | Show and focus the panel; pressed again, fold it |
| `Ctrl+4` | `panel-toggle-timeline` | Timeline Full ↔ Strip (Build: shown ↔ hidden) |
| `Ctrl+\` | `layout-focus` | Focus on/off |
| `Ctrl+Alt+M` | `layout-arrange` | Move the focused panel with the arrow keys between allowed regions, Enter commits, Esc cancels |

**Room to grow.** Every context shows at most **five** default quick actions, so its **sixth slot is free for a pin**: a person can pin any command to a context's quick actions from its menu row's context menu (*Pin to quick actions*), and pins are stored with the layout (per workspace); a second pin takes the slot of the context's last default, which stays in the context's menu. Features add titled sections to an inspector context through the section registry (architecture §3.13), in a declared order, closed by default.

### 1.6 Presets per workspace

Each workspace has its own arrangement; sizes are shared (the `docs/animation-modes.md` contract).

| Workspace | Preset | Arrangement |
|---|---|---|
| Animate | **Animate** (default) | Rail left · inspector right (Properties, VFX, Library) · timeline full width |
| | **Timing** | Timeline full width and tall · inspector Properties only; stores 40% of the workspace in the one shared timeline height (section 1.9) |
| | **Focus** | Rail and stage; inspector and timeline Strip (a toggle that restores) |
| | **Review** | Inspector Hidden, timeline Strip |
| Draw | **Draw** (default) | As Animate |
| Build | **Build** (default) | Structure left · inspector right · timeline Hidden, as today |
| | **Build + timeline** | As Build, timeline shown |
| any | Saved presets | Up to 8 per install, tied to the workspace they were saved in |

Timeline mode (Simple or Advanced) is a setting, not part of a layout.

### 1.7 Saved presets, Focus mode and persistence

- *Save as preset…* asks for a name inline (48 characters). A saved preset card's context menu offers *Rename…*, *Update*, *Delete*; eight at most (when full, *Save as preset…* is disabled with the reason "8 presets saved. Delete one first."). *Reset* returns the workspace to its default; *Settings › Interface › Panel layouts › Reset all* resets every workspace and the shared sizes.
- **Focus mode** (`Ctrl+\`, *View › Focus mode*, or the Focus preset) snapshots the arrangement, folds the side panels and the timeline to strips, and restores the snapshot on the second press. Per workspace; survives restart.
- Layouts persist in `workspace-preferences.json` (localStorage in the browser build). An older StykAnimate still opens with the person's sizes; a layout written by a newer StykAnimate is never overwritten; fitting a layout into a small window never rewrites it; two windows no longer erase each other's layouts in normal use.
- **Remembered interface state (revision 4), without changing defaults:** the open state of each titled section per context kind, quick-action pins, the last tool variant, the last Tweener mode, the last Add menu item's position, the export format and size (as revision 3; the size starts on Original, today's default), and the readout's Time │ Frames choice (Time, today's MM:SS:FF, by default). The camera's *Ease new keys* is an opt-in for the session and is never remembered across sessions. First-run defaults are today's.

### 1.8 Responsive tiers

The solver measures the `#app` content box (CSS px after the 75–200% UI scale) and writes **two independent tiers**: `:root[data-tier]` from the width (folds horizontal chrome only) and `:root[data-height]` from the height (folds vertical chrome only). **Folding hides labels first, then moves items into their declared path; nothing is ever silently lost.**

**Width tiers** (`data-tier`):

**Revision 4.1: the tiers keep what today's app keeps.** Today's app (measured at `c82312fb`, `design/app-ui/reference/tools/today-tiers.json`) keeps its menubar, its 292px inspector, its view pill, its workspace tabs and *Simple │ Advanced* at every width down to 600px, and its frame rate down to 801px; it hides Save below 1101px, the Scene crumb below 1025px and First frame below 961px. Revision 4 folded the menubar and the frame rate from 1180px and the inspector, the view toggles, the switch and *Simple │ Advanced* from 900px, which made common setups (1440×900 at 125% is 1152×720 CSS px, at 150% 960×600, 1366×768 at 125% 1093px, half-screen windows) one click further for everyday commands. Revision 4.1 keeps all of them docked from 801px, folds the band's labels and spacing before its menubar, and checks every function and task again at those sizes (section 0.3).

| Tier | Trigger | What changes |
|---|---|---|
| **Wide** | ≥ 1367 | The saved layout. Inspector 288. |
| **Regular** | ≤ 1366 | Inspector 272. |
| **Narrow** | ≤ 1180 (down to 801) | Inspector 256; label column 168; island padding 14; stage insets 20. **Everything stays docked**: the menubar, the inspector, the view toggles, the workspace switch, *Simple │ Advanced*, the frame rate, Loop, First frame and Audio. The band folds its labels and spacing in its fold order (below). Tool options fold their labels, then their **twins** (the option shows in its tool's inspector section instead: Draw's Mirror pair, the same two clicks as today's inspector toggle; the recent colours always live in the tool's section, as today) and **homes** (Pen pressure folds back to Brush details › Dynamics, today's third click), then into *More options* only what today's quick bar clips at that width (Smooth from 900px, then Flow). In Build, Structure narrows to 200px before it folds, and Highlight part and Static handles fold into *View › Build* when the stage header is full (today's builder View ▾ is a third click too). |
| **Compact** | ≤ 800 | The inspector becomes a sheet opened from the band's Properties button (the same `#inspector` root moves into the sheet, whatever is selected). The frame rate folds into the Scene's Rate and Go to frame (today's app hides it at 800 too). Label column 156. The view toggles, the switch's three segments and *Simple │ Advanced* stay; a message may cover the view toggles while it shows. The menubar stays docked while the band fits (Animate: down to 700px). Dialogs become full-window sheets. |
| **Minimal** | ≤ 660, or wherever the band does not fit even with every step of its fold order | **The menubar folds into the mark** (the StykAnimate menu gains File, Edit, View, Animation or Figure and Help as submenus; Alt shows the menubar as an overlay). Rail 40 with 32px tools. *Add frame* and *Next copy* show their glyphs only. **First frame, Loop, Audio and Edit together fold into *Timeline ⋯*** (rows at its top; Edit together also stays the range inspector's switch). The crumb drops the size. Nothing in the band overflows; the window controls stay inside the window. |

**The band's fold order** (measured, not a tier; each step applies only while the band still overflows). **Revision 4.3: the ink primary keeps its word longest** (today's app keeps "Export", and Build's "Done", at every width it fits; the newcomer's first launch at 1024 and 960px showed a wordless black circle in revision 4.2): the document state's words fold to its dot → the menubar's spacing tightens → the document name truncates to 12 characters, then to 8 (with its ellipsis; the full name is its tooltip and the Document popover) → Save shows its glyph only → *Test rig* shows its glyph → Save folds into File (today's app hides Save below 1101px) → the window controls narrow to 36px → a session's quiet Export shows its glyph → the workspace switch drops its dots and some padding (its names stay) → the switch shows its three glyphs (never a pill; each keeps its tooltip and one click; Build's glyph is a bone) → the document name folds to its dot → Redo folds into Edit → a session's quiet Export folds into File (Ctrl+Shift+E) → **only then, last of all, the primary's word**. Only then, at the minimal tier, does the menubar fold. **Measured with three names** (the demo's "Kick combo", a new file's "Untitled animation" and "Fight scene storyboard final v3") and in every session: the primary keeps its word at every tier gate size and wherever the menubar is folded (`bandfolds.mjs`, internal research, not in the repository); at 900px the switch keeps its names (without their dots); at 860–801px it shows its glyphs; in Build at 1024px Save is in File, Export and Test rig are glyphs and Done keeps its word (`reference/57`). The only places the primary shows its glyph: a compact Animate band at 661–700px and a movieclip session at 800px, where the docked menubar (two clicks to any command, as today) is kept instead (a tier trade below).

**Height tiers** (`data-height`):

| Tier | Trigger | What changes |
|---|---|---|
| **Tall** | ≥ 641 | The default timeline height (section 1.9): Camera and Scene as two compact pinned rows and **4½ content slots above 800px, 4 from 641 to 800px**. `#viewport` insets top and bottom 24 above 800px, **10 from 641 to 800px** (revision 4.3: the insets give way before the rows do). At 800px and below the inspector's rhythm tightens (26px fields). |
| **Short** | 569–640 | The Advanced timeline shows Camera, Scene and **four whole content rows** (revision 4.3: 28px content rows, a 24px ruler, 224px in all; **three below 600px**, where four would put the artboard under its floor); the Simple frame bar tightens (its title line drops); the inspector's fields are 24px. Insets 8 / 8. |
| **Low** | ≤ 568 | **The timeline is its 40px header**; `⋯` starts with *Timeline…*, which opens the timeline body itself as a bottom sheet over the stage (the label column with its header, the ruler with its tools, the grid; or the Simple frame bar and filmstrip). The rail compacts to 40 with 32px tools. Insets 8 / 8. The stage header stays 40px (it holds the view, the zoom and the message). |

**Why 568.** Below it, docking even the short body would leave the artboard under 45%; the body is one click away as a sheet.

**Build: Structure** starts folded to its 40px strip (2026-09 Build redesign), so the figure gets the stage: Build at 1440×900 fits the canvas at 99% instead of 79%. The strip's buttons open Structure as a sheet over the stage, and Fit, Timeline and Snapping stay on it. Docked again (its tab menu, or the strip), Structure stays docked while `#viewport` keeps its 360px floor: 232 wide, then 200, then its strip (always at compact and minimal width; at narrow below about 890px).

**Never hidden:** the document state (at least its dot), Undo, Export (or the session's Done), the workspace switch's three segments, the window controls, zoom and Fit, the view toggles (a message may cover them for its moment at compact and minimal width), *Simple │ Advanced*, and, outside Build, Play, Add frame and Onion. **From 801px also** the menubar, the docked inspector and its quick actions, and the frame rate.

**Collapse order.** Width: the band's fold order (labels and spacing, the primary's word last) → tool options (labels, twins and homes, then *More options* for what today's quick bar clips) → Build's left dock (200, then a strip) → the timeline header (revision 4.3: first the transport slides into the header's free space; then *Edit together*'s word, *Next copy*'s word, and only below about 860px *Add frame*'s word, where the three clusters cannot keep their gap otherwise; today's app shows Add frame's glyph below 1101px) → the inspector (a sheet, 800px) → the frame rate (into the Scene, 800px, as today) → the menubar (into the mark, minimal) → First frame, Loop, Audio and Edit together (into ⋯, minimal). Height: the vertical insets (24 → 10 → 8) → timeline rows (scroll, with the "N more" cue) → the short timeline → the timeline body (a sheet) → the rail's tool size.

**Tier trades** (the only places a function is further than today's app at the same size, all below the tier gate's sizes, each for the stage): at 661–800px the inspector is a sheet (+1 for a property edit; today keeps a 230–292px inspector there with a 25–42% artboard; revision 4.3 gives 49%); at 700px and below Redo folds into Edit; at 660px and below the menubar folds into the mark (+1 for File, Edit, View, Animation and Help); in Build below about 890px Structure is a strip (+1; today keeps a 236px outliner and a 29% artboard); at the low height tier (568px and below: 1440×900 at 175% is 823×514) the timeline body is a sheet (+1 for rows and keys; today keeps its timeline body there and a 17% artboard at 823×514, revision 4.1 gives 49%). **Revision 4.3 adds two, both labels or a row, both for the stage floor:** from 569 to 599px tall the default timeline shows three content rows (today's app 4.38 there, with a 22–25% artboard; a fourth row is one scroll away and the "N more" cue says so); and at 661–700px in Animate and at 800px in a movieclip session the ink primary shows its glyph (today's app keeps "Export" and "Done" there; revision 4 keeps the docked menubar instead). The function ledger lists them per size (`function-ledger.md`, the tier check).

### 1.9 Stage-space guarantee and the timeline height

- **Insets.** `#viewport` holds nothing but the canvas, so its insets are pure clearance around the artboard at fit: horizontal by the width tier (28 at wide and regular, 20 at narrow and compact, 10 at minimal), vertical by the height (revision 4.3: 24/24 above 800px, 10/10 from 641 to 800px, 8/8 at the short and low tiers; they give way before the timeline's rows do). The audit checks at least 8px of clear space on every side in every state.
- **Timeline height** is user-owned: one height for every workspace and both modes, taken once and afterwards changed only by the splitter (120px to 60%), **Tall timeline** (the ruler tools' column; double-click the splitter for the default), *Timeline ⋯ › Default height* or the Timing preset. **The default gives at least today's layer capacity** (revision 4.3; today's timeline shows Camera, Scene and 4.38 content rows at every size, so its fourth layer is whole and its fifth shows 12px): **Camera and Scene are two compact 24px pinned rows** (their keys, eye and lock as today, in a thinner row, so they never take two of the few content slots), then **4½ content slots of 32px in windows taller than 800px** (264px with the header and the ruler at 1440×900), **4 from 600 to 800px** (248px at 1280×720 and 1024×700; at the short tier 4 rows of 28px under a 24px ruler, 224px at 960×600), and 3 from 569 to 599px (a tier trade, section 1.8). The stage floors hold because the vertical insets give way first, never the rows. **Nothing changes the height automatically**: more layers, the VFX tab's effect rows, the audio lanes and switching Simple ↔ Advanced keep it, so the artboard never moves on a routine click.
- **When rows are clipped, the list says so** (revision 4.3; revision 4.2 promised it but drew neither): a soft 12px fade under the last visible row (it never hides a whole row's eye and lock), **a drawn thin scrollbar** in the ruler tools' column (the painter draws it, as today's canvas timeline does, so it shows whatever the platform's scrollbar setting), and at its foot **"N more"** (a quiet button with a down arrow: "2 more" in a six-layer file at 1440×900; a click scrolls the next rows in; its name says "2 more layers below"). With Audio open at 1280×720 the lanes take their row under the layers and the list shows two whole rows and the cue (today's app shows two layer rows beside its larger audio panel).
- **The ruler tools have their own column** (revision 4.3): zoom, *Fit timeline* and *Tall timeline* sit in a 148px column at the ruler's right end (132 at narrow, 116 at compact and minimal); **the ruler and the grid end before it**, so no frame, ruler number, playhead tab or onion end ever sits under a tool, and *Fit timeline* fits the animation into the width that remains. Under the tools the column is the list's quiet margin (the drawn scrollbar and the cue). The painter keeps the playhead tab and both onion ends inside the ruler (it scrolls the view when they would leave it). The audit hits every frame of the painted range, the playhead tab and the onion ends at their centres in every state.
- **Stage floors, monotonic across tiers.** Every window at least as large as a row below gets at least that row's artboard zoom (Animate, Draw and the sessions; Build is held to `#viewport` ≥ 360×200). The audit resizes one live page through **3,828 sizes** (33 widths × 29 heights, in Animate, Draw, a camera session and Build): **0 sizes under their floor**, 0 stages under 360×200, 0 overflowing bands, 0 window controls outside the window, 0 pages taller than the window. The smallest margin is 1 point, at 500×340 (36% against 35%).

| Window at least | Artboard zoom floor |
|---|---|
| 500×340 | 35% |
| 600×441 | 45% (revision 4.1: up to 1023px wide; the 800×600 row of 50% is dropped because the inspector stays docked from 801px, as today, where today's artboard is 42–44%) |
| 1024×700 | 60% |
| 1280×720 | 65% |
| 1440×900 | 90% |

| Guarantee | Target | Reference |
|---|---|---|
| 1440×900, Advanced and Simple | ≥ 90%, the same in both modes | 91% (revision 4.3; today 81%) |
| A tab switch, a mode switch, a new layer, switching tools within a workspace | the artboard does not move | 91% in `reference/01`, `03`, `13`, `35`, `43`, `189` |
| 1280×720 / 1024×700 / 800×600 | ≥ 65% / 60% / 45% | 66% / 62% / 49% |
| The tier gate's sizes: 1152×720, 1100×700, 960×600, 900×700 (everything docked) | ≥ 60% / 60% / 45% / 45% | 66%, 62%, 49%, 56% |
| **The default timeline's layer capacity** (revision 4.3) | at least today's: four whole content rows at every tier size (today 4.38, its fifth row 12px) | 4½ slots at 1440×900, 4 at 1280×720 to 900×700 and at 960×600; 3 from 569 to 599px tall (a tier trade) |
| Short windows (1920×520, 960×520, 911×485, 1000×450, 853×453, 823×514, 640×480, 601×441) | ≥ 45%, the inspector and switch kept from 801px | 69%, 63%, 58%, 56%, 52%, 49%, 60%, 54% |
| 500×340 | ≥ 35%, no clipped control | 36%, 0 off-screen targets |
| `#viewport` in every state and workspace | ≥ 360×200 | 456×208 at 500×340; Build at 900×700 with Structure docked: 360×608 |
| Clear space around the artboard at fit, inside `#viewport` | ≥ 8px | ≥ 8px in every state |
| Anything over the artboard | never | 0 in every state |
| The page | exactly one window | 0 in every state and every swept size |
| Every layer row, tree row, frame card, library card, brush preset and effect tile in the state's model | on screen, scrollable to, or reached through the tier's declared path | 0 unreachable; rows folded at the low tier are reached through *Timeline ⋯ › Timeline…*, Build's tree through the Structure strip, the inspector's presets at compact through the band's Properties button |

---

## 2. Top band

```
[✶▾] File Edit View Animation Help  [Kick combo · Edited]        ( ●Animate | ●Draw | ●Build )        [↶][↷] [💾] [⇧ Export]  – □ ×
```

Three clusters: who and where (the mark, the menubar, the document), the workspaces, the actions (history, Save, Export) and the window controls.

| Item | Spec | Hooks |
|---|---|---|
| Mark | 32px ghost: the StykAnimate symbol in brand blue with a 12px `▾`: **the StykAnimate menu**: *Search commands…* `Ctrl+P`, *Settings…* `Ctrl+,`, *About StykAnimate*, *Check for updates…*, *Quit*. At the minimal tier it also lists File ▸, Edit ▸, View ▸, Animation ▸ (Figure ▸ in Build) and Help ▸ (the folded menubar). | `.brand[data-action=menu]` |
| **Menubar** | **Docked at every width down to the minimal tier**, as today's app keeps it (revision 4.1): File, Edit, View, Animation (Figure in Build), Help as quiet 13/500 text items; access keys underlined while Alt is down; Alt+F/E/V/A/H open them. The menus are registry indexes (section 8). The band folds its labels and spacing first (section 1.8); only at minimal does the menubar fold into the mark, where Alt shows it as an overlay above the band's start. | `nav.app-menubar[role=menubar]`, `[data-app-menu=file|edit|view|animation|editor|help]` |
| Document | The name (13/600) and the state (12, text 3) with a dot: **Edited**, **Saved 12:04** (only after a real save), **Saving…**, **Not saved**, **Backup paused**. Opens the **Document popover**: the name field (Enter commits), "Edited · backup 12:03", "Last saved 11:42 · Documents › StykAnimate", *Save as…*, *Show in folder*, and while an unrestored recovery exists *Restore last session*. | `#project-name`, `#dirty-dot`, `#save-state`, `#doc-pop`, `#rename-input` |
| History | Undo, Redo (28px icon buttons; the tooltip names the action: "Undo Move Bubble · Ctrl+Z"). Redo moves to Edit at minimal. | `[data-action=undo|redo]` |
| **Save** | **A labelled quiet button, "💾 Save", beside Export** (revision 4.2: today's word is back; tooltip "Save · Ctrl+S"), so `.titlebar [data-action=save]` keeps today's label. Its word folds after the document name truncates, then it folds into File (below 961px with a new file's name, as today's app hides Save below 1101px). On desktop the first save of a new file adds the native Save dialog, as today. | `.titlebar [data-action=save]` |
| Workspace switch | Segmented, 32px, white thumb with a 3:1 hairline; each item has its concept dot and name. When the band is tight its dots go first (the names stay), then the three segments show their glyphs instead (a figure in motion, a pen line, **a bone** for Build), each with its tooltip, still one click; **never a pill**. | `[data-workspace-mode=animate|draw|rig]` |
| Primary slot | **Export** (ink pill, icon + "Export"). During a session: **Done** (ink, with a check): Build (`#builder-done`), camera (`camera-done`), movieclip (`movieclip-done`), and **Export stays in the band as a quiet labelled button beside it** (revision 4.3: today's title bar keeps Export in Build and with the Camera selected; File › Export… and `Ctrl+Shift+E` too): Build reads *Save · Export · Test rig · Done*, a camera session *Save · Export · Done*, a movieclip session *Save · Export · Cancel · Done*. **A movieclip session adds *Cancel*** (ghost) before Done (today's breadcrumb pair); **Build adds *Test rig*** (a labelled ghost button with its glyph, `rig-test`, `Ctrl+Enter`) before Done, where today's builder bar has it. **The primary keeps its word at every tier gate size** (the band's fold order, section 1.8); only where nothing else is left does it become a 32px round ink icon. | `[data-action=export]`, `.rf-export2` (the session's Export), `[data-action=movieclip-cancel]`, `.shell-top [data-action=rig-test]` |
| Properties | Compact and minimal width only (800px and below): an icon button that opens the inspector as a sheet, the same root with whatever is selected (a tier alias of *View › Panels › Properties*). Its glyph is **a window with a shaded side panel** (revision 4.2), so it never reads as Build's Timeline toggle beside it (a window with a shaded bottom panel). | `[data-action=panel-toggle-properties]` |
| Window controls | 44×44 ghost buttons; close hovers danger-soft. Hidden on macOS. | `#window-controls [data-action=minimize|maximize|close]` |

The band is the drag region; every control and overlay root is `no-drag`. Double-click on empty band toggles maximize. **Why the menubar is back, and why it stays:** today's menubar is two clicks to any command at every width down to 600px; behind the mark (revision 3, and revision 4 below 1181px) it was three for 40 commands (R09). Pivot and desktop users expect File, Edit and Help; the names are quiet text, grouped with the mark and the document as one cluster, so the band still reads as three calm groups.

---

## 3. Workspaces and the rail

### 3.1 Switching workspace

The switch changes the rail's tools, the stage header's tool options and view toggles, the inspector's context, the menubar's fourth menu (Animation ↔ Figure) and the arrangement. The band, Undo, Redo, Save and the primary slot keep their places. Entering Build runs `builder.enter()`; leaving through Done or the switch runs `requestExit()` and its dialog. The switch is instant (no transition next to `#viewport`).

### 3.2 Rail per workspace

Tools, anchored to the top, 36px buttons, 4px gaps. **Build adds its quick options** under its tools, past a 20px hairline (2026-09 Build redesign, as a modelling tool keeps snapping and mirroring beside its tool shelf): Whole branch `B`, Smart snapping, Isolate joint and Fit figure; an option that is on is a soft accent tile, never the active tool's white tile. The active tool is a white tile with the one lift and a blue glyph (`aria-pressed`). **A tool with variants keeps today's small corner tick** (revision 4.1: the Tweener, Select pixels, Shapes), so the variants are visible at rest: a click on the tick, a right-click or a long press lists them (two clicks, as today's 14px arrow), and while the tool is active they are a segmented control in its tool options. The rail button keeps the last-used variant. Tooltips carry the name, key and "the corner lists its modes".

| Animate (4) | Draw (8) | Build (7; Test rig is beside Done in the band) |
|---|---|---|
| **Add** (`#open-insert`, `add-menu`: the Add menu) | **+** (`#open-insert`, revision 4.3: today's Draw meaning, **New drawing layer** in one click; its **corner tick** lists the Add menu, led by New drawing layer, then Image… (a reference to trace), Stick figure, Text… and the rest, so adding from Draw needs no workspace switch: an image to trace takes 2 clicks, today 3) | **Edit joints** `J` (`rig`, default) |
| **Select and pose** `V` (`P` stays an alias) | **Brush** `B` | **Select figure** `V` |
| **Tweener** `W` (`#tweener-button`; the in-between glyph and its corner tick) | **Eraser** `E` | **Line** `L` |
| **Pan** `H` (Space-hold everywhere) | **Fill** `G` | **Chain** `K` |
| | **Select pixels** `L` (variants in its options) | **Circle** `C` |
| | **Shapes** `U` (variants in its options) | **Polygon** `Y` |
| | **Transform** `Q` · **Pan** `H` | **Pan** `H` |

The new tool keys (`W`, `Q`, `J`, `K`, `Y`) are default bindings added after a conflict check against `hotkeys.mjs` (section 7.2); every one can be rebound in Settings › Shortcuts.

### 3.3 Add menu (the rail's `+`)

In Draw (the + button's corner tick, revision 4.3) the menu starts with *New drawing layer* ─. Then: *Stick figure* (`add-figure`) · *Text…* `T` · *Image…* (`import-sprite`) · *Import figures…* (`import`) · *Movieclip…* (`movieclip-new`) ─ **In this project**: another copy of a figure or a clip already in the file (Bubble, Rival, Punch…; today's Insert dialog "Project library", in the browser too) ─ **Examples ▸** (Figures and rigs; Animations). A clip made from the selection is the selection menu's *Make movieclip…*; one made from frames is the frame menu's. `#insert-dialog` stays a hidden compatibility host until `asset-library.mjs` is ported (architecture M7c).

---

## 4. Stage

### 4.1 Anatomy

```
┌ stage island (12px corners from one ::after cap layer) ──────────────────────────────────────┐
│ 40 │ start: the tool's options or the location │  centre: one message  │ end: view · zoom · Fit │  ← .stage-head
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ 24 ┌──────────────── artboard (fit inside the insets) ─────────────────┐                      │  ← #viewport
│ 28 │                                                                     │ 28                  │
│    └─────────────────────────────────────────────────────────────────────┘                      │
│ 24                                                                                              │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **The stage header** (`.stage-head`, `role=toolbar` "Stage") is the canvas's own line, level with the inspector's tabs. It is a sibling of `#viewport`, above it, so nothing it holds is ever over the artwork, in the canvas hotkey scope, or under a wheel-zoom. It replaces today's canvas toolbar (the crumb and undo), view pill and drawing quick bar.
- `#viewport` fills the island below the header; the dotted desk is a static background. Build shows today's view: the white artboard at fit canvas with the figure being built.
- Nothing inside `#viewport` sits over the artboard except the renderer's own drawing (`#scene`, `#overlay`) and the `#renderer-error` and `#canvas-empty` cards while their state is active. The audit counts controls inside `#viewport` (0) and anything over the artboard (0).
- `#viewport` has `role=application`, `aria-roledescription=canvas`, a name, `aria-describedby=selection-summary`, `tabindex=0` and an inset 2px focus ring.

### 4.2 The stage header's start: the tool's options, or where you are

**The tool options bar** (`.ui-optbar`) holds the active tool's everyday options, grouped, in one row. The tool's complete settings stay in the inspector under the target (section 5.3). Fields size to their label and value plus one spare character, so a value never clips. When the header is narrow, labels drop first; then items fold in their declared order, to a **twin** in the tool's inspector section where one is declared (Mirror: the same two clicks as today's inspector toggle), to their **home** (Pen pressure: Brush details › Dynamics), and only then into "More options" (a chevron at the bar's end), in the order today's quick bar clips them at that width (revision 4.1: at 1024px Brush keeps Size, Opacity, Flow, Smooth and Pen pressure; at 960px all but Pen pressure; at 900px Size, Opacity and Flow, with Smooth in More options, where today's bar cuts it off).

| Tool | Options (groups separated by space) | Fold order |
|---|---|---|
| Select and pose, Pan (Animate) | none: **the location crumb** "▭ Scene 1 960 × 540" (a click selects the Scene: today's canvas crumb) and, at its end, **the scene's background chip** (revision 4.3: a swatch filled with the background colour and a visible border, so it reads as a colour, never as an empty screen; one click opens its colour picker: T19 takes 3 steps, today 4) | — |
| Tweener (Animate) | Mode: Breakdown │ Neighbor │ Push │ Relax (a segmented control; it was a 14px flyout) · Amount | — |
| Brush | the colour pair (stroke over fill; opens the colour picker) · Swap `X` · Size (revision 4.2: its scrub is logarithmic, section 7.6) · Opacity · Flow · Smooth · **Mirror** (one labelled pair: horizontally `Shift+M` and vertically, quiet toggles with their state; revision 4.1 merges today's split mirror controls) · Pen pressure. The recent colours are the Brush section's *Recent* row at wide and regular widths, as today's inspector swatches; at the narrow tier they are the colour picker's *Recent* (revision 4.2, so the brush and the drawing layer's settings stay in view; today's inspector swatches need a scroll at every tier size) | Mirror (twin: a field in the Brush grid, beside Lock alpha) → Pen pressure (home) → Smooth → Flow |
| Eraser | Size · Opacity · Smooth · Pen pressure | Pen pressure (home) → Smooth |
| Fill | the colour pair · Swap · Tolerance · Gaps · Expand (Recent in the Fill section) | Expand |
| Select pixels | Lasso │ Rectangle │ Ellipse │ Wand (icons) · while a selection exists: **Apply** `Enter` · **Deselect** · **Flip horizontally** · **Flip vertically** · **Delete pixels** `Del` | — |
| Shapes | Line │ Rectangle │ Ellipse (icons) · the colour pair · Swap · Fill (quiet toggle) · Size · Opacity (Recent in the Shape section) | Opacity |
| Transform (Draw) | Scale · Angle · Flip horizontally · Flip vertically · Apply | — |
| Pan (Draw) | Rotation · Reset rotation (the reset glyph) · Flip view `M` | — |
| Edit joints (Build) | Drag: a select, Move joint or Rotate branch (`#rig-mode`, today's select). Whole branch `B`, Snapping and Isolate are Build's rail options (2026-09 Build redesign), since they reach every tool's edits | labels (the toggles show their glyphs, 28px), the "Drag" label; then the end cluster's Highlight part and Static handles fold into *View › Build* (900px); Snapping last, into *View › Build* (revision 4.2: it stays in view at 900px) |
| Line, Chain, Circle, Polygon (Build) | Snapping; while drawing a chain or a polygon: Finish `Enter` · Cancel `Esc` (`#chain-controls`, `#polygon-controls`) | — |

**In a session** the start shows the scope path: "▭ Scene 1 › ▭ Punch" in a movieclip, "▭ Scene 1 › ◫ Camera" in a camera session; the first part leaves the session (the same command as the band's Done). This replaces today's movieclip breadcrumb.

### 4.3 The message slot (the header's centre)

One message at a time, centred in the stage header, in priority order **error → recovery → mode → update → toast → first-run hint**; a queue of 3; identical messages de-duplicated; hover or focus pauses the 5s timeout. A message is a 28px pill: an icon or dot, one line (the verb in `--text-1`), at most two small actions and a dismiss. The host keeps `#toast`.

- **It has priority over the location and the tool options, never over the view cluster, and it is never cut** (revision 4.2). Its room is the header up to the view cluster (at compact and minimal width up to zoom and Fit: the view toggles step aside while it shows). It is centred in the header when that clears the view cluster and centred in its room otherwise, covering the crumb or the tool options while it shows (they return when it closes). **When its whole text does not fit there, it takes a line of its own**, a 32px pill just under the stage header, centred, over the stage's top margin for its moment (it may overlap the artboard's top edge; it is transient, never at rest except the first-run hint, which fits in the header from 900px), so the verb is always read in full. There is no width cap and no ellipsis. Measured (`reference/175`–`180`, and the message pass of the audit: each of the first-run hint, recovery, a toast, the join mode and the slow message at 1180, 1100, 1024, 960, 900 and 801px): the first-run hint stays in the header down to 900px (covering the crumb where they would meet; its own line at 801px), recovery takes its own line from 1024px down, and a toast, the join instruction and the slow message at 801px; **0 cut, 0 meeting the view cluster, every button hit at its centre.**
- **The mode kind (revision 4)** carries the instruction a pick mode needs, for as long as it lasts: "**Click the joint** to join to · Cancel" (Join), "Pick the start anchor · Cancel" (Connect joints), "Place the image · Enter · Esc" (sprite placement), "Click to add points · Enter finishes" (Chain, Polygon), "Drag across the canvas to blend" (the Tweener's first use). Today these hints existed but were hidden (R16).
- **The quiet kind (revision 4)**: "Slow · 14 of 24 fps · Details", only while playback misses its target (today's PLAYING/achieved-fps badge, R25); *Details* opens Help › Performance.

| Message | Content |
|---|---|
| First-run hint (once per install) | "● **Drag a red joint** to pose ×". Dismissed by ×, by the first successful joint drag, or by any other message. |
| Recovery (startup) | "**Restore unsaved work** from 12:04? Not now · Restore" (`#restore-recovery`). |
| Toast | "Frames 22–28 eased · Undo", "Deleted 6 frames · Undo", "Applied to 6 frames · Undo", "Exported kick-combo.mp4 · 3.4 MB · Show". Destructive or wide-scope edits always carry Undo. |
| Error (`role=alert`, persists) | "**Could not open whoosh.wav**, it is in use ×"; "**Couldn't load Speed lines** · Retry" (`draw:retry`). |
| Update | "StykAnimate 1.2 is ready · Restart to update". |
| Task (over 150ms) | "Copying 3 figures ▬▬▬ Cancel". Export progress stays in its dialog. |

**Renderer error** (`#renderer-error`, `#retry-renderer`) is a centred card on the dead canvas: "The canvas stopped · Your work is safe. · Reconnect".

### 4.4 The stage header's end: view, zoom, Fit

Today's view pill, one click away, then zoom and Fit:

| Workspace | View toggles (quiet when on) | Then |
|---|---|---|
| Animate | **Joints** `Shift+J` (`#handles-button`) · **Motion paths** `M` with its settings (a split button: `#paths-button` and `.path-options-button`, which opens the Motion path settings popover: Show for, Range, Around, Frame numbers, In-between dots) · **Grid** `Ctrl+'` with its settings (revision 4.1, a split button: `#canvas-guides-button` shows or hides the grid, its state visible; `#guides-options-button` opens the Grid and guides popover: Show grid, Size, Opacity; Vertical guide, Horizontal guide, X, Y, Centre guides, Lock guides) · **Effects preview** (`#vfx-preview`) | zoom · Fit |
| Draw | Grid (the same split button) | zoom · Fit |
| Build | **Static handles** `F10` · **Highlight part** `F12`; when the header is full (900px) Highlight part, then Static handles fold into *View › Build* (revision 4.2: *Timeline* and *Fit figure* are Structure's foot again, as today's outliner footer, section 5.2) | zoom · Fit canvas |

- **Zoom** (`#zoom-label`, `zoom-menu`): the value ("95%") opens the zoom menu: Zoom in, Zoom out ─ 25%, 50%, 100%, 200% as radios (none checked when the view matches no preset) ─ Fit selection `Shift+2`; in Draw also Flip view `M` and Reset rotation.
- **Fit** (`zoom-reset`, `Shift+1`): fits the canvas (today two clicks through the zoom menu).
- Other figures' joints `Ctrl+H`, Camera frame `Ctrl+K` and Onion skin `O` are View menu rows (the menubar) and keys, as today (Onion's home is the timeline header).
- **The view toggles stay at every tier** (revision 4.1), as today's view pill does; at compact and minimal width a message may cover them while it shows.
- **Recognisable at first glance** (revision 4.2): a view toggle's tooltip is its name and shortcut ("Joints · Shift+J"); its pressed look shows its state and aria-pressed announces it; Effects preview is an **fx** glyph (the sparkle read as "AI"); the crumb's **background chip is a swatch** (revision 4.3: filled with the scene's colour inside a visible 1px border, 18×13px; tooltip "Background colour · #FFFFFF"), never an empty square or a tiny screen.
- **The view popovers apply live and close on the next click elsewhere** (Grid and guides, Motion path settings, Onion skin settings): there is no separate close step (T28: the grid and a vertical guide take 3 clicks, today 4). **What that click may do** (revision 4.3): on the canvas it only **selects or deselects** what it lands on, as a plain click would; it never starts a drag, a pose, a joint edit or a box selection (the press is taken by the closing popover until the button is released), so dismissing the Grid popover can never move a figure. On chrome (a button, a tab, a row) the click does what that control does. Needs sign-off (section 11); without it, the click only closes the popover (T28: 4, as today).

### 4.5 What the canvas shows

The canvas shows only what today's renderer shows. There is **no selection ring, no hover halo, no dashed selection box, no joint name tag, no drop outline or glow and no drag readout** on the canvas (revision 4.3: dropping a colour, an effect or an image says what it will do in the message slot and on the cursor, never on the drawing; section 7.3). A selected joint is drawn paler, as today; a selected Build part keeps today's look. The marquee, snap feedback, guides, the camera frame in a camera session and the drawing cursor keep today's drawing, restyled through `canvasChromeTheme` (architecture §2.5). **In a camera session the figures' joint handles stay drawn**, dimmed to 50% as the renderer's unselected handles, and draggable (revision 4.3, as today with the Camera selected; section 5.11).

Invisible improvements stay in scope (they add nothing to see): **joint hit area** 24px limited to half the distance to the nearest neighbour; **body click** selects the figure; **right-click** never targets hidden or zero-width joints; **the keyboard opens the context menu** (Shift+F10, the Menu key; today's keyboard `contextmenu` never reached the canvas, C94).

### 4.6 First launch and empty scenes

- **First launch** (`reference/13`): "Untitled animation · Not saved", Bubble standing on the stage and **selected, as today** (Transform, Appearance, Arrange and its quick actions), the Advanced timeline at its default height with one frame, *Layer 1* in today's ink (the inspector's Layer select reads just "Layer 1 ▾": a select whose value already names its kind drops its inline label, which stays its tooltip and accessible name, so it never reads "Layer Layer 1"), the readout at today's 00:00:00, onion off, IK off, **no has-audio dot** (a new file has no sound; the audit fails a first launch that shows a has-audio dot, onion, a toggled layer or a scope line), the view toggles at today's defaults (Joints and Effects preview on, drawn quiet), and the one first-run hint in the stage header's centre. **Revision 4.3: no control that cannot work yet**: *Edit together* appears in the timeline header once the file has two frames (on a one-frame file it can never apply), and *Focus selected layers* once there are two layers. What's new queues through the overlay manager after it; statistics are announced by one line on Home (STATISTICS.md), not a prompt.
- **Draw on a new file** (revision 4.3, `reference/186`–`188`: the screen a curious newcomer opens early): the inspector is titled **"New drawing"** with the brush glyph, one quiet line says **"Paint anywhere to start a drawing layer"** (an empty state, like VFX's "No effects on Bubble"), and a visible **New drawing layer** button makes one without painting (today's visible button); then the Brush section as usual and Brush details. The drawing layer's own sections (Drawing layer, Cel, Parallax) appear once a layer exists. The timeline shows Camera, Scene and Layer 1 (a figure layer, the selected row); *Next copy* waits, quiet, with its tooltip ("Works on a drawing layer: paint, or New drawing layer"). The stage shows Bubble standing, as today's Draw does. The default inspector fits at 1440×900 and the state is held to the first-glance ceilings (section 0.2).
- **Empty scene** (`reference/55`): a new file's empty artboard with nothing over it ("Untitled animation · Not saved"), and the Scene in the inspector, its meta line from the model ("0 figures · 1 frame · 0.04 s").
- **A new file in Simple** (`reference/170`, `171`): one card, Bubble standing; the frame bar reads "Frame 1 of 1 · holds 0.04 s · 0.04 s in all" and its layer "Layer 1". Adding a figure is the rail's *Add*; dragging a file over the window shows `#canvas-empty` ("Drop to open or import").

---

## 5. Surfaces

### 5.1 Inspector (Properties tab)

```
288 ──────────────────────────────────────────
 40  Properties   VFX   Library                line tabs; a hairline under them (the island header line)
 32  Bubble                                ⋯   the name (Inter Tight 16/650; double-click renames) and ONE menu
 28  [scope line: ● Editing frames 22–28  Stop] only while Edit together is on
 28  ⇋   To front  To back   ⧉+ 🗑             quick actions: ≤ 5 defaults and a pin slot, ≤ 3 groups, 28px
 14  Transform                                 a core section: quiet title (12/600, text 3), ≤ 2 title actions
 32  [X 474    ] [Y 300    ]                   fields 32, no ring at rest, regular values
 32  [Angle 0° ] [Scale 100%]
 14  Appearance                           ↺    the title action (Reset colours)
 32  [■ 0D99FF ] [Opacity 100%]
 14  Arrange                            Join…  the title action (Join to figure, J), a word
 32  [Layer Bubble ▾] [Order ↓ 2 ↑]           a labelled select; the Order (Z-index) stepper: its label, Send backward · value · Bring forward
 28  Colours                               ›   a titled section: one line, opens in place, remembered
 ──  ▭ Add to library                          the footer (today's Properties footer)
```

- **Header:** the target's name and at most one menu button (`#object-actions` runs `selection-more` and opens the selection menu; the joint, part, scene, camera, motion, movieclip, layer and drawing-layer menus in their contexts). An optional kind glyph before the name (text, image, movieclip, scene, camera, layer). No crumb, chip or badge. **Names are today's** ("Joint 4" unless it has a name; double-click the name to rename, `#builder-joint-name` in Build). **One name per thing on one screen** (revision 4.1): Build's part inspector is titled by its Structure label ("Line 4"; its tooltip names the joint), and a layer reads the same in the inspector, both timeline modes and the Layers popover (the demo file's layers are Bubble, Rival and Sketch; a new file's first layer is "Layer 1").
- **The scope line** (`.ui-scope`) appears only while an edit reaches beyond the selection: with Edit together on, the figure reads "● Editing frames 22–28 · Stop". It prevents wrong-scope edits and gives the way back (O4).
- **Quick actions** (`.ui-quick`): the context's most used commands (O1), **at most five defaults, the sixth slot kept for a pin**, each with a tooltip naming the command and its key, Shift variants included ("Bring to front · Shift: one step"). **Words where glyphs are hard to tell apart** (revision 4.1): Build's Split and Duplicate and the range's Remove keys are small labelled buttons; the joint's Match pair sits behind a quiet "Match" label with pose glyphs that are never the transport's frame steps; unmistakable commands keep their glyphs (Flip, Delete). **Revision 4.2:** *To front* and *To back* (a bare "Back" read as navigation); the joint's *Isolate* and the camera's *Level* carry words; **Duplicate has its own glyph** (the copy with a plus; Copy keeps the two squares, so *Copy frames* and *Duplicate* never share a symbol); the Simple frame bar's *Copy* and *Paste* carry words. **Revision 4.3: one grammar.** A label that belongs to glyphs shares one sunken tile with them, as a stepper does (*Match ◀ ▶*, never a loose word beside loose glyphs, so it cannot read as a button); a word button (*Isolate*, *To front*, *Level*, *Centre*, *Split*) has the same gap and hover tile as a glyph button; the camera's *Centre* is a word; *Exact values* has a clearer glyph (a ruler with a typed angle; the "123" field read as a code) with its tooltip; a context's row never wraps or scrolls at any inspector width (the camera's *Guides* is the Preview section's title action, beside the monitor it draws on). The context menus list the same commands (the visible home plus menu aliases rule, section 8).
- **Title actions:** at most two per section (several figures' Selection: *Rotate 15°* and *Centre*, as words since revision 4.2; the camera's Transform: Copy and Paste camera); every other section has at most one. A title action that is a command with no unmistakable glyph is a quiet word (*Join…*, *Save preset*, *Invert*, *Combine with…*).
- **Core sections**: two to three per context, always open. **Titled sections**: fold behind their own title, open in place (one click), remember their state per context kind, and open by themselves when their content matters now. Never a generic "More".
- **Fields:** inline label (scrubs: drag, Shift ×0.1, Alt ×0.01; **revision 4.2: a quiet dotted underline says so at rest, the ↔ cursor and the accent on hover, and the first field a person focuses shows the one-time hint "Drag a label to scrub · Shift ×0.1 · Alt ×0.01" in the message slot**, today's permanent caption made once), value with its unit, simple expressions (`+10`, `*2`), "Mixed" for several figures, no ring at rest. A value always keeps its whole text and one spare character, scrollbar included (the audit measures every input and select); a pair holding a labelled select or switch stacks in a narrow inspector. **One pattern per kind of field** (revision 4.2; the gallery's *Field patterns* card; the audit fails an outside-labelled select in the inspector): a value field with its inline label; **a select with its inline label** ("Layer Bubble ▾", "Blend Normal ▾", "Plays Always ▾", "Shape Round line ▾"), which drops the label when its value already names its kind ("Layer 1 ▾"); **the field switch** (its label inside the field box, the switch at its end: Static, Use IK, Pin joint, Lock alpha, Edit together, Ease new keys), laid out in the same grid as the fields; a stepper or a segmented control takes a row label (Inbetweens, Chain, Aspect), **except the Order stepper, a field of its own with its inline label** (revision 4.3: "Order ↓ 2 ↑", its tooltip "Order: 2 of 2"; its one-step arrows are plain, never the barred ⤒ ⤓ that read as "to top"); a titled section that switches a feature on carries its switch **right after its title text** (revision 4.3: Stretch, Parallax; the whole title row opens the section, the chevron at its end, and only the switch itself switches). Two selects that could read alike never sit in one context under the same label (revision 4.3: Draw's *Brush blend* is a row of its own in the Brush section; the drawing layer keeps *Blend* under its own title). Popovers and dialogs keep switch rows and row labels. The inspector body fades its last line while more is below, so a half-visible title always reads as "scrolls". Keys are made the way they are today (pose at a frame, or *Add frame* `A`) and managed in the Advanced timeline; **the inspector never shows key state.**
- Every `PropertyControls` hook, `data-section` identity and control id is kept (architecture §3.13).

| Selection | Menu (⋯) | Quick actions | Core sections (open) | Titled sections |
|---|---|---|---|---|
| **Figure** (also first launch, and while the Tweener is active) | Selection menu | Flip horizontally · **To front, To back** (words; Shift: one step) · Duplicate, Delete · (a free slot for a pin) | Transform: X, Y, Angle, Scale · Appearance: colour (`#figure-color`), Opacity; action *Reset colours* · Arrange: Layer (`#figure-layer`, a labelled select naming the file's layers as the timeline does), **the Order stepper** (revision 4.2: *Send backward*, the value, *Bring forward*: today's one-step Stacking buttons, one click and visible; revision 4.3: its inline label "Order" and plain one-step arrows, "Order ↓ 2 ↑", beside the Layer select in a two-column grid, so its value never reads as a layer number); action **Join…** `J` (a word) | Connection (opens while joined: Joined to, Unjoin, Combine connected) · Colours (used colours, fills; their pages) · Drawing sets (when a joined drawing bank exists). Footer: *Add to library* |
| **Several figures** (`reference/76`) | Selection menu | Flip · To front, To back · Duplicate, Delete | Selection: X, Y, W, H (Mixed); actions *Rotate 15°*, *Centre* (words) · Align: Left, Centre, Right │ Top, Middle, Bottom (today's six buttons) · Appearance: colour (Mixed), Opacity; action *Reset colours* | — |
| **Joint** (`reference/14`) | Joint menu | **Isolate** (a word; latched, its state visible) · Exact values… `I` (revision 4.3: a clearer glyph, a ruler with a typed angle) · **Match ◀ ▶** (revision 4.3: one sunken tile holding the "Match" label and two pose glyphs: Match previous pose `L`, Match next pose `Shift+L`; never the transport's ◀| |▶) · Flip limb `Shift+H` | Joint: Angle, Length, Bend, Static · IK: **Use IK** (`#node-is-ik`, off) and **Pin joint** (`#pin-joint`, off) side by side; **turning Use IK on pins the joint, as today, and Pin joint turns on with it** (revision 4.2: the switch shows and controls the real pin; switching it off unpins, so the foot is never pinned while the UI says it is not; tasks.md problem 8); while Use IK is on: Chain, Bend (Left │ Auto │ Right), Stretch, Target (`reference/123`) · Style: Width, colour (`#segment-color`), Opacity, Order, Shape · **Figure: Layer** (today's Layer select, revision 4.1) | Second colour (two-tone, colour, opacity) · Connector (opens on connector joints: Segment │ Slider, Position) |
| **Text figure** (`reference/118`) | Selection menu | As a figure | Text: preview and *Edit text…* (double-click the text too) · Transform · Appearance: Opacity, Z-index | Layer |
| **Image figure** (`reference/119`) | Selection menu | As a figure | Transform · Appearance: Opacity · Arrange | (An Image section is where replace and crop will go; they do not exist today) |
| **Movieclip instance** (`reference/70`) | Movieclip menu (Edit clip, Make unique, Break apart frame, Bake to frames, Export clip…) | **Edit clip** (a labelled button; double-clicking the clip enters it too) · Make unique · Duplicate, Delete | Playback: mode (Loop, Once then hold, Once then hide, Single frame), Start, Speed; "Frame 3 of 12" · Transform: X, Y, Angle, Scale, Opacity, Z-index | Extend (Next keys, *Add*) · Drawing sets |
| **Movieclip session** (`reference/36`) | Movieclip menu (Make unique, Break apart frame, Bake to frames, Export clip…) | — (the band holds Cancel and Done) | As the instance | As the instance |
| **3D rig figure** | Selection menu | As a figure | Pose: Pose │ Rotate (the tested pair), the turn and tilt pad; action *Reset pose* · Body: Move figure, Rotate figure, the limb and torso buttons, Plant feet, Articulation · Limb: IK, Pin, Stretch, bend, depth, reach | Exact angles · Perspective · Shape · Mechanism · Choices · Placement (X, Y, Scale when nothing is selected) · Appearance · Arrange |
| **Camera** (a session, `reference/37`) | Camera menu (Copy camera `F11`, Paste camera `F12`, Reset camera `Ctrl+Alt+K`) | **Level** and **Centre** `F8` (words, revision 4.3) · Reset · **Motion ▾** (a preset list: Handheld, Shake, Wobble, Impact punch, Zoom pulse, added at the playhead) | Preview: the camera monitor; action **Guides** (a quiet toggle beside the monitor it draws on, revision 4.3) · Transform: X, Y, Zoom, Angle, and **Ease new keys** (an opt-in field switch, off; revision 4.2: **remembered** once turned on and shared with figure keys, section 11: a key you add eases from the key before it, Linear, instead of holding; the default stays Constant; T39 takes 4 steps with the switch in view, today 5); actions *Copy camera*, *Paste camera* | Motion clips (the list, *Bake all*) · Framing (**Fit view** `F10`, Centre X, Centre Y, Match previous, Match next, Apply to figures) |
| **Camera motion clip** (`reference/109`) | Camera motion menu | Preview · Mute · Duplicate · Bake clip range · Delete | Timing: Start, Duration · Motion: Strength, Speed, Move X, Move Y, Roll (per type, as today) | Graph · Noise (Roughness, Seed, *Randomize*) · Fades |
| **Scene** (nothing selected; `reference/55`) | Scene menu | — | a meta line from the model: "2 figures · 48 frames · 2.0 s" (today's status bar count; a new or empty file "0 figures · 1 frame · 0.04 s") · Canvas: Width, Height, Aspect · Background: colour (`#background-color`), *Library…* (`background-style`); action *Background image* (`import-background`) · Playback: Rate (mirrors the timeline's frame rate) | — |
| **Layer** (a label row, `reference/120`) | Row menu | Move layer up, Move layer down (the step glyphs) · Delete layer (Focus is the layer list's header toggle) | Layer: Name, Opacity | Parallax (its switch on the title row; opens while on: Depth, X and Y with Link axes, *Set reference*, the preview) |
| **Drawing layer** (Draw, every tool) | Drawing layer menu | — (revision 4.1: the cel commands are Draw's timeline header split, *Next copy ▾*, where today's *Next copied drawing* button is; New drawing layer is the layer list's + in Draw) | **The tool's section** (Brush: today's 14 brushes and saved ones as a **four-column grid of today's stroke textures** with one-line names (revision 4.2), *Recent* (at wide and regular widths), then Hardness and Lock alpha side by side, **Brush blend** as a row of its own (revision 4.3, so the two blends never read alike) and the Mirror twin as fields; action *Save preset* (a text action). Eraser: Hardness. Fill: Sample all layers. Select pixels: Scale, Angle; action *Invert selection*. Transform: X, Y, Opacity) · **Drawing layer** (revision 4.2: under a divider and its own title, so the brush's Opacity and Blend never read as the layer's): Opacity, Blend. On a new file (no drawing layer yet) the inspector is titled "New drawing" with its one line and the New drawing layer button, and this section, Cel and Parallax wait for a layer (section 4.6) | **Brush details** (one titled section: the live stroke preview, today's large one, then Tip, Stroke, Texture, Dynamics) · Wand; Filters · Cel (Resolution, Filtering, *Resample…*) · Parallax |
| **Frame range** (Advanced, `reference/26`) | Frame menu | Copy frames, Paste frames · **Remove keys** (labelled: the poses go, the time stays), Delete frames (the trash: the time goes) | **Edit together** (`#range-edit`, a field switch; the timeline header's *Edit together* is the same entry and always shows the same state, audited) · Easing: select (today's six modes, section 5.7) + curve · Timing: Inbetweens | — |
| **Build part** (`reference/05`; titled by its Structure label, "Line 4", renamed in place in the header) | Part menu | **Split** `S`, **Duplicate** (labelled, as today's builder bar) · Flip, Flip vertically · Delete part (Shift, or Whole branch on: the branch) | 2026-09 Build redesign, most changed first: **Style** (colour across the row, Width, Opacity, Shape) · **Geometry** (Angle, Length, Bend, Static) · **Arrange** (Layer, Order ↓ ↑). While Whole branch is on, the scope line says "Editing the whole branch · N parts · Stop" | Second colour · IK (open while on) · **Rig** (open while the part has a rig): one block per behaviour, a hairline between them: *Connect* and *Weighted* (joint; a connector: anchors A and B), **Smart Stretch** (its switch; while on, under a guide: driver, rest length, minimum, maximum, width, new parts), **Stretch response** (where a stretch reaches the part), **Angle lock** (its choice; while on: angle, rotation, when it applies, a second rotation) · **Attachment** (stretch driver, orientation) · Weighted joint and Angle-driven path (Reference positions) replace Rig on parts that are one |
| **Build figure** (no part) | The Figure menu (the menubar's, a second opener) | — | Figure: Name | IK defaults · Stretch defaults · Attachments |
| **Build fill** | Part menu (its fill rows) | Bring fill to front, Send fill to back · Delete fill | Fill: colour, Opacity, Sides, Flip facing, *Reference joints…* | Faces |

### 5.2 Build workspace (`reference/05`, `16`, `31`, `32`, `57`, `60`–`64`, `105`–`107`, `145`)

- **A session.** The band's primary slot holds **Done**, with **Test rig** labelled beside it (where today's builder bar has it) and **Save** and **Export** before them (revision 4.3: today's title bar keeps Save and Export in Build; Export is a quiet labelled button, Done the ink primary); the timeline is Hidden, as today (the Timeline view toggle, `Ctrl+4`); the rail holds the seven Build tools and Build's quick options (Whole branch, Snapping, Isolate, Fit figure); the stage header holds Edit joints' Drag and Build's view toggles; the inspector keeps today's three tabs.
- **Structure island** (`#builder-outliner`, `.builder-tree-row`, 30px rows, 14px indent) shows today's labels in today's order ("Line 4", "Circle fill 12"), today's static and hidden flags as quiet glyphs after the name, **a twisty at rest in a quiet tone** (revision 4.2; full contrast on hover and focus, as today's outliner shows them), polygon fill rows under their part, and one glyph slot for a rig role. **Its head names the figure being built**, as today's outliner header: "**Bubble** · 26 parts" (double-click the name to rename the figure, every Bubble; revision 4.2) and *Find part* `Ctrl+F`; **when the figure is shared, a scope line under it says so**: "● Edits change all 3 Bubbles" (its tooltip: Done asks before it updates them), the same visible-state rule as Edit together's scope line. At the strip tier the strip's tooltip is "Structure of Bubble · 26 parts" and the sheet's head names it. The selected row is blue-soft; a right-click opens the part menu; drag reorders or reparents (Move and Arrange in the part menu are the keyboard path).
- **Structure stays docked** while `#viewport` keeps its 360px floor (232, then 200 wide; at 900×700 and 960×600, as today's 236px outliner) and folds to its 40px strip only below that (always at compact and minimal; at narrow below about 890px); its button opens Structure as a sheet.
- **Today's view by default:** the white artboard at fit canvas with the figure being built and its static handles. The construction desk remains a pending option (section 11).
- **Structure's foot** (revision 4.2): today's outliner footer, **Fit figure** `Shift+2` (C220) and **Timeline** `Ctrl+4` (C219, shows Build's hidden timeline), two quiet labelled buttons, one click after Build and visible (revision 4.1 had hidden Fit figure in the zoom menu); at the strip tier they are the strip's glyphs under its Structure button. The stage header keeps Snapping in view down to 900px.
- **The builder bar's commands, one click away again** (R06): Split and Duplicate (labelled, as today's builder bar), Flip H, Flip V and Delete are the part's quick actions; the branch scope is the Whole branch toggle in the rail's quick options, with its state visible there and in the inspector's scope line; Drag (Move joint or Rotate branch, `#rig-mode`, a select) is Edit joints' option; Snapping is a toggle beside it; Test rig is labelled beside Done in the band. Copy appearance is the Style section's action; Connect joints, Attach image and Weighted joint are the Attachment section. The builder bar's Edit ▾ rows (Set origin, Remove joint keep ends, Delete joint only, Delete branch, Exact values…) are part menu rows (2 clicks, as today's Edit ▾); its Arrange ▾ is four flat part menu rows; its View ▾ is the stage header (Static handles, Highlight part), the part menu (Isolate) and *View › Construction colour…* `F9`.
- `#builder-bar`, `#builder-title` and `#builder-menu-*` stay as a hidden compatibility host until `builder-mode.mjs` is ported.
- **Exit dialog** (sm, the existing `requestExit` logic): "Keep changes to Bubble?" with *Update all 3 Bubbles* (primary), *Save as a new figure*, *Discard changes*, and *Keep editing*; the `#builder-exit-*` ids stay on the choices.

### 5.3 Draw workspace (`reference/04`, `15`, `33`, `34`, `58`, `78`–`84`, `101`, `114`, `115`, `140`, `141`, `155`, `156`, `161`, `186`–`188`)

- The rail holds the seven drawing tools. The stage header holds the active tool's everyday options (section 4.2): the colour and its swap where a tool paints (today's quick bar, R14), the sizes, **Mirror as one labelled pair** (horizontally and vertically, their states visible), Pen pressure, the variants, and the pixel selection's commands while a selection exists. Nothing floats over the drawing.
- **The inspector** (revision 4.1, **it fits at 1440×900 without scrolling**; a budget rule) shows the drawing target (the selected drawing layer, its brush glyph and one menu), **the tool's section** (Brush: **today's 14 brushes** (Ink, Brush pen, Pencil, Liner, Nib, Marker, Soft, Airbrush, Charcoal, Chalk, Dry brush, Sponge, Blender, Oil) and saved ones, one collection, **drawn with today's own stroke textures** (revision 4.2: a tapered ink, the pencil's grain, the marker's translucent overlap, the soft and airbrush blurs, the charcoal's rough edge, the chalk's broken line, the dry brush's bristles, the sponge's dabs, the blender's red-to-blue, the oil's highlight; the audit fails two tiles that draw the same thumbnail) in **four columns of one-line tiles of one height** (the longest name keeps its padding at every inspector width; the audit fails a label wider than its tile); **Recent** (the recent colours, one collection, as today's inspector swatches; at the narrow tier the colour picker's *Recent*); **Hardness** and **Blend** side by side, **Lock alpha** and, while the stage header has folded it, the **Mirror** twin, all fields; *Save preset* as the section's text action; a saved preset's right-click menu has *Delete preset*), then, under a divider and its own title, **Drawing layer** (Opacity, Blend), and **Brush details** (one titled section: the live stroke preview, today's large one, then today's Tip, Stroke, Texture and Dynamics groups), Wand and Filters where the tool has them, then Cel and Parallax. **The Brush section and the drawing layer's settings stay in view at the narrow tier** (1024×700, 900×700, 1152×720; audited), the titled sections below scroll under the fade.
- **The cel commands live in the timeline header, where today's *Next copied drawing* button is** (revision 4.1): in Draw the header's start cluster adds **Next copy ▾** (a labelled split: the button is *Next copied drawing*; its chevron lists *Next blank drawing*, *Blank drawing here* `F7`, *Copy drawing here* and *Extend* `Shift+A`, the frame menu's drawing-row rows one click closer). **New drawing layer** is the layer list's + in Draw (its chevron: *New layer*). The drawing layer's menu (the inspector's ⋯, the row menu) lists them too.
- **The pixel selection menu** (a right-click on the drawing with Select pixels or Transform, or Shift+F10; `reference/84`): *Apply* `Enter` · *Deselect* · *Select all* `Ctrl+A` · *Invert selection* ─ *Cut* · *Copy* · *Paste* (the clipboard group) ─ *Fill selection* `Shift+Backspace` · *Flip horizontally* · *Flip vertically* ─ *Delete pixels* `Del`. With a painting tool a right-click on the drawing opens today's palette, restyled as a popover.
- **Keys.** `[` `]` size, `Shift+[` `Shift+]` softer and harder, `1`–`0` opacity, `X` swap, `Shift+M` mirror, `M` flip view (Draw).
- **Targeting.** The selected timeline row is the drawing target; the inspector names it. With no drawing layer targeted, painting creates one, as today, and the inspector says so before it happens (revision 4.3): with no drawing layer in the file it is titled "New drawing" with "Paint anywhere to start a drawing layer" and a New drawing layer button (section 4.6); with a figure layer selected in a file that has drawing layers, the title is the drawing layer the next stroke goes to ("Speed lines"), as today's Draw picks it.
- **The rail's +** (revision 4.3) keeps today's Draw meaning, New drawing layer in one click, and its corner tick lists the Add menu (Image… to trace, Stick figure, Text…), so nothing needs a switch back to Animate (section 3.2).

### 5.4 VFX tab (`reference/43`, `44`, `45`, `112`, `113`, `124`, `148`, `160`, `165`, `166`)

- **Header:** the target's name. Under it, **Apply to** is a visible labelled select (revision 4.1, today's visible "Apply to"): *This figure* │ *Selected joint* │ *Figure + attached* │ *Scene*; its value is the scope's state readout. **The list's own header** (revision 4.4) follows: the title **Effects**, the **Show** choice (At this frame │ Only selected │ All) as a quiet menu beside it, then *Paste* while something is copied and **Add**, the one way to add (its catalogue opens on Effects and switches to Presets). The header says what receives effects; the list header says what is listed and adds to it. With nothing selected, the panel shows only its empty state and *Scene effects*.
- **The effects on the target are one grid** (a single tab stop; 32px rows): each row is **its effect's own glyph** (revision 4.2: today's glyph for every effect, on a small tile in its category's colour, so five effects never look alike), the name, the on/off switch, **its ⋯** and a chevron that turns while its settings show (quiet at rest on every row, as a layer row's eye; full contrast on hover and on the selected row; today's card shows it at full contrast), and a grip on hover to reorder or combine by dragging. Clicking a row selects it; the ⋯, a right-click or Shift+F10 open the effect menu (Copy effect, Duplicate effect ─ Move up, Move down ─ Rename…, Combine with another effect… (*Add effect to group…* for a group), Visible keys… ─ Reset effect, Remove effect). **Whenever the Show filter hides effects**, a labelled row says so under the list ("Show · At this frame · 5 of 7 ▾"), so the default filter never makes effects seem to vanish. (Revision 4.4: *Add effect* and a separate **Presets** button became the list header's single **Add**; the catalogue's Effects │ Presets switch and the empty state's look tiles keep presets one click away.)
- **The catalogue** (`reference/45`, `160`): search, an **Effects │ Presets** switch at its top (Add opens Effects), then today's whole registry, **drawn as today** (revision 4.2): the five generators as **rendered stills** of what they do to a figure (particles, an aura, an energy beam, smoke, an explosion), the other categories as two-column rows of **each effect's own glyph** and its whole name, and the looks as rows of **a still of the look on a figure**, its name and **how many effects it adds** (Power up 2, Hologram 4…); no two tiles of a collection draw the same thumbnail (audited): **22 effects in their six categories** (Generate: Particles, Aura, Energy beam, Smoke, Explosion; Distort: Turbulent displacement, Dissolve, RGB split, Wave distortion, Shockwave; Colour: Tint, Colour grading, Vignette; Light: Glow, Outline, Shadow, Bloom, Light sweep; Blur: Blur; Texture: Pixelate, Noise, CRT / scanlines) and **13 looks** (Power up, Teleport, Impact, Hologram, Ice, Poison, Neon, Golden hour, Retro screen, Energy, Hit flash, Ghost, Retro). Scene-only entries (Shockwave, CRT / scanlines, Retro screen) show for a figure too, dimmed, with their reason. Search and the switch stay pinned; the tiles scroll. (The balance inventory counted 23 effects and 12 looks; `vfx-registry.mjs` and `vfx-presets.mjs` define 22 and 13, 12 of them for a figure.)
- **The selected effect's own settings open under its own row** (revision 4.4, replacing 4.2's titled section under the list, which repeated the row's name and read as a separate thing): clicking a row opens it and clicking it again closes it; the open entry spans the panel between two hairlines. It holds **its parameters, colour first as today** (Glow: Colour, Radius, Strength; a directional effect's *Aim at*, a generated effect's *Variation*), for a group its strength, then *Effects in this group* indented on a guide line (rows that open one at a time) and *Add to group*; then **Timing** (Plays: Always │ From frame │ Once; Start; Duration) and a titled **Advanced** section (style, toggles). So adding a Glow and making it bigger and red never needs a scroll: right after adding it, Colour and Radius sit at y 292 and 328 at 1280×720 (`reference/166`), and with five effects on the target at 1440×900 at y 470 and 506, clear of the timeline (`reference/43`). A missing connected part shows a one-line warning under its name.
- **Empty state** (`reference/124`): "No effects on Bubble", **today's twelve one-click suggestions** as tiles, each **a still of the effect on a figure** (revision 4.3: in the light theme on a mid-tone slate stage, `#48506A`, so twelve dark tiles never outweigh the calm Properties tab; the glows and light still read) with its name and a quiet second line (its category, or "Look · 2" for a look) (Glow, Outline, Shadow, Blur; Particles, Aura, Energy beam, Explosion, Smoke; the looks Power up, Neon, Hit flash; one collection, one tab stop; the Scene suggests Colour grading, Vignette, Bloom, CRT / scanlines, Golden hour and Retro screen), then *All effects…* and *Presets*.
- **Keys for effect parameters** live in the parameter's menu (right-click its label): *Add key at frame 28* `K`, *Remove key*, *Previous key*, *Next key*, *Easing ▸*, *Reset value*. The inspector shows no key state; the keys are drawn in the effect's timeline row, whose label shows *Visible keys* on hover.

### 5.5 Library tab (`reference/46`, `125`–`127`, `162`)

- **Sources**: *This project │ Mine │ Examples* (a segmented control). *This project* lists the file's cast, clips and backgrounds (works in the browser too; today's Insert dialog "Project library"); *Mine* is the desktop library with folders; *Examples* holds figures, rigs and animations (today's Rig examples and example animations).
- **Tools**: search, a Kind filter (All, Figures, Movieclips, Backgrounds), the library menu (`⋯`: Preview background, Animated previews).
- **The folder path** (Mine): "Library › Fighters" as a crumb, with **New folder**, **Show in folder** and **Refresh** at its end (today's toolbar buttons, one click each); drop a card on a folder in the path to move it.
- **Cards** are one listbox in a two-column grid (a single tab stop), with animated previews on hover. Click selects; double-click or Enter inserts at the stage centre; drag to the stage inserts at the drop point. **A card's menu has a visible ⋯** (revision 4.1) on the selected card and on hover and focus (today's selection action bar, one click from a hovered card): Insert, Rename, Move to…, Show in folder, Move to Recycle Bin; Shift+F10 and a right-click open the same menu.
- **Add selection** is **pinned to the tab's foot** (revision 4.2), today's footer primary, visible whatever the cards' scroll (it was after every card, out of view). Browser build: *Mine* reads "Library is in the desktop app".

### 5.6 Timeline header and the Simple frame bar (`reference/03`, `20`, `42`, `50`, `87`, `89`, `92`, `149`)

**Header (three clusters, 15 controls in Animate Advanced, 14 in Simple; 16 in Draw):**

| Start | Centre | End |
|---|---|---|
| `[Simple │ Advanced]` (`#timeline-workflow`, `[data-timeline-mode]`, an `aria-pressed` group; at every tier) · **Add frame** (named exactly "Add Frame", tooltip "Add frame · A") · in Animate Advanced **Edit together** (today's *Edit selected frames*, at rest where today's is; **revision 4.3: a quiet glyph while it is unavailable, its tooltip saying why ("select two or more frames first"), and its word only while it is available** (a range selected, or on); not shown on a one-frame file, where it can never apply; pressed while on; the range inspector's switch, the Simple frame bar's switch, its Timeline ⋯ row and the scope line are the same entry and always show the same state) · in Draw **Next copy ▾** (revision 4.1: today's *Next copied drawing* header button, labelled, with a chevron for *Next blank drawing*, *Blank drawing here* `F7`, *Copy drawing here*, *Extend* `Shift+A`) | **First frame** `Home` · previous `,` · **Play** (soft round disc, `#play-button`, `Space`) · next `.` · **Loop** (`#loop-button`, a quiet toggle, on by default as today) · **readout** in today's **MM:SS:FF** (`#time-display`, "00:01:03"; its tooltip names the frame, "Frame 28 of 48"; click: Go to frame) · **frame rate** "24 fps" (`#fps`, an inline field: click and type; at 800px and below it folds into the Scene's Rate and Go to frame, as today's app hides it) | **Onion** (a split button: `#onion-button` toggles, `#onion-settings-button` opens the settings) · **Audio** (`#timeline-audio`, a quiet toggle; a mint dot **only when the animation has sound**: the demo file's whoosh.wav, never a new file) · **⋯** (`#timeline-menu-button`) |

**Timeline ⋯** (rare rows only; `reference/23`, `59`, `75`): *Last frame* `End` · *Previous key* `Shift+,` · *Next key* `Shift+.` ─ *Default height*; at the low height tier *Timeline…* first; at minimal width *First frame*, *Loop playback*, *Audio* and *Edit together* first (their header buttons fold there; Edit together's row shows its reason while unavailable). *Simple │ Advanced* never folds into it (revision 4.1). The key jumps have their own glyph (revision 4.3: a round key with an arrow), never the transport's frame steps. **The three clusters never touch and no two controls overlap** (revision 4.3, audited at every size): when the start cluster would meet the transport, **the transport first slides right into the header's free space**; only then do labels fold to their glyphs, in this order: *Edit together*'s word (it is only there while available), *Next copy*'s word, and last *Add frame*'s word, only below about 860px where the clusters cannot otherwise keep their gap (today's app shows its glyph below 1101px, so Add frame keeps its word wherever today's does: at 1180, 1152, 1100, 1024, 960 and 900px, first launch included). At the minimal tier the readout and the frame rate never meet the end cluster (the frame rate is in the Scene there, and the header keeps its gaps at 500px, `reference/195`).

**Go to frame** (the readout's popover): a frame field (type a number, Enter) with "of 48 · 1.13 s", and *Show: Time │ Frames*, which switches the readout (R22). **Time is the default**, today's readout; *Frames* shows "Frame 28 / 48" and is remembered.

**The Simple frame bar** (`.rf-framebar`, 372px at the filmstrip's start; O7, R05; revision 4.2, plain words in three rows, so it never scrolls at 1280×720): **"Frame 6 of 8 · holds 0.25 s"** and, at its end, **"2.0 s in all"** (revision 4.3: in Simple a frame is a card, the Pivot meaning, so the line never counts timeline frames too; the whole length is a time, and its tooltip says "2.0 s in all: 48 timeline frames at 24 fps, with the inbetweens"; the line drops at the short height tier) · a two-column grid: **Inbetweens** (a stepper for every selected card) and **Easing** (an inline-labelled select that shows the current easing, today's six modes, section 5.7); **Copy · Paste · 🗑** (the frame commands with their words) and **Edit together** (the field switch of Advanced's range inspector, one name in both modes; today's "Edit selected frames") · **Layer ● Bubble ▾** (`#layers-button`: the layer Simple edits, its chevron beside the name; it opens the Layers popover). At compact width it is one 212px column again; revision 4.3's timeline height gives it room, so at 800×600 every row, the Layer row last, is whole without a scroll (`reference/92`).

**Filmstrip** (`.sheet-filmstrip`, listbox "Animation frames"): cards framed as today, the number, one quiet duration bar (the "Frame N inbetweens" slider); **the current card says its count in words** ("6 · 5 inbetweens"), as do a hovered card and a bar being dragged; the other cards show their number only. Double-click a card: its easing (as today). The strip's **zoom and Fit** sit above its top-right end (today's floating zoom, off the cards). The working copy keeps today's behaviour (the edited dot; Keep changes / Discard). **Card menu** (right-click, Shift+F10): *Change easing…* · *Insert inbetween…* ─ *Copy frames* · *Cut frames* · *Paste frames* ─ *Delete frames* `Del`; while the layers are locked *Unlock layers* replaces the editing rows. During playback a transform-only progress line moves along the current card's bar.

### 5.7 Advanced timeline (`reference/01`, `02`, `26`, `27`, `43`, `74`, `85`, `86`, `88`, `100`, `130`–`132`, `135`, `189`–`192`, `195`, `196`)

The grid stays canvas-drawn by `layer-timeline.mjs` (`ROW = 32` for content rows, row model unchanged; revision 4.3: Camera and Scene are 24px pinned rows, and content rows are 28px at the short height tier only, section 1.9). **Keys are drawn as today, better:** round 9px keys in the row's colour with a 1px outline; blank keys and cel starts hollow; soft 12px exposure capsules and thin tween arrows; Camera and Scene keep today's key colours (Camera blue, Scene violet) with neutral spans; neutral cels (the active one outlined in blue, **a thumbnail of the drawing inside a cel wide enough to show it**); effect clips as neutral blocks with their keys; a line every 5 frames; ruler numbers every 5 frames across the whole visible span; the quiet area past the end; the playhead line under the keys and a white-on-blue tab; onion ranges on the ruler whenever onion is on (today's colours, 24px draggable ends that sit inside the ruler, never over the Camera row; section 5.9).

**Easing: one vocabulary on every surface** (revision 4.3; the easing popover, the range inspector's select, the Simple frame bar's select, the frame and card menus' *Change easing…* and a VFX parameter's *Easing ▸*): **today's six modes in today's order, Auto · Bezier · Ease in · Ease out · Linear · Constant** (`keyframe-easing.mjs`, whose validation message names them; `hold` stays a read-compatible alias of Constant and is never shown). New keys start on **Constant**, as today. The popover draws each mode as a small curve with its name and a tooltip ("Auto: smooth through the keys around it", "Bezier: your own curve (drag the handles below)", "Constant: holds, then jumps (new keys start here)"); dragging a handle makes the key Bezier. Revision 4.2's Smooth, Hold and Custom… are gone (they renamed today's modes, and one select listed Hold beside Constant).

**Direct manipulation (revision 4, O8)**, drawn only where the pointer or the selection is:

- **The exposure's end handle**: the selected exposure (and a hovered one) shows a 3px blue grip at its end in a 24px target; drag it to hold longer (today's hidden edge drag, T30).
- **Live timing while dragging keys**: the ruler shows "12 → 14" beside the playhead tab until release.
- **Double-click keeps today's meanings**: a key opens its easing (the easing popover: presets, the curve with its two handles, and their numbers, EA-02/03); an empty cell adds a key.
- **Clicking a key or a range shows the range inspector** (Edit together, Easing, Timing) with the frame commands as quick actions.
- **Effect clips**: fade handles on the selected clip.

**Label column** (196; 168 narrow; 156 compact and minimal; its edge is a splitter, double-click resets). **Its header** holds the title "Layers", **Focus selected layers** (today's one-click header toggle, revision 4.1; pressed while a focus is active), **New layer** (a split button: `+` adds a layer and opens its name for typing, in Draw a drawing layer; the chevron adds the other kind) and **Find layers** `Ctrl+F` (the find field replaces the title and filters rows as you type; Esc clears). Rows (`.sheet-layer`, 32px) have one marker each (a type icon for Camera and Scene, the colour dot, a muted brush glyph after a drawing layer's name, the parallax depth "· 40%" after a layer's name while parallax is on). **Eye and lock are on every row at rest** (revision 4.1), in their own column, as quiet `--text-3` glyphs like today's 35% icons, and at full contrast when not at their default (a hidden layer's eye-off, a locked layer's lock), so a newcomer sees at first glance that layers can be hidden and locked; only a **grip** (at the row's start, for reordering) and an effect row's **Visible keys** wait for hover. Camera-motion lanes collapse with a twisty on the Camera row.

**The ruler tools' own column** (revision 4.3; revision 4.2 floated them over the ruler, which hid the last frames, the "45" and, at 640–760px, the playhead tab and the onion ends): **Timeline zoom** (`#timeline-zoom`, a quiet slider; Ctrl+wheel too), **Fit timeline** (`timeline-fit-frames`: the whole animation in the width left of the column) and **Tall timeline** (`#expand-timeline`, a quiet toggle; today's header expand; revision 4.3: its own glyph, a panel growing upward, never full screen's four corners). The ruler and the grid end before the column; under the tools it holds the drawn scrollbar and the "N more" cue (section 1.9). The label column's header shows **Focus selected layers** once there are two or more layers (or while a focus is active).

**Menus:**

- **Row menu** (right-click a row, Shift+F10; `reference/86`, `114`): *Rename layer* `F2` · *Layer colour ▸* ─ *Move layer up* · *Move layer down* · *Duplicate layer* (drawing layers) ─ *Focus selected layers* (reads *Show all layers* while a focus is active) ─ *Delete layer*.
- **Background menu** (right-click an empty part of the grid or the label column; `reference/85`): *Fit selected frames* · *Reveal playhead* ─ *Show all layers on canvas* · *Unlock all layers* ─ *Select Camera* · *Select Scene*.
- **Camera motion clip menu** (a right-click on a clip in the Camera row, or the clip context's `⋯`): *Preview motion* ─ *Mute motion* · *Duplicate motion* · *Bake clip range* ─ *Delete motion*; while the Camera is locked *Unlock Camera* replaces the editing rows.
- **Frame menu** (right-click cells or a selected range; `reference/27`): *Copy frames* `Ctrl+C` · *Paste frames* `Ctrl+V` · *Cut frames* `Ctrl+X` ─ *Change easing…* (opens the range inspector's Easing) · *Insert inbetween…* · *Make movieclip…* ─ *Extend* `Shift+A` · *Insert blank key* `F7` · *Insert copied key* ─ *Remove keys* `Del` (the keys go, the time stays) · *Delete frames* `Shift+F5` (the time goes). With a drawing row targeted the blank and copied rows read *Blank drawing here* and *Copy drawing here*, and *Next copied drawing* and *Next blank drawing* join them. While the targeted layers are locked, *Unlock layers* replaces the editing rows.

### 5.8 Transport and playback

`#play-button` is the soft disc in every tier. Space plays and pauses; holding Space pans. During playback only the readout (5 Hz) and the playheads are written; the inspector freezes and refreshes on stop; the camera monitor does not update; the one exception is the quiet "Slow · 14 of 24 fps" message, written at most once a second and only while playback misses its target.

### 5.9 Onion skin (`reference/39`)

The header's split button (the toggle `O`, and its chevron), the ranges on the ruler while onion is on (drag their ends: today's 7×9px handles, now a 24px target **inside the ruler**, never reaching into the Camera row; T06 takes 2 steps, as today's own drag; revision 4.3, **hit priority**: a press and release without movement on an end passes through as a click on the ruler, so it goes to that frame (T05), and only a drag past the drag slop moves the end; the end's tooltip says "Drag to adjust (a click goes to the frame)"), and **the settings popover with every option today has** (it applies live and closes on the next click elsewhere), in two titled groups: **Range** (Before and After, each with its colour dot that opens the colour picker; Sample: Poses │ Frames; Every) and **Look** (Opacity; Show: All │ Selected; Tint, Fade; Show on top; Joined figures; Camera outline). **Defaults are today's** (off on new installs; `#e76b70` before, `#549de7` after, 14% opacity, 2 before, 1 after, Tint and Fade on).

### 5.10 Audio (`reference/135`)

The header's **Audio** toggle opens today's audio lanes (`#timeline-audio-panel`, 64px rows, waveform in `--audio-ink`, the clip popover for gain, trim and fades) under the layers; **its mint dot shows only while the animation has sound** (the demo file's whoosh.wav in `reference/135`, drawn with its waveform and trim end; never a new file, `reference/13`). *Import audio…* sits at the lanes' head; a file with no sound shows "Drop a sound here". Dropping audio anywhere on the timeline imports it (O13). Unchanged behaviour.

### 5.11 Camera and movieclip sessions (`reference/37`, `36`, `150`, `184`, `197`)

Viewing and editing are separate: *View › Camera frame* `Ctrl+K` only shows the frame. Editing is a session started by selecting the Camera row, double-clicking the frame, or the Scene menu's *Edit camera*. While editing: the band holds **Done**; the stage header's start shows "Scene 1 › Camera"; the band also keeps **Save** and **Export** (revision 4.3, as today's title bar does with the Camera selected); the inspector holds the camera context (section 5.1); the frame uses `--sheet-camera-line`. **The figures' joint handles stay drawn, dimmed to 50%, and draggable** (revision 4.3; revision 4.2 hid them, which today's app does not): **a joint drag poses the figure and ends the session in one gesture**, as today (T49: adjust the camera, then pose, 3 steps as today). **Clicking a figure or another row leaves the session** (as today's selection change did; R19), as do Done and Esc.

**Movieclip editing** is the same kind of session: the band holds **Cancel** and **Done** (`movieclip-cancel`, `movieclip-done`: today's breadcrumb pair) after Save and Export, the stage header's start shows the scope path ("Scene 1 › Punch"; nested clips add levels), and the rest of the scene fades. Double-clicking a clip instance enters it.

### 5.12 Menus

One `.ui-menu` component (top layer, 232–320 wide, 28px items, an icon, check or pad on every row, shortcuts as plain text, a reason line for disabled items, submenus with hover intent, scroll, flip and shift inside the window). Menus render from the command registry. Items that make no sense in the workspace or the current state are hidden, not disabled. **Glyphs** (revision 4.1): one glyph per concept, checked by **SVG content** as well as by name (today's icon set ships byte-identical pairs: `rotate` = `reset`, `sliders` = `settings`, `chevron-up` = `up`; revision 4.1 draws Rotate 15°, Exact values, the order steps, Match previous and next pose, Next copied drawing, Join to figure and Focus selected layers with their own glyphs); and at rest one symbol stands for one command family (the audit fails a state where, say, ◀| means both "previous frame" and "match the previous pose"). **Revision 4.3:** across every state, menus included, and with no alias between families: a frame step (`,` `.`: the transport's ◀| |▶) and a key jump (`Shift+,` `Shift+.`: a round key with an arrow) are two families with two glyphs, in the Animation menu, Timeline ⋯ and a VFX parameter's menu alike.

**Two kinds of menu.** The **menubar menus** (File, Edit, View, Animation or Figure, Help; and the StykAnimate menu's copies at the minimal tier) are **registry indexes**: they list their group's commands in full, wherever those commands live. Every other menu (the selection, joint, part, scene, frame, card, row, background, camera motion, pixel selection, movieclip, camera, timeline, zoom, add, new layer, effect, VFX header, library and tab menus) lists the commands of its context; a command whose home is a quick action, a tool option or a section action appears in its context menu too (the visible home plus menu aliases rule, section 8). **One glyph per concept** holds for menu rows, quick actions, tool options and view toggles (visual-system §10); the reference build fails on a collision.

| Menu | Items (groups separated by ─) |
|---|---|
| **StykAnimate (the mark)** | Search commands… `Ctrl+P` ─ (at minimal width: File ▸ · Edit ▸ · View ▸ · Animation ▸ or Figure ▸ · Help ▸ ─) Settings… `Ctrl+,` · About StykAnimate · Check for updates… (becomes *Restart to update*) ─ Quit `Ctrl+Q` |
| **File** (index) | New animation `Ctrl+N` · New window · Open… `Ctrl+O` · Open recent ▸ ─ Save `Ctrl+S` · Save as… `Ctrl+Shift+S` · Save figure… · Rename… ─ Import figures… · Import image… · Import background… · Import audio… ─ Export… `Ctrl+Shift+E` ─ Quit |
| **Edit** (index) | Undo · Redo ─ Cut · Copy · Paste · **Paste in place** `Ctrl+Shift+V` · Paste special ▸ (Paste instance · Paste unique copy) · Duplicate `Ctrl+D` · Delete ─ Select all `Ctrl+A` · Invert selection · Select same figure ─ Settings… `Ctrl+,` |
| **View** (index; `reference/116`; **every checkmark is the state of the toggle it names**, audited) | Canvas: Joints `Shift+J` · Other figures' joints `Ctrl+H` · Motion paths `M` · Motion path settings… · Grid `Ctrl+'` · Grid and guides… · Camera frame `Ctrl+K` · Effects preview · Onion skin `O` ─ Build (in Build): Highlight part `F12` · Static handles `F10` · Smart snapping · Construction colour… `F9` ─ Zoom: Zoom in · Zoom out · Fit canvas `Shift+1` ─ Panels: Properties `Ctrl+1` · VFX `Ctrl+2` · Library `Ctrl+3` · Timeline `Ctrl+4` · Layout… `Ctrl+Alt+L` · Focus mode `Ctrl+\` · Full screen (**no default key**: `F11` is today's *Copy camera*; revision 4.2) |
| **Animation** (index; Animate, Draw) | Play / pause `Space` · Loop ─ First frame `Home` · Previous frame `,` · Next frame `.` · Last frame `End` · Previous key `Shift+,` · Next key `Shift+.` (their own glyph, revision 4.3) · Go to frame… `Ctrl+G` ─ Add frame `A` · Extend `Shift+A` · Insert blank key `F7` · Insert inbetween… · Delete frames ─ New layer · New drawing layer ─ Movieclip ▸ (New movieclip… · From selection… · From frames…) ─ Timeline ▸ (Simple, Advanced) |
| **Figure** (index; Build; `data-app-menu="editor"`) | Exact values… `I` ─ Split `S` · Duplicate part · Flip horizontally · Flip vertically · Arrange ▸ ─ Set as origin · Remove joint, keep ends `Ctrl+Del` ─ Connect joints… · Attach image… · Find part… `Ctrl+F` ─ Delete part `Del` · Delete branch `Shift+Del` |
| **Help** (index) | Keyboard shortcuts `?` · Tutorials ▸ · What's new ─ Report a bug… · Share an idea… · Performance ─ Privacy and diagnostics · Support development · StykAnimate website ─ About StykAnimate · Check for updates… |

**Context menus** (right-click, `Shift+F10`, the Menu key). Every context menu repeats the clipboard group where it applies (aliases of the Edit entries). **Which canvas hit opens which menu** (revision 4.2): a right-click on **a joint handle or a limb stroke** selects that joint and opens the **joint menu**; on **the figure's origin handle** (or with several figures selected) the **selection menu**; on **the empty canvas** the **Scene menu**; with Select pixels or Transform, on the drawing, the pixel selection menu; in Build, on a part, the part menu. The inspector's ⋯ opens its context's menu (the figure's selection menu, the joint's joint menu).

| Context | Items |
|---|---|
| **Canvas, empty = the Scene menu** (a right-click on the empty canvas and the Scene inspector's `⋯`; `reference/38`) | Paste · Paste in place · **Paste instance · Paste unique copy** (flat, two clicks as today's list; revision 4.2) ─ Select all ─ Edit camera |
| **Selection** (a right-click on a figure, the figure inspector's `⋯`, Shift+F10; `reference/08`, `29`, `91`) | Copy · Paste · Paste in place · **Paste instance · Paste unique copy** (flat rows, as today's right-click list; revision 4.3: revision 4.2 had them only in the Scene menu) · Duplicate ─ **Flip horizontally** `Shift+H` · **Flip vertically** `Shift+V` · **Rotate 15°** · **Centre** · Arrange ▸ (Bring to front, Bring forward, Send backward, Send to back) ─ Join to figure `J` · Combine connected (connected figures only) ─ **Reset pose** · **Reset colours** ─ Make movieclip… · Add to library · Edit figure ─ Delete |
| **Joint** (a right-click on a joint handle or a limb, the joint inspector's `⋯`; `reference/30`, `117`) | **Today's joint right-click list first** (revision 4.2, C95): Copy · Paste · Paste in place · Paste special ▸ · Duplicate ─ Isolate joint `Caps Lock` · Exact values… `I` · Match previous pose `L` · Match next pose `Shift+L` ─ **Flip limb** `Shift+H` · **Flip vertically** `Shift+V` (the figure) · Arrange part ▸ (the part's order in its figure) · **Join to figure** `J` ─ **Figure ▸** (only the rarer figure rows: Flip horizontally, Rotate 15°, Centre, Arrange ▸, Reset pose, Reset colours, Make movieclip…, Add to library, Edit figure) · **Edit part ▸** (revision 4.3, `reference/193`: today's Editor-menu segment commands on this joint's part, run in place in Animate, 3 clicks as today: its first line names the part and **its scope, "Line 4 · changes all 3 Bubbles"** (a shared figure's edit changes every copy, as today, but now it says so), then Split `S` · Remove joint, keep ends `Ctrl+Del` ─ Duplicate part · Duplicate branch ─ Flip part · Flip part vertically · Flip branch · Flip branch vertically ─ Set as origin ─ Delete part `Del` · Delete branch `Shift+Del`; each edit is one Undo step and shows **"Split Line 4 in all 3 Bubbles · Undo"**, `reference/194`) · **Edit in Build** (opens Build on that part, for everything else) ─ **Delete** |
| Build part / Structure row (`reference/31`) | Split `S` · Duplicate part · Select branch · Exact values… `I` ─ Flip horizontally · Flip vertically ─ Bring to front · Bring forward · Send backward · Send to back ─ Copy appearance · Paste appearance ─ Isolate joint · Set as origin ─ Remove joint, keep ends `Ctrl+Del` · Delete part `Del` · Delete branch `Shift+Del`. With Shift or Whole branch on, Split, Duplicate and Flip act on the branch. With a fill targeted: Bring fill to front · Send fill to back ─ Delete fill |
| Movieclip (`reference/71`, `36b`) | Edit clip (instance) ─ Make unique · Break apart frame · Bake to frames ─ Export clip… |
| Camera (`reference/90`) | Copy camera `F11` · Paste camera `F12` ─ Reset camera `Ctrl+Alt+K` |
| New layer ▾ (`reference/132`) | New layer · New drawing layer |
| **Next copy ▾** (Draw's timeline header; `reference/161`) | Next copied drawing · Next blank drawing ─ Blank drawing here `F7` · Copy drawing here · Extend `Shift+A` (the frame menu's drawing-row rows) |
| Pixel selection, brush preset, frames, filmstrip card, row, background, camera motion clip, VFX parameter, effect, VFX header | Sections 5.3–5.7 |
| Library (`reference/127`) | Preview background · Animated previews |
| Inspector tab | Dock left · Dock right · Float · Fold to strip · Hide |
| Library card (its ⋯ on the selected card and on hover; `reference/162`) | Insert · Rename · Move to… · Show in folder ─ Move to Recycle Bin |
| Text fields (desktop) | Cut · Copy · Paste · Select all |

`#menu` stays the host instance with `.menu-item[data-action]`, `role=menuitem`, `span` + `kbd`, so the tests that use `#menu [data-action=…]` keep working (architecture §3.4).

### 5.13 Command palette (`reference/22`)

`Ctrl+P`, `Ctrl+Shift+P`, `F1`, or *Search commands…* in the StykAnimate menu. A top-anchored dialog on the dimmed veil: a search row, then groups **Commands** (registry, shortcut as text), **In this project** (figures, layers, clips, scenes), **Learn** (tutorials) and **Settings**. Typing a number jumps to that frame. Out-of-context commands show a reason; choosing one switches workspace first. The palette is an index, never a home.

### 5.14 Dialogs

Native `<dialog>` + `showModal()` (hotkeys suspended), `<form method="dialog">`, initial focus `[autofocus]` → first field → primary (never × and never a tab); a pointer-opened dialog keeps a text field's ring off until the first key press (`data-pointer-open`); a fixed size per dialog; a dimmed veil declared on `::backdrop`; no blur. Sizes: sm 420, md 640, lg 880×min(540, window − 32); radius 16. At compact and minimal md and lg dialogs are full-window sheets.

**Export** (`reference/06`, `17`, `49`, `56`, `172`–`174`, `174b`), 960 × 700 (min(700, window − 32); 880 × 520 until the quick presets), one height for every type, so the preview never jumps:

```
┌ preview (sunken mist) ─────────────┬ Export                                                × ┐
│                                     │ Quick presets                                            │
│                                     │ [YouTube] [Shorts] [TikTok] [Instagram]                  │
│                                     │ [X] [Chat GIF] [Transparent] [Best quality]              │
│                                     │ Ready for YouTube: 1920 × 1080.                          │
│ ┌ live preview 16:9 ────────────┐  │ ──────────────────────────────────────────────────────── │
│ │                                │  │ Name     [ kick-combo                             .mp4 ] │
│ │                                │  │ Format   [ Video | GIF | Frames | Project ]              │
│ └────────────────────────────────┘  │ Type     [ MP4 (.mp4)                              ▾ ]   │
│ ▌▭ ▭ ▭ ▭ ▭ ▭ ▭ ▭▐  (ink trim ends)  │ Size     [ Original · 960 × 540                    ▾ ]   │
│ ▶ Frames  [From 1] [To 48]          │ Quality  [ Draft | Great | Max ]                          │
│                                     │ Sound    [ whoosh.wav                             (on) ] │
│                                     │ Picture  [ Smooth edges ▾ ] [ Transparent        (off) ] │
│                                     │ Encoding ›                      H.264 · automatic bitrate │
│                                     │ 960 × 540 · 2.0 s · about 1.1 MB        Cancel [Export MP4] │
└─────────────────────────────────────┴──────────────────────────────────────────────────────────┘
```

- **Quick presets** (`src/export-presets.mjs`) come first: eight tiles (a glyph, the place and what it makes, "1080p · 9:16") that fill in Type, Size and Quality. The chosen tile is the selected surface with the accent line until a setting it chose changes; the note under the tiles says what the export will be, or in the warning ink that a canvas of another shape will play with bars and where Canvas size is. A vertical preset shows the preview in a 9:16 frame with black bars. Presets keep the canvas's shape (see [export experience](../export-experience.md)).
- **Format** is one segmented control matching today's categories (`[data-category=video|animated|frames|editable]`); **Type** (`#output-format`) is a visible select beside it, with a line under it saying what the chosen type is for, listing the category's formats (Video: MP4, WebM, AVI, WMV, VFW; GIF: GIF, APNG; Frames: PNG, SVG, PNG/JPEG/GIF/SVG sequences; Project: .piv, .stkz, .stk, .stykmov). The browser build starts on the first video type it supports (WebM).
- **Size** starts on **Original** (the artboard's size, today's default; revision 4.1) and remembers the person's choice; presets: Original, 1080p, 720p, 4K, Custom…; a preset whose aspect differs from the artboard is disabled with a reason ("needs a 9:16 canvas").
- **Frames**: drag the ink ends of the frame strip (`#export-start`, `#export-end`) or type **From** and **To** beside the caption (in the active numbering; Simple: "Frames 1–8 · plays as 48").
- **Picture**: Edges (Smooth │ Crisp), Transparent (GIF, PNG, WebM).
- **The chosen type's own settings** (revision 4.2, drawn in `reference/172`–`174b`): **GIF** shows *Colours: Dither* (a switch that **starts from `defaultGIFDither(report)`, as today**: on only when the animation has image backgrounds or image parts, off for the vector-only demo, `reference/173`; revision 4.2 had drawn it on) instead of Quality and Sound. **Video** types end with **Encoding**, a titled section (closed at rest, as today's *Advanced video settings*; its title shows the current summary, "H.264 · automatic bitrate"; it opens in place and remembers being open): MP4 *Codec* (H.264 │ MPEG-4), *Bitrate* (Automatic │ Set manually) and *Target* Mbit/s; AVI *Codec* (MPEG-4 │ FFV1 lossless │ Raw); **VFW** (Windows) *Codec* (the installed codecs) with *Configure…*, *Quality* %, *Keyframes* every N and *Rate* Mbit/s. When Encoding is open the form column scrolls under a fade; the dialog keeps its height. **Custom size**: choosing *Custom…* shows Width, *Lock ratio* (a linked-values glyph, on) and Height on the row under Size. A **Project** lists its four types as a visible list (Pivot animation .piv, StykAnimate figure .stkz, Pivot figure .stk, Movieclip .stykmov), one click each, as today's editable-file choices.
- Choices are remembered in `exportPreferences`. Progress stays in the dialog (`#export-progress`, `#cancel-export`); Esc and × ask "Stop exporting?". The primary names the format ("Export MP4"). A successful export shows a message with *Show*.

**Settings** (`reference/47`), md: line tabs Interface, Canvas, Animation, Shortcuts (the desktop app adds Feedback and Privacy: the statistics switch, "See the last report" and the privacy note). Interface: Theme (System │ Light │ Dark), Language, Interface size (75–200%), Timeline (Simple │ **Advanced**, the default; a mirror of the header's switch), Panel layouts (Reset all). Every existing setting group is kept (Canvas: joint handles, zoom gesture, box selection, figure builder, graphics, pen; Animation: playback quality, backup interval). *Done* closes; changes apply live.

| Dialog | Size | Content | Primary |
|---|---|---|---|
| Save changes? | sm | "Save changes to Kick combo?" · "Your changes will be lost if you don't save them." | **Save** · *Don't save* (danger ghost) · Cancel |
| Edited frame (Simple) | sm | Today's decision, unchanged semantics and default | **Keep changes** (`#keep-editing`) · *Discard* (`#discard-changes`) |
| Build exit | sm | Section 5.2 | **Update all 3 Bubbles** |
| About | sm | Symbol, "StykAnimate", version, links | **Close** |
| Text | md | Preview and fields (content, font, size, line height, bold, italic, alignment, colour, opacity, outline) | **Add text** / **Update text** |
| Background | md | Library, search, colour, gradient, image, fit | **Use background** |
| Exact values | sm | Angle, Bend, Length, Relative angle, Copy/Paste values | **Apply** |
| Insert inbetween | sm | Where, count, easing, preview | **Insert** |
| Sprite placement | md | Canvas with handles, anchor, scale (the mode message explains the drag) | **Place image** |
| Movieclip | sm | Name, source, options | **Create clip** |
| Keyboard shortcuts | lg | Read-only, grouped, searchable, filtered by workspace, including the power gestures (Alt-drag rotates and scales, Ctrl-drag stretches, right-drag bends, Caps Lock isolates, R edits handles, L matches the pose); the only place keycaps appear; *Edit shortcuts…* opens Settings › Shortcuts | **Close** |
| Performance | md | Live numbers, renderer, activity log, "Copy report" | Close |
| The last report (Settings › Privacy) | md | The exact JSON last sent and waiting, or "Nothing has been sent yet" | Close (*Privacy note*, *Copy*) |
| What's new | md | Release notes | **Start animating** |
| Feedback | lg | The shared support centre | per form |

---

## 6. Overlay system

- One `OverlayManager` owns every menu, popover, sheet, palette, message and dialog: one outside-click and Esc owner, focus return to the invoker (fallback `#viewport`), a hotkey gate (menus capture typing), a startup prompt queue, `no-drag` on every root. Esc closes every popover (today's onion popover ignored it, tasks.md problem 6).
- **Nesting.** A menu or picker opened inside a dialog mounts inside it; one opened from a popover or sheet uses `showPopover({ source })`, so the host stays open.
- **View popovers pass through** (revision 4.1): Grid and guides, Motion path settings and Onion skin settings apply live and close on the next click elsewhere, and that click still acts (it is the next step, not a separate close step). Other popovers and menus close on an outside click as before.
- **Positioning.** CSS anchor positioning with flip fallbacks, 6px offset; menus anchor to their invoker (the menubar's menus under their names, the Onion popover above its chevron, the Layers popover above the frame bar's layer button); context menus open at the pointer and flip. Every menu's top is clamped to the band's bottom edge + 6px, its height to the window below that.
- **Tooltips.** One ink tooltip (`popover="hint"`), 500ms delay, instant between neighbours: the name, a middle dot and the shortcut as plain text, from the registry. Accessible names never include the shortcut; `aria-keyshortcuts` carries it.
- **The message** is not an overlay in revision 4: it is the stage header's centre (section 4.3), in flow, so it never covers the artwork or another overlay.

---

## 7. Interaction details

### 7.1 Hover, selection and feedback

Hover is `--surface-hover` in 100ms; pressed `--surface-pressed` with a .97 scale on controls of 28px or more; selection is `--surface-selected` (rows) or a 2px `--accent-line` ring (cards); a view toggle that is on is a quiet soft tile; a mode toggle that changes what edits do is blue-soft; focus is a 2px `--focus-ring`. On the canvas: today's renderer only (section 4.5).

**Scrub labels say so** (revision 4.2): a field's label that scrubs has a quiet dotted underline at rest and the ↔ cursor and the accent on hover; the first time a person focuses such a field, the message slot shows once "Drag a label to scrub · Shift ×0.1 · Alt ×0.01" (today's permanent caption under Transform, P12, made a one-time hint).

**Feedback with Undo (O11).** The Undo and Redo tooltips name the action ("Undo Move Bubble"). Destructive or wide-scope edits show a message with *Undo* ("Deleted 6 frames · Undo", "Applied to 6 frames · Undo", "Frames 22–28 eased · Undo").

### 7.2 Keyboard model

- **Regions (F6):** band → rail → left dock → stage header → stage → right dock → timeline → floating panels. `Ctrl+F6` reverses. Each region remembers its last focus.
- **Inside regions:** the rail, toolbars (the tool options, quick actions, view cluster), tab lists and the menubar are single tab stops with arrow keys; the filmstrip is a listbox; Structure is a tree; the label column is a grid of rows; menus have typeahead.
- **Canvas (`#viewport` focused):** `[` / `]` previous and next joint in Animate and Build; arrows nudge; Alt+arrows move the selection; Ctrl+←/→ previous and next figure; **Shift+F10 or the Menu key open the selection menu** (fixed: C94); `I` Exact values; Caps Lock hold isolates; Esc cancels, clears, then leaves the canvas.
- **Timeline:** `←` `→` move the selected keys by a frame (Shift: 10) (O10); `Enter` on a tween opens its easing; number keys `1`–`6` pick an easing preset while the easing select is focused; `F2` renames the selected layer; `Ctrl+F` finds layers.
- **Alt.** While the menubar is docked (every tier but minimal) a clean Alt tap focuses it and underlines its access keys; at minimal width it shows the menubar as an overlay above the band's start. The tap is cancelled by any pointer, wheel or other key while Alt is down, a hold over 500ms, or an active gesture.
- **New default shortcuts: every one is listed, with its conflict check, in section 11 for the owner's approval** (revision 4.2: the table there lists all of them, not a subset). Without approval each command is bindable with no default key. **Full screen has no default key** (`F11` is today's *Copy camera*, `F12` *Paste camera*). Loop and Bring to front / Send to back get bindable entries with no default key. `?` opens Keyboard shortcuts; Settings stays on `Ctrl+,`.

### 7.3 Direct manipulation and drag and drop

Every drop target calls `preventDefault` on `dragover` and `drop`, so the global file drop never double-imports. **Drop feedback stays off the canvas** (revision 4.3; revision 4.2 specified an outline, a glow and a highlight on the drawing, which the owner's veto on selection rings, halos "and stuff" rules out): while a colour, an effect or an image is dragged over the stage, the **cursor carries a small badge** of what is dragged (the swatch, the effect's glyph, the image's thumbnail) and **the message slot says what the drop will do** ("Drop to colour Bubble · left forearm", "Drop to add Glow to Bubble", "Drop to attach logo.png to Line 4"), updating as the pointer moves between targets; nothing is drawn over the artwork. Letting the canvas show the result live (the limb in the new colour, the effect rendered, the image at the joint), with no outline, glow or highlight, is listed in section 11 for the owner's decision; without it the badge and the message are the whole feedback.

| Drag | Feedback | Keyboard or menu alternative |
|---|---|---|
| OS files onto the window | `#canvas-empty` "Drop to open or import" | File › Open / Import |
| Audio anywhere on the timeline | The lane (or the Audio button) highlights | File › Import audio… |
| A swatch (recent colours, the colour picker) onto a limb or a figure (O13) | The cursor's swatch badge and the message "Drop to colour Bubble · left forearm" (never an outline on the canvas) | The inspector's colour field |
| An effect tile onto a figure (O13) | The cursor's effect badge and "Drop to add Glow to Bubble" (never a glow on the canvas) | VFX › the tile |
| An image onto a joint in Build (O13) | The cursor's thumbnail and "Drop to attach logo.png to Line 4" (never a joint highlight) | Attachment › Attach image… |
| Library card to the stage | Ghost card | Enter inserts |
| A key or a range in the timeline | "12 → 14" on the ruler | `←` `→` with the keys selected |
| The exposure's end | The capsule stretches; the frame count shows | Frame menu › Extend, `Shift+A` |
| A layer row (grip on hover) | 2px accent drop line | Row menu › Move layer up / down |
| Structure reorder / reparent | Drop line or inside ring | Part menu's order rows |
| A panel tab | One calm drop target | Layout popover; tab menu; `Ctrl+Alt+M` |
| Splitters (islands; the label column) | 2px accent bar on hover | Arrow keys, Home/End, double-click resets |
| Filmstrip duration bar | The count shows on the card | The frame bar's Inbetweens; slider arrows |
| Export trim ends | The ends move; From and To update | Type From and To |
| Onion range ends on the ruler (a 24px target inside the ruler; today's 7×9px handle; a press without movement goes to that frame, revision 4.3) | The band moves | The Onion popover's steppers |
| Rows below the fold (revision 4.3) | The "N more" cue at the list's foot scrolls them in; the wheel and ↓ in the list too | ↑ ↓ in the label column |

### 7.4 Pen, touch and hover-free input

Eye and lock are visible at rest everywhere (revision 4.1). Under `(hover: none)` grips, twisties, a library card's ⋯ and every other hover-revealed action are always visible too. Nothing opens on hover alone. Press-and-hold (500ms) opens context menus; the pen barrel button still does. Zoom and Fit are on screen in the stage header. Every custom drag uses `dragSlop` (5px pen, 10px touch).

### 7.5 Motion and reduced motion

Only transform, opacity and colour animate; docking commits instantly; overlays enter over 160–240ms; the segmented thumb springs; a titled section's chevron rotates 90° as it opens. With `prefers-reduced-motion` everything is instant.

### 7.6 Interaction fixes on the power routes (revisions 4.2 and 4.3)

Measured defects on today's routes (the task study's problems 4, 5 and 7, internal research, not in the repository), fixed at the UI layer; none changes a default or the document model:

- **Shift-click extends from a fresh anchor** (problem 4; T29, T32): a plain click on a key, a cell or a frame card **resets the selection anchor** to that frame, so the next Shift-click extends from it (today the anchor goes stale after a plain click and Shift-click extends from an older frame). A Ctrl-click toggles and leaves the anchor where it is. The ruler's selection feedback names the range ("22–28") while Shift is down.
- **Camera edits never rewrite a key silently** (problem 5; T39): with the playhead past the last frame, a camera drag is **refused with a message** ("The camera is past the last frame · Add frames to 30 · Go to frame 24"): *Add frames* extends the animation to the playhead first (one Undo step with the edit), *Go to…* moves the playhead back; today's edit rewrote the frame 1 key without a word.
- **Press or drag?** (revision 4.3): on the ruler an onion end is a drag handle, and a press and release without movement passes through as a click on the ruler (it goes to that frame); only a drag past the drag slop (5px pen, 10px touch, 3px mouse) moves the end. The same rule for the exposure's end handle (a click selects the cell under it).
- **The camera session never takes posing away** (revision 4.3; T49): with the Camera selected, the figures' joint handles stay drawn (dimmed) and a joint drag poses that figure and leaves the session in the same gesture, as today; a drag on empty canvas moves the camera frame.
- **A view popover's closing click only selects** (revision 4.3; T28, pending sign-off): it selects or deselects what it lands on and never starts a drag, a pose or a box selection.
- **Size scrubs logarithmically** (problem 7; T45): Brush and Eraser *Size* scrub in proportion to the value (about 4% of the value per pixel, at least 0.5 px), so a 14px drag from 8 px reaches 12 px, not 71; Shift ×0.1 and Alt ×0.01 as every field; the wheel over the field steps one size step (1 px under 10, 2 up to 40, 5 above); `[` `]` keep today's steps. Opacity, Flow and Smooth keep their linear rate (they are percentages).

---

## 8. Command homes, with clicks today and in revision 4

**Home** is the place, named in the Home column, where a person who has never used a shortcut finds the command in context. **Clicks** are pointer actions from the rest state (Animate, a figure selected, the Advanced timeline, 1440×900; revision 4.1 checks every function again at the tier sizes, section 0.3): a menu item is menu + item, a submenu adds 1, a native select adds 2, the Build or Draw switch counts when the command lives there, "(ctx)" means one click once the thing it acts on is selected, and "key" means today had no pointer path. Every row is one registry entry; labels come from the registry.

**The table is checked against today's app, not against itself.** `design/app-ui/reference/tools/registry.mjs` reads today's command set from the app source (the `actions` map, `HOTKEY_COMMANDS`, the timelines' run-time menu labels and the panel-local commands): **391 commands**. `design/app-ui/reference/tools/homes.mjs` is this section as data: every command has one home (260 drawn in the reference and resolved by selector, 30 keyboard-only, 59 aliases, 33 specified but not drawn, 9 internal entries). The audit fails when a command of today's app has no entry, a drawn home is missing, or a command sits on two home surfaces that no rule below explains. **Result: 0 without a home, 0 missing, 0 second homes.** The function-level view (852 rows, every property and gesture as well as the commands) is `function-ledger.md`, checked by `design/app-ui/reference/tools/ledger.mjs` per function (3 rows further than today, all low-frequency documented trades, section 8.7; 0 further at any tier size or from inside the sessions; 0 less visible than today without a documented reason; every visible home names a control the reference draws).

**Indexes and declared aliases are not second homes.** They render the same registry entry. These are the only kinds:

1. **Indexes.** The palette and hotkeys; the menubar menus and the StykAnimate menu's copies of them (File, Edit, View, Animation or Figure, Help, and their submenus), which list their whole group.
2. **A second opener of the same menu object.** The selection menu (a right-click on a figure or, through Figure ▸, on a limb; the figure inspector's `⋯`); the Scene menu (the empty canvas; the Scene inspector's `⋯`); the tab menu; the movieclip menu (an instance; its session); the Figure menu (the menubar; the Build figure inspector's `⋯`); the camera motion menu (a clip in the Camera row; the clip context's `⋯`); the effect menu (an effect row; its clip row); the row menu (a label row; a row of the Simple Layers popover).
3. **The clipboard group in context menus** (Cut, Copy, Paste, Paste in place, Paste special, Select all), by platform convention; its home is Edit.
4. **One home per context, never two in one context.** The joint menu (Animate) and the part menu (Build); the frame menu (Advanced) and the card menu (Simple); Advanced's range inspector and Simple's frame bar (easing, inbetweens, Edit together, Copy, Paste, Delete frames).
5. **Settings mirrors persistent preferences.** Its rows for the timeline mode, Show handles, Show unselected figures, Virtual camera, Motion paths, Static handles and Highlight segment mirror homes elsewhere.
6. **One row whose label follows state.** Focus selected layers / Show all layers; Mute motion / Enable motion; Check for updates… / Restart to update; Hide / Show and Lock / Unlock on a row; Insert blank key / Blank drawing here.
7. **Quit** in the StykAnimate menu and File is the window's Close.
8. **Tier aliases.** A control a tier shows in place of a folded one runs that one's entry: the band's Properties button (compact, minimal), *Timeline ⋯*'s First frame, Loop playback and Audio (minimal), Simple │ Advanced in *Timeline ⋯* (compact).
9. **One row model, two kinds; one scope, two targets.** The VFX list runs each effect-menu row for the row's kind; Edit's Cut, Copy and Paste act on pixels while pixels are selected, on frames while the timeline has focus.
10. **Revision 4: a visible home plus menu aliases.** A high- or medium-frequency command has **one visible home** (a quick action, a tool option, a header toggle or a section's title action) and the context menus of the same selection list it too, as today's menus do: Flip, Front and Back, Duplicate, Join, Delete, Reset colours, Combine, Rotate 15° and Centre (several figures), Isolate, Exact values, Match previous and next, Remove keys and Delete frames, Edit clip and Make unique, Split, Duplicate part, Flip part, Delete part, Copy appearance, New layer and New drawing layer, Blank drawing, Copy drawing here, Extend, Invert selection (pixels), Move layer up and down, Focus, Delete layer, Reset camera, Copy and Paste camera, the motion clip commands, Add to library, the pixel selection's Apply, Deselect and Flip, Flip view, Edit together (the range inspector, the Simple frame bar and the scope line's *Stop*), Edit in Build, Import background (the Scene's title action), and the Timeline panel toggle (Build's view toggles). Revision 3 removed these visible homes as "duplicates"; that is what made 194 functions regress.

### 8.1 Shell, document and application

| Command (`id`) | Home | Today | Rev 4 | Keys |
|---|---|---|---|---|
| StykAnimate menu (`menu`) | Band: the mark | 1 | 1 | `Alt` focuses the menubar |
| Command palette (`command-palette`) | StykAnimate menu › Search commands… | — (new) | 2 | `Ctrl+P`, `Ctrl+Shift+P`, `F1` |
| Menubar menus (`data-app-menu`) | Band: the menubar, docked at every tier but minimal (there, the StykAnimate menu's submenus) | 1 | 1 | `Alt+F/E/V/A/H` |
| Workspace switch (`data-workspace-mode`) | Band switch | 1 | 1 | — |
| Undo / Redo (`undo`, `redo`) | Band (Redo in Edit at minimal) | 1 | 1 | `Ctrl+Z` / `Ctrl+Y` |
| **Save** (`save`) | **Band › Save** (beside Export) | 1 | **1** (revision 3: 2) | `Ctrl+S` |
| Save as (`save-as`) | Document popover › Save as…; File | 2 | 2 | `Ctrl+Shift+S` |
| Rename project (`rename`) | Document popover name field (Enter commits) | 2 (+ type) | 1 (+ type) | — |
| Export (`export`) | Band primary slot; **in a session a quiet labelled button beside Done** (revision 4.3: Build, a camera session, a movieclip session, as today's title bar keeps it) | 1 | 1 (1 in every session, as today) | `Ctrl+Shift+E` |
| Export formats (`export-mp4` … `-svg-sequence`) | Export › Format + **Type** (visible) | 3–4 | 3 | — |
| Project formats (`export-piv`, `-stk`, `-stkz`, `-stykmov`) | Export › Format › Project › Type (*File › Save figure…* is `export-stkz` from a figure) | 3–4 | 3 | — |
| New animation, New window, Open, Open recent (`new`, `new-window`, `open`, `open-recent`) | File | 2 | 2 | `Ctrl+N`, —, `Ctrl+O`, — |
| Save before an update restart or before closing (`save-and-update`, `save-and-close`) | The *Save changes?* dialog's Save | ctx | ctx | — |
| Import figures, Import image (`import`, `import-sprite`) | Rail Add menu (File lists them) | 2 | 2 | — |
| Import background (`import-background`) | File; the Scene's Background title action | 2 | 2 | — |
| Import audio (`import-audio`) | The timeline's Audio › Import audio…; File | 2 | 2 | drop a file on the timeline |
| Settings (`settings`) | StykAnimate menu; Edit | 2 | 2 | `Ctrl+,` |
| About (`about`); Check for updates / Restart to update (`check-updates`, `restart-update`) | StykAnimate menu; Help | 2 (About: broken) | 2 | — |
| Close / Minimize / Maximize | Window controls (Quit is Close) | 1 | 1 | `Ctrl+Q` |
| Keyboard shortcuts (`help`) | Help | 2 | 2 | `?` |
| Tutorials, What's new, StykAnimate website, Privacy and diagnostics, Support development, Report a bug / Share an idea, Performance (`release-notes`, `website`, `privacy`, `donate`, `feedback`, `performance`) | Help (the menubar) | 2 (Performance: 1, the status bar) | 2 (Performance: 1 from the slow-playback message) | — |
| Cancel the current gesture (`cancel`) | Keys; every native dialog has its own × | key | key | `Esc` |

### 8.2 Layout and view

| Command (`id`) | Home | Today | Rev 4 | Keys |
|---|---|---|---|---|
| Layout popover, presets, save, reset (`layout-menu`, `layout-*`) | View › Layout… | — (new) | 2 | `Ctrl+Alt+L` |
| Show/fold a panel (`panel-toggle-properties`, `-vfx`, `-library`, `-timeline`) | View › Panels (Build: the Timeline view toggle) | 2 (Build timeline: 2) | 2 (Build timeline: 2) | `Ctrl+1–4` |
| Dock, float, fold, hide a panel | The tab's context menu; drag the tab | — (new) | 2 | — |
| Focus mode (`layout-focus`) | View › Focus mode | — (new) | 2 | `Ctrl+\` |
| Full screen | View › Full screen | macOS native menu only | 2 | — (revision 4.2: `F11` is today's *Copy camera*; bindable) |
| **Joints** (`toggle-handles`, `#handles-button`) | **Stage header** | 1 | **1** (revision 3: 3) | `Shift+J` |
| **Motion paths** (`toggle-motion-paths`, `#paths-button`) and their settings (`.path-options-button`) | **Stage header** (a split button; the popover) | 1 / 1 | **1 / 1** | `M` |
| **Grid** (`toggle-grid`, `#canvas-guides-button`) and **Grid and guides** settings (`#guides-options-button`) | **Stage header** (a split button: the button shows the grid, the chevron opens the settings popover, which applies live and closes on the next click elsewhere) | 1 (+1 per option) | **1** (+1 per option; a grid and a guide: 3, T28, today 4) | `Ctrl+'` |
| **Effects preview** (`#vfx-preview`) | **Stage header** | 1 | **1** | — |
| Camera frame visibility (`toggle-camera`) | View › Camera frame | key / Settings | 2 | `Ctrl+K` |
| Other figures' joints (`toggle-unselected-handles`) | View › Other figures' joints | key / Settings | 2 | `Ctrl+H` |
| Highlight part, Static handles (`builder-highlight`, `builder-static-handles`) | Build › stage header (when its header is full, 900px: View › Build, 3, as today's builder View ▾) | 3 (builder View ▾) | 2 | `F12`, `F10` |
| Smart snapping (`#builder-snap`) | Build › the tool options | 2 (outliner footer) | 2 | — |
| Construction colour (`builder-canvas-color`) | Settings › Canvas › Figure builder (View › Construction colour… and `F9` open it) | 3 | 3 | `F9` |
| Box selection: figure bounds or origins | Settings › Canvas › Box selection | 3+ | 3+ | — |
| Zoom menu (`zoom-menu`, `#zoom-label`) | Stage header: the zoom value | 1 | 1 | — |
| Zoom in / out, presets, Fit selection (`zoom-in`, `zoom-out`, `zoom-25`…`-200`, `zoom-selection`) | Zoom menu (View lists them) | 2 | 2 | `+`, `−`, —, `Shift+2` |
| **Fit figure** (Build; `zoom-selection`, C220) | **Build › Structure's foot › Fit figure** (today's outliner footer; revision 4.2) | 2 (Build, the outliner footer's button) | **2**, visible | `Shift+2` |
| **Fit canvas** (`zoom-reset`) | **Stage header › Fit** | 2 | **1** | `Shift+1` |
| Flip view, Reset rotation (Draw) | Draw › Pan's tool options; the zoom menu (Draw) | 2 | 2 | `M` |
| Scene properties (`scene-settings`, selects the Scene) | **Stage header crumb** "Scene 1 960 × 540" | 1 | 1 | — |
| **Background colour** (the Scene's `#background-color`) | **The crumb's background chip** (revision 4.1; the Scene › Background swatch too) | 2 (+ the picker) | **1** (+ the picker; T19: 3 steps, today 4) | — |

### 8.3 Tools, the canvas and the inspector

| Command (`id`) | Home | Today | Rev 4 | Keys |
|---|---|---|---|---|
| Add to the scene (`add-menu`): Stick figure, Text, Image, Import figures, New movieclip | Rail Add; **in Draw, the rail +'s corner tick** (revision 4.3; the + itself is today's New drawing layer there) | 2 (Draw: a switch to Animate first, 3) | 2 (Draw: 2) | —, `T` for Text |
| **Another copy of something in this project** (the project library) | **Add › In this project** | 2 (Insert dialog) | **2** (revision 3: none in the browser) | — |
| Examples (figures, rigs, animations) | Add › Examples ▸; Library › Examples | 2–3 | 2–3 | — |
| Select and pose, Tweener, Pan (`select`, `tweener`, `hand`) | Rail | 1 | 1 | `V` (`P`), `W` (new), `H` |
| **Tweener mode** and Amount | **The Tweener's rail tick** (visible at rest, as today's arrow) or **the stage header's Tweener options** (segmented, while active) | 2 (a 14px flyout) | **2** | — |
| Drawing tools (`drawing-*`) and their variants | Rail (Draw); the variants in the tool options | 1–2 (flyouts) | 1–2 | `B`, `E`, `G`, `L`, `U`, `Q` |
| Build tools (`rig`, `select`, `line`, `chain`, `circle`, `polygon`) | Rail (Build) | 1 | 1 | `J`, `V`, `L`, `K`, `C`, `Y` |
| Chain / polygon Finish · Cancel | Build › the tool options while drawing | ctx | ctx | `Enter`, `Esc` |
| Test rig (`rig-test`) | **Build's band, beside Done** (labelled, as today's builder bar) | 2 | 2 | `Ctrl+Enter` |
| Done (`#builder-done`, `camera-done`, `movieclip-done`) | Band primary slot during the session; the crumb's first part | 1 | 1 | `Esc` (camera, clip) |
| **Cancel clip edits** (`movieclip-cancel`) | **Band › Cancel** (beside Done) | 1 | **1** (revision 3: 3) | `Esc` |
| **Edit movieclip** (`movieclip-edit`) | **Movieclip quick actions › Edit clip**; double-click the clip | 2 | **2** | — |
| **Make unique** (`movieclip-unique`) | **Movieclip quick actions** | 2 | **2** | — |
| Break apart, Bake, Export clip (`movieclip-break`, `-bake`, `-export`) | Movieclip menu | 3 | 2 | — |
| Movieclip playback mode, start, speed; Extend (`movieclip-extend`) | Movieclip › Playback; Extend (titled) | 2–3 | 2–3 | — |
| **Isolate joint** (`toggle-isolate`; hold `isolate-hold`) | **Joint quick actions** (latched, its state visible); joint and part menus | 2 (a hidden rail button) | **2** | `Caps Lock` hold |
| Edit handles while held (`handle-edit-hold`) | Keys (listed in Keyboard shortcuts and the Select tool's tooltip) | key | key | `R` hold |
| **Exact values** (`segment-values`) | **Joint quick actions**; joint and part menus | 1 (I) or 2 | 1 (I) or 2 | `I` |
| **Match previous / next pose** (`locate-previous`, `locate-next`) | **Joint quick actions › Match ◀ ▶** (a labelled pair with pose glyphs, never the transport's frame steps) | 3 | **2** | `L`, `Shift+L` |
| IK on/off, pin, chain, bend, stretch, target rotation | Joint › IK (Use IK, Pin joint; the rest while IK is on) | 2 / 3 | 2 / 3 | — |
| Joint Angle, Length, Bend, Static; Width, colour, opacity, order, shape | Joint › Joint, Style (core sections) | 2 | **2** (revision 3: 3) | — |
| Joint cycling, figure cycling, nudge, move | Keys on the canvas | key | key | `[`, `]`, `Ctrl+←/→`, arrows, `Alt+arrows` |
| **Flip horizontally** (`mirror`) | **Quick actions** (figure; several figures; *Flip limb* on a joint); the selection and joint menus | 2 | **1** (revision 3: 3) | `Shift+H` |
| Flip vertically (`mirror-vertical`) | Selection menu (a flat row) | 2 | 2 | `Shift+V` |
| **Bring to front, Send to back** (`layer-front`, `layer-back`); **one step** (`layer-up`, `layer-down`) | **Quick actions › To front, To back** (words; Shift: one step); **one step: Arrange's Z-index stepper** (*Send backward*, *Bring forward*, visible; revision 4.2, today's Stacking buttons); selection menu › Arrange ▸ | 1 | **1**, visible (revision 3: 3; revision 4.1: a Shift-click only) | — |
| A part's order inside its figure (`selection-front`, `-up`, `-down`, `-back`) | Joint menu › Arrange ▸ | 3 | 3 | — |
| Figure Z-index (`figure_z_order`); Layer (`#figure-layer`) | Figure › Arrange (core section: the stepper's value; the Layer select) | 1; 2 | **1; 2** (revision 3: 2; 2) | — |
| **Duplicate, Delete** (`duplicate`, `delete`) | **Quick actions**; the selection menu | 2 | **1** | `Ctrl+D`, `Delete` |
| Cut / Copy / Paste (`cut`, `copy`, `paste`) | Edit (context menus repeat the clipboard group) | 2 (Cut: key) | 2 | `Ctrl+X/C/V` |
| **Paste in place** (`paste-in-place`) | **Edit; the selection and Scene menus (a flat row)** | 2 | **2** (revision 3: 3) | `Ctrl+Shift+V` |
| Paste instance, Paste unique copy | **Scene menu** (a right-click on the empty canvas) **and the selection menu** (a right-click on a figure), flat rows as today's right-click list (revision 4.3; revision 4.2 had them only in the Scene menu); Paste special ▸ in the joint menu and Edit | 2 | **2** (revision 4.1: 3, hidden by a group range) | — |
| Select all / invert / same figure | Edit | 2 | 2 | `Ctrl+A`, —, — |
| **Join / unjoin** (`join-figure`) | **Figure › Arrange's title action, *Join…*** (a word, visible at rest; revision 4.1 keeps the quick actions' sixth slot for a pin); the joint menu; the Connection section while joined (Unjoin); the selection menu | 1 (+ scroll, today's Connection button) | **1** | `J` |
| Combine connected (`combine-figures`) | The Connection section (open while joined); the selection menu | 1 + scroll | 1 | — |
| **Reset pose** (`reset-pose`) | **Selection menu › Reset pose** (a flat row) | **∅ (unreachable)** | **2** | — |
| **Reset colours** (`reset-color`) | **Figure › Appearance's title action**; selection menu | 1 | **1** (revision 3: 3) | — |
| **Rotate 15°, Centre** (`rotate`, `center`) | **Several figures › Selection's title actions**; selection menu (one figure) | 1 (multi); ∅ (one figure) | **1** (multi); **2** (one figure) | — |
| Align left, centre, right, top, middle, bottom (`align-*`) | Several figures › Align (six buttons) | 1 (multi) | 1 (multi) | — |
| Make a movieclip from the selection (`movieclip-create`) | Selection menu › Make movieclip… | 3 | 2 | — |
| **Add to library** (`add-to-library`) | **Figure inspector footer**; selection menu; Library › Add selection | 1 | **1** (revision 3: 2) | — |
| Edit figure (`edit-in-build-mode`); **Edit in Build on a part** | Selection menu; **joint menu › Edit in Build** | 2 | 2; 2 | — |
| Open the selection menu from the inspector (`selection-more`) | The figure inspector's `⋯` | broken | 1 | `Shift+F10` |
| Colours used, fills and their pages (`palette-*`, `polygons-*`) | Figure › Colours (titled) | 3 | 2 | — |
| Edit text (`edit-text`) | Text › Edit text…; double-click the text | 1–2 | 1–2 | — |
| Background style (`background-style`) | Scene › Background › Library… | 2 | 2 | — |
| **Split, Duplicate part, Flip part** (`split-segment`, `duplicate-segment`, `mirror-segment`, `mirror-segment-vertical`; Shift or Whole branch: `duplicate-branch`, `mirror-branch`, `mirror-branch-vertical`) | **Build part quick actions** (Split and Duplicate labelled, as today's builder bar); the part menu | 2 (builder bar) | **2** (revision 3: 3–4) | `S` for Split |
| A part's order (`segment-order-*`) | Part menu (four flat rows); Structure drag | 3 (builder Arrange ▾) | 3 | — |
| **Copy appearance** (`copy-builder-appearance`); Paste appearance | **Style's title action**; the part menu | 3 | **2**; 3 | — |
| Set as origin, Remove joint keep ends, Delete part, Delete branch | Part menu (Delete part is also a quick action) | 3 | 3 (Delete part: 2) | —, `Ctrl+Del`, `Del`, `Shift+Del` |
| **Segment surgery while animating** (today's Editor menu in Animate: `split-segment`, `unsplit-segment`, `origin-segment`, `duplicate-segment`, `duplicate-branch`, `mirror-segment`, `mirror-segment-vertical`, `mirror-branch`, `mirror-branch-vertical`, `delete-single-segment`, `delete-segment`) | **Joint menu › Edit part ▸** (revision 4.3: run in place, as today; the submenu's first line says which figures change, "changes all 3 Bubbles", and each edit's message offers Undo); *Edit in Build* for the rest | 3 (a joint, the Editor menu, the item) | **3** (a right-click on the joint, Edit part ▸, the item; revision 4.2: 6–7 through Build) | `S` (Build), `Ctrl+Del`, `Del`, `Shift+Del` |
| **Whole branch** (`toggle-builder-branch`) | **Build's rail quick options** (its state visible; the scope line while on) | 2 (builder bar) | **2** (revision 3: 4, state hidden) | `B` |
| **Drag: Move joint or Rotate branch** (`#rig-mode`, a select) | **Build › Edit joints' options** | 2 | **2** (revision 3: 4–5) | — |
| **Connect joints, Attach image, Weighted joint** (`rig-connect`, `add-sprite-segment`, `rig-weighted`) | **Build part › Attachment** (a core section) | 2 | **2** (revision 3: 4) | — |
| Anchor picks (`rig-pick-start`, `rig-pick-end`) | Attachment (a step of Connect joints; the mode message explains it) | 3 | 3 | — |
| **Smart Stretch** on/off; driver; bind branch | **Part › Stretch** (its switch on the title row; the rest inside) | 2; 4 | **2; 3** | — |
| Find part | Structure's head; the Figure menu | 2 | 2 | `Ctrl+F` (Build) |
| Rig examples (`rig-examples`) | Library › Examples; Add › Examples ▸ | 2 | 2 | — |
| **Brush presets** (`[data-draw-preset]`, today's 14 and saved ones); Save preset; Delete preset | **Draw › Brush section** (a five-column grid of stroke thumbnails with names); its text action; a saved preset's menu | 2 | **2** (revision 3: 3) | — |
| Brush size, opacity, flow, smoothing, mirror (both axes) | **Draw › the tool options** (Mirror: one labelled pair; at 900px Smooth folds into More options, where today's quick bar cuts it off) | 2 | **2** (revision 3: 3 for smoothing and mirror; flow unspecified) | `[ ]`, `1–0`, —, —, `Shift+M` |
| Hardness, Blend, Lock alpha | Draw › Brush section (Blend labelled) | 2 | 2 | `Shift+[`, `Shift+]` |
| **Colour pair, swap, recent colours** | **Draw › the tool options** (the pair and Swap: Brush, Fill, Shapes); **the tool's section › Recent** (as today's inspector swatches) | 2 | **2** (revision 3: 3) | `X` |
| **Pixel selection: Apply, Deselect, Flip H, Flip V, Delete pixels** | **Draw › Select pixels' options** while a selection exists; the pixel menu | 2 | **2** (revision 3: 3–4) | `Enter`, `Ctrl+Shift+A`, —, —, `Del` |
| Select all, Invert selection, Fill selection (pixels) | Pixel menu; Invert is the Selection section's title action | 2 | 2–3 | `Ctrl+A`, `Ctrl+Shift+I`, `Shift+Backspace` |
| Pixel filters (Blur, Colour, Tone, Invert) | Draw › Filters (titled) | 3–4 | 3–4 | — |
| Cel resolution, filtering, Resample…, parallax, blend | Drawing layer › Layer; Cel, Parallax (titled) | 2–3 | 2–3 | — |
| **Camera Level, Centre, Reset, Guides** (`camera-level`, `camera-center`, `camera-reset`, `camera-guides`); **Fit view** (`camera-align-view`) | **Camera quick actions**; Fit view: **Camera › Framing** (titled; today a third click too) | 2 (Level, Reset, Guides); 3 + scroll (Fit view) | **2**; 3 (Fit view) | —, `F8`, `Ctrl+Alt+K`, —, `F10` |
| **Ease new keys** (new, an opt-in) | **Camera › Transform** (a field switch, off; revision 4.2: remembered once on, and shared with figure keys, section 11; a key you add eases Linear from the key before it; keys still default to Constant) | — | 2 (T39: 4 steps with it in view, today 5) | — |
| Centre X / Y, Match previous / next, Apply to figures | Camera › Framing (titled) | 3 | 3 | — |
| **Copy / paste camera** (`camera-copy`, `camera-paste`) | **Camera › Transform's title actions**; the camera menu | 2 + scroll | **2** | `F11` / `F12` |
| Edit camera (session) | Camera row; the Scene menu › Edit camera; double-click the frame | 1 | 1 | — |
| Insert or rename a library item (`library-open`, `library-rename`) | Library › a card (Enter, double-click) and **its ⋯** (on the selected card, and on hover and focus) | 2–3 | 2 | `Enter`, `F2` |

### 8.4 Timeline and animation

| Command (`id`) | Home | Today | Rev 4 | Keys |
|---|---|---|---|---|
| Timeline mode (`[data-timeline-mode]`) | Timeline header, at every tier (Settings mirrors it) | 1 | 1 | — |
| Add frame (`add-frame`) | Timeline header | 1 | 1 | `A` |
| Play (`play`, `play-pan`) | Timeline header | 1 | 1 | `Space` |
| Previous / next frame | Timeline header | 1 | 1 | `,` `.` |
| **First frame** (`first-frame`) | **Timeline header** | 1 | **1** (revision 3: 2) | `Home` |
| Last frame (`last-frame`) | Timeline ⋯ | 2 | 2 | `End` |
| **Loop** (`toggle-loop`, `#loop-button`) | **Timeline header** (a quiet toggle) | 1 | **1** (revision 3: 2, state hidden) | bindable |
| Go to frame | The readout › Go to frame | — (new) | 1 (+ type) | `Ctrl+G`; a number in the palette |
| Previous / next key (`previous-keyframe`, `next-keyframe`) | Timeline ⋯; Animation (a round key with an arrow, revision 4.3: never the frame steps' glyph) | key | 2 | `Shift+,` `Shift+.` |
| Previous / next exposure | Keys in the filmstrip (bindable) | key | key | — |
| **Frame rate** (`#fps`) | **Timeline header** ("24 fps", an inline field, docked from 801px as today's; at 800px and below the Scene's Rate); Scene › Rate mirrors it | 1 (+ type) | **1** (+ type) (revision 3: 2–3) | — |
| **Readout: time or frames** | The readout, in today's MM:SS:FF by default; its popover's *Show: Time │ Frames*; the frame number in its tooltip | 0 (MM:SS:FF) | 0 (MM:SS:FF, as today; frames when switched) | — |
| Onion skin (`toggle-onion`, `#onion-button`) | Timeline header | 1 | 1 | `O` |
| **Onion settings** (`#onion-settings-button`), every option | **Timeline header › Onion ▾** | 1 (a 22px chevron) (+1 per option; +2 under its More) | **1** (+1 per option) | — |
| **Audio** (`#timeline-audio`); audio clip and lane commands | **Timeline header › Audio** (a dot only while the animation has sound); the lanes, unchanged | 1 | **1** (revision 3: 2) | — |
| **Timeline zoom** (`#timeline-zoom`), **Fit timeline** (`timeline-fit-frames`) | **The ruler tools' own column** (revision 4.3: the ruler and the grid end before it; Simple: above the strip's end) | 1 | **1** (revision 3: 2) | Ctrl+wheel |
| **Tall timeline** (`#expand-timeline`); Default height (`timeline-reset-height`) | **The ruler tools' column** (its own glyph, a panel growing upward); Timeline ⋯ › Default height | 1 | **1**; 2 | double-click the splitter |
| The timeline body at the low height tier (`timeline-sheet`) | Timeline ⋯ › Timeline… | — (new) | 2 | — |
| Fit selected frames, Reveal playhead, Show all layers on canvas, Unlock all layers, Select Camera, Select Scene | Timeline background menu | 2 | 2 | — |
| Layers in Simple (visibility, lock, order) | Simple frame bar › Layer ▾ (`#layers-button`) | 1 + Simple | 1 + Simple | — |
| **Find layers** (`timeline-find-layers`) | **The layer list's header** | 1 | **1** (revision 3: 2) | `Ctrl+F` (timeline) |
| **New layer**, New drawing layer | **The layer list's header** (+ opens the name; in Draw + makes a drawing layer; ▾ the other kind) | 1 (+ rename 2) | **1** (+ type); 2 (in Draw: 1) | — |
| Hide / show, lock / unlock a layer | **The row's eye and lock, on every row at rest** (quiet; full contrast when hidden or locked); revision 4.3: at least four whole content rows in view at every tier size, as today's timeline (T46–T48) | 1 (a row below the fourth: 2, a scroll first) | 1 (the same) | — |
| Reorder layers | Drag the row (a grip on hover); row menu › Move layer up / down; layer quick actions | 1 | 1 | — |
| Rename layer, Layer colour, Duplicate layer (drawing), Delete layer | Double-click the name (inline); the row menu; layer quick actions (Delete) | 1–2 | 1–2 | `F2`, —, —, — |
| Focus selected layers / Show all layers | **The layer list's header** (today's one-click toggle); the row menu | 1 (header toggle) | **1** | — |
| Layer select up / down | Keys in the timeline | key | key | `↑` `↓` |
| **Easing** (`keyframe-easing-*`) | Advanced: **the range inspector › Easing** (a select); one key: **double-click it** (the easing popover: presets, handles, numbers); Simple: **the frame bar › Easing**; every surface lists today's six modes, Auto · Bezier · Ease in · Ease out · Linear · Constant (revision 4.3) | 2 (a double-click and a preset); 5 for a range | **2**; 4 for a range | `Enter` on a tween; `1`–`6` in the select |
| **Inbetweens** | Advanced: range inspector › Timing; Simple: **the frame bar › Inbetweens** (every selected card) and each card's duration bar | 1 (+ type) | **1** (+ type) (revision 3: none for a selection) | — |
| Insert inbetween… | Frame menu (Advanced), card menu (Simple) | 2 | 2 | — |
| **Edit together** (`toggle-range-edit`, `#range-edit`) | **The timeline header's *Edit together*** (at rest in Advanced, as today's *Edit selected frames*: a quiet glyph until frames are selected, its word while available, revision 4.3; not on a one-frame file); the range inspector's field switch; **the Simple frame bar's Edit together**; the scope line's *Stop*; Timeline ⋯ at the minimal tier; every one shows the same state | 1 after selecting frames | **1** after selecting frames, visible at rest (revision 3: +1, Advanced only) | — |
| **Hold a pose longer** (drag the exposure's end) | **The selected exposure's end handle** (visible) | 1 (a hidden edge) | **1** (visible) | `Shift+A` |
| Extend (`extend-keyframe`) | Frame menu; Draw's timeline header › Next copy ▾ | 2 | 2 | `Shift+A` |
| Insert blank key, insert copied key (drawing rows: Blank drawing here, Copy drawing here) | Frame menu; **Draw's timeline header › Next copy ▾** | 2 | 2 | `F7`, — |
| **Next copied drawing**, next blank drawing | **Draw's timeline header › Next copy** (labelled, where today's button is; ▾ Next blank drawing); the frame menu on a drawing row | 1 | **1**; 2 | — |
| Copy / paste / cut frames | **Range inspector and Simple frame bar quick actions**; the frame and card menus | 2 (Advanced menu); 1 (Simple sidebar) | **1** | `Ctrl+C/V/X` |
| **Remove keys** (`clear-keys`, time stays) | **Range quick actions › Remove keys** (labelled); frame menu | 2 | **1** after selecting | `Del` (timeline), `Shift+F6` |
| **Delete frames** (`delete-frame`, removes time) | **Range quick actions**; **Simple frame bar**; frame and card menus | 2; 1 (Simple) | **1** after selecting | `Shift+F5` (Advanced), `Del` (filmstrip) |
| Unlock layers (while the targeted layers are locked) | Frame and card menus | ctx | ctx | — |
| Make a movieclip from frames (`movieclip-range`) | Frame menu › Make movieclip… | 3 | 2 | — |
| Camera motion clip: Preview, Mute / Enable, Duplicate, Bake clip range, Delete; Unlock Camera | **Motion clip quick actions**; the camera motion menu | 3 | **2** | — |
| **Add camera motion** (a preset) | **Camera quick actions › Motion ▾** | 3 | **3** (revision 3: 5) | — |
| VFX: add effect (and presets), on/off, parameters, timing | VFX tab: the twelve suggested tiles (empty), Add effect (the catalogue: Effects │ Presets, 22 effects in six categories), **Presets** (a button beside it), the row switch, the selected effect's sections | 2–3 | 2–3 | — |
| VFX target (Apply to), list view (Show), Paste effect | **Apply to: a labelled select under the name**; **Show: a labelled row while the filter hides effects**, and the VFX ⋯ menu; **Paste effect beside Add effect** | 3 (Apply to, Show); 2 (Paste) | **3; 2**; 2 (Show at rest: 0, a readout) | — |
| VFX effect: copy, duplicate, move, rename, combine, visible keys, reset, remove | The effect menu; the effect row's *Visible keys* on hover | 2–3 | 2 (keys: 1) | `Alt+↑` `Alt+↓` |
| VFX parameter keys: add, remove, previous, next, easing, reset | The parameter's menu | 3 | 3 | `K`, `Shift+,` `Shift+.` (focused parameter) |

### 8.5 Panel commands (read from today's panels)

| Command (registry id) | Home | Today | Rev 4 |
|---|---|---|---|
| Camera monitor (`camera:monitor`) | Camera › Preview | ctx | ctx |
| Add a motion clip from a preset (`motion:add`, `motion:preset`) | Camera quick actions › Motion ▾ › a preset | 3 | 3 |
| The clip list, bake every clip (`motion:select`, `motion:bake`, `motion:bake-range`) | Camera › Motion clips (titled); a clip in the Camera row | 3 | 2–3 |
| A clip's Start, Duration and parameters (`motion:fields`), Randomize (`motion:randomize`) | Motion clip › Timing, Motion; Noise (titled) | 3 | 2–3 |
| Preview, mute, duplicate, delete (`motion:preview`, `motion:toggle`, `-duplicate`, `-delete`) | Motion clip quick actions (aliases: the motion menu) | 3 | 2 |
| Today's camera inspector tabs (`camera:tabs`) | Dissolved: Transform is the camera context; Motion is the quick action and the clips section | 2 | — |
| Parallax: on, depth, X, Y, link axes, set reference, preview (`parallax:*`) | Layer › Parallax (the switch on its title row) | 2–3 | 2–3 |
| Effect copy, duplicate, move, rename, combine, visible keys, reset, remove (`vfx:*`, `clip:*`) | The effect menu (visible keys: the row's hover action) | 2–3 | 2 |
| Effect target, list view, paste (`vfx:scope`, `clip:view`, `vfx:show-all`, `vfx:paste`, `clip:paste`) | Apply to (a labelled select under the name); Show (a labelled row while it hides effects; the VFX ⋯ menu); Paste beside Add effect | 2–3 | 2–3 |
| Add effect, presets, quick adds (`vfx:add`, `vfx:presets`, `vfx:quick`) | VFX › the twelve suggested tiles (empty), Add effect (the catalogue's Effects), **Presets** (a visible button; the catalogue's Presets) | 2–3 | 2–3 |
| Select an effect, on/off, reorder (`vfx:select`, `vfx:enable`, `clip:select`, `clip:enabled`, `vfx:drag`) | The effect list (a row, its switch; drag) | 2 | 2 |
| Aim at, Shuffle (`clip:aim-pick`, `clip:aim-clear`, `clip:shuffle`) | The selected effect's parameters | 3 | 3 |
| Save preset, Delete preset, the presets (`draw:save-preset`, `draw:delete-preset`, `draw:toggle-quick-presets`) | Draw › Brush section (its title action; a saved preset's menu) | 2–3 | 2–3 |
| Blur, Colour, Tone, Invert (`draw:filter-*`) | Draw › Filters (titled) | 3–4 | 3–4 |
| Delete pixels, flip the selection (`draw:delete-pixels`, `draw:flip-selection-x`, `-y`) | Select pixels' options (the pixel menu lists them) | 2 | 2 |
| Mirror vertically (`draw:mirror-y`) | Draw › the tool options' Mirror pair (its twin in the Brush section when folded) | 2 + scroll | 2 |
| Duplicate a drawing layer (`draw:duplicate-layer`) | The row menu (drawing layers) | 2 | 2 |
| Resample a drawing (`draw:resample`) | Drawing layer › Cel (titled) | 3 | 3 |
| View rotation, Reset rotation (`draw:reset-rotation`) | Draw › Pan's options | 2 | 2 |
| Today's Draw panel buttons whose commands have homes elsewhere (`draw:new`, `-blank`, `-copy-key`, `-extend`, `-swap-colors`, `-mirror-x`, `-flip-view`, …) | Aliases: Draw's timeline header (Next copy ▾), the layer list's + in Draw, the tool options, the frame and pixel menus | 2 | 2 |
| Next blank drawing, next copied drawing (`draw:next-blank`, `-next-copy`); retry a drawing (`draw:retry`) | Draw's timeline header › Next copy (▾ Next blank drawing); the frame menu on a drawing row; the error message's *Retry* | 1–2 | 1–2 |
| Select branch; a fill's front, back and delete (`builder-context-select-branch`, `-fill-front`, `-fill-back`, `-delete-fill`) | Part menu (the fill rows with a fill targeted); the fill context's quick actions | 3 | 2–3 |
| Today's Build context menu pages and tool rows | Dissolved into the part menu (flat), the rail, Shift or Whole branch, the stage header and the Timeline toggle | 3–4 | 2–3 |

Every `data-action` in the reference DOM is an `actions` key (architecture §4.2) or one of the ids the redesign registers before the guard wrapper (architecture §3.9): the `timeline-*` rows, `camera-motion-*`, `range-easing`, `card-easing`, `insert-inbetween`, `builder-find-part`, `builder-snap`, `drawing-flip-selection-*`, `toggle-fullscreen`, `reveal-document`. Controls found by id (a switch such as `#builder-branch`) carry `data-command` with their registry entry. Panel commands keep their own attributes (`data-motion-action`, `data-vfx-action`, `data-clip-action`, `data-draw-action`, `data-parallax-*`, `data-library-action`).

### 8.6 What revision 4 fixed, by regression (gaps.md §3)

| Ref | Regression in revision 3 | Revision 4 home |
|---|---|---|
| R01 | Save behind the Document popover | Band › Save (1) |
| R02 | Figure stacking three clicks away | Quick actions To front, To back (1); Arrange's Z-index stepper: Send backward, Bring forward (1, visible) |
| R03 | Canvas overlays behind the mark | Stage header view toggles (1); their popovers (2) |
| R04 | Timeline header controls in one generic `⋯` | First frame, Loop, Onion ▾, Audio, the frame rate in the header; New layer and Find in the list's header; zoom, Fit and Tall at the ruler's end |
| R05 | Simple frame tools dissolved | The Simple frame bar |
| R06 | Build part commands and modes hidden | Part quick actions; Edit joints' options (Drag, Whole branch, Snapping) |
| R07 | Flip three clicks; a limb right-click lost the figure | Quick action Flip (1); flat rows; the joint menu's Flip limb and Figure ▸ |
| R08 | Commands for several figures behind menus | Several figures' quick actions and section actions; Align's six buttons |
| R09 | Application menus behind the mark | The menubar, docked at every tier but minimal (revision 4.1; revision 4 folded it below 1181px) |
| R10 | Project library and example animations lost | Add › In this project, Examples ▸; Library › This project, Examples |
| R11 | Joint properties behind More, some unspecified | Joint, IK, Style core sections; Second colour, Connector |
| R12 | Edit together hidden, Advanced only | The timeline header at rest (Advanced), a field switch in both modes; the scope line |
| R13 | Double-click meanings and one-key easing | Kept: double-click a key for its easing (with handles and numbers), an empty cell for a key |
| R14 | The Draw quick bar dissolved | The tool options bar; the Brush section's presets and Hardness |
| R15 | Pixel selection commands menu-only | Select pixels' options while a selection exists |
| R16 | Mode instructions hidden | The mode message |
| R17 | Layer eye and lock hover-only | On every row at rest as quiet glyphs, full contrast when not default (revision 4.1 finishes the fix: revision 4 still hid the default ones) |
| R18 | VFX setup steps and details unspecified | Today's twelve suggestions as tiles; Apply to and Show visible and labelled; Presets beside Add effect and the catalogue's Effects │ Presets switch; Timing, parameters, Advanced |
| R19 | Camera motion presets five clicks; Framing in More; a modal session | Motion ▾ (3); Framing quick actions; clicking away leaves the session |
| R20 | Edit movieclip and Cancel in menus | Edit clip quick action; Cancel in the band |
| R21 | Frame rate two to three clicks | The header's frame rate (1) |
| R22 | Time readout in a tooltip only | The readout keeps today's MM:SS:FF; Go to frame's Time │ Frames and the frame in its tooltip; "plays as" in the frame bar |
| R23 | Add to library in a menu | The inspector's footer (1) |
| R24 | Library management unspecified | The folder path's New folder, Show in folder, Refresh; Kind; the library menu |
| R25 | Playback health hidden | The quiet "Slow · 14 of 24 fps · Details" message |
| R26 | Status bar in Help | The Scene's meta line; Help › Performance (a documented trade) |
| R27 | Onion options partly unspecified | Every option, in two titled groups |
| R28 | Timeline details dropped | The label column splitter, cel thumbnails, fade handles, the parallax readout, Next copied drawing |
| R29 | Figure, scene, layer and rig details behind More | Titled sections and title actions |
| R30 | Structure details unspecified | Twisties, fill rows, one role glyph slot |
| R31 | Segment surgery from Animate (deliberate) | **Revision 4.3: back in Animate**, the joint menu's *Edit part ▸*, 3 clicks as today, run in place with its scope said and an Undo message (revisions 3–4.2 kept it in Build, 6–7 clicks) |
| R32 | Less frequent Edit and File commands three clicks | The menubar (2); Paste in place a flat row |
| R33 | 3D rig inspector unspecified | Specified in full (section 5.1) |
| R34 | Drawing sets on a figure | A titled section when a joined bank exists |
| R35 | Tween type | The rail's corner tick at rest (2, as today) and a four-part segmented control in the Tweener's options (2) |
| R36 | Export formats and settings | Type visible; 1080p, 720p, 4K; From and To |
| R37 | The scene crumb and stage size | The stage header's crumb, as today |

### 8.7 Documented trades (the only functions further than today)

**3 rows, all low-frequency** (`function-ledger.md`, "Documented trades"). Revision 4.1 counted segment surgery's full round trip through Build (13 trades); **revision 4.3 removes them**: the joint menu's *Edit part ▸* runs the surgery commands in Animate, 3 clicks as today, and says which figures change (the owner's "don't lose any functionality or ease of use"). Revision 4.2 counted every function by itself and found three more rows further than today: *Paste instance* and *Paste unique copy* (flat rows of the Scene and selection menus, 2 clicks as today, so no longer trades) and the Performance dialog's status-bar icon (SB-04, a trade below, with HE-02).

| Functions | Today | Rev 4 | Why |
|---|---|---|---|
| Performance (the status bar's icon: HE-02, and SB-04, counted by itself since revision 4.2) | 1 | 2 (Help › Performance); 1 from the slow-playback message's *Details* | The status bar is gone (R26). Performance matters when playback is slow, and that is exactly when the message offers it. |
| The live figure count (the status bar) | 0 | 1 (the Scene's meta line, through the crumb or an empty-canvas click) | As above; the count is shown where the scene is described. |

---

## 9. Reference build

`design/app-ui/reference/editor.html` is generated by `design/app-ui/reference/tools/build.mjs` from `design/app-ui/tokens.css`, `design/app-ui/components.css`, `reference.css` (the shell layout and feature parts) and `reference.js` (state switching and stand-ins for the shell solver with its two tiers and the Build fold rule, the timeline painter, the overlay manager, and the tool options' fold). It uses the local Inter and Inter Tight files, the app's Lucide set plus the proposed glyphs (the build fails if two concepts share a glyph, by name and, since revision 4.1, by SVG content: menu rows, quick actions, tool options and view toggles included; the key diamond is left out of the sprite), and the Bubble figure geometry. The canvas stand-in draws today's renderer.

States (query string): `theme`, `mode=animate|draw|rig`, `tl=simple|advanced`, `sel=none|figure|multi|joint|text|image|layer|range|tween|clip|clipinst|camera|motion|empty|segment`, `tool=brush|eraser|fill|lasso|shape|transform|hand` (Draw), `tab=properties|vfx|library`, `fx=none|one` (no effects; one, the Glow just added), `src=project|mine|examples` (Library), `scope=range` (Edit together on), `joined=1`, `ik=on`, `fmt=mp4|gif|vfw|piv`, `size=custom`, `enc=open` (Export), `doc=new|long` (a new file; a long name), `span=full|stage`, and `layers=6`, `ov=` one of the overlays and transient states (menus, popovers, dialogs, sheets, messages, `sections` to open every titled section, `newlayer` for the rename in place, `join` for the mode message, `audio`, `easing`, `grid`, `paths`, `crumbbg`, `vfxpresets`, `celmenu`, `libcard`, …). The tiers come from the window size; the band's fold steps are written to `data-band`.

`design/app-ui/reference/tools/states.mjs` lists **200 states**: revision 3's 116 (the core states, dark variants, every menu and popover, the sessions, every Draw tool, the small tiers and short windows, the narrowest bands, Build around its fold, the camera and motion contexts, the effect and target menus) and **35 for revision 4**: the View menu from the menubar; the joint menu's Figure ▸; the text, image and layer contexts; the scope line; a joined figure; IK's options; the empty VFX tab; the Library's This project, Examples and menu; Grid and guides; Motion path settings; a key's easing; the new layer's rename and its menu; the join mode message; the slow-playback message; the audio lanes; the Add menu's Examples; the camera's Motion ▾; the colour pickers from the inspector; Draw at 1024 (the tool options' fold) and Select pixels at 1280; Animate at 1180; the Alt menubar and the StykAnimate menu at 640 (the minimal tier, where the menubar folds); Build at 1280; dark Tweener, joint, VFX, Simple at 800×600 and camera; and **14 for revision 4.1**: Animate at the tier gate's sizes (1152×720, 960×600, 900×700, 1100×700), Draw at 900×700 and 1152×720, Build and a joint at 900×700, Animate at 700×600 (the compact band with its menubar) and 823×514 (1440×900 at 175%), the catalogue's Presets, Draw's Next copy menu, a library card's menu and the crumb's background colour; and **22 for revision 4.2**: VFX right after adding a Glow at 1440×900 and 1280×720, first launch at 1280×720, 1024×700, 960×600 and 900×700, a new file in Simple at 1440 and 1280, Export's MP4, AVI and VFW Encoding and GIF with a custom size, the messages at the narrow widths (recovery at 1024, 960 and 900, the join instruction at 801, a toast at 960, the slow message at 1100), the band with a long file name at 1024, Build's scope line in dark, the camera at 1024 and the joint menu at 1280; and **13 for revision 4.3**: Draw on a new file at 1440×900, 1280×720 and 1024×700; a six-layer file at 1440×900, 1280×720 and 960×600; the audio lanes at 1280×720; the joint menu's *Edit part ▸* and a surgery message; the timeline header with a range at 520×400 and 1152×720; the camera session at 900×700; Build at 900×700 in dark. **104 of them are at rest.** New query keys: `layers=6` (the six-layer file), `doc=new` in Draw, `ov=jointpart`, `ov=surgery`. `design/app-ui/reference/tools/shoot.mjs` renders each with Playwright (Chrome, device scale 1, scrollbars shown) and writes the PNGs and `audit.json` to `artifacts/ui-redesign/reference/` (generated, not committed). A state named `reference/NN` in this spec is that PNG. **It measures** (revision 4.2 adds **fields**: one select pattern in the inspector, labels inside their controls, no two tiles alike in a collection, menu checkmarks equal to their toggles, a scope line with its range, Build naming its figure; **the message pass**: five messages at six widths; **glyphs across states**, menus included; and makes the task gate and the tier pass clip-aware): text below 11px, text contrast (4.5:1, 3:1 large), targets under 24×24, controls outside the window and not scrollable to, overflowing bars and overlays, focus-ring and control-boundary contrast (3:1), canvas-read tokens, a forced-colours pass, and in every state: **stage** (`#viewport` ≥ 360×200; the guarantees and floors of section 1.9), **chrome** (the message and the view cluster never meet; the artboard keeps 8px of clear space in `#viewport`; their buttons are hit at their centres), **menus** (below the band), **reach** (rows in the state's model on screen, scrollable to, or reached through the tier's declared path, clicked in a fresh page), **band** (never overflows; window controls inside), **page** (exactly one window), **clip** (revision 4.1: every input keeps its whole value and a spare character, every select its whole option, scrollbars included; no control label is cut; a section title cut at the inspector's edge sits under its fade); in every rest state **the balanced budget** (section 0.1: with the default inspector's fold rule), **the first-glance rule** (section 0.2: with one symbol per command family, and no state marks at first launch); once, **the size sweep** (3,828 sizes), **homes** (section 8), **the 53-task gate** (section 0.3) and **the tier pass** (revision 4.1: at each of six tier sizes, which surfaces are shown, twinned or folded in each workspace's rest state, and every task's targets again). `design/app-ui/reference/tools/today-tiers.mjs` measures today's app at the same sizes (`today-tiers.json`).

**Revision 4.3's audits** (the reviewers found what the earlier ones let through): **heads** (the band's and the timeline header's controls never overlap, and each is the element at its own centre, in every state); **ruler** (every frame of the painted range, the playhead tab and both onion ends are hit on the ruler, never under a tool, and an onion end never reaches into the Camera row); **fields** gains paired toggles (the controls of one entry, such as Edit together's four, show one state); **words** at every tier size (Add frame keeps its word wherever today's app shows it, from 1101px; Export at every tier size; a session's Done too; measured by `today-labels`, internal research, not in the repository); **every visible target** counted beside the budget count, with a frozen ceiling for each workspace's default (section 0.2); the glyph union with no family alias (a frame step and a key jump are two families); **one build**: `audit.json` records the hash of the files the reference is made of (`editor.html`, `reference.js`, `reference.css`, `tokens.css`, `components.css`; `fonts.css` too before the reference moved into the repository), and a full run fails when any state's PNG is older than them or a PNG belongs to no state (revision 4.2's two dark Build pictures predated their build). The task gate counts a scroll once at each size (a scroll at 1440×900 is not counted again at a tier size), and the function ledger is also measured from inside the sessions.

**The result: 0 findings in 200 states; 0 budget and 0 first-glance failures in 104 rest states; 0 header overlaps and 0 ruler failures; 0 message failures in 30 message checks; 0 glyph clashes across 200 states; 0 of 3,828 sweep sizes under their floor or overflowing; 0 of today's 391 commands without a home, 0 missing homes, 0 second homes; 53 tasks: 0 longer than today, 0 targets missing or hidden, the steps adding up (11 steps on surfaces the reference does not draw, a dialog's field or the OS picker, are named by their spec section); at the six tier sizes 0 tasks longer and 0 words lost; every PNG from one build (`582d21d76396`).** `node design/app-ui/reference/tools/ledger.mjs` adds the 852-row function check, per function (3 further, all low-frequency documented trades; 0 further at the tier sizes, clip-aware on both sides; 0 less visible without a reason; 60 visible homes checked against the reference, 0 missing; 13 checks from inside the sessions, 0 further). It does not measure canvas-drawn marks in screenshots (those are token pairs in `contrast.mjs`, internal design tooling, not in the repository), other GPUs or fonts, or other languages than English (the band's step is measured per language by the solver).

---

## 10. Owner feedback and resolutions

| Owner feedback | Resolution |
|---|---|
| "don't lose any functionality or ease of use or hide good buttons just to get a clean UI" | Every one of today's 852 functions has a home at most as many clicks away as today, **counted per function and clip-aware**, at 1440×900 and at six common window sizes, and from inside the sessions, except 3 low-frequency documented trades (section 8.7); no high- or medium-frequency function is less visible than today (revision 4.2 brings back one-step order, *Fit figure*, *Edit together* in the header, the effect's ⋯ and *Combine with…*, the scrub cue and Library's pinned *Add selection*; revision 4.3 brings back segment surgery while animating, Export and posing inside the sessions, Draw's +, the paste variants on a figure's menu and today's layer capacity in the timeline); the 53 tasks take 150 steps against today's 159 without the two behaviours awaiting sign-off (148 with them), none longer at any of those sizes; the visible homes revision 3 removed as "duplicates" are back (rule 10), and so are Apply to, the VFX Show filter, the Presets button, today's twelve effect suggestions and fourteen brushes, a card's ⋯, the Tweener's tick, Test rig's label and the joint's Layer |
| "everything should still be there and not completely hidden" | No generic "More": titled sections say what they hold and remember being open; the menubar is visible; the view pill, the builder bar, the Draw quick bar, the Simple sidebar and the Library toolbar each have a visible successor |
| "improve UX across the board, improve interactions and layout in general" | Quick actions per context; the tool options bar; the scope line; the mode message; the exposure's end handle and live timing; rename on create; grips; double-click meanings kept; Undo in messages; new default keys; direct drags (colour onto a limb, an effect onto a figure, audio anywhere); the island header line and three clusters per row; revision 4.1: the grid as a split button and pass-through view popovers (a grid and a guide in 3 clicks, today 4), the crumb's background chip (3, today 4), the camera's opt-in *Ease new keys* (a pan in 4, today 5), words on the buttons whose glyphs were look-alikes; revision 4.2: the joint menu starting with today's joint list, the effect's settings under its row, *Use IK* showing its pin, the message never cut, the anchor, camera and Size fixes of section 7.6, Test rig beside Done; revision 4.3: segment surgery in Animate that says which figures it changes and offers Undo (today's edits are silent), a timeline that says how many layers are below ("2 more") with a drawn scrollbar, a ruler with nothing over it, onion ends that never steal a click on the ruler, the transport sliding before a label folds, Draw's + adding an image to trace without leaving Draw, a designed first look for Draw on a new file, one grammar in the quick actions |
| "simple at a glance but … all the functionality we have now and room for even more" | The first-glance rule (≤ 76 controls and ≤ 30 words at first glance, 73 and 26 used; 0 accent toggles; three clusters per row; one line of island headers; one symbol per command family; the default inspector of every workspace fits without scrolling); revision 4.3 counts honestly too (every visible target: first launch 77 against today's 66, Draw on a new file 93 against 72, Build 86 against 88: the functions today keeps below the fold are visible) and **freezes every ceiling** per workspace default; room to grow as **named slots**: every budget keeps headroom or says which slot a feature took, every quick-actions row a free slot for a pin, every header a reserved slot and a fold rule; *Edit together*'s word and Focus appear only when they can act |
| No keyframe diamonds; edit "like it is now but with better design" | No diamonds, key state or chips anywhere in the inspector; keys drawn as today in the Advanced timeline, calmer |
| Keep it clean; not crowded or overwhelming | The balanced budget and the first-glance rule, audited in 104 rest states; one pattern per kind of field; collections that draw what they hold; nothing over the artboard; one accent, one ink primary, one shadow; Draw's inspector fits without scrolling, its cel commands in the timeline header where today's button is |
| No selection ring and stuff | The canvas shows today's renderer only; the new direct-manipulation cues live in the timeline and the inspector, never on the canvas; **revision 4.3 corrects revision 4.2**, which had specified an outline, a glow and a joint highlight while dragging a colour, an effect or an image onto the canvas: a drop now says what it will do on the cursor and in the message slot, and a live preview of the result (no outline, glow or highlight) waits for the owner's decision (section 11); in the camera session the figures' joint handles are today's renderer handles, dimmed |
| No default changes | Advanced timeline, onion off with `#e76b70`/`#549de7`, IK off, the first figure selected, Build's hidden timeline and VFX tab, blue Camera keys, Joints and Effects preview on, Loop on; new keys still default to Constant (tasks.md problem 3 is noted, not changed; the camera's *Ease new keys* is an opt-in for one session); revision 4.1 restores three defaults revision 4 had changed: the readout's MM:SS:FF (frames are an option), Export's Original size, and no has-audio dot on a new file; revision 4.3 keeps two more: GIF's Dither starts from `defaultGIFDither(report)` (on only with images), and the easing names are today's six (Auto, Bezier, Ease in, Ease out, Linear, Constant) |

Revision 3's must-fix resolutions carry over unchanged (the Tweener and Test rig glyphs, the ruler label, the Export veil, stage shares at 800×600 and 1280×720, IK off in the joint state, no arrange-mode sentences, the rendered surfaces, anchored menus, the Alt overlay, Simple layer management, VFX parameter keys, neutral cels and accents, onion at first launch, the short-window tiers, one sticky timeline height).

---

## 11. Scope decisions (to approve before implementation)

| Item | Needs | Default if not approved |
|---|---|---|
| **Every new default key** (revision 4.2 lists all of them; the table below shows the conflict check) | The owner's approval (they add bindings; none changes one of today's defaults) | Each command is bindable with no default key; its menu row, button and the palette stay |
| Pinning commands to quick actions | A small layout-store field (`pins` per workspace, architecture §3.11.2) | Quick actions are fixed per context |
| Drag a swatch onto a limb, an effect onto a figure, an image onto a joint | Hit-testing on drop through the existing pick path (no renderer change) | The inspector paths only |
| The "Slow · N of M fps" message | A throttled read of today's playback stats | Help › Performance only |
| Cel thumbnails in the Advanced grid | The thumbnail worker gate (as the filmstrip's) | Neutral cels, as revision 3 |
| Filmstrip thumbnails framed on the figures | The thumbnail-worker gate (revision 3's pending option) | Today's artboard framing |
| Export aspect presets that differ from the artboard; export in the background | Export-pipeline changes | Disabled with a reason; progress in the dialog |
| Phase 2 timeline rows; window bounds memory, cross-window sync, native theme sync | An owned milestone; main-process work | Today's row model; not included |
| A construction desk for Build | The owner's sign-off | Today's view: the white artboard at fit canvas |
| **Revision 4.1:** the camera's *Ease new keys* (an opt-in for the session) | The owner's approval (it adds a choice; the default stays Constant) | Today's route: double-click the key, pick Linear |
| **Revision 4.1:** view popovers that close on the next click elsewhere, which still acts (Grid and guides, Motion path settings, Onion); **revision 4.3 defines that click**: on the canvas it only selects or deselects what it lands on (never a drag, a pose, a joint edit or a box selection); on chrome it does what the control does | The overlay manager's pass-through mode | They close on an outside click that does nothing else (T28: 4 steps, as today) |
| **Revision 4.1:** the 800×600 stage floor of 45% (was 50%), for the inspector docked from 801px as today | The owner's view on the trade (today: 42–44% there) | Compact from 900px, as revision 4, with its extra click for property edits at 801–900px |
| **Revision 4.2:** *Ease new keys* as a **remembered** opt-in (Settings › Animation › *New keys ease*, mirrored by the camera's switch) that applies to **figure keys** as well as camera keys | The owner's approval (a new preference; the default stays Constant, tasks.md problem 3) | The camera's switch for its session only (4.1); figure keys hold as today (T31 keeps its 2 easing steps) |
| **Revision 4.2:** a message that does not fit beside the view cluster takes its own line under the stage header, over the stage's top margin, for its moment | The owner's view (it may overlap the artboard's top edge while it shows) | The message covers the view toggles too (as at compact width), and its text stays whole |
| **Revision 4.2:** refusing a camera edit past the last frame, with *Add frames* and *Go to frame* (section 7.6) | The owner's approval (today the edit silently rewrites the frame 1 key) | A clamp: the edit applies at the last frame, with a message saying so |
| **Revision 4.3: the timeline's height for today's layer capacity** (section 1.9): Camera and Scene as 24px pinned rows, 4½ content slots above 800px and 4 from 600px (28px rows at the short tier), the vertical insets giving way (24 → 10 → 8). The trade: the budget state's artboard is 91% (revision 4.2: 95%; the floor is 90%), 1280×720 66% (68%), 1024×700 62% (64%); and from 569 to 599px tall three content rows (today 4.38 there, with a 22–25% artboard) | The owner's view of the trade (rows against the stage) | Revision 4.2's heights: two pinned 32px rows and 2–3 content slots, fewer layer rows than today at every size (T47 and T48 then cost a scroll at every tier size and T46 too at 1280×720 and below) |
| **Revision 4.3: segment surgery in Animate** (the joint menu's *Edit part ▸*, today's Editor-menu commands, 3 clicks as today) **says its scope** ("Line 4 · changes all 3 Bubbles") **and offers Undo** in its message | The owner's view (the scope line and the message are new; the commands and their shared-figure behaviour are today's) | The same submenu without the scope line and the message (today's silent edit); never the round trip through Build |
| **Revision 4.3: a live drop preview on the canvas** (while a colour, an effect or an image is dragged onto a target, the renderer draws the result: the limb in the new colour, the effect, the image at the joint; no outline, glow or highlight) | The owner's decision (the veto on canvas cues; it draws only what the drop would make) | The cursor's badge and the message slot only (section 7.3) |
| **Revision 4.3: the ink primary's glyph at compact width** (661–700px in Animate, 800px in a movieclip session), so the menubar stays docked | The owner's view (today's app keeps "Export" and "Done" there) | The menubar folds into the mark from 700px (+1 for the menus) and the primary keeps its word |

**The new default keys and their conflict check** (against today's `hotkeys.mjs` defaults, the legacy migrations it still runs, and the browser build's reserved keys):

| Key | Command | Today's binding | Conflict check |
|---|---|---|---|
| `Ctrl+P`, `Ctrl+Shift+P`, `F1` | Command palette | none (`P` alone is the Pose tool) | Browser build: `Ctrl+P` (print) and `F1` (help) are cancelled while the app has focus; `Ctrl+Shift+P` is Firefox's private window, which a page cannot cancel, so Firefox users keep `Ctrl+P` and `F1` |
| `F6`, `Ctrl+F6` | Move focus between regions, forward and back | none; **`F6` was the legacy *Add frame* key**, which `hotkeys.mjs` migrates to `A` when it is stored alone; `Shift+F6` is *Remove keyframes* | A person who kept `F6` for Add frame beside other keys keeps it: a user binding wins and the region key stays on `Ctrl+F6` and the Tab order |
| `Ctrl+1`–`Ctrl+4` | Show or hide Properties, VFX, Library, Timeline | none | Desktop only: the browser build leaves them unbound (browsers switch tabs with them); the View menu and the Layout popover are the path there |
| `Ctrl+\` | Focus mode | none | free in both builds |
| `Ctrl+Alt+L` | Layout… | none (`Ctrl+Alt+K` is *Reset camera*) | free; Linux desktops that lock the screen on it keep the View menu |
| `Ctrl+Alt+M` | Move the focused panel | none | free |
| `Ctrl+'` | Grid | none | free |
| `Ctrl+G` | Go to frame | none | browser build: *find next* is cancelled while the app has focus |
| `W` | Tweener | none | free |
| `Q` | Transform (Draw) | none | free in Draw |
| `J` in Build | Edit joints | `J` is *Join / unjoin figure* (Animate) | scoped: Join to figure has no meaning in Build |
| `K` in Build; `K` on a focused VFX parameter | Chain; Add key | none (`Ctrl+K` is *Camera frame*) | scoped |
| `Y` in Build | Polygon | none | free |
| `[` `]` in Animate and Build | Previous, next joint | none there (Draw keeps them for brush size) | scoped by workspace |
| Full screen | — | `F11` is *Copy camera* (`F12` *Paste camera*) | **no default key** (revision 4.1 had given it `F11`) |


**Not changed:** the VFX tab stays in Build; the Build timeline stays hidden by default; the Camera row keeps its blue keys; the first figure is selected at launch; Build opens on the white artboard at fit canvas; the onion ranges show on the ruler whenever onion is on; today's Structure labels and joint names; new keys default to Constant; *A* keeps today's routing.

Follow-ups outside the app repository: re-run `verify-app-guide.mjs` and the capture scripts; re-shoot the site's editor screenshot; update the docs that describe UI locations; mark tutorials recorded on the old UI.

---

## 12. Implementation order

`ui-architecture.md` §5 is the build order (M0–M9), revised for revision 4 (the stage header in M3b, quick actions and titled sections in M4, the header clusters, frame bar and ruler tools in M5, the function and task gates from M3b). Each milestone's exit includes screenshots of the affected surfaces at 1440×900, 1280×720, 1152×720, 1024×700, 900×700, 800×600, 500×340 and 1000×450 in light and dark, the **balanced budget and first-glance audit** (`tests/ui-budget.browser.mjs`), the **task gate** (`tests/ui-tasks.browser.mjs`, driven by `design/app-ui/reference/tools/tasks.json` against the app, at 1440×900 and the six tier sizes) and the **function ledger** (`scripts/check-function-ledger.mjs`).
