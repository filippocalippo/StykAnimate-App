# Native recovery and autosave (K-rec)

The documents host owns recovery through `styk_core::documents::recovery`; the platform implements
`styk_services::recovery::{Recovery, RecoveryCopy, Workspaces}`. The chooser's `View` holds records, selection, visibility, busy
state and a reported error. Views never call storage: they send `Command::Recovery(Event)` to `Core::dispatch` ([The views](#the-views)).

## Composition and worker lifetime

After `attach_host`, call `Documents::attach_recovery(store, clock)` with the same window's recovery
directory and its monotonic clock. Initial listing is queued automatically. Continue calling `poll`
on worker notifications and schedule an event-loop wake for `recovery_deadline()`.
Accepted transitions may queue work without starting a worker: the core emits `PollDocuments`
for that first poll, including Quit, Discard cleanup and Retry with timed autosave disabled.
`TopBand::pump` accepts one completion per message and schedules one continuation for a real
transition; `None` waits for worker progress or the current deadline. Busy quit/response requests
are retained by `recovery::Panel` and retried once per host wake (`Core::documents_progress`),
not from refresh, focus or an immediate retry loop. Repeated close intents coalesce; Cancel
supersedes a refused answer. Busy keeps the prompt; a terminal refusal retires the invalid question
and reaches the existing stage-message owner through `Notice`. Cancelled saves and invalidated
checkpoints release the UI's quit intent so a fresh close remains possible. An unrelated lane's
failure cannot finish a checkpoint the documents owner still holds. Playback, scrubbing,
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
including with timed autosave off. Only a successful, current copy for a tab in that close intent
completes its checkpoint; an unrelated in-flight copy cannot satisfy it. A failed
attempt first reports `Event::Failed`, then the confirmation carries `recovery_error`, including the
failure reason. Its retained prompt offers `CloseChoice::RetryRecovery`, Save, Cancel or explicit
Discard; failure never silently becomes a successful checkpoint. Retry starts the retained Close/Quit
intent again, and a successful retry clears the prompt's warning.
A changed project invalidates that close intent. Cancel retains both tab and copy. Successful current
manual saves remove the exact copy; stale/failed saves retain it. Save cleanup retains the tab's slot
lease for later edits, and a failed data removal retains its record/ownership. A committed data removal
always acknowledges success, even if optional metadata deletion fails, so the host never reinstates an
obsolete data record. Closing or discarding a tab releases its copy; QuitReady follows completion of
queued copy cleanup.

## Disk compatibility and selection safety

`styk_platform::recovery::LocalRecovery::new(directory)` accepts an explicit directory and does no
profile discovery. The primary directory is the shell's profile; an independent window uses the
shell's workspace. An independent workspace adoption failure is retained and reported;
recovery is disabled for that window, never redirected into the primary namespace. `LocalWorkspaces` wraps S6's existing workspace-adoption policy, shared by shell
startup and the asynchronous service: a dead process's `workspaces/<pid>` directory is renamed to
the new PID, live directories and reparse points are left alone. The service never recursively deletes
anything. Tests supply private temporary roots, never the owner's app-data or recovery folder.

The files are today's `recovery-<lowercase-uuid>.styk` and `.json`, plus legacy `recovery.styk` and
`recovery.json`. Copies are nonempty and at most 256 MiB. Display names use today's illegal-character
replacement and 180 UTF-16-unit limit; metadata is the optional `{name,savedAt}` object. Data is staged,
flushed and atomically renamed through K-doc's `LocalFiles`, then metadata is independently replaced.
A failure or process exit before data commit leaves the old file; afterwards the complete new file
is readable even if metadata is missing or old. Optional metadata/pruning failure does not retract an
already committed copy. A write returns a receipt computed from the committed bytes without a
post-commit read; optional sidecar replacement/read failure cannot poison the next autosave's identity.
Crash-left staging files are not guessed to belong to this process or deleted.

**Electron coexistence.** Today's `desktop/main.cjs` uses `requestSingleInstanceLock`, and
`desktop/recovery.cjs` records only `{name,savedAt}`: neither named nor unnamed copies identify
their owning process. Electron never takes native `.lock` leases. For pre-existing copies,
`LocalRecovery` therefore also acquires Chromium's profile `lockfile` with conflicting sharing
permissions, retaining that OS handle for the entire adopted lease. This is both the orphan proof
and exclusion against a legacy process starting after the check. Sharing violations, access errors
and unverifiable ownership produce `Record::read_only`, never permission to delete. Independent
legacy workspaces have no such lock: only this process's already-adopted `workspaces/<pid>`
namespace is eligible for native adoption; other workspace namespaces stay read-only.
The pinned [Chromium implementation](https://raw.githubusercontent.com/chromium/chromium/142.0.7444.0/chrome/browser/process_singleton_win.cc)
and [Electron 39 patch](https://raw.githubusercontent.com/electron/electron/v39.8.10/patches/chromium/process_singleton.patch)
establish the file handle protocol; native does not impersonate the legacy message window or kill its owner.

A read-only offer restores into a new dirty document without inheriting the source lease. Later
checkpoint, save, close and quit operate on that new document's own slot. Discard is unavailable
for the source, and both the core and storage enforce that refusal; pruning excludes it too.
Claim rechecks profile exclusion, so a legacy owner arriving after listing can only reduce access.
Native-created copies retain K-rec's exclusive per-slot ownership.

Each lease opens or creates the same `.lock` file with no sharing and holds the OS handle for the
session. A sharing violation means another process owns it; successful opening reclaims an orphaned
file. Delete-on-close is only housekeeping: a leftover file after power loss never establishes ownership.
Records include a SHA-256 data identity. Chooser records additionally seal data attributes and a
readable sidecar; restore and discard revalidate that selection under the lease. Write receipts identify the
committed data independently of optional metadata. Data reads hold a handle that denies writes/renames.
Discard marks verified handles for deletion, never deletes paths after releasing the checked handles.
A failed optional sidecar deletion retains its fingerprint in the lease and retries before later
writes/removals; a changed sidecar is left alone. Releasing the lease can leave an inert sidecar behind.
Unavailable optional sidecars (missing, unreadable, or not regular files) never hide valid data.
Listing falls back to `Recovered animation` and the data file's modification time, as today's chooser
does for missing display information. Such offers identify only the data bytes: later sidecar
availability cannot invalidate the selected project or authorize deleting that sidecar. If previously
readable metadata becomes unavailable during claim, read or discard, the data identity still decides
and the unverifiable sidecar is left untouched. Readable metadata that changes is still refused.
This intentionally improves on Electron, which can hide a good copy when its sidecar is unavailable.
Reparse-point data files are refused; reparse-point sidecars are unavailable metadata. Listing skips
owned/unreadable data copies and keeps them on disk.
After commit, named copies beyond sixteen are pruned
oldest-unowned first; the legacy copy and owned copies are never pruned.

Restore opens a dirty project beside the front tab, adopts the lease and removes that record from the
chooser; the disk copy remains until replaced or a successful save/close removes it. Failed decoding,
stale ownership or tab-limit refusal preserves the copy. Dismiss only hides the offer. The old Electron
base64/IPC methods are not native APIs; their legacy on-disk copy is supported through the typed service.

## The views

`styk_core::recovery` is what a person sees of recovery and answers; `styk-ui` draws it. `recovery::model` is plain data (no engine
type, built by pure functions so the engine-free preview draws the same models): the `Offer`, the `Chooser` (rows `name · time`, the
selected row, busy, the error) and the `Closing` prompt. `Event` is everything a view says: `NotNow`, `Manage`, `Restore` (the
offer), `Pick`, `RestoreChosen`, `DiscardChosen`, `CancelChooser` (the chooser), `Respond(Choice)` (the close prompt: `Save`,
`Discard`, `Cancel`, `Retry`). `Command::Recovery(event)` reaches `recovery::Panel`, which turns each event into the documents host's
request (`Request::Recovery(Command::..)`, `Request::Respond`); nothing in a view calls the host.

- **The offer** is the stage's message (priority recovery, the clock glyph, no timeout, no dismiss button): `Not now`, `Manage copies`
  (when several copies are offered) and `Restore`, whose `Do::Recovery(event)` actions come back from the host as `Update::act`. It
  is written from the host's view on `Core::refresh` (`in {name} from {time}?`, or the count) and written again when the copies
  change. `Restore` restores the one copy it names and opens the chooser when several are offered.
- **The chooser** is a modal dialog on the overlay stack opened by `Manage` (or a `Restore` among several). Its select is the host's
  anchored menu; the list opens over the dialog. It closes on `Cancel`, Escape, the close button, a restore that landed, or the last
  copy being discarded; a refused or failed restore or discard keeps it open with the reason under the body (`Changed`, `Owned` and
  `Missing` in today's words). While the host works the submit buttons are busy.
- **The close prompt** opens from the host's `ConfirmClose` and `ConfirmQuit` effects (`Core::document_effect`, which the window
  hands every effect it takes from `Documents::poll` and `dispatch`). `Don't save`, `Cancel`, `Save`, and `Retry` while the recovery
  copy's failure shows under the body (`Recovery copy could not be written: {reason}`); Escape and its close button are Cancel. `Save`'s
  file dialog is the save flow's (K-doc, K-cmd): no platform save-dialog consumer exists yet.
  Save is therefore unavailable when any affected dirty document lacks a target; Discard and Cancel
  stay actionable. Existing targets use the normal K-doc save sequence. The accepted layout and labels are unchanged.
- **Times** are written as today's English `Intl` writes them (`02:03 PM`, `11/8/26, 2:03 PM`) in the person's UTC offset
  (`Core::set_utc_offset`; the platform supplies it, 0 until it does) in every language, until the catalogue has date formats.
- **The window's wiring** (`styk-app`): a real run (no `--screen`, `--automation` or unattended strategy) builds
  `styk_platform::recovery::LocalRecovery` over the primary profile (`styk_platform::shell::profile_dir()`: `STYK_USER_DATA_DIR`, else
  `%APPDATA%StykAnimate`, so the copies Electron left are offered) or, for an independent window, over its `workspaces/<pid>`
  directory (`Shell::workspace`), as this page's "Disk compatibility" says; the settings folder of K-store
  (`%LOCALAPPDATA%StykAnimatesettings`) is where preferences live, not recovery copies. `TopBand::new` attaches it with
  `Documents::attach_recovery` on the application clock. The documents host's `notify` is `Wake::Documents`; layout load/save receipts use `Wake::Layouts`
  in the same coalesced window wake stream (`wakes.rs`). Each document wake polls the host and hands every
  effect to `Core::document_effect`. One scheduled redraw (`TopBand::wake_widget`) follows `Core::wake_deadline`: the earliest
  of recovery, the session-end bound, the overlay host and the layout save queue, so nothing runs while all are idle. Closing asks the host
  (`TopBand::ask_to_quit`, `Request::Quit`): unsaved projects open the close prompt with its recovery retry, the window ends on the
  host's `QuitReady` (`top_band::Request::QuitReady`) once the lane has finished its copies; an unattended run does not ask.
  `styk-app/src/recovery_wiring_tests.rs` drives `App::close`, returned iced tasks, the real coalesced wake
  stream, the mounted deadline widget and mounted recovery controls over a private local store.
  It never supplies periodic document polls. The playback, scrub, drawing, import and export
  owners do not yet report `set_recovery_activity`.

**Quit order.** The documents host decides first: Busy keeps the intent, the close prompt stays until its answer is
accepted, and Save/Discard/Cancel and recovery finish before `QuitReady` grants window exit. The documents host fences edits
from accepted Save/Discard through cleanup and window teardown; the core uses that permission for all input commands. A failed
or cancelled save releases the fence with its continuation. The fence also covers the later preference drain. An ordinary quit
starts both the layout `SaveQueue` flush and Settings `Event::Finish` without debounce, waits for both worker receipts,
then saves window placement and ends. Both are maintenance admitted under the core's edit fence; input remains fenced,
and maintenance wakes cannot replay deferred edits. A refused final write abandons only the proposal while transactional
storage preserves the last complete file, including preferences a later launch needs. Session end retains its identity after the
checkpoint: once documents grant `QuitReady` (including bound expiry), the app cancels and detaches layout and Settings work, skips placement
persistence, releases the shutdown block and ends immediately. A session request during an already approved ordinary quit
also takes this path. Neither preference lane extends the platform-derived session bound; detached replies cannot restart quit.
The app regression `dirty_quit_discards_then_drains_settings_and_layout_under_the_same_fence_and_session_bound`
drives the mounted Discard button with a dirty document and both preference writes pending. It checks successful drain,
Settings refusal preserving the old file, and session end cancelling both lanes. Removing Settings from this order must fail it.

**OS session end.** The platform window subclass translates `WM_QUERYENDSESSION` and a forced
`WM_ENDSESSION` into the same guarded quit. Query replies immediately with refusal while it posts
the intent; no interface thread waits for disk. `ShutdownBlockReasonCreate` uses the presentation's
existing `common.saving` message for the in-flight
checkpoint. The core releases the reason on checkpoint completion, failure or refusal, via a message
posted back to the window thread; cancelled session-end and window destruction also release it.
The normal Save/Discard/Cancel prompt remains the authority once the checkpoint finishes. A cancelled
OS shutdown does not discard anything or automatically answer that prompt.

An outstanding session checkpoint has an app-owned deadline in the core's recovery panel, on the
injected monotonic clock. The platform supplies `SPI_GETWAITTOKILLTIMEOUT`: the configured number of
milliseconds Windows waits before terminating an application that does not answer shutdown. If the
query is unsupported or fails, the fallback is the documented five-second Vista shutdown response
window. A configured zero means no wait. See [Windows' timeout query](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-systemparametersinfoa)
and [Vista's shutdown contract](https://learn.microsoft.com/en-us/windows/win32/shutdown/shutdown-changes-for-windows-vista).
These OS values establish the bound; no measurement or test threshold selects it.

`TopBand::wake_widget` includes the session deadline even while a worker is
pending. Repeated queries cannot extend it. Expiry is checked before consuming worker replies: it
cancels and detaches both document lanes through their existing asynchronous teardown, emits
`SessionCheckpointFinished` and `QuitReady`, and skips the final window-placement save. It does not
run Discard or recovery cleanup, delete a committed copy, or wait for a worker to acknowledge cancel.
An atomic write already committed remains on disk even if its reply arrives late; the detached lane
retires that reply without adoption or cleanup. Further OS queries are accepted after expiry.
Checkpoint success, failure or refusal retires the deadline normally. Each posted platform reply
carries a unique window-lifetime identity; destroyed/detached windows reject late replies, including
when Windows reuses a handle. Destruction and explicit detach both release the block and subclass owner.
See [Microsoft's query contract](https://learn.microsoft.com/en-us/windows/win32/shutdown/wm-queryendsession)
and [shutdown-block lifetime](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-shutdownblockreasoncreate).

Screens: `recovery-offer`, `recovery-chooser`, `recovery-busy`, `recovery-error` and `close-prompt`, each in both themes, against
today's own modules (`engine/crates/styk-app/automation/recovery-reference/screens.mjs`). The select draws today's dialog form there (`Select::form`: a `--icon-sm` chevron 10 px from the end; the inspector's field keeps its `--icon-xs` one). The interaction script is `engine/crates/styk-ui/tests/recovery.auto` (`recovery ...` steps and `expect
recovery ...` in `styk_core::automation`), run through the widgets by `styk-ui/tests/recovery.rs`, which also drives Restore and
Discard and the close prompt's Cancel through the mounted buttons to the core and the host. Logic tests: `styk-core/tests/recovery_views.rs`.

## Checks

`styk-core/tests/recovery.rs` checks fixed-clock deadlines, busy retry/backoff, resting cancellation,
save byte equality (root and movieclip scope), chooser ownership/identity, restore beside the front,
cleanup failure, close/quit, and pending-write cancellation/disposal. Existing documents-host/jobs tests
cover the surrounding lifecycle. `styk-platform/tests/recovery.rs` exercises real sandboxed files,
pruning, legacy metadata and selection changes. Platform unit tests terminate a child test process at
each of ten data/metadata staging, write, flush, commit and rename points; the surviving file must equal
one of the complete repository projects. Workspace tests adopt only a sandboxed simulated dead process.
Review regressions first failed on `d24e7793`: an orphaned lock hid a complete copy, read-only metadata
retracted a committed removal, a post-commit sharing violation retracted a write, and failed Close/Quit
checkpoints produced unqualified confirmations. Further checks hold a lease in another process, kill
only that child by handle, exercise cleanup with changed metadata, and retry failed close intents.
Sidecar regressions first failed on `e941f89c`: a directory or deny-sharing handle at the JSON path
hid valid committed bytes, and metadata becoming unreadable prevented selection. Tests also cover
fallback labels/timestamps, changed-data refusal and sidecar availability changing after listing;
discard must preserve every unverifiable or unselected sidecar.

`node --test tests/native-recovery-reference.test.mjs` checks that the writer is unchanged from
`99c62189`, writes a public repository fixture twice through that recovery code, and compares every
project byte. Only sidecar timestamps vary. Its outputs go to ignored `artifacts/native-recovery-reference`.
The explicit ignored platform oracle reads both named/legacy copies; the core oracle restores those
bytes and compares the canonical document. Run those ignored tests by their full individual names;
the crash-child entry is only invoked by its parent test. No frozen fixture is changed.
