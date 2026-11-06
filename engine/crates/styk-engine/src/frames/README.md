# Prepared cache control and worker storage

`frames::Cache` remains the single frame cache. State contains only its small
generation/epoch/settings/playhead control, latest pending demand and scalar
summary. The same owner's `Storage` mutex holds the existing entries, wanted
cursor, inflight set and eviction algorithm. Workers acquire storage before
capturing pending controls; no worker waits for storage while holding State.
Interface lookups try State and storage once and return cold on contention.
State guards check identities, transfer pending heads and copy scalars; dense
construction, sorting, growth, reset and rejected/completed data destruction
run outside State on workers. Empty publication heads are prebuilt and their
exclusive storage scalars are initialized during the existing head exchange.

Hidden/effects changes advance epoch immediately and coalesce one pending
reset. Resource invalidation preserves the exact cached/inflight/wanted union;
a later replacement demand discards that old union, including when another
resource invalidation coalesces before the worker runs. The frame scheduler
handles maintenance without adding a retained task per toggle, preserving
ordinary task priority and the image preparation barrier.

`FrameAdmission` is `Busy=0`, `Unchanged=1`, `Applied=2`. UI callers use the
additive try setters and retry the latest demand through the existing playback
owner. Busy changes nothing and leaves playback cold. Synchronous setters and
explicit `prepared_frame_now_at` remain worker/tool APIs. The actual produced
worker snapshot is returned even when the existing budget immediately evicts
it. `DrawList::bytes`, the 90% trim target, exact fractional keys and the
protected playhead policy are unchanged.

Mobile pin API additions: `FrameAdmission`, `FrameMetadata`, `GenerationHeader`,
`Engine::{try_request_samples,try_set_hidden,try_set_effects,frame_ready_at,
frame_metadata,try_generation_header,try_generation,generation_for_frame_epoch,
try_frame_stats,try_images_pending}`. `FrameSnapshot`, `FrameData` and existing
integer/worker entry point signatures are unchanged. Existing non-preparing
frame reads now return cold rather than spinning if their shared state or
storage is busy. Browser admission methods use the same three numeric codes;
metadata/readiness no longer clone a dense frame solely for its header.
The actor lane separately owns `generation_identity_now` and the browser's
`try_record_identity`; this cache slice neither duplicates nor changes them.

This is the first critical-section/read/admission milestone. It does not
certify global D7: a UI snapshot or separately cloned DrawList/Generation Arc
can still become a dense final owner after eviction or publication. Aggregate
retained-allocation charging, bounded worker lease retirement and orderly
presenter/worker shutdown ACK remain separate work. ExportFrames, image upload,
edit Scene and renderer/glyph/atlas lifetime owners also remain separate.
The legacy `record_identity`/`unsupported` bindings and synchronous edit-frame
preparation are not converted by this cache slice; actor admission uses its
separate try identity, and the old tool interfaces remain available.
No runtime eligibility, class ownership or JavaScript deletion is changed.
