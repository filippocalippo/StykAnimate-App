# Project tabs

Several projects stay open in one window, as tabs in the top band. One project is live at a time; the others
rest. The design was chosen from a set of mockups (concept 6, "Calm band").

## The band

The band reads left to right as three groups: where (the mark and the open projects), how (Animate, Draw,
Build) and what next (undo, redo, save, Export).

- The mark opens the StykAnimate menu. File, Edit, View, Joint, Animation and Help are its first rows, each
  a submenu; with two or more projects it also lists them. The `.app-menubar` stays in `index.html` as the
  source of those menus (`[data-app-menu]`) and never shows.
- `#project-tabs` holds the tab list and New. `src/shell/project-tabs-view.mjs` renders one tab per open
  project: a picture of its stage, its name, and a dot while it has unsaved changes (Close takes the dot's
  place under the pointer). `aria-label` says the state in words. A save shows the success dot for a moment.
- The tab of the project in front replaced the old document button (`#project-name`, `#save-state`,
  `#dirty-dot`). Rename is a double-click or F2 on the tab, its menu, or File › Rename project. Save is a
  glyph beside undo and redo.
- The tabs share the room the start cluster has (`components/project-tabs.css`). The strip's own width does
  not depend on its tabs (`contain: inline-size`, `data-band-reserve`), so the band is measured again only
  when its other content changes, and adding a tab never moves another control. Resting tabs shrink four
  times as fast as the one in front; a narrow tab drops Close, then its name. In very small windows the band's
  `name` and `dot` fold steps narrow the strip, then keep only the tab in front.

Interaction: a click or Enter brings a project to the front; arrows move focus without switching (switching
is not free); middle-click, Delete or Ctrl+W closes; drag reorders; right-click or the Menu key opens the
tab's menu. Ctrl+Tab (`src/shell/project-switcher.mjs`) goes to the project used before; held, it shows
every open project as a picture, Tab moves, releasing the modifier switches and Escape stays.
Ctrl+Page Up/Down step through the tabs. The tab keys are bound in the desktop app only: a browser keeps
them for its own tabs.

## One live project

`src/project-tabs.mjs` is the list (order, the project in front, the order of use, the limit of 12).
`src/project-tabs-host.mjs` moves projects between the list and the editor; `src/app.mjs` supplies its hooks.

The editor holds one document. `editor.detachDocument()` (`src/editor-sessions.mjs`) hands over everything
the editor holds for it (report, history, selection, playhead, saved revision, movieclip scopes) as a
session, without cloning; `resumeDocument(session)` puts it back and publishes a `document` change, so
every module rebuilds exactly as after a load. The clipboards, configuration, installed services and the
revision counters stay with the editor, so a copy pastes into any project and no revision repeats across
projects (caches keyed by a revision can never confuse two projects). Derived caches are dropped on
detach. `discardDocument(session)` ends a closed project's session for good.

A project that rests holds its document, its history and what `app.mjs` captured for it (view, hidden and
locked figures, save target, the imported original's lease, the last save). It has no renderer state,
no playback or thumbnail worker mirror, no preview caches and no timers. Bringing it forward reloads the
playback workers and thumbnails from its document, as after opening a file; editing is ready at once.

Memory: each resting project costs its document plus its undo history (bounded by the editor's history
budget, 48 MB by default). A project with drawing layers also keeps its pixel tiles (bounded by the drawing
budget) and any drawing workers it had started, idle, until it closes. Twelve projects is the limit; a
thirteenth is refused with a message.

Opening a file, New and restoring a recovery copy open a tab beside the project in front, except that an
untouched empty animation gives its place. A load that fails puts the parked project back in front
unchanged. Closing a project brings it forward first, so the question about unsaved changes is asked
about what is on screen; the project used before it comes forward. The last project closes into a new,
empty one. A switch first ends what belongs to the project in front: the edit in progress, Draw (once its
pixels are published) and Build (by its own keep or discard choice); a save, an import or a raster export
in progress refuses the switch.

## Saving and recovery

The desktop keeps a save target per open document (`desktop/project-files.cjs`): `activateDocument`
opens one, `selectDocument` brings one to the front (only the front one can be written), and
`releaseDocument` closes one. A page that loads again forgets the previous page's documents.

Each project has its own recovery copy: `recovery-<document token>.styk` in the instance directory
(`desktop/recovery.cjs`), or a key of its own in the browser's store (`src/browser-recovery.mjs`). The copy
of the project in front is written on the usual schedule; a project that leaves the front with changes
its copy does not have gets one write in a quiet moment, which edits in front never interrupt. Saving or
closing a project removes only its copy. At the next start every copy no open project owns is offered;
each restores into a tab of its own and adopts the copy it came from. Copies left behind make room oldest
first beyond 16. The single `recovery.styk` of earlier versions is still read.

Closing the window asks once for every open project with unsaved changes (Save all, Cancel, Discard all);
Save all saves each in turn and stops at the first one the person cancels.

## Measurements

`tests/project-tabs-switch.benchmark.mjs` on 2026-10-02 (i5-13420H, Intel UHD iGPU, headless Chrome 153, development
server), switching six times between AyameDemo.piv (2 MB) and Uriel 19-2-2026.piv (6 MB):

| | Result |
| --- | --- |
| Until the project in front is editable (its scene drawn) | 82–161 ms |
| Longest main-thread task per switch | 58–103 ms (one per switch) |
| JS heap: AyameDemo alone / with Uriel resting beside it | 113 MiB / 190 MiB (Uriel resting: 77 MiB) |
| JS heap: Uriel in front | 217 MiB |

The project in front does no extra work per frame: the tab strip writes only when a name or a state changes,
and the band is not measured again while editing or playing (`tests/shell-layout.browser.mjs`). Not measured:
the desktop build (Electron), GPU memory, and resting projects with large drawing layers.

## Verification

- `node --test tests/editor-sessions.test.mjs tests/project-tabs.test.mjs tests/document-save.test.mjs`
- `node --test scripts/project-files.test.mjs scripts/recovery.test.mjs`
- `STYK_URL=<dev server> node tests/project-tabs.browser.mjs` (opening, switching, per-project undo,
  cross-project paste, closing, saving, recovery copies, twelve tabs, Ctrl+Tab, reordering)
- `npm run test:project-tabs:desktop` (Electron: a save target per project, the window-close question for
  several unsaved projects, a recovery copy per project, and restoring them after a restart)

## Reload from disk

On desktop, File → Reload from disk (also in the active tab’s context menu)
reopens the current saved `.styk` in the same tab. Unsaved projects must be saved
first. Unsaved edits require choosing Don’t save or Cancel; reload never writes
over the externally updated file. Missing or invalid files leave the current
project intact. Other tabs are retained. Reload resets the playhead and undo
history, as opening a project does. Browser projects do not offer disk reload.
