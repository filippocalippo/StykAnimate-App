import {syncDerived} from './pivot/model.mjs';

// Update existing display aliases without changing the decoded record shape.
// Authoritative writer fields and all unknown data remain in the document.
export function synchronizeExistingDerived(report) {
  const absent = [], nestedAbsent = [];
  const remember = (record, keys) => {
    for (const key of keys) if (!Object.hasOwn(record, key)) absent.push([record, key]);
  };
  remember(report, ['auto_easing_disabled_raw', 'total_output_frames', 'duration_seconds']);
  for (const figure of report.figure_types || []) {
    remember(figure, ['segment_count']);
    for (const segment of figure.segments || []) {
      remember(segment, ['flags', 'is_static', 'flag_bits', 'segment_kind', 'segment_type', 'visible']);
      // syncDerived replaces flag_bits, so cleanup must resolve its new owner.
      if (segment.flag_bits && !Object.hasOwn(segment.flag_bits, 'is_static')) nestedAbsent.push(segment);
    }
  }
  for (const frame of report.keyframes || []) {
    remember(frame, ['inbetweens', 'hidden', 'duration_frames']);
    for (const object of frame.objects || []) remember(object,
      ['color_override_rgb', 'color_override_mix', 'transparency', 'opacity']);
  }
  syncDerived(report);
  for (const [record, key] of absent) delete record[key];
  for (const segment of nestedAbsent) delete segment.flag_bits.is_static;
}
