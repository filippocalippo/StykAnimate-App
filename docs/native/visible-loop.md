# Native visible editing loop (V0)

`Core::start_runtime` starts the document-derived facts, timeline and Select lanes. The
window's document pump consumes host completions and attaches the published front
project to its existing `Surface`. Command-line opens explicitly notify that pump;
recovery opens use the same host completion path. The existing dock mounts the stage
and Properties. The stage retains navigation and its fitted view.

## Presses and Properties

`Core::stage_event` forwards Surface's unconsumed pointers to `styk_core::tools`.
Only a left press selects. The existing handle/segment queries and alpha-aware artwork
picker run on a worker. There is at most one submitted query and one latest waiting
press. A reply must still match its input serial, document lineage, revision, playhead
and stage view. The common panel lifecycle invalidates it before switching tabs or
running another command. Empty canvas clears; modifier clicks toggle figures; a
selected figure's joint changes the session's selected joint. Selection adds no undo.

Selection remains in the session. The Inspector context returns to Auto after a pick.
Its facts lane also returns the selected instances' resolved figures, so their colour
and segment style include instance overlays. Controls stay pending until those facts
match the current key; the interface never resolves instance styles or builds geometry.
Numbers keep the existing field gesture. Solid figure and segment colours call their
existing session commands. Each committed edit is one undo entry.

`Effect::RequestFrame` becomes `Message::PollDocuments` in the UI adapter. This starts
publication after an edit, undo or redo, without waiting for unrelated input. Worker
receipts refresh the Inspector and revise the active Surface. The pump synchronizes
the band's undo/redo state as part of that same update.

The always-mounted raw event subscription delivers a tab's button release even when
Windows batches it with the press, before the drag subscription has been installed.
An activated tab explicitly schedules publication for its front document.

## File and colour services

The registry's file owner routes New, Open, Save, Save As, Save All and Close to the
documents host, after the shared panel settlement barrier. The band's mark opens the
existing overlay menu with these currently implemented actions. File prompts and the
Inspector's existing swatches request `styk_services::dialogs::Dialogs`. The Windows
implementation runs the window-owned common dialog on a worker. Unattended runs
refuse OS dialogs; automation supplies choices at the same boundary.

Save answers retain the host's prompt identity. Busy continuations are retained and
retried on host progress, without a polling loop. Cancellation or picker failure
answers a pending save with no target. A colour answer carries the original document,
revision, tick, selection and target, and an intervening editor intent invalidates it.
Window blur alone does not invalidate a colour dialog, since the modal receives focus.

V0 adds no views. The native solid-colour dialog is the platform implementation
behind the service; gradients, the full paint editor and the complete application menu
remain later view work. Existing untitled close/quit Save availability is unchanged:
Save or Save As can establish a target before closing. Stage dragging, marquee and
selection decorations remain later tool work.

## Verification entry points

- `cargo test -p styk-core --test visible_loop`: production worker routing, figure/joint/
  empty selection, supersession, colour, number, history, save bytes/reopen and front tabs.
- `cargo test -p styk-app visible_loop`: mounted Properties controls and production
  subscription/task handling, including publication without a synthetic frame poll.
- `stykanimate tests/edit/startup.document.json --automation crates/styk-app/automation/visible-loop.styk-auto --size 1560x1000` from `engine/`:
  real mounted controls, messages posted only to that window, file/colour choices at
  the service boundary, and PrintWindow captures in `artifacts/native-v0/` (create that
  output directory first). Steps wait for the stage's current picture. The existing
  frame-settling interval counts only complete glyph frames, so a held previous frame
  cannot be mistaken for the new selection's Properties.

The unattended Windows adapter suppresses that window's OS `MouseLeave` notifications:
the physical desktop pointer deliberately stays elsewhere. Otherwise iced sees an
unavailable cursor for the entire posted click batch. The hook exists only after an
automation click in a background window and removes itself when that window is destroyed.

All commands run through the machine queue with `STYK_BACKGROUND_WINDOW=1`.
