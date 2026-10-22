# StykAnimate changelog

What's new in each version of StykAnimate.

<!-- Maintainers: follow the writing guide in docs/RELEASING.md before adding entries. -->

## [Unreleased]

### Added

- StykAnimate is now open source: its code is on GitHub under the GPL-3.0 license.
- Everyday Props · Pivot 3D: 30 editable everyday objects with working hinges and wheels for your animations.
- Vehicles · Pivot 3D asset pack with twelve editable vehicles, spinning wheels, steering and opening parts.
- Named poses for articulated figures, with detailed controls that can be shown when needed.
- Change individual colors on 3D figures from the Colors palette.
- Keep several projects open at once in tabs, each with its own undo history, and switch between them with a click or Ctrl+Tab.
- A new Home page to start an animation in landscape, vertical or square, reopen your projects and organize them with pins and folders.
- Five short interactive tutorials that guide you step by step through the canvas, posing, the timeline and the panels.
- Right-click a joint and choose Disconnect segment to turn that part of a figure into a figure of its own.

### Changed

- Ctrl-dragging a node that uses IK stretches it like any other node.
- A calmer top bar: the menus are in the StykAnimate menu, and your open projects take their place.
- On a Mac, showing or hiding unselected handles is now Shift+Command+H, so Command+H hides the app as usual.

### Fixed

- Fixed an error when deleting your last color palette.

## [1.2.5]

Layer folders, camera follow and smoother editing

### Added

- Layer folders with quick creation and a searchable filter to organize your timeline.
- Playback ranges to loop a chosen section of your animation.
- Automatic updates for the Linux AppImage, with a prompt to save your work before restarting.
- Move a layer up or down from its menu in the timeline.
- Auto key in the Advanced timeline: turn it on (K) and every change you make adds a keyframe at the playhead.
- Camera follow: right-click figures and choose Follow with camera to keep them in frame, with smooth catch-up, look ahead, a dead zone and auto zoom. Projects that use it need this version or newer.

### Changed

- Shorter layer menus with related commands grouped into submenus.
- Easier timeline navigation: zooming stays on the playhead, the view follows it, and there is room below the last layer.
- Layer focus stays active until you turn it off, with support for multiple layers and Focus and lock to protect other artwork while you work.
- Zooming the canvas with the mouse wheel is smooth and easier to control. Compatibility mode zooms in quick steps by default, and Settings › Canvas › Smooth zooming lets you choose.
- Complete interface translations for all 26 supported non-English languages, with right-to-left layouts and clearer text in narrow windows.
- Onion skin is enabled when the app starts.
- While joining figures, movable nodes are shown in red and static nodes in white.
- A simpler Motion tab for camera moves, with a gallery that explains each preset and plain sliders for the settings that matter most.
- Dragging layers in the timeline shows where they will land, moves several layers or a whole folder at once, and drops them into or out of folders.
- Camera motions share one compact timeline row, color-coded by type, that only grows where motions overlap. Hover a motion to see its name and frames.
- Redesigned onion skin markers on the timeline: drag them straight to the frame you want, without catching the playhead. You can hide them in onion skin settings.

### Fixed

- Repeated Save commands no longer start overlapping writes, and newer edits keep the project open when closing.
- Successful saves no longer show a failure if an old recovery copy cannot be removed.
- Imported Pivot originals stay available after other imports, and saving stops if an original cannot be retrieved.
- Recovery copies are scheduled more reliably during frequent editing.
- Fixed multiple layer selections and searches being lost during editing.
- Fixed figures and text staying blurry when zooming far into the canvas.
- Fixed long freezes when zooming or panning animations that use effects or onion skins.
- Fixed blur, glow, and shadow effects shifting or failing at certain positions.
- Fixed drawings disappearing with VFX enabled or changing layer position after the first stroke.
- Fixed onion skins disappearing behind lower layers or skipping nearby drawings in animations with many layers.
- Fixed repeated captions in controls and panels when changing the interface language.
- Fixed Settings running off the edge of very narrow windows.
- Browser downloads now keep your work recoverable until a file save is confirmed.
- Browser recovery keeps each tab's unsaved project separately and pauses playback when the tab is hidden.
- Double-clicking a static node now selects its branch, just like other nodes.
- Clicking a frame in the Simple timeline keeps your current selection instead of selecting every figure.
- Copying, pasting or duplicating a figure now keeps its effects.
- Bending a connector now follows your pointer smoothly, and also works with Move joint in Build.
- Adding parts to a figure in an imported Stick Nodes project no longer stops the saved project from opening.

