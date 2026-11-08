# Native recovery and autosave (K-rec)

The documents host owns recovery through `styk_core::documents::recovery`; the platform implements
`styk_services::recovery::{Recovery, RecoveryCopy, Workspaces}`. There is no recovery view in this chunk.
The chooser's `View` holds records, selection, visibility, busy state and a reported error. Views send
`Request::Recovery(Command::{Refresh, Select, Restore, Discard, Dismiss})`; they never call storage.

## Composition and worker lifetime

After `attach_host`, call `Documents::attach_recovery(store, clock)` with the same window's recovery
directory and its monotonic clock. Initial listing is queued automatically. Continue calling `poll`
on worker notifications and schedule an event-loop wake for `recovery_deadline()`. Playback, scrubbing,
import, drawing gestures, manual export and their owners supply `set_recovery_activity(Activity)`;
the host additionally checks its own session gesture and document jobs. Settings call
`set_autosave_seconds`, clamped to today's 0–300 seconds with a 2.5-second default.

One single-flight recovery lane uses `styk_services::worker::Worker` and the documents host's engine
scheduler. It clones only COW tree handles and scope identities on the interface thread. Serialization,
scope folding, memory admission, file work, decoding and rejected-result reclamation run on workers.
The lane and documents worker share the engine lifetime; dropping either never joins on the interface.
Cancellation uses the job's own `Cancel`, including waking a pending service future. An edited front
snapshot is cancelled; editing a different front project does not cancel a resting project's copy.
Manual save cancels its project's pending copy and returns a retryable Busy request until that reply
lands, so a late committed copy cannot recreate a recovery file after successful save cleanup.

There is at most one snapshot in flight, twelve live tab leases and a bounded cleanup set. No new
lease is admitted ahead of cleanup. Cleanup is deduplicated by lease, and failed service submission
retains the request. Resource handles retire on a worker. Copy saves call the same `save_project`
as manual saves with the same root name, source-order flag and movieclip scopes. An unreadable-save
warning refuses recovery replacement, retaining the previous good copy. Recovery never marks saved,
changes undo history, or exits a movieclip scope.

## Deadlines and close

The front deadline ports `RecoveryDeadline` and `scheduleRecovery`: edits defer the attempt but keep
the first pending time, bounded by `max(interval, min(60 s, interval × 3))`; a busy attempt waits 1 s.
A running attempt sets a floor of `min(30 s, max(1 s, interval × backoff))`. Interruptions and failures
double backoff, capped at 12; failures retry after `min(60 s, interval × backoff)`. Success resets it.
As in today's app, a still-dirty front project schedules the next periodic copy even without another
edit. Turning timed autosave off does not disable explicit or close checkpoints.

A dirty project whose copy lacks its current stamp becomes owed when it leaves the front. The
resting timer waits 1500 ms, retries busy after 1000 ms, takes the first owed tab in band order,
continues after 250 ms on success/cancellation, and retries failures after 15 s, stopping after three.
Bringing that project forward cancels its resting write. Switching back to a current copy does not
start another front deadline. Revisions, mutation epochs, root lineage and scope depth guard replies;
replacement of a tab with the same tab ID cannot adopt the old project's copy.

Close and Quit checkpoint affected dirty projects before returning their existing confirmation effects,
including with timed autosave off. A failed copy is reported and does not consume the close intent.
A changed project invalidates that close intent. Cancel retains both tab and copy. Successful current
manual saves remove the exact copy; stale/failed saves retain it. Save cleanup retains the tab's slot
lease for later edits, and a cleanup failure retains its record/ownership. Closing or discarding a tab
releases its copy; QuitReady follows completion of queued copy cleanup.

## Disk compatibility and selection safety

`styk_platform::recovery::LocalRecovery::new(directory)` accepts an explicit directory and does no
profile discovery. The primary directory is the shell's profile; an independent window uses the
shell's workspace. `LocalWorkspaces` wraps S6's existing workspace-adoption policy, shared by shell
startup and the asynchronous service: a dead process's `workspaces/<pid>` directory is renamed to
the new PID, live directories and reparse points are left alone. The service never recursively deletes
anything. Tests supply private temporary roots, never the owner's app-data or recovery folder.

The files are today's `recovery-<lowercase-uuid>.styk` and `.json`, plus legacy `recovery.styk` and
`recovery.json`. Copies are nonempty and at most 256 MiB. Display names use today's illegal-character
replacement and 180 UTF-16-unit limit; metadata is the optional `{name,savedAt}` object. Data is staged,
flushed and atomically renamed through K-doc's `LocalFiles`, then metadata is independently replaced.
A failure or process exit before data commit leaves the old file; afterwards the complete new file
is readable even if metadata is missing or old. Optional metadata/pruning failure does not retract an
already committed copy. Crash-left staging files are not guessed to belong to this process or deleted.

Each lease is a uniquely created deny-sharing `.lock` file with Windows delete-on-close: another native
process cannot claim it, and process death releases it. Records include a SHA-256 identity over the
data, write time and sidecar; restore and discard revalidate under the lease. Data reads hold a handle
that denies writes/renames. Discard marks the verified data and metadata handles for deletion, never
deletes a path after releasing the checked handles. Reparse-point files are refused. Listing skips
owned/unreadable copies and keeps them on disk. After commit, named copies beyond sixteen are pruned
oldest-unowned first; the legacy copy and owned copies are never pruned.

Restore opens a dirty project beside the front tab, adopts the lease and removes that record from the
chooser; the disk copy remains until replaced or a successful save/close removes it. Failed decoding,
stale ownership or tab-limit refusal preserves the copy. Dismiss only hides the offer. The old Electron
base64/IPC methods are not native APIs; their legacy on-disk copy is supported through the typed service.

## Checks

`styk-core/tests/recovery.rs` checks fixed-clock deadlines, busy retry/backoff, resting cancellation,
save byte equality (root and movieclip scope), chooser ownership/identity, restore beside the front,
cleanup failure, close/quit, and pending-write cancellation/disposal. Existing documents-host/jobs tests
cover the surrounding lifecycle. `styk-platform/tests/recovery.rs` exercises real sandboxed files,
pruning, legacy metadata and selection changes. Platform unit tests terminate a child test process at
each of ten data/metadata staging, write, flush, commit and rename points; the surviving file must equal
one of the complete repository projects. Workspace tests adopt only a sandboxed simulated dead process.

`node --test tests/native-recovery-reference.test.mjs` checks that the writer is unchanged from
`99c62189`, writes a public repository fixture twice through that recovery code, and compares every
project byte. Only sidecar timestamps vary. Its outputs go to ignored `artifacts/native-recovery-reference`.
The explicit ignored platform oracle reads both named/legacy copies; the core oracle restores those
bytes and compares the canonical document. Run those ignored tests by their full individual names;
the crash-child entry is only invoked by its parent test. No frozen fixture is changed.
