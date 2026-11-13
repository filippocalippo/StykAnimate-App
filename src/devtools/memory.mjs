/**
 * The page's memory by owner (docs/DEVTOOLS.md "Memory by owner"): who holds the renderer process's private bytes, and
 * what is left unexplained. Developer build only; pure, so the panel, the control channel's `memory`, the profiling
 * runner's checkpoints (perf/lib/run.mjs) and the report (perf/report/) all split the memory the same way.
 *
 * The parts of the page's process:
 *   engine memory        the engine's WebAssembly memory, all of it: what it grew to is committed and never given back
 *                        (docs/engine/memory.md "The high-water mark");
 *   JavaScript heap      the interface thread's V8 heap as committed (`totalBytes`; what is in use is under it);
 *   array buffers        typed arrays the interface thread holds outside its heap, by the owners that registered
 *                        them (src/trace.mjs `traceMemory`), and the rest when the thread's total is known;
 *   pictures             canvases and image bitmaps kept in this process (`where: 'page'`, kind `pixels`);
 *   workers              each worker's heap and array buffers (the codec's and the drawing workers' WebAssembly memory
 *                        among them), when an inspector can read them (the runner) or the browser measured them;
 *   unexplained          the process's private bytes less all of the above: the browser's own (style, layout, fonts,
 *                        compiled code, its allocators), and whatever no owner names.
 * Owners kept in the graphics process (the stage's canvas, accelerated 2D canvases) are listed apart, not subtracted.
 */

/** An owner's kind: array buffers of the interface thread, or pixels the browser keeps for a canvas or a bitmap. */
export const KINDS = Object.freeze({buffers: 'array buffers', pixels: 'pictures'});

const finite = value => (Number.isFinite(value) ? value : null);
const sum = (rows, key = 'bytes') => rows.reduce((total, row) => total + (Number.isFinite(row[key]) ? row[key] : 0), 0);

/**
 * The threads an inspector read (`Runtime.getHeapUsage` of each target), with the engine's shared memory taken out:
 * every thread that joined the engine reports it among its array buffers. `threads` is [{thread, usedBytes, totalBytes,
 * backingBytes}]; `sharedBytes` the engine memory's size. A thread's `buffersBytes` is what it holds of its own.
 */
export function ownBuffers(threads, sharedBytes) {
  return threads.map(row => {
    const backing = finite(row.backingBytes);
    const shared = backing !== null && Number.isFinite(sharedBytes) && sharedBytes > 0 && backing >= sharedBytes;
    return {...row, sharedEngine: shared, buffersBytes: backing === null ? null : shared ? backing - sharedBytes : backing};
  });
}

/** Workers by name, added up: [{name, count, heapBytes, buffersBytes, bytes}], heaviest first. */
export function workerGroups(threads) {
  const groups = new Map();
  for (const row of threads) {
    const name = row.name || row.thread || 'worker';
    const group = groups.get(name) ?? {name, count: 0, heapBytes: 0, usedBytes: 0, buffersBytes: 0, bytes: 0};
    group.count++;
    group.heapBytes += row.totalBytes ?? 0; group.usedBytes += row.usedBytes ?? 0; group.buffersBytes += row.buffersBytes ?? 0;
    group.bytes = group.heapBytes + group.buffersBytes;
    groups.set(name, group);
  }
  return [...groups.values()].sort((a, b) => b.bytes - a.bytes);
}

/**
 * The page's process split by owner. Every input may be missing; a part that cannot be known is left out and said in
 * `missing`, and `unexplainedBytes` is null without the process's own count.
 *
 *   processBytes      the page's private bytes (the desktop's process metrics), or null;
 *   engine            `engine.memory()` ({heapBytes, liveBytes, frameCacheBytes, imagesReadyBytes, ...}), or null;
 *   engineMemoryBytes the engine memory's size as the page sees it (its buffer's length), when `engine` has no heap;
 *   jsHeap            the interface thread's {usedBytes, totalBytes};
 *   threads           what an inspector read of every thread: [{thread, name, interface: bool, usedBytes, totalBytes, backingBytes}];
 *   workers           what the browser measured of the workers' heaps when no inspector could (`measureUserAgentSpecificMemory`): [{name, bytes}];
 *   owners            the registered owners (the early script's `memory.read()`): [{owner, bytes, count, where, kind}].
 *
 * Returns {processBytes, parts: [{part, bytes, rows?}], graphics: [...owners], explainedBytes, unexplainedBytes, missing}.
 */