### Performance

- Smoother scrolling through long layer lists in the timeline.
- Quicker repeated saves for small projects and smaller exported movieclips.
- Smoother zooming and panning, fewer pauses, and more responsive joints and selection when editing complex animations in Compatibility mode.
- Much smoother playback of busy animations and scenes with effects, with fewer pauses, especially on laptops without a dedicated graphics card and in Compatibility mode.
- Complex STK figures open faster, including figures with long chains of joints.
- Faster color adjustments on large drawings, especially when painted areas are far apart.
- Faster keyframe edits and figure posing in long animations with many layers.
- Large personal libraries open faster, with more responsive selection.
- Quicker preparation for playback and exports.
- APNG and PNG sequence exports use less memory.

## [1.2.0]

A new workspace, particle effects, Linux and the browser

### Added

- StykAnimate for Linux, with an AppImage you can download and run.
- Animate in your browser, with project saving, recovery, your own library and offline use after the first visit.
- Community library: browse free figures and movieclips shared by other animators and insert them straight into your scene.
- Particle effects: add explosions, auras, beams, smoke and steam, design your own particles, and save reusable presets.
- Custom layouts: dock, group or float panels wherever you like, and switch between layouts from View → Layout.
- Command palette: press Ctrl+P or F1 to find any command, setting, layer, figure or frame.
- Keyboard navigation: F6 moves between editor areas, Ctrl+\ switches to Focus mode, and Ctrl+1 to Ctrl+4 toggle the main panels.
- Color palettes in every color picker: keep your project's colors, reuse recent ones, and create named palettes for any project.
- Richer drawing brushes, with tapered strokes, textured tips, steadier lines and adjustable tablet pressure.
- Moving parts for 3D props, like a pistol's slide or trigger; projects using them need this version or newer.
- Reshape a whole arc of motion by right-dragging a point on its motion path.
- Hold Alt and drag a figure to duplicate it, or hold Shift while dragging its origin to move its pinned joints too.
- Press A while dragging a joint or figure to add frames without letting go.
- Right-drag to bend lines in Build and Animate.
- Choose whether pasted figures keep their original layering or appear in front in Canvas settings.
- Pinch with two fingers to zoom and pan the canvas on a touch screen.

### Changed

- A fresh look, with the StykAnimate typeface, brighter colors and matching panels, menus and dialogs.
- More room for your animation, with floating canvas tools and panels that adapt to smaller windows.
- The top bar keeps workspaces, Undo, Redo, Save and Export together and shows whether your project is saved.
- Redesigned timelines, with stretchable frame cards in Simple mode and clearer pose bars in Advanced mode.
- Redesigned motion paths, with multiple trails, speed colors and pose previews as you point along them.
- Easier 3D posing, with on-screen joint dragging, depth adjustment and IK for arms and legs.
- Drag along a line segment to pose it without having to grab its node precisely.
- A clearer Export window with live preview, trimming, size options and presets for popular video platforms.
- Simpler Properties and VFX panels, with common actions close to the selection and individual effect switches.
- A clearer Build workspace, with simpler part properties and a compact toolbar for splitting, duplicating, flipping and deleting parts.
- A cleaner Library panel with search, filters and larger previews.
- Easier-to-find settings and commands, with searchable Settings, grouped menus and shortcut hints.
- The app chooses a comfortable interface size for your screen, with manual adjustment in Settings.
- Short hints guide joining figures, placing images, drawing shapes and using the Tweener.
- A clearer What's new screen that matches the website.
- New projects start with Blue, a simple stick figure with hand and foot IK for easy posing.
- The small playback FPS counter is back, and the low-FPS warning has been removed.

