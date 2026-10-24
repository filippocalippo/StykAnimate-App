# Effects and connected figures

Effect scratch surfaces share a 16,777,216-pixel budget and a maximum 4096-pixel edge (or the device limit). Preview raster resolution includes nested effect padding, so large halos cannot exceed that budget while the final artwork fits it. Regions that outgrow the GPU budget do not fail: they render through the software executor over lazily painted sources. During tiled export the filtered region each output pixel needs — the artwork's world rect intersected with the output, plus the effect halo — is tile-invariant, so it is filtered once and every tile composites its slice from a bounded per-context cache. Without a shared region, lazy tiles render with overlap for neighboring samples and a stable full-object origin for spatial filters, compositing only each tile's output core. Export parameters and authored effects are preserved; only a filtered region larger than the 128-megapixel software bound fails explicitly. GPU camera targets are checked before texture allocation.

In the VFX inspector, choose **Whole figure** to apply one shared effect stack
across the figure's artwork and all joined
descendants. Selecting a child as the owner includes its subtree, not its parents
or siblings. **This part** targets only the selected STK; **Selected node** targets
a node. This single target selector also changes the selected clip's scope or the
existing pose stack's scope. Figures, joints, identities and poses stay separately editable.

Child and node effects render first; the enclosing figure's stack renders after
the parts have been composited. Nested connected groups and movieclips retain
their inner stacks. Each part retains its opacity. Spatial effect bounds and
gizmos use the full assembly, and hidden child artwork is excluded before filtering.
Hiding the effect owner removes its group effect; visible descendants keep their
own artwork and effects.

Whole-figure effects preserve native drawing order automatically. When unrelated
figures appear between attached parts, the renderer filters each uninterrupted
run of parts at its existing position. Adjacent parts still composite together;
all runs share the assembly's effect settings and spatial coordinates. This keeps
foreign artwork, including translucent objects, between the same parts without
changing the document. Blur, glow and outlines sample the artwork in their own
run, so their output follows that run's depth. Run textures use the existing
bounded caches and surface budgets; playback, thumbnails and export share the
same grouping plan. Hidden parts are excluded and nested effects remain inside
their enclosing assembly. Effect handles use the bounds of the complete assembly.
Connected groups support at most 16 nested scopes to bound compositing depth.

## Persistent effects and keys

New effects belong to a scene or figure instance (or one of its nodes), independent
of pose frames. **Always** applies an effect throughout the animation. **Timed**
adds a start and duration; drag the clip or its edges in the Advanced timeline.
Moving a clip carries its local keys. Trimming preserves the source phase and keys
outside the trimmed range, so extending it restores the animation. Extending before
the original start preserves existing key positions and holds the initial value.

The inspector defaults to **At playhead**. It excludes clips outside their range,
disabled clips, and clips whose effects are all keyed off or have zero strength.
The endpoints of a timed fade remain in its range. **Selected** keeps one clip's
controls available outside its active range; **All** includes a search. Clicking
an inactive timeline block switches to **Selected**. Only one clip expands at a time.

Timeline effects belong only to the primary selected figure, including its node
effects. Scene effects appear when Scene is the inspector target. Sequential
clips share lanes. Keys appear inside their effect block. The key filter in the
selected lane or inspector chooses individual values or effects in a group;
**All**, **None**, and each value's isolate button make switching quick. Larger
groups include search. Duplicate effects have numbered names. The same filter
controls both entry points and key navigation, without changing the animation.

Coincident visible keys share one diamond. Dragging or deleting it edits only
those visible values, preserving hidden keys and easing. Collisions among visible
values reject the entire edit; each edit creates one undo step. No parameter rows
are added. Clicking a value selects its channel without creating a key. The
inspector's fixed bottom strip navigates that channel, adds/removes its current
key and edits easing. Creating a parameter's key also selects that value. Clicking
a timeline diamond seeks to its frame; Left/Right nudges a selected key by one
frame, or ten with Shift. Hidden values are preserved.

The selected timed block has two round fade handles along its top edge. Drag them
to adjust fade in/out, or focus a handle and use arrows (Shift for ten frames),
Home or End. The envelope and frame count preview the drag; release commits once
and Escape cancels. The block edges show a resize cursor and trim or extend the range in either direction, while diamonds along the bottom
edit keys. Timing fields occupy one compact inspector row.

