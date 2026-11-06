# Keyboard shortcuts

Open **Settings → Shortcuts** (or **Help → Keyboard shortcuts**). Click a binding and press the desired combination. Use **+** for up to four alternatives, **×** to remove a binding, **Reset** for one command, or **Reset all**. Escape cancels recording; Tab retains normal focus navigation. Missing bindings display “Unassigned”. Conflicts within the same context require an explicit replacement; cancelling leaves both commands unchanged.

**Ctrl+P**, **Ctrl+Shift+P** or **F1** (or **Search commands…** at the top of the StykAnimate menu) opens the command palette. Type to find any command, a layer or a figure on the current frame, or a setting, and press Enter to run or open it; typing a number goes to that frame. Commands that cannot run at the moment stay listed with the reason, such as "In Build" or "Select a figure first", and recent commands come first. In the browser, Ctrl+P and F1 no longer print or open the browser's help while the editor has focus; Firefox keeps Ctrl+Shift+P for a private window, so use Ctrl+P or F1 there.

**F6** and **Ctrl+F6** move focus to the next or previous area of the editor: the top band, the tools, the side panels, the stage and the timeline; they work from a text field too, so they are the way out of one. **Ctrl+\\** turns Focus mode on and off: the side panels and the timeline fold to strips, and a second press restores them. **Ctrl+Alt+M** moves the focused panel: the arrow keys choose a place (Dock left, Dock right, Float), Enter moves it and Escape cancels. **Ctrl+Alt+L** opens View › Layout…, the layout presets and panel positions. On a focused panel tab, **Shift+F10** or the Menu key opens its menu (Dock left, Dock right, Float, Fold to strip, Hide). In the desktop app, **Ctrl+1** to **Ctrl+4** show and focus Properties, VFX, Library and the timeline, and fold the panel when it already has focus; a browser keeps those keys for its tabs, so they are unassigned there. A panel's splitter takes the arrow keys (Shift for bigger steps), End for its largest size, and Home or Enter restores its default size. Ctrl+Alt+M and Ctrl+Alt+L also work from a text field.

**A** duplicates the frame after the current frame in both timeline modes. Ctrl+Enter is unassigned. The existing simple-mode Space workflow still adds a frame; holding Space and dragging pans. These bindings can all be changed. Operating-system commands, pointer gesture modifiers, and standard navigation inside form controls and menus remain standard UI behavior.

## Architecture

`HotkeyManager` uses the same `mac` setting for resolving key events and displaying
shortcut labels. Its default follows the host platform; an explicit override also
applies to labels and hints. `shortcutLabel(bindings, id, mac)` accepts the same
optional platform override, with host detection as the default.

In Animate, Shift-dragging a figure origin carries its pinned IK nodes with it;
Shift-click still toggles selection. Ctrl/Command constrains the origin move to
one axis and can combine with Shift. Motion-path origins with pinned IK use the
same modifiers; other trail points retain Shift for axis locking. These pointer
modifiers do not register global commands or change custom shortcut bindings.

In Build mode, **Ctrl+D** starts placement of a copy of the selected segment,
and **Shift+H / Shift+V** flip the selected segment horizontally / vertically.
These shortcuts use the selected branch or the persistent **Branch** toggle
(**B**) to include descendants. Their Ctrl/Shift binding modifiers do not change
scope or mirror a duplicate. **S** splits the selected segment(s) at the midpoint;
**Shift+S** temporarily includes the branch. All use the shortcut settings,
including remapped bindings; Shift included in a custom Split binding is part of
that binding, not a branch modifier. Escape cancels duplicate placement.

- `src/hotkeys.mjs` is the command catalog and pure dispatcher. Stable command IDs connect labels, defaults, context, repetition and held-key behavior. Every supported binding is validated and normalized. `Mod` maps to Ctrl on Windows/Linux and Command on macOS; physical `KeyboardEvent.code` values keep bindings stable across Caps Lock and shifted punctuation.
- `src/app.mjs` provides the context and command adapter, retaining editing transactions, renderer recovery restrictions and polygon draft protections. `src/timeline-hotkeys.mjs` shares timeline behavior between the integrated app and standalone timeline widgets. Specific contexts override editor-wide bindings.
- `src/hotkey-settings.mjs` owns recording, search, conflict replacement and focus. `EditorSettings` owns normalization and persistence using the existing browser or desktop preference store. Absent command IDs inherit defaults; an empty array explicitly disables a command. Invalid preferences are repaired deterministically, with customized bindings taking precedence over conflicting defaults. Save errors remain visible and can be retried by closing Settings again.
- `src/hotkey-hints.mjs` derives menu badges and each shortcut control's hints from active bindings: its name (`data-hotkey-title`), shortcut text (`data-hotkey-hint`) and `aria-keyshortcuts`. The one tooltip (`src/ui/ui-tooltip.mjs`) shows "name · shortcut" with the shortcut read from the command registry (`src/ui/command-registry.mjs`), so a rebinding shows at once and a workspace that claims a key shows its own command (in Draw, M flips the view, so Motion paths shows no key there). Shortcut controls carry no `title`, which would add a second, native tooltip, and accessible names never include the shortcut. Localization preserves those hints. Electron delegates editor shortcuts to the renderer, avoiding native accelerators that bypass settings or intercept typing.
- `src/ui/command-palette.mjs` is an index of the registry, never a home of its own: a modal dialog anchored near the top. `app.mjs` answers the catalog's availability conditions (`CATALOG_REQUIREMENTS`), runs actions through the same wrapped `actions` map as a click and hotkey-only commands the way their key would, and adds the palette's "In this project" (layers, figures on the current frame) and Settings rows (`EditorSettings.searchIndex()`).

Typing, composition/IME, AltGraph and open dialogs cannot trigger editor commands. Key release is captured even if a control stops event propagation. Focus loss, hidden documents, opening a dialog, cancellation and rebinding clear held keys without running tap actions.

To add a shortcut, add a stable catalog entry and implement its command in the editor adapter or relevant scoped widget. Declare repeat/hold behavior explicitly. Avoid adding independent key listeners for editor commands.

## Verification

- `npm run test:hotkeys` — normalization, dispatch, conflict handling, contexts, repetition and held-key cleanup.
- `npm run test:hotkeys:ui` — Settings interactions, persistence, menus, both timeline modes and actual scrollbar dragging. Requires `npm run serve`.
- `npm run test:hotkeys:desktop` — Electron dispatch, native menu interception and persistence across a process restart with an isolated profile and library.

The advanced timeline renders only within the scroll viewport's client dimensions. Native horizontal and vertical scrollbar gutters sit outside the canvas and playhead overlay. The filmstrip also has a visible horizontal scrollbar. Scrollbar gestures are excluded from frame selection and editing.

Add Frame (A) is the single frame creation command. Selecting a cell in the advanced timeline adds a key at that cell without shifting later keys. Working on the canvas adds a copy of the current pose immediately after the current frame and advances to it. The filmstrip adds after the current frame. Space plays or pauses in both modes.
