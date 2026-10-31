# Encoded retained allocation accounting

`retained_bytes_checked(&DrawList)` belongs to the portable encoder. Run it once
on the worker after encoding and retain the resulting scalar with that payload.
It allocates temporary deduplication sets; readiness and presentation must never
call it. No engine descriptor or runtime caller is introduced by this prerequisite.

The charge includes the eventual DrawList Arc/header/alignment, every Vec's
capacity (including passes), unique typed effect-stack container allocations and
capacities, resolved effect/id/paint/stop payloads, and unique glyph triangle
slice allocations. Shared allocations inside one list count once; independently
retained lists can conservatively charge them again. The existing private
`geometry::cache::Resolved` owner supplies effects and paints. Scene's original
saturating total stays exact; this checked result also includes Arc layout
padding. Accounting retains no Arc. The existing parameter accessor may briefly
clone a paint Arc while inspecting it; the original strong counts are restored.

`RetainedBytesError::UnknownEffects { layer }` refuses a public opaque `Any`
payload that is not the encoder's `Vec<Arc<vfx::Effect>>`.
`RetainedBytesError::Overflow` refuses unrepresentable arithmetic/layouts.
Changing public buffers requires recomputing their charge. Neither error mutates
the list, cache or document.

This does not reserve memory or change `DrawList::bytes()`, logical eviction,
budgets, protected playheads, FrameData/FrameSnapshot or presentation admission.
It excludes allocator overhead, Frame/raw Value/Scene, typed Figure overrides,
Generation/Prepared/Assets and renderer/GPU ownership. In particular,
GlyphMasks can retain triangles independently after replacing its list. A
worker lease and actual release ACK remain prerequisites for safe final UI
release; this helper does not certify a complete physical Scene/process cap.

Mobile pin API addition: `styk_eval::drawlist::{retained_bytes_checked,
RetainedBytesError}`. No existing struct/enum/API shape changes.

`tests/drawlist_retained.rs` observes requested live allocation bytes independently
through the actual allocator. It exercises capacities/passes, typed shared and
distinct payloads, actual encoder/text/sampled-paint fixtures, opaque refusal and
source immutability. The explicitly ignored dense worker diagnostic is run only
as a loaded-machine cost check, separate from the idle engine-1 protocol.