export function breakdown({processBytes = null, engine = null, engineMemoryBytes = null, jsHeap = null, threads = null, workers = null, owners = []} = {}) {
  const parts = [], missing = [];
  const engineBytes = finite(engine?.heapBytes) ?? finite(engineMemoryBytes);
  if (engineBytes !== null) {
    const live = finite(engine?.liveBytes);
    parts.push({part: 'engine memory', bytes: engineBytes, rows: [
      {name: 'in use', bytes: live},
      {name: 'of which the frame cache', bytes: finite(engine?.frameCacheBytes) ?? null},
      {name: 'of which pictures waiting for the stage', bytes: finite(engine?.imagesReadyBytes) ?? null},
      {name: 'free: reserved by earlier work, kept', bytes: live === null ? null : engineBytes - live},
    ].filter(row => row.bytes !== null && row.bytes >= 0)});
  } else missing.push('engine memory');

  const measured = threads?.length ? ownBuffers(threads, engineBytes) : null;
  const main = measured?.find(row => row.interface) ?? null;
  const heap = finite(main?.totalBytes) ?? finite(jsHeap?.totalBytes);
  if (heap !== null) parts.push({part: 'JavaScript heap', bytes: heap, rows: [{name: 'in use', bytes: finite(main?.usedBytes) ?? finite(jsHeap?.usedBytes)}].filter(row => row.bytes !== null)});
  else missing.push('JavaScript heap');

  const page = owners.filter(row => (row.where ?? 'page') === 'page');
  const buffers = page.filter(row => (row.kind ?? 'buffers') === 'buffers'), pixels = page.filter(row => row.kind === 'pixels');
  const named = buffers.map(row => ({name: row.owner, bytes: row.bytes, count: row.count}));
  const ownBytes = finite(main?.buffersBytes);
  if (ownBytes !== null) {
    // The thread's own total is known: the owners are a part of it, and the rest is said as such.
    const rest = ownBytes - sum(named);
    parts.push({part: 'array buffers', bytes: Math.max(ownBytes, sum(named)), rows: [...named, ...(rest > 0 ? [{name: 'not named by an owner', bytes: rest}] : [])]});
  } else if (named.length) parts.push({part: 'array buffers', bytes: sum(named), rows: named});
  if (pixels.length) parts.push({part: 'pictures', bytes: sum(pixels), rows: pixels.map(row => ({name: row.owner, bytes: row.bytes, count: row.count}))});

  const others = measured?.filter(row => !row.interface) ?? [];
  if (others.length) {
    const groups = workerGroups(others);
    parts.push({part: 'workers', bytes: sum(groups), rows: groups.map(group => ({name: group.name, bytes: group.bytes, count: group.count, heapBytes: group.heapBytes, buffersBytes: group.buffersBytes}))});
  } else if (workers?.length) {
    parts.push({part: 'workers', bytes: sum(workers), rows: workers.map(row => ({name: row.name, bytes: row.bytes, count: row.count ?? 1}))});
  } else missing.push('workers');

  const explainedBytes = sum(parts);
  const known = finite(processBytes);
  return {processBytes: known, parts, graphics: owners.filter(row => row.where === 'graphics').map(row => ({name: row.owner, bytes: row.bytes, count: row.count})),
    explainedBytes, unexplainedBytes: known === null ? null : known - explainedBytes, missing};
}

/** A breakdown in megabytes, one decimal, for checkpoints and reports: {part: MB} plus `unexplained` and `process`. */
export function breakdownMegabytes(split) {
  const mb = bytes => (Number.isFinite(bytes) ? Math.round(bytes / 1048576 * 10) / 10 : null);
  const parts = Object.fromEntries(split.parts.map(part => [part.part, mb(part.bytes)]));
  return {process: mb(split.processBytes), ...parts, unexplained: mb(split.unexplainedBytes),
    rows: Object.fromEntries(split.parts.map(part => [part.part, (part.rows ?? []).map(row => ({name: row.name, mb: mb(row.bytes), ...(row.count ? {count: row.count} : {})}))])),
    graphics: split.graphics.map(row => ({name: row.name, mb: mb(row.bytes), count: row.count}))};
}
