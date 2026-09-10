/** A reusable native figure retains its displayed pose and exact style overlays. */
import {evaluatedFrame, timeline, buildGeometry} from './pivot/geometry.mjs';
import {createFrame} from './demo.mjs';
import {frameOrder, setOrder} from './pivot/structure.mjs';

export function nativeFigureDocument(report, {figureTypeId, figureUid, figureUids, tick = 0, sourceFrame} = {}) {
  const rows = timeline(report);
  let index = 0;
  while (index + 1 < rows.length && rows[index + 1].start <= tick) index++;
  const row = rows[index];
  const frame = sourceFrame ?? evaluatedFrame(report, index, row.count ? Math.max(0, Math.min(1, (tick - row.start) / row.count)) : 0, tick);
  if (figureUids?.length) {
    const selected = new Set(figureUids), sources = frame.objects.filter(o => selected.has(o.unique_id));
    if (!sources.length) throw new Error('Select figures to save to the library.');
    const slots = new Map(sources.map((o, i) => [o.object_slot, i])), geometry = buildGeometry(report, frame);
    const figures = report.figure_types.filter(f => sources.some(o => o.figure_type_id === f.figure_type_id));
    const objects = sources.map((source, i) => {
      const object = {...source, object_slot: i};
      delete object.runtime_segments; delete object._movieclipSample;
      if (source.join && slots.has(source.join.target_object_slot)) object.join = {...source.join, target_object_slot: slots.get(source.join.target_object_slot)};
      else {
        object.join = null;
        if (source.join || source._stykIK) {
          const solved = geometry.objects.get(source.object_slot);
          object.root_x = solved.root.x; object.root_y = solved.root.y;
          if (solved.solvedAngles) object.angles = solved.solvedAngles.slice();
        }
      }
      const clip = figures.find(f => f.figure_type_id === object.figure_type_id)?._styk?.movieclip;
      if (clip) object._stykMovieclip = {start:0,end:Math.max(1,Math.ceil(clip.duration*report.fps/clip.document.fps)),offset:0,speed:1,mode:'loop'};
      return object;
    });
    const savedFrame = createFrame(objects, 1); setOrder(savedFrame, frameOrder(frame).filter(id => selected.has(id)));
    return {version: report.version, canvas_width: report.canvas_width, canvas_height: report.canvas_height, fps: report.fps,
      auto_easing: false, auto_easing_disabled_raw: 1, figure_types: figures, backgrounds: [], keyframes: [savedFrame],
      _styk: {format:'StykAnimate', format_version:1, name: sources.length === 1 ? figures[0].name || 'Figure' : 'Figure set', libraryKind: sources.length > 1 ? 'set' : figures[0]._styk?.movieclip ? 'movieclip' : 'figure'}};
  }
  const source = frame.objects.find(object => figureUid == null ? object.figure_type_id === figureTypeId : object.unique_id === figureUid);
  const figure = report.figure_types.find(figure => figure.figure_type_id === source?.figure_type_id);
  if (!source || !figure) throw new Error('Select a figure or movieclip to export.');
  const object = {...source, object_slot: 0, join: null};
  if (source._stykIK || source.join) {
    const geometry = buildGeometry(report, frame).objects.get(source.object_slot);
    object.root_x = geometry.root.x; object.root_y = geometry.root.y;
    if (geometry.solvedAngles) object.angles = geometry.solvedAngles.slice();
    // Keep unstretched source lengths with editable controllers. Runtime IK
    // reproduces their displayed stretch without turning it into a new rest pose.
  }
  delete object.runtime_segments;
  delete object._movieclipSample;
  if (figure._styk?.movieclip) object._stykMovieclip = {start:0,end:Math.max(1,Math.ceil(figure._styk.movieclip.duration*report.fps/figure._styk.movieclip.document.fps)),offset:0,speed:1,mode:'loop'};
  return {
    version: report.version, canvas_width: report.canvas_width, canvas_height: report.canvas_height,
    fps: report.fps, auto_easing: false, auto_easing_disabled_raw: 1,
    figure_types: [figure], backgrounds: [], keyframes: [createFrame([object], 1)],
    _styk: {format: 'StykAnimate', format_version: 1, name: figure.name || 'Figure'},
  };
}
