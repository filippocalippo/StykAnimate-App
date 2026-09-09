const epoch = () => performance.timeOrigin + performance.now();
let document, originalMetrics;
const chunkAcks = new Map();
const jsonBytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
function audit(report) {
  const fields = { top: {}, figure: {}, segment: {}, frame: {}, object: {}, runtime: {} };
  const accumulate = (scope, item) => { for (const [key, value] of Object.entries(item)) fields[scope][key] = (fields[scope][key] || 0) + jsonBytes(value); };
  accumulate('top', report);
  let figures = 0, segments = 0, objects = 0, runtimeSegments = 0, runtimeOverrides = 0, runtimeOverrideFields = {};
  const types = new Map(report.figure_types.map(figure => [figure.figure_type_id, figure]));
  for (const figure of report.figure_types) { figures++; accumulate('figure', figure); for (const segment of figure.segments) { segments++; accumulate('segment', segment); } }
  for (const frame of report.keyframes) {
    accumulate('frame', frame);
    for (const object of frame.objects) {
      objects++; accumulate('object', object); const figure = types.get(object.figure_type_id);
      for (const [i, runtime] of (object.runtime_segments || []).entries()) {
        runtimeSegments++; accumulate('runtime', runtime);
        const segment = figure?.segments[i];
        for (const [field, actual, fallback] of [
          ['angle_rad', object.angles?.[i] ?? runtime.angle_rad ?? segment?.angle_rad ?? 0, object.angles?.[i] ?? segment?.angle_rad ?? 0],
          ['bend_rad', object.bend_flag ? object.bends?.[i] ?? 0 : runtime.bend_rad ?? segment?.bend_rad ?? 0, object.bend_flag ? object.bends?.[i] ?? 0 : segment?.bend_rad ?? 0],
          ['length', object.len_flag ? object.lengths?.[i] ?? segment?.length : runtime.length ?? segment?.length ?? 0, object.len_flag ? object.lengths?.[i] ?? segment?.length : segment?.length ?? 0],
        ]) if (actual !== fallback) { runtimeOverrides++; runtimeOverrideFields[field] = (runtimeOverrideFields[field] || 0) + 1; }
      }
    }
  }
  for (const scope of Object.keys(fields)) fields[scope] = Object.fromEntries(Object.entries(fields[scope]).sort((a, b) => b[1] - a[1]).slice(0, 20));
  return { documentBytes: jsonBytes(report), figures, segments, objects, runtimeSegments, runtimeOverrides, runtimeOverrideFields, fields };
}
self.onmessage = async ({ data }) => {
  if (data.type === 'ack') { chunkAcks.get(data.index)?.(); chunkAcks.delete(data.index); }
  else if (data.type === 'load') {
    const response = await fetch('/api/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: data.path }) });
    if (!response.ok) throw new Error(await response.text());
    const text = await response.text(), parseStart = performance.now(); const result = JSON.parse(text);
    document = result.document; const parseMs = performance.now() - parseStart;
    originalMetrics = { parseMs, responseBytes: new TextEncoder().encode(text).byteLength, audit: audit(document) };
    self.postMessage({ type: 'ready', metrics: originalMetrics });
  } else if (data.type === 'send-chunked') {
    const postedEpoch = epoch(), started = performance.now(); let index = 0, senderSerializeMs = 0;
    const send = async chunk => {
      const current = index++, before = performance.now();
      const ack = new Promise(resolve => chunkAcks.set(current, resolve));
      self.postMessage({ type: 'chunk', index: current, chunk }); senderSerializeMs += performance.now() - before;
      await ack;
    };
    const { figure_types, keyframes, backgrounds, ...header } = document;
    await send({ header });
    for (const [table, items] of Object.entries({ figure_types, keyframes, backgrounds })) {
      let values = [], weight = 0;
      for (const item of items || []) {
        const count = item.segments?.length ?? item.objects?.length ?? 1;
        if (values.length && weight + count > 1000) { await send({ table, values }); values = []; weight = 0; }
        values.push(item); weight += count;
      }
      if (values.length) await send({ table, values });
    }
    self.postMessage({ type: 'chunk-end', postedEpoch, totalMs: performance.now() - started, senderSerializeMs, chunks: index });
  } else if (data.type === 'send') {
    let report = document;
    if (data.compact) {
      report = structuredClone(document);
      for (const frame of report.keyframes) for (const object of frame.objects) delete object.runtime_segments;
    }
    const postedEpoch = epoch(), before = performance.now();
    self.postMessage({ type: 'document', document: report, postedEpoch, compact: data.compact });
    self.postMessage({ type: 'sent', senderSerializeMs: performance.now() - before, compact: data.compact });
  }
};