### Fixed

- Fixed empty windows on Linux Wayland desktops.
- Fixed browser update notices being delayed after an export.
- Fixed selecting figures on the canvas while using the Tweener.
- Fixed patchy onion skins where parts of a figure overlap.
- Fixed Feedback sometimes opening on the wrong report type.
- Fixed the timeline and effect list jumping while selecting several frames.
- Selecting artwork no longer accidentally moves its figure.
- Fixed leaving Draw sometimes losing your previous layer and selection.
- Fixed errors appearing behind dialogs, and added confirmation before closing an active export.
- Fixed typing in a menu switching tools, and the Properties ⋯ menu not opening.
- Fixed What's new and the privacy prompt overlapping at startup.
- Fixed Enter not confirming a new project name.
- Fixed StykAnimate staying open in the background after an unexpected close.
- Fixed adding figures being refused in some Pivot animations.

### Performance

- Fewer pauses when first adding particle effects or opening their previews.
- Faster property adjustments in long animations and smoother editing in scenes with many images.
- 3D figures pose, scrub and play more smoothly, use less memory and save to smaller files.
- Older Pivot animations open faster, and large ones scrub and zoom more smoothly.
- Smoother playback and editing in busy scenes, especially on laptops and in Compatibility mode.

## [1.1.0]

Drawing layers and smoother editing

### Added

- Drawing layers: draw and animate by hand on their own layers, right alongside your figures.

### Changed

- Better drawing tablet support: pen taps no longer nudge joints, holding the pen still no longer opens the right-click menu, and you can zoom or rotate the view with the pen.
- Scaling and rotating several figures at once now works like in Pivot, around the figure you drag.
- Frame counts now match between the Simple timeline, the Advanced timeline and Export.
- More compact onion skin settings and a clearer audio timeline.
- Adding and editing effects in the VFX panel is easier.
- Property labels you can drag to change a value are now marked. Hold Shift or Alt for finer steps.

### Fixed

- If the app stops unexpectedly, it now offers to recover your work instead of leaving a black window.
- Fixed right-click bending on the canvas.
- Fixed joined figures coming apart when breaking apart or baking a movieclip.
- Fixed movieclip Scale, Angle, Opacity and Z-index fields in Properties having no effect.

### Performance

- Large animations open, play and edit faster and use less memory, especially freshly imported Pivot files.
- Posing detailed figures is smoother.
- Cancelling an import or export no longer delays the next one.

## [1.0.6]

Private feedback and playback quality options

### Added

- Send bug reports and feedback privately from the app or the website, with attachments and replies from the developer.
- Playback quality options in Animation settings, from Normal down to Draft, plus an Automatic mode.
- A setting to fit the view when playback starts, turned on by default.
- Press Ctrl+Shift+V to paste figures in their original position.

### Fixed

- Fixed importing Build changes as a new figure losing edits or changing the original figures.
- Fixed the selected effect being deselected when moving between frames with the keyboard.
- Fixed black bands and cut-off edges on scene effects in playback and exports.
- Imported sprites now keep their original colors and transparency.
- Transparent areas of the scene now show a checkerboard while editing.

### Performance

- Fewer pauses and less memory use in large and detailed animations.

## [1.0.5]

Effects with their own timing, and editing refinements

### Added

- Effects now have their own clips on the timeline, with timing, keyframes and fades separate from your poses.
- Copy and paste the look of parts in Build.

### Changed

- Duplicate and Flip in Build now respect whether you selected a single part or a whole branch. New S and B shortcuts split a part and switch branch mode.
- A Canvas setting to zoom with the scroll wheel alone, or with Ctrl + scroll as before.
- Comma and period now go to the previous and next frame, and Shift+comma and Shift+period jump between keyframes. Your custom shortcuts are kept.
- A new Extend keyframe shortcut, Shift+A by default.
- Effects now apply across connected figures.
- Pick colors from the canvas with the color picker's Eyedropper button. Clicking outside the picker now closes it.

