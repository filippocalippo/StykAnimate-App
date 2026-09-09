/** The large native tables stay in the worker while editable render metadata changes. */
const retained = new Set(['keyframes', 'figure_types', 'backgrounds', '_stykSource']);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const sourceId = id => typeof id === 'string' && /^[a-z][a-z0-9-]{0,127}$/.test(id);
export function playbackProperties(report) {
  const properties = {};
  for (const key of Object.keys(report)) if (!retained.has(key)) {
    if (key === '_styk' && report._styk) {
      const {frameSources, ...metadata} = report._styk; properties._styk = metadata;
    } else properties[key] = report[key];
  }
  return properties;
}

/** Validate the entire incoming transaction before replacing any live mirror field. */
export function applyPlaybackPatch(report, patch) {
  if (!patch?.properties || typeof patch.properties !== 'object' || Array.isArray(patch.properties) ||
    Object.keys(patch.properties).some(key => retained.has(key)) || own(patch.properties._styk || {}, 'frameSources') ||
    !Array.isArray(patch.frames) || !Array.isArray(patch.sources) || typeof patch.hasFrameSources !== 'boolean')
    throw new Error('Invalid playback document patch.');
  const frameIndices = new Set(), sourceIds = new Set();
  for (const entry of patch.frames) {
    if (!Number.isInteger(entry.index) || entry.index < 0 || entry.index >= report.keyframes.length || frameIndices.has(entry.index) || !Array.isArray(entry.frame?.objects))
      throw new Error('Playback frame update targets are invalid.');
    frameIndices.add(entry.index);
  }
  for (const entry of patch.sources) {
    if (!sourceId(entry.id) || sourceIds.has(entry.id) ||
      (entry.frame !== null && (!patch.hasFrameSources || !Array.isArray(entry.frame?.objects) || entry.frame._styk?.frameId !== entry.id)))
      throw new Error('Playback retained-source update targets are invalid.');
    sourceIds.add(entry.id);
  }
  if (patch.hasFrameSources && (!patch.properties._styk || typeof patch.properties._styk !== 'object'))
    throw new Error('Playback retained sources require document metadata.');
  const sources = report._styk?.frameSources || {};
  for (const entry of patch.sources) { if (entry.frame === null) delete sources[entry.id]; else sources[entry.id] = entry.frame; }
  for (const key of Object.keys(report)) if (!retained.has(key) && !own(patch.properties, key)) delete report[key];
  for (const [key, value] of Object.entries(patch.properties)) Object.defineProperty(report, key, {value, enumerable: true, configurable: true, writable: true});
  if (patch.hasFrameSources) report._styk.frameSources = sources;
  for (const entry of patch.frames) report.keyframes[entry.index] = entry.frame;
  return report;
}
