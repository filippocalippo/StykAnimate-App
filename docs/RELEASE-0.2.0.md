# StykAnimate 0.2.0

This desktop release replaces the initial workspace with a compact, neutral interface, consistent vector icons, movable panels, and a virtualized animation timeline. The real Pivot document remains editable throughout import, posing, playback, saving, and export.

- Drag panel grips to float or dock a panel; drag its edges to resize it. Desktop layouts survive restarts.
- Drag any connected figure's origin or body to move its complete attached component. Drag a red joint to pose a branch. Orange origins move figures; blue joints belong to unselected figures; attached origins are white with a visible outline.
- Press **R** to edit the rig, including static joints. Choose **Move joint** to retain neighboring endpoints or **Rotate branch** to rotate the branch. Rig changes update reusable instances and undo together.
- Hold **Space** and drag to pan; tap Space to play or pause. Scroll to pan, Ctrl/Cmd-scroll to zoom, Shift+1 to fit the canvas, and Shift+2 to fit the selection.
- Line and circle tools start where you draw. Starting at an existing joint extends that figure. Polygon creation uses existing handles and finishes with Enter.
- Alt-drag a joint to bend; Ctrl/Cmd-drag to stretch. Caps Lock isolates the operation using the appropriate posing or rig rules.
- Right-click a figure for clipboard, selection, attachment and ordering commands. Shift-click or Shift-marquee toggles figures. Numeric group transforms and alignment preserve joined components.
- Use F6 for a keyframe, F7 for a blank keyframe, Shift-click for a range, and Ctrl/Cmd-click to toggle individual keys. The timeline supports holds, easing, sparse frame operations, and hidden-key navigation.
- Search the figure library and add figures from their previews. Complex libraries use bounded rows and idle thumbnail work.

Large-document work runs in bounded worker tasks. Autosave and native file transfers no longer serialize the entire project on the UI thread. Ordinary pose edits transfer one changed frame to playback; zoom changes retain the worker document. Prepared textures exclude unused offstage regions and use one camera-aware resolution calculation. Prefetch uses measured packet sizes to prepare the nearest frames that fit in memory, preventing repeated raster work from building up on the GPU.

Windows includes its own codec runtime and compiled JSON encoder. Separate Setup and Portable executables are produced. macOS and Linux build targets are supplied, with Windows the platform exercised here.

The [compatibility checklist](PIVOT_PARITY.md) and [implementation evidence](IMPLEMENTATION.md) retain the remaining gaps and measured performance limits. Complete Pivot parity and uniformly smooth playback on every scene or device are not claimed.
