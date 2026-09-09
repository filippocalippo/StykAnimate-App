/** A reusable native figure retains its displayed pose and exact style overlays. */
import {evaluatedFrame, timeline, buildGeometry} from './pivot/geometry.mjs';
import {createFrame} from './demo.mjs';

export function nativeFigureDocument(report, {figureTypeId, figureUid, tick = 0} = {}) {
  const rows = timeline(report);
  let index = 0;
  while (index + 1 < rows.length && rows[index + 1].start <= tick) index++;
  const row = rows[index];
  const frame = evaluatedFrame(report, index, row.count ? Math.max(0, Math.min(1, (tick - row.start) / row.count)) : 0, tick);
  const source = frame.objects.find(object => figureUid == null ? object.figure_type_id === figureTypeId : object.unique_id === figureUid);
  const figure = report.figure_types.find(figure => figure.figure_type_id === source?.figure_type_id);
  if (!source || !figure) throw new Error('Select a figure to save as .stkz.');
  const object = {...source, object_slot: 0, join: null};
  if (source._stykIK || source.join) {
    const geometry = buildGeometry(report, frame).objects.get(source.object_slot);
    object.root_x = geometry.root.x; object.root_y = geometry.root.y;
    if (geometry.solvedAngles) object.angles = geometry.solvedAngles.slice();
    // Keep unstretched source lengths with editable controllers. Runtime IK
    // reproduces their displayed stretch without turning it into a new rest pose.
  }
  delete object.runtime_segments;
  return {
    version: report.version, canvas_width: report.canvas_width, canvas_height: report.canvas_height,
    fps: report.fps, auto_easing: false, auto_easing_disabled_raw: 1,
    figure_types: [figure], backgrounds: [], keyframes: [createFrame([object], 1)],
    _styk: {format: 'StykAnimate', format_version: 1, name: figure.name || 'Figure'},
  };
}
