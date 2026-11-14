/**
 * English strings of the inspector kit's own words (src/inspector-kit.mjs):
 * scrub tips and hints, the Mixed value, the step buttons' names, the scope
 * line's Stop and unit names in accessible names. Section titles and control
 * labels come from the context descriptors, which are translated where they
 * are built; add a key here only for text the kit writes itself.
 *
 * en.mjs spreads this fragment once the kit is wired into the app (the
 * Integrator composes it, architecture.md §3.16); until then the kit falls
 * back to these texts itself.
 */
export default Object.freeze({
  'inspector.scrubTip': 'Drag to adjust · Shift: fine · Alt: extra fine',
  'inspector.scrubLabel': 'Scrub {name}',
  'inspector.scrubHint': 'Drag a label to scrub · Shift ×0.1 · Alt ×0.01 · Ctrl ×10',
  'inspector.mixed': 'Mixed',
  'inspector.decrease': 'Decrease {name}',
  'inspector.increase': 'Increase {name}',
  // A field's accessible name with its unit: "X (px)", "Angle (degrees)".
  'inspector.withUnit': '{label} ({unit})',
  'inspector.unit.degrees': 'degrees',
  'inspector.stop': 'Stop',
  'inspector.actions': 'Actions',
});
