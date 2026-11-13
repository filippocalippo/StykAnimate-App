/**
 * The canvas: moving around the scene without changing it.
 */

export const pan = {
  id: 'canvas.pan', area: 'canvas', title: 'Pan the canvas', kind: 'gesture',
  description: 'Drags with the middle button round a circle for 1.5 s. Nothing in the document changes: each frame is the same scene drawn at a new place.',
  async run(context) {
    const {centre, height} = await context.stage();
    const radius = Math.min(160, height / 4);
    // The circle starts at its right: begin there, so the pass ends with the view where it was.
    await context.input.stroke(context.paths.circle({x: centre.x - radius, y: centre.y}, radius), {durationMs: 1500, button: 'middle'});
  },
};

export const zoom = {
  id: 'canvas.zoom', area: 'canvas', title: 'Zoom the canvas', kind: 'gesture',
  description: 'Turns the wheel with Ctrl held at the middle of the stage: in for 0.75 s, back out for 0.75 s.',
  async run(context) {
    const {centre} = await context.stage();
    await context.input.wheel(centre.x, centre.y, {notches: 36, durationMs: 1500, ctrl: true, deltaY: notch => (notch < 18 ? -100 : 100)});
  },
};

export const hover = {
  id: 'canvas.hover', area: 'canvas', title: 'Move the pointer over the scene', kind: 'gesture',
  description: 'Moves the pointer across the figures with no button held for 1.5 s: the app finds what is under the pointer and highlights it.',
  async run(context) {
    const {centre, width, height} = await context.stage();
    await context.input.stroke(context.paths.circle({x: centre.x - width / 4, y: centre.y}, Math.min(width, height) / 4), {durationMs: 1500, button: null});
  },
};

export default [pan, zoom, hover];
