/** Stable source-pose identities shared by the editor and composition workers. */
const indices = new WeakMap();
export function invalidateFrameIndex(report) { indices.delete(report); }
function indexFor(report) {
  let index = indices.get(report);
  if (!index || index.frames !== report.keyframes || index.length !== report.keyframes.length) {
    index = {frames: report.keyframes, length: report.keyframes.length, byId: new Map()};
    report.keyframes.forEach((frame, position) => { const id = frame._styk?.frameId; if (id) index.byId.set(id, position); });
    indices.set(report, index);
  }
  return index.byId;
}
export function frameIndexForId(report, id) {
  const position = indexFor(report).get(id);
  if (position === undefined) return -1;
  if (report.keyframes[position]?._styk?.frameId === id) return position;
  invalidateFrameIndex(report); return indexFor(report).get(id) ?? -1;
}
export function getFrameById(report, id) {
  const position = frameIndexForId(report, id);
  const sources = report._styk?.frameSources;
  return position >= 0 ? report.keyframes[position] : sources && Object.prototype.hasOwnProperty.call(sources, id) ? sources[id] : null;
}