Values are constant until a parameter's diamond creates its first key. Further
edits to an animated parameter set a key at the playhead. Numbers and colors
interpolate, while discrete modes hold. Easing changes the outgoing key at the
playhead. Presets create named groups; **Add to group** adds another effect.
Groups share timing, strength and fades, with independent parameter keys inside.
One effect expands at a time. Drag its grip to reorder it, use Alt+Up/Down on the
grip, or open its actions menu for ordering, enable/disable and removal. Reordering
preserves keys and the expanded effect. Individual effect strength is under
**More** in groups; the group's strength remains directly available.

Drag numeric values or their labels, click to type, or use the contextual slider.
Timing and group strength use the same controls. Each gesture creates one undo
step; Escape cancels it. Undo/redo use document history even while a VFX numeric
field has focus, including configured shortcuts and desktop menu actions.
Selecting an effect or its value exposes supported spatial handles on the canvas.
Those handles edit persistent keys or constant values in one transaction, using
the whole connected assembly's bounds when applicable. Overlapping hit areas use
the nearer effect or native figure handle. Effect handles hide while posing or
moving a figure, and during playback,
preview bypass, locked layers and inactive effects. Selection colors use shared
theme tokens, without transitions that mix light and dark palettes.

Authored pose drafts invalidate their composed VFX view on mutation. Cached
Canvas artwork follows the current figure root without rerasterizing translations.

**Copy animation** and **Paste animation** preserve the clip's parameter keys,
local timing and easing with new identities. Render order is explicit and never
changes when a clip is moved in time or the inspector is filtered.

Existing pose effects remain in **Pose effects**, following their existing
exposure/key rules and the same activity, selection and search filters. Their
Copy/Paste preserves effect identities and layer easing,
including legacy authored scalar channels. Opening a project never converts its
old pose effects or guesses correspondence between unrelated effects.

## Implementation and verification

`vfxScope` is a figure-only discrete property stored as `_stykVfxScope: 1` on its
saved pose. Missing/zero preserves figure-only behavior. STYK roundtrips retain
the setting; the existing rejection of lossy VFX Pivot export still applies.

`vfx-connected.mjs` creates cached render views over the native geometry. It
reuses movieclip isolation and bounded raster caches, without mutating geometry
used for posing or adding physical container figures. WebGPU, Canvas, prepared
playback, movieclip interiors and image/SVG/video export share that grouping.
Prepared GPU textures containing connected members reject changed hidden-member
visibility and fall back to live rendering. Incremental native geometry remains
available; affected groups rebuild their combined artwork.

Regression coverage: `tests/vfx-connected.test.mjs`, `tests/vfx.test.mjs`
and `tests/vfx.browser.mjs`.


Persistent records live in `_styk.vfxClips` as immutable, sparse clips. Editor
commands retain changed clip records and shared tables for undo; previews commit
one command. Pose snapshots exclude runtime sampling metadata. Geometry receives
composed effect values without writing them into poses, and scene values are
explicitly carried in worker packets. Validation bounds clips, keys, per-group
stacks, and simultaneous effects. Saved clips retain their source time inside
captured movieclips. Legacy Pivot export continues to reject unsupported effects.

Timeline key projection uses binary searches and skips dense keys by pixel bucket.
Its weak cache retains only the latest viewport projection per immutable key table;
timing and fade drags reuse the table. Only the selected block mounts two accessible
slider elements. Pointer previews never clone the document or rebuild GPU effects.
Channel visibility is editor session state, reset on document load and capped at
256 clip preferences. It stores property identities, not document snapshots. A
weak projection cache shares the original channel arrays; filtering never scans
their keys, reindexes timeline tracks, marks the document dirty, or enters undo.

Opaque vector groups without inner effects or Canvas-only artwork can rasterize
and filter on one WebGPU device. Worker packets transfer vector buffers and effect
descriptors; prepared playback uses the same GPU path as live editing. Transient
resources are released after submission and final textures use existing bounded
caches. Subpixel strokes, nested effects and unsupported artwork retain the
existing compatibility renderer. This fast path does not change export quality.

Additional checks: `tests/vfx-clips.test.mjs`, `tests/vfx-clips.browser.mjs`,
`tests/vfx-key-channels.test.mjs`, `tests/vfx-key-channels.browser.mjs`
and `tests/vfx-interactions.browser.mjs`.
