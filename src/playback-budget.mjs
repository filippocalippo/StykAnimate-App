/** Best available device-RAM hint in gigabytes. The desktop preload exposes
 * real system memory; browsers only report the privacy-bucketed
 * navigator.deviceMemory tier (8 GB maximum), which understates large hosts. */
export function deviceMemoryHint(environment = globalThis) {
  const bytes = environment.stykDesktop?.memoryBytes;
  return Number.isFinite(bytes) && bytes > 0 ? bytes / 1073741824 : environment.navigator?.deviceMemory;
}

/** Resident bytes per CPU/GPU cache. Keep the conservative legacy budget when
 * the runtime has no memory hint. Cap each cache at 1/16 of the reported RAM
 * tier and 1 GiB; explicit constructor budgets always take precedence.
 * Packet sharing makes this a working-set budget, not a per-frame multiplier. */
export function playbackMemoryBudget(deviceMemory=deviceMemoryHint()){
  const mib=1024*1024;
  return typeof deviceMemory==='number'&&Number.isFinite(deviceMemory)&&deviceMemory>0
    ? Math.max(32,Math.min(1024,deviceMemory*64))*mib : 128*mib;
}

/** Free GPU allocations retained for reuse after a frame/batch releases them.
 * Active frame textures remain accounted by gpuFrames; active raster scratch
 * may temporarily exceed these retention targets for one bounded batch. */
export function playbackReuseMemoryPlan(frameBytes=playbackMemoryBudget()) {
  const mib=1024*1024;
  return {gpuRecycled:Math.min(128*mib,frameBytes/4),gpuMsaa:Math.min(64*mib,frameBytes/8),gpuScratch:Math.min(16*mib,frameBytes/16)};
}

/** Partition retained pixel caches from one hardware policy. These are app-owned
 * cache targets, not a claim about total process RAM (document data, decoding
 * internals, output canvases and transient GPU uploads also consume memory). */
export function previewMemoryPlan(deviceMemory = deviceMemoryHint(), workerCount = playbackWorkerCount(undefined, deviceMemory)) {
  const base = playbackMemoryBudget(deviceMemory), mib = 1024 * 1024;
  const workers = playbackWorkerMemoryPlan(base), count = Math.max(1, Math.min(4, Math.floor(workerCount) || 1));
  const plan = {cpuFrames: base, gpuFrames: base, editorImages: Math.min(64 * mib, base / 4),
    editorRasters: Math.min(128 * mib, base / 2), editorOnions: Math.min(64 * mib, base / 8),
    editorSoftwareFilters: Math.min(64 * mib, base / 4),
    editorBackgrounds: Math.min(16 * mib, base / 16),
    library: 8 * mib,...playbackReuseMemoryPlan(base)};
  return {...plan, workerImages: workers.images, workerSources: workers.sources, workerRasters: workers.rasters,
    workerVectors: workers.vectors, workerDrawings: workers.drawings, workerTints: workers.tints, workerSoftwareFilters: workers.softwareFilters, workerBackgrounds: workers.backgrounds,
    workerCount: count, workerRetainedBytes: workers.retainedBytes, workerPoolBytes: workers.retainedBytes * count,
    retainedBytes: Object.values(plan).reduce((sum, bytes) => sum + bytes, 0) + workers.retainedBytes * count};
}

/** One playback worker's retained allocations, derived by the controller from
 * its actual frame allowance. Send these to workers rather than recomputing
 * from their privacy-bucketed RAM hint. Drawing/tint targets can be exceeded by
 * resources required together for the current draw; documents and geometry are
 * not measured by these pixel/array cache targets. */
export function playbackWorkerMemoryPlan(frameBytes = playbackMemoryBudget()) {
  const mib = 1024 * 1024, base = Math.max(0, Number.isFinite(frameBytes) ? frameBytes : playbackMemoryBudget());
  const images = Math.min(64 * mib, base / 4);
  const plan = {images, sources: images / 2, rasters: Math.min(128 * mib, base / 4),
    vectors: Math.min(32 * mib, base / 8), drawings: Math.min(96 * mib, Math.max(16 * mib, images)), tints: 32 * mib,
    softwareFilters: Math.min(64 * mib, base / 8), backgrounds: Math.min(16 * mib, base / 16)};
  return {...plan, retainedBytes: Object.values(plan).reduce((sum, bytes) => sum + bytes, 0)};
}

/** Parallel packet-preparation workers. Every worker mirrors the document and
 * owns private image/raster/vector caches, so the count follows real RAM when
 * the hint is honest; the browser's capped 8 GB tier keeps the safe default.
 * Workers still share the machine with the UI thread, compositor and GPU
 * process, so a quarter of the hardware threads is the ceiling, not the goal. */
export function playbackWorkerCount(cores = globalThis.navigator?.hardwareConcurrency, deviceMemory = deviceMemoryHint()) {
  const threads = Number.isFinite(cores) && cores > 0 ? Math.floor(cores) : 4;
  const byCores = Math.max(1, Math.min(3, Math.floor(threads / 4)));
  if (typeof deviceMemory === 'number' && Number.isFinite(deviceMemory) && deviceMemory > 0)
    return Math.min(byCores, deviceMemory >= 16 ? 3 : deviceMemory >= 8 ? 2 : 1);
  return Math.min(byCores, 2);
}
