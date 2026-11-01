import { figureRows } from './figure-types.mjs';
import { complexityBucket, formatFamily, fpsBucket, sizeBucket } from './telemetry-schema.mjs';

// An authored-segment estimate for the first keyframe, not raster complexity or a scan of the animation.
// Unknown is preferable to an extra large document traversal on the UI thread.
export function documentComplexity(report) {
  const figures = report?.figure_types, objects = report?.keyframes?.[0]?.objects;
  if (!Array.isArray(figures) || !Array.isArray(objects) || figures.length > 1024 || objects.length > 1024) return 'unknown';
  const rows = figureRows(figures);
  if (rows.some(row => row.segments === null)) return 'unknown';
  const sizes = new Map(rows.map(row => [row.id, row.segments]));
  let total = 0;
  for (const object of objects) {
    if (!object) return 'unknown';
    const count = sizes.get(object.figure_type_id);
    if (!Number.isFinite(count)) return 'unknown';
    total += count;
    if (total >= 10000) break;
  }
  return complexityBucket(total);
}
export function workload({ format, bytes, report, fps } = {}) {
  if (fps === undefined) fps = report?.frame_delay_ms > 0 ? 1000 / report.frame_delay_ms : report?.fps;
  return { format: formatFamily(format), size: sizeBucket(bytes), complexity: documentComplexity(report), fps: fpsBucket(fps) };
}