### Fixed

- Fixed dragging empty timeline cells creating blank frames.
- Dragging keyframes onto other keyframes now replaces them.
- New lines in Build now take the color and thickness of the part they grow from.
- Fixed Pivot projects with damaged or missing images failing to import.
- Fixed figures with very long hidden parts looking blurry.
- Fixed empty edges showing around background images when the camera moves.

## [1.0.1]

A cleaner workspace

### Changed

- The figure color palette moved to a compact section at the bottom of Properties.
- Parallax settings only show for selected layers.
- A simpler welcome screen, with recent release notes in the same window.

## [1.0.0]

New animation tools, refined editing and smoother playback

### Added

- Audio: add sound to the timeline, with waveforms, trimming, splitting, volume and fades.
- Tweener tool with Breakdown, Blend to Neighbor, Push and Relax.
- Camera shake, handheld motion, wobble, impacts and zoom pulses.
- Editable motion paths.
- Connectors that link two points, with sliding joints and Smart Stretch.
- Join and unjoin figures with J, just like in Pivot. Showing handles moved to Shift+J.
- A redesigned Figure builder: what you select is what you edit, with new tools to go with it.
- A color palette for the selected figure that lets you replace colors in bulk.
- An eyedropper with a magnified preview to pick colors from the canvas.
- Canvas grid and guides.
- Layer parallax.
- Animated strength and wavy distortion for effects.
- Alt-drag to rotate and scale every selected figure together.
- An interface size slider in the desktop app, from 75% to 200%.
- Refined timelines, with a quick mode switch, layer search and colors, easing controls and new onion skin controls.

### Changed

- A refined Properties panel and simpler canvas controls.
- Zoom now goes from 0.1% to 10,000%.
- Redesigned movieclip properties. Pasting onto an existing movieclip now creates an independent copy.
- A better asset library, with animated previews, right-click actions and drag-and-drop into folders.
- Figure outlines are now set up in the VFX panel, and rounded outlines look smoother.

### Fixed

- Fixed freezes lasting several seconds when editing, copying, pasting or dragging in busy scenes.
- Fixed Flip ignoring the selected parts and branches.
- Fixed Simple timeline thumbnails.
- Fixed Add Frame in the Advanced timeline adding the key on the wrong frame.
- Figures keep their colors when copied between projects or Pivot versions.
- Double-clicking a StykAnimate, Pivot or Stick Nodes file now opens it in the app.
- The app now recovers when the graphics driver resets, and exports keep going.

### Performance

- Faster playback, scrubbing and editing, especially in busy scenes and on older computers.
- Faster camera playback, high-resolution exports, and saving and opening projects.
- Large exports and big images use much less memory.
- Creating movieclips is faster.
- Lower resource use when the app is idle.

## [0.5.6]

Effects, dark mode and smoother animation

### Added

- Visual effects for joints, figures, movieclips and the camera, with 16 effects, gradients and presets.
- Dark mode, which follows your system setting by default.
- Add a movieclip to several upcoming keyframes at once.

### Changed

- Selected joints and branches are highlighted in a lighter red.
- The view fits the scene when playback starts, and you can still zoom and pan while playing.
- The camera frame stays visible as a subtle dotted outline.
- The app and new projects start with one frame starring Jonh Styk.
- Simpler export options, with automatic video quality and a progress counter.

### Fixed

- Fixed playback slowing down badly after running low on memory.
- Fixed the canvas going blank after a graphics reset or when replaying after edits.
- Fixed arranging figures from the toolbar for single-part figures and selected branches.
- Advanced timeline: dragging now selects keys, clicking keeps your selection, and deleting keys no longer shifts later frames.
- More reliable Pivot imports.
- Various other bug fixes.

### Performance

- Smoother playback and editing, and faster high-resolution exports.

## [0.5.5]

Welcome to the first beta of StykAnimate!

### Added

- Have fun! Share bug reports and ideas on Discord, or from Help → Send feedback in the app.
