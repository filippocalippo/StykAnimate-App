// The Properties panel's catalogue screens: which fixture, which selection and which context each shows. The native
// screens (styk_core::screens::inspector) open the same documents the same way; keep the two lists equal.
const SIZE = {width: 320, height: 502};
const CONTEXTS = [
  {name: 'scene', fixture: 'startup', select: [null, -1]},
  {name: 'figure', fixture: 'startup', select: [1, -1]},
  {name: 'joint', fixture: 'startup', select: [1, 1]},
  {name: 'figures', fixture: 'property-sheet', many: [1, 2, 3]},
  // The startup document with every segment a text segment (primitive 5).
  {name: 'text', fixture: 'startup', select: [1, -1], primitive: 5},
  {name: 'image', fixture: 'sprite-segment-sparse-native', select: [3, -1]},
  // Entered after the selection, the way a person does (a selection change resets the context): the camera's row, the
  // layer's row, a key on the timeline.
  {name: 'camera', fixture: 'startup', select: [1, -1], enter: 'camera'},
  {name: 'layer', fixture: 'startup', select: [1, -1], enter: 'layer'},
  {name: 'frame', fixture: 'startup', select: [1, -1], enter: 'frame'},
];
export const SCREENS = CONTEXTS.flatMap(context => ['light', 'dark'].map(theme => ({
  ...context, ...SIZE, theme, id: `inspector-${context.name}${theme === 'dark' ? '-dark' : ''}`,
})));
/** Enters a screen's context in today's page (runs in the page): the camera's track, the active layer's track, or the
 * timeline's keys changing, which shows the frame's animation (timeline-host.mjs `onKeysChange`). */
export function enter(kind) {
  const styk = window.styk;
  if (kind === 'camera') styk.actions['toggle-camera']();
  else if (kind === 'layer') styk.timeline.onTrackSelect(styk.timeline.trackById.get(styk.editor.activeLayerId));
  else if (kind === 'frame') styk.timeline.onKeysChange();
}

/** The fixture as the screen shows it. */
export function document(report, screen) {
  if (screen.primitive !== undefined) for (const figure of report.figure_types) for (const segment of figure.segments) segment.primitive_code = screen.primitive;
  return report;
}
