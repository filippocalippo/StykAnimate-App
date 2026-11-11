# Camera controls

Camera and Scene are always listed above the figure layers, with a blue camera icon and a purple clapperboard icon. Select Camera to show its gizmos; choosing Scene or a figure layer hides them. Ctrl+K selects Camera or toggles its controls when already selected. The blue frame shows the shot in document space. Drag its center to move, any corner to scale around the center, and the top circular grip to rotate. The hit targets remain 24 screen pixels across at every canvas zoom. Hovering a grip shows its current value and cursor.

Hold Ctrl while starting a move to lock its first dominant axis. Hold Shift during scaling to snap to 10% increments, or during rotation to snap to 15°. Arrow keys over a grip adjust position by one screen pixel, rotation by 1°, or scale by 1%. Escape cancels a gesture; release commits one undo step.

The Camera inspector includes a live output monitor, composition-guide toggle, Level and Reset. Numeric fields preview while typing or scrubbing; Enter commits and Escape restores the original value. The output monitor also follows timeline scrubbing and playback, independently of canvas pan and zoom. Scale is the size of the camera frame; its inverse is shown as zoom in the monitor.

The Transform tab contains these pose tools. The Motion tab adds Follow, which keeps figures in frame, and timed additive Shake, Handheld, Wobble, Impact punch and Zoom pulse clips. User layers have a Parallax section with linked axis responses and a separate camera-pan preview. See [camera motion and parallax](camera-motion.md) for editing, baking, saved data and rendering contracts.

The monitor draws the frame the stage shows again through the scene camera, on the stage's device with a renderer of its own: during playback the already-prepared frame, sharing device buffers instead of re-evaluating the scene; while editing or scrubbing the displayed pose. Where the stage runs on WebGL2 the preview worker draws it on the CPU. The monitor draws only while the Camera inspector is open and lowers its working resolution during interaction and playback; there is no fixed frame-rate guarantee.
