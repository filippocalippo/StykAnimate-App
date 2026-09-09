# Scene background editing

`src/editor-scene.mjs` is installed on `Editor`. It supplies these commands:

| API | Behavior |
| --- | --- |
| `setSceneColor(argb, {indices})` | Set a 32-bit ARGB color absolutely at selected native frames or authored Scene keys. Numeric zero is transparent. |
| `setSceneBackground(id, {indices})` | Select an existing background; zero selects the default white background. Clear any active color override at the edited point. |
| `importSceneBackground(background, {indices})` | Import a decoded image, solid color or gradient, assign a fresh native ID, select it, and return the inserted asset. Import and selection form one undo command. |
| `renameSceneBackground(id, name)` | Change only a background's name. The image/gradient asset retains its identity and media bytes. |
| `sceneValuesAt(editor, index, tick)` | Sample only Scene fields, without composing or copying figure poses. |

Indices default to the current stored frame. Native changes snap to that frame's
start. A single authored edit uses the displayed tick; authored range changes use
the selected native frame start ticks. Hidden or locked Scene tracks reject edits
before changing the document.

Ordinary editing does not create scalar animation channels. Existing Scene color
or background channels receive keys on those channels. If a Scene pose track is
present instead, the command records a minimal Scene-only source and a pose key,
preserving unrelated animation tracks. Selecting a background writes a `null`
key to an existing color channel: null returns control to the background, whereas
ARGB zero remains a transparent color. Composition applies the background channel
before the color channel, independently of channel creation order.

Native undo snapshots contain only changed Scene fields and newly imported table
entries. Renaming snapshots only the previous and next names. They do not copy
existing figure arrays or unrelated images. Authored snapshots contain only
changed channels and small source frames; the standard source-history lifecycle
keeps required sources available through undo/redo and prunes unused captures.

`tests/editor-scene.test.mjs` passes 12 cases covering sparse ranges, authored
inbetween edits, null/transparent colors, atomic image import, name-only history,
source pruning, invalid/locked/hidden edits and real PIV writer/reimport. A 2 MB
unrelated image does not appear in color history; native color history stays below
5 KB, and renaming a 1 MB image stays below 2 KB.

Rendering uses the shared Scene override in Canvas, WebGPU, prepared playback and
SVG. `tests/scene-background.browser.mjs` previously passed 35 checks with all four
paths, transparent/translucent colors, Scene/Camera visibility and retained-cache
changes. The pixel report is in
[`artifacts/scene-background/report.json`](../artifacts/scene-background/report.json).
These checks cover the engine and rendering contracts; they do not claim the
separate background library dialog's UI workflow is complete.
