# Missing reads during native preference updates

F2 investigates the `four_process_updates_keep_every_entry_and_every_read_decodes`
failure reported against `0ff3d0dc`: an existing preference file was reported as
`None` while other processes updated it.

## Ownership and evidence

K-doc introduced `LocalFiles::replace` in `b3ead141`; K-store introduced the
unlocked `LocalStorage::load` in `673228b3`. The latter immediately converted a
`File::open` error of kind `NotFound` to `Ok(None)`. Successful reads already use
one handle for metadata and all bytes; there is no metadata/open race in that path.

`LocalFiles` creates a unique sibling, writes bounded chunks, flushes, checks the
cancellation commit boundary and calls `std::fs::rename`. It never unlinks the
destination, renames it to a backup, or uses `ReplaceFileW`.
[Rust 1.99.1's Windows implementation](https://github.com/rust-lang/rust/blob/1.99.1/library/std/src/sys/fs/windows.rs)
first calls `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING` (without
`MOVEFILE_COPY_ALLOWED` or `MOVEFILE_WRITE_THROUGH`), then tries
`SetFileInformationByHandle(FileRenameInfoEx)` with replace/POSIX flags on access
denied. [MoveFileExW's documentation](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw)
does not establish a delete-then-move sequence for this same-volume operation.
[POSIX rename semantics](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_rename_information)
explicitly retain existing handles while subsequent opens name the new file.

No missing-name interval was found in this code or reproduced in the gated real
replacement test. The exact Win32 cause of the original sporadic failed open is
not established. The deterministic regression injects that reported open result
once while the real writer is gated after flushing under the profile lock. On
the original code it returns `Ok(None)` before the writer finishes. A second
regression needs no injected error: it observes a first publication still staged
under the lock and likewise gets premature `None` on the original code.

## Fix and callers

The storage owner now confirms a missing open under the writer's existing
profile lock, then reopens and reads through one handle. It opens only an existing
lock, so loading a new profile still creates nothing. Lock acquisition, wakeup on
future drop and error propagation reuse the update path. No retry count, sleep,
second lock identity, cache or document writer was added.

`LayoutStore` passes `None` through; the app's `TopBand::load_layouts` uses it to
try legacy import. The visible timeline branch's `settings::persistence::Store::load` also uses
`Storage::load` before attempting legacy import/defaults. Both receive the fix at
the shared service boundary; their parsing and state ownership need no changes.
Recovery uses `LocalFiles` directly, exclusive per-copy leases and stable handles,
not `Storage::load`; it has no equivalent unlocked preference-absence decision.

## Verification boundaries

The new gate test checks both storage reads and document reads at every write
step over 128 replacements, keeping an old read handle alive across each rename.
The existing K-rec crash test exits without destructors at all ten project/sidecar
write steps and checks complete old/new repository project bytes. Both safety
checks also pass on the original writer; neither is represented as a fail-first
writer defect. These process-termination tests do not simulate physical power loss.
Frozen fixtures and existing test expectations remain unchanged.
