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
  {name: 'camera', fixture: 'startup', select: [1, -1], state: {inspectorContext: 'camera'}},
  {name: 'layer', fixture: 'startup', select: [1, -1], state: {inspectorContext: 'layer'}},
  {name: 'frame', fixture: 'startup', select: [1, -1], state: {inspectorTab: 'animation'}},
];
export const SCREENS = CONTEXTS.flatMap(context => ['light', 'dark'].map(theme => ({
  ...context, ...SIZE, theme, id: `inspector-${context.name}${theme === 'dark' ? '-dark' : ''}`,
})));
/** The fixture as the screen shows it. */
export function document(report, screen) {
  if (screen.primitive !== undefined) for (const figure of report.figure_types) for (const segment of figure.segments) segment.primitive_code = screen.primitive;
  return report;
}
