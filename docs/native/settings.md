# Settings owner: initial native implementation

This is the minimal implementation of the approved Settings design used by timeline part 1.
Later Settings pages extend this owner; there is no adapter or temporary preference store.

`settings::Settings` owns typed animation preferences and `ViewMemory`.
The single `set(SettingId, Value) -> Change` path validates values and lists application/persistence
effects. `Core::dispatch(Command::Settings(...))` routes changes and guarded reverts; a stale revert
cannot undo a later choice. Loads preserve changes made before completion. Transport consumes mode,
loop, fit-on-playback, quality and auto-key now; drop policy is loaded for later edits.

The schema-1 envelope is `settings.json`, with separate `values`, `view`, `shortcuts`, `extra` and
import provenance. Native profile storage uses K-store's asynchronous transactional `Storage::update`
and `LocalStorage`; transaction locking and atomic replacement supersede the design's older service
signatures. Changed keys merge into the latest file, preserving unrelated process writes. No new
wall-clock ordering scheme or writer registry is needed. Unknown envelope and preference fields
survive. Load and the transaction refuse schemas newer than 1; invalid native files are preserved
read-only with a visible notice.

On first load, the platform reads only `editor-settings.json` from the legacy profile (honouring
`STYK_USER_DATA_DIR`, otherwise the roaming profile). The legacy file is never written. The native
profile stays separate. Known keys split into design sections, unknown keys go to extra, and
session-only motionPaths is omitted. Transport's six typed fields use today's defaults and
normalization; other groups and shortcut records remain available for their Settings extensions.
The imported filename is recorded; unavailable old application version/time metadata is not invented.

One worker parses and writes. Edits coalesce for 200 ms and failures use the existing layout
SaveQueue's 200/400/800/.../10000 ms retry backoff. New edits remain pending during an earlier write;
only acknowledged values retire. Refused worker admission retains its request and a retry deadline.
Each setting also owns its latest mutation identity. A Change can revert only that mutation,
including after an ABA value sequence; changing another setting does not invalidate it. These
identities are transient and never enter the settings file.
Ordinary flush waits for the transaction and retries failures while notices remain visible. Corrupt-file
backup/recovery actions and Settings controls arrive with later design chunks, using this same owner.

After the documents host grants `QuitReady`, `Event::Finish` is final maintenance: it bypasses
debounce, drains an outstanding load/import/write, and settles on a refused final transaction.
That refusal leaves the previous atomic file intact; it does not revert the in-memory preference.
Normal `Flush` retains its retry policy. `Event::Abandon` cancels/detaches this lane at OS session
end, so preference persistence cannot extend the session-end bound.

The app integration test `settings_storage` uses real LocalStorage in directories created and
removed by each test; keeping this cross-owner test at the app avoids a core-to-platform dependency. It covers
unknown fields, future schemas at load and transaction time, a separate read-only legacy root,
late edits, actual replacement failure/retry, coalescing and Core's final maintenance drain.
The real app quit regression also checks the Settings and layout receipts under the accepted-quit fence;
see [recovery.md](recovery.md). Screens and unattended runs use no personal preferences store.
Native-only notice keys in `styk-core/messages/en.json` extend the English catalogue through the
build script; other locales use the existing fallback presentation path.
