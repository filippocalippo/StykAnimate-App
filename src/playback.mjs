import { timeline } from './pivot/geometry.mjs';
import { documentChunks } from './document-transport.mjs';
import { playbackProperties } from './playback-patch.mjs';
import {PlaybackPlanner} from './playback-planning.mjs';
import {storedFrameReport} from './pivot-frame-draft.mjs';
import {PlaybackBitmapPool,packetFootprint,closePacketBitmaps} from './playback-bitmap-pool.mjs';
import {playbackMemoryBudget} from './playback-budget.mjs';
import {playbackRetentionSnapshot,unchangedPlaybackTicks} from './playback-retention.mjs';

const abortError = message => { const error = new Error(message); error.name = 'AbortError'; return error; };
const closePacket = closePacketBitmaps;
const yieldToInput = () => globalThis.scheduler?.yield ? scheduler.yield() : new Promise(resolve => {
  const channel=new MessageChannel();channel.port1.onmessage=()=>{channel.port1.close();channel.port2.close();resolve();};channel.port2.postMessage(null);
});

/**
 * Bounded CPU packet LRU backed by one native-evaluation worker. Rendering calls
 * get() only: a miss never silently evaluates the scene on the animation thread.
 * The owner advances one exact tick after its packet arrives, holding on underrun.
 */
export class PlaybackCache {
  constructor({ maxBytes = playbackMemoryBudget(), maxFrames = 120, maxPending = 120,
    baseURL = globalThis.location?.href, token = '', scale = 1, onReady, onError, timeoutMs = 120000,
    workerURL = new URL('./playback-worker.mjs', import.meta.url), workerFactory } = {}) {
    Object.assign(this, { maxBytes, maxFrames, maxPending, baseURL, token, scale, onReady, onError, timeoutMs });
    this.cache = new Map(); this.pending = new Map(); this.revision = 0; this.disposed = false; this.needsLoad = false;
    this.cacheNamespace = globalThis.crypto.randomUUID();
    this._mirrorAvailable = false; this._frameUpdates = new Map(); this._protectedTick = null; this._prefetchRanks = null;
    this._mirrorSources = new Map(); this._sourceUpdates = new Map(); this._mirrorTables = null; this._patchPending = false;
    this._packetSizes = new Map(); this._sizeLimit = Math.max(256, maxFrames * 4, maxPending * 4); this._recentPacketBytes = 0;
    this.bitmapPool=new PlaybackBitmapPool();this._packetFootprints=new Map();this._footprintBytes=0;this._recentShared=false;
    this.stats = { backend: 'Worker prepared playback', revision: 0, readyFrames: 0, pendingFrames: 0, bytes: 0,bitmapResources:0,footprintBytes:0,
      maxBytes, maxFrames, hits: 0, misses: 0, evictions: 0, preparedFrames: 0, compileMs: 0, lastCompileMs: 0, loadMs: 0,
      loadChunks: 0, loadSerializationMs: 0, loadMaxTaskMs: 0, loadKind: null, updatedFrames: 0, droppedPrefetchFrames: 0, suppressedPrefetchFrames: 0, failure: null };
    this.worker = workerFactory ? workerFactory(workerURL) : new Worker(workerURL, { type: 'module', name: 'StykAnimate playback preparation' });
    this.planner = new PlaybackPlanner(this);
    this.worker.addEventListener('message', event => this._receive(event.data));
    this.worker.addEventListener('error', event => { event.preventDefault?.(); this._fail(new Error(event.message || 'The playback worker stopped unexpectedly.')); });
    this.worker.addEventListener('messageerror', () => this._fail(new Error('A prepared playback frame could not be transferred.')));
  }
  load(report, { scale = this.scale, revision, cameraEnabled = true, storedFrames = false } = {}) {
    if (this.disposed) throw new Error('The playback cache has been disposed.');
    this.invalidate(); this.report = report?.document ?? report?.report ?? report; this.scale = scale; this.cameraEnabled = cameraEnabled;
    this.documentRevision = revision; this.storedFrames = storedFrames; this._refreshTimeline();
    this.needsLoad = true; this._loadWorker(); return this;
  }
  setInteractionActive(active) {
    this.interactionActive=Boolean(active);
    if(!active){this._releaseInteraction?.();this._releaseInteraction=null;this._interactionPromise=null;}
  }
  async _yieldLoad() {
    await yieldToInput();
    if(this.interactionActive&&!this.disposed)await (this._interactionPromise??=new Promise(resolve=>{this._releaseInteraction=resolve;}));
  }
  updateView({ scale = this.scale, cameraEnabled = this.cameraEnabled, storedFrames = this.storedFrames } = {}) {
    if (this.disposed) throw new Error('The playback cache has been disposed.');
    if (scale === this.scale && cameraEnabled === this.cameraEnabled && storedFrames === this.storedFrames) return this;
    if (!this.report) { this.scale = scale; this.cameraEnabled = cameraEnabled; this.storedFrames = storedFrames; return this; }
    // Preserve an unfinished edit when the view changes; ordinary view changes
    // keep the acknowledged mirror without resending scene data.
    if (!this._mirrorAvailable || this.needsLoad)
      return this.load(this.report, { revision: this.documentRevision, scale, cameraEnabled, storedFrames });
    if (this._patchPending || this._frameUpdates.size || this._sourceUpdates.size)
      return this.updateDocument({revision: this.documentRevision, scale, cameraEnabled, storedFrames});
    this.invalidate({ scale, cameraEnabled, storedFrames, retainDocument: true }); this._refreshTimeline();
    this._retentionSnapshot = playbackRetentionSnapshot(this.report, this.entries, this); return this;
  }
  updateFrame(index, frame, { revision = this.documentRevision } = {}) {
    if (this.disposed) throw new Error('The playback cache has been disposed.');
    if (!Number.isInteger(index) || index < 0 || index >= (this.report?.keyframes?.length || 0) || frame !== this.report.keyframes[index])
      throw new Error('Playback frame updates must reference a frame in the current document.');
    return this.updateDocument({frameIndices: [index], revision, loadKind: 'frame'});
  }
  planLayerMigration(request, options) {return this.planner.planLayerMigration(request, options);}
  planInsertInbetweens(request, options) {return this.planner.planInsertInbetweens(request, options);}
  _refreshTimeline() {
    const report = this.storedFrames ? storedFrameReport(this.report, {validate: false}) : this.report;
    this.entries = timeline(report); const last = this.entries.at(-1); this.totalTicks = last ? last.start + last.count : 0;
  }
  _snapshotTables() {
    return {definitions: [...(this.report.figure_types || [])], backgrounds: [...(this.report.backgrounds || [])],
      frameIds: this.report.keyframes.map(frame => frame._styk?.frameId ?? null)};
  }
  _tablesMatch() {
    const tables = this._mirrorTables, report = this.report;
    return tables && tables.frameIds.length === report.keyframes.length &&
      tables.frameIds.every((id, index) => id === (report.keyframes[index]._styk?.frameId ?? null)) &&
      tables.definitions.length === (report.figure_types?.length || 0) && tables.definitions.every((value, index) => value === report.figure_types[index]) &&
      tables.backgrounds.length === (report.backgrounds?.length || 0) && tables.backgrounds.every((value, index) => value === report.backgrounds[index]);
  }
  updateDocument({frameIndices = [], sourceIds = [], revision = this.documentRevision, scale = this.scale,
    cameraEnabled = this.cameraEnabled, storedFrames = this.storedFrames, structural = false, definition = false, loadKind = 'patch'} = {}) {
    if (this.disposed) throw new Error('The playback cache has been disposed.');
    if (!this.report) throw new Error('Load a document before updating playback.');
    for (const index of frameIndices) if (!Number.isInteger(index) || index < 0 || index >= (this.report?.keyframes.length || 0))
      throw new Error('Playback frame updates must reference a frame in the current document.');
    for (const id of sourceIds) if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,127}$/.test(id)) throw new Error('Invalid retained playback source ID.');
    if (!this._mirrorAvailable || this.needsLoad || structural || definition || !this._tablesMatch())
      return this.load(this.report, {revision, scale, cameraEnabled, storedFrames});
    for (const index of frameIndices) this._frameUpdates.set(index, {frame: this.report.keyframes[index]});
    const sources = this.report._styk?.frameSources || {}, dirtySources = new Set([...this._sourceUpdates.keys(), ...sourceIds]);
    for (const [id, frame] of Object.entries(sources)) if (this._mirrorSources.get(id) !== frame) dirtySources.add(id);
    for (const id of this._mirrorSources.keys()) if (!Object.hasOwn(sources, id)) dirtySources.add(id);
    // Keep all uncertain IDs until an ACK. A cancelled transaction may already
    // have committed in the worker while its ACK was still crossing threads.
    for (const id of dirtySources) this._sourceUpdates.set(id, {frame: Object.hasOwn(sources, id) ? sources[id] : null});
    const previousSnapshot = this._retentionSnapshot;
    this._refreshTimeline();
    const nextSnapshot = playbackRetentionSnapshot(this.report, this.entries, {scale, cameraEnabled, storedFrames});
    const retainTicks = dirtySources.size ? new Set() : unchangedPlaybackTicks(previousSnapshot, nextSnapshot, this.cache.values(), this._frameUpdates.keys());
    this.invalidate({revision, scale, cameraEnabled, storedFrames, retainDocument: true, retainTicks}); this._patchPending = true;
    this._retentionSnapshot = nextSnapshot;
    const generation = this.revision, updates = [...this._frameUpdates], sourceUpdates = [...this._sourceUpdates], started = performance.now();
    const payload = {properties: playbackProperties(this.report), frames: updates.map(([index, entry]) => ({index, frame: entry.frame})),
      sources: sourceUpdates.map(([id, entry]) => ({id, frame: entry.frame})), hasFrameSources: this.report._styk?.frameSources !== undefined};
    Object.assign(this.stats, {loadKind, loadChunks: 0, loadSerializationMs: 0, loadMaxTaskMs: 0, maxChunkBytes: 0,
      patchFrames: updates.length, patchSourceUpserts: sourceUpdates.filter(([, entry]) => entry.frame !== null).length,
      patchSourceDeletes: sourceUpdates.filter(([, entry]) => entry.frame === null).length});
    const task = (async () => {
      let sequence = 0; const iterator = documentChunks(payload, {maxBytes: 64 * 1024, maxRecords: 128, timeBudgetMs: 2});
      for (;;) {
        if (generation !== this.revision || this.disposed) throw abortError('Playback document updates were superseded.');
        const step = performance.now(), next = iterator.next(); if (next.done) break;
        const sent = this._sendLoad({type: 'patch-chunk', revision: generation, sequence: sequence++, chunk: next.value});
        this.stats.loadMaxTaskMs = Math.max(this.stats.loadMaxTaskMs, performance.now() - step);
        this.stats.maxChunkBytes = Math.max(this.stats.maxChunkBytes, next.value.estimatedBytes || 0); await sent;
        await this._yieldLoad();
      }
      await this._sendLoad({type: 'patch-complete', revision: generation, sequence}, 'loaded');
      if (generation === this.revision) {
        for (const [index, entry] of updates) if (this._frameUpdates.get(index) === entry) this._frameUpdates.delete(index);
        for (const [id, entry] of sourceUpdates) {
          if (entry.frame === null) this._mirrorSources.delete(id); else this._mirrorSources.set(id, entry.frame);
          if (this._sourceUpdates.get(id) === entry) this._sourceUpdates.delete(id);
        }
        this._patchPending = false;
        this.stats.loadMs = performance.now() - started; this.stats.updatedFrames += updates.length;
      }
    })();
    this._loadPromise = task;
    task.catch(error => { if (generation === this.revision && error.name !== 'AbortError') this._fail(error); })
      .finally(() => { if (this._loadPromise === task) this._loadPromise = null; });
    return this;
  }
  invalidate({ scale = this.scale, revision = this.documentRevision, cameraEnabled = this.cameraEnabled, storedFrames = this.storedFrames, retainDocument = false, retainTicks } = {}) {
    this.planner.cancel(abortError('Background planning was invalidated by a document or view change.'));
    this._abortLoad(abortError('Playback snapshot was invalidated by a document change.'));
    this.revision++; this.scale = scale; this.documentRevision = revision; this.cameraEnabled = cameraEnabled; this.storedFrames = storedFrames;
    for (const [tick, packet] of this.cache) if (!retainTicks?.has(tick)) {this.bitmapPool.release(packet); this.cache.delete(tick);}
    if (!this.cache.size) this.cacheEpoch = `${this.cacheNamespace}:${this.revision}`;
    this._retentionSnapshot = null;
    this._protectedTick = null;
    this._prefetchRanks = null;
    for (const tick of this._packetSizes.keys()) if (!this.cache.has(tick)) this._packetSizes.delete(tick);
    for (const tick of this._packetFootprints.keys()) if (!this.cache.has(tick)) this._packetFootprints.delete(tick);
    this._footprintBytes = [...this._packetFootprints.values()].reduce((sum, entry) => sum + entry.metadataBytes, 0);
    const latest = [...this.cache.values()].at(-1);
    this._recentPacketBytes = latest?.byteLength || 0; this._recentShared = Boolean(latest?.compatibility?.some(entry => entry.artworkKey !== undefined));
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(abortError('Playback preparation was invalidated by a document change.')); }
    this.pending.clear();
    Object.assign(this.stats, { revision: this.revision, bytes: this.bitmapPool.bytes, readyFrames: this.cache.size, retainedFrames: this.cache.size,
      pendingFrames: 0,bitmapResources:this.bitmapPool.resources.size,footprintBytes:this._footprintBytes,workerCache:null,lastSharing:null,reusedGeometryObjects:0 });
    if (!retainDocument) {
      this._mirrorAvailable = false; this._frameUpdates.clear(); this._sourceUpdates.clear();
      this._mirrorSources.clear(); this._mirrorTables = null; this._patchPending = false;
    }
    this.needsLoad = Boolean(this.report) && !retainDocument;
    if (!this.disposed) this.worker.postMessage({ type: 'invalidate', revision: this.revision, retainDocument, options: { scale, cameraEnabled, storedFrames } });
    return this;
  }
  _loadWorker() {
    if (!this.needsLoad) return this._loadPromise || Promise.resolve();
    this.needsLoad = false;
    this._refreshTimeline();
    this._retentionSnapshot = playbackRetentionSnapshot(this.report, this.entries, this);
    const start = performance.now(), revision = this.revision, tables = this._snapshotTables(), sources = new Map(Object.entries(this.report._styk?.frameSources || {}));
    // Original encoded source is useful for saving, but has no role in playback.
    const { _stykSource, ...renderReport } = this.report;
    const options = { scale: this.scale, cameraEnabled: this.cameraEnabled, storedFrames: this.storedFrames, baseURL: this.baseURL, token: this.token, maxPacketBytes: this.maxBytes };
    this.stats.loadKind = 'document'; this.stats.loadChunks = 0; this.stats.loadSerializationMs = 0; this.stats.loadMaxTaskMs = 0;
    this.stats.maxChunkBytes = 0; this.stats.patchFrames = 0; this.stats.patchSourceUpserts = 0; this.stats.patchSourceDeletes = 0;
    const task = (async () => {
      let sequence = 0;
      for (const chunk of documentChunks(renderReport)) {
        if (revision !== this.revision || this.disposed) throw abortError('Playback snapshot was superseded.');
        await this._sendLoad({ type: 'load-chunk', revision, sequence: sequence++, chunk, options });
        await this._yieldLoad();
      }
      await this._sendLoad({ type: 'load-complete', revision, sequence }, 'loaded');
      if (revision === this.revision) { this.stats.loadMs = performance.now() - start; this._mirrorAvailable = true; this._mirrorTables = tables; this._mirrorSources = sources; }
    })();
    this._loadPromise = task;
    // load() deliberately returns immediately; prepareRange() observes failures.
    task.catch(error => { if (revision === this.revision && error.name !== 'AbortError') this._fail(error); })
      .finally(() => { if (this._loadPromise === task) this._loadPromise = null; });
    return task;
  }
  _sendLoad(message, responseType = 'load-ack') {
    // The preceding ACK may resolve just before another document replaces this
    // generation. Its resumed continuation must never replace the new waiter.
    if (this.disposed || message.revision !== this.revision)
      return Promise.reject(abortError('Playback snapshot was superseded.'));
    return new Promise((resolve, reject) => {
      const timer = this.timeoutMs > 0 ? setTimeout(() => this._fail(new Error('Playback snapshot timed out.')), this.timeoutMs) : null;
      this._loadAck = { revision: message.revision, sequence: message.sequence, responseType, resolve, reject, timer };
      try {
        const start = performance.now(); this.worker.postMessage(message); const elapsed = performance.now() - start;
        this.stats.loadChunks++; this.stats.loadSerializationMs += elapsed; this.stats.loadMaxTaskMs = Math.max(this.stats.loadMaxTaskMs, elapsed);
        this.stats.maxChunkBytes = Math.max(this.stats.maxChunkBytes || 0, message.chunk?.estimatedBytes || 0);
      } catch (error) { this._abortLoad(error); }
    });
  }
  _abortLoad(error) {
    if (this._loadAck) { clearTimeout(this._loadAck.timer); this._loadAck.reject(error); this._loadAck = null; }
    this._loadPromise = null;
  }
  get(tick) {
    const packet = this.cache.get(tick);
    if (!packet) { this.stats.misses++; return null; }
    this.cache.delete(tick); this.cache.set(tick, packet); this.stats.hits++; return packet;
  }
  has(tick) { return this.cache.has(tick); }
  _feasiblePrefetch(ticks) {
    const feasible = [],seen=new Set(); let estimatedBytes = 0,probed=false;
    for (const tick of ticks) {
      const footprint=this._packetFootprints.get(tick);
      const bytes=footprint?footprint.base+footprint.resources.reduce((n,[key,bytes])=>n+(seen.has(key)?0:bytes),0):this._recentPacketBytes;
      // Always admit the next exact tick. Unknown future sizes use the latest
      // packet until their own measurements become available.
      if(feasible.length>=this.maxFrames)break;
      if(feasible.length&&estimatedBytes+bytes>this.maxBytes){
        // Discover one unknown frame's overlap. Its actual packet still passes
        // admission/eviction checks; a known non-fitting frame is not reprobed.
        if(!footprint&&this._recentShared&&!probed){feasible.push(tick);probed=true;}
        break;
      }
      feasible.push(tick); estimatedBytes += bytes;
      for(const [key] of footprint?.resources||[])seen.add(key);
    }
    return feasible;
  }
  _trimQueuedPrefetch() {
    if (!this._prefetchRanks?.size) return;
    const requested = [...this._prefetchRanks.keys()], feasible = this._feasiblePrefetch(requested);
    if (feasible.length === requested.length) return;
    const keep = new Set(feasible), previousRanks = this._prefetchRanks;
    this._prefetchRanks = new Map(feasible.map((tick, index) => [tick, index]));
    this.stats.suppressedPrefetchFrames += requested.length - feasible.length;
    for (const [tick, pending] of this.pending) if (previousRanks.has(tick) && !keep.has(tick)) {
      clearTimeout(pending.timer); this.pending.delete(tick);
      pending.reject(abortError('Playback prefetch was trimmed to the measured frame budget.'));
    }
    this.stats.pendingFrames = this.pending.size;
    // Trim as soon as a size arrives, before another animation tick. Otherwise
    // a cold 24-frame batch can continue rasterizing after only two frames fit.
    // Explicit requests outside the speculative window retain their queue slots.
    this.worker.postMessage({ type: 'retain', revision: this.revision, ticks: [...new Set([...feasible, ...this.pending.keys()])] });
  }
  async prepareRange(ticks, { replacePending = false } = {}) {
    if (this.disposed) throw new Error('The playback cache has been disposed.');
    if (this.failure) throw this.failure;
    if (!this.report) return [];
    const revision = this.revision;
    await this._loadWorker();
    if (this.disposed || revision !== this.revision) throw abortError('Playback preparation was superseded.');
    if (replacePending) {
      const requested = [...new Set(ticks)].filter(tick => Number.isInteger(tick) && tick >= 0 && tick < this.totalTicks);
      const feasible = this._feasiblePrefetch(requested);
      this.stats.suppressedPrefetchFrames += requested.length - feasible.length;
      ticks = feasible;
      const keep = new Set(ticks);
      this._protectedTick = ticks[0] ?? null;
      this._prefetchRanks = new Map([...keep].map((tick, index) => [tick, index]));
      for (const [tick, pending] of this.pending) if (!keep.has(tick)) {
        clearTimeout(pending.timer); this.pending.delete(tick); pending.reject(abortError('Playback prefetch moved to a different frame window.'));
      }
      this.worker.postMessage({ type: 'retain', revision, ticks: [...keep] });
    }
    const requests = [], promises = [];
    for (const tick of new Set(ticks)) {
      if (!Number.isInteger(tick) || tick < 0 || tick >= this.totalTicks) continue;
      if (this.cache.has(tick)) continue;
      let pending = this.pending.get(tick);
      if (!pending) {
        if (this.pending.size >= this.maxPending) break;
        let resolve, reject;
        const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
        const timer = this.timeoutMs > 0 ? setTimeout(() => this._fail(new Error('Playback preparation timed out.')), this.timeoutMs) : null;
        pending = { promise, resolve, reject, timer }; this.pending.set(tick, pending); requests.push(tick);
      }
      promises.push(pending.promise);
    }
    this.stats.pendingFrames = this.pending.size;
    if (requests.length) this.worker.postMessage({ type: 'prepare', revision, ticks: requests });
    // Resolve without retaining packet references outside the LRU.
    await Promise.all(promises); return { revision, readyFrames: this.cache.size, requestedFrames: requests.length };
  }
  _receive(message) {
    if (this.disposed || message.revision !== this.revision) { closePacket(message.packet); return; }
    if (this.planner.receive(message)) return;
    const loading = this._loadAck;
    if (loading && message.type === loading.responseType && message.sequence === loading.sequence) {
      clearTimeout(loading.timer); this._loadAck = null; loading.resolve(); return;
    }
    if (message.type === 'load-error') { this._fail(new Error(message.message)); return; }
    if (message.type === 'loaded') return;
    const pending = this.pending.get(message.tick);
    if (!pending) { closePacket(message.packet); return; }
    clearTimeout(pending.timer); this.pending.delete(message.tick); this.stats.pendingFrames = this.pending.size;
    if (message.type === 'error') { const error = new Error(message.message); if (message.code) error.code = message.code; pending.reject(error); this.onError?.(error); return; }
    const packet = message.packet;
    if (!packet) { pending.reject(new Error('The playback worker returned no render packet.')); return; }
    // Packet keys/revisions identify immutable compilation results. An epoch
    // identifies shared pixel ownership across explicitly retained revisions.
    packet.cacheEpoch = this.cacheEpoch;
    this._packetSizes.delete(packet.tick); this._packetSizes.set(packet.tick, packet.byteLength); this._recentPacketBytes = packet.byteLength;
    const footprint=packetFootprint(packet);footprint.metadataBytes=32+footprint.resources.reduce((n,[key])=>n+32+key.length*2,0);
    this._footprintBytes-=this._packetFootprints.get(packet.tick)?.metadataBytes||0;
    this._packetFootprints.delete(packet.tick);this._packetFootprints.set(packet.tick,footprint);this._footprintBytes+=footprint.metadataBytes;
    this._recentShared=footprint.resources.length>0;
    while(this._packetFootprints.size>this._sizeLimit||this._footprintBytes>Math.max(65536,this.maxBytes/8)){
      const [tick,entry]=this._packetFootprints.entries().next().value;this._packetFootprints.delete(tick);this._footprintBytes-=entry.metadataBytes;
    }
    while (this._packetSizes.size > this._sizeLimit)this._packetSizes.delete(this._packetSizes.keys().next().value);
    this.stats.footprintBytes=this._footprintBytes;
    // One frame larger than the budget cannot be retained safely. Surface this
    // explicitly, allowing the application to offer its normal rendering path.
    if (packet.byteLength > this.maxBytes || this.maxFrames < 1) {
      closePacket(packet); const error = new Error(`A playback frame exceeds the ${Math.round(this.maxBytes / 1024 / 1024)} MB preparation budget.`);
      error.code = 'playback_frame_budget'; pending.reject(error); this.onError?.(error); return;
    }
    while (this.cache.size && (this.cache.size >= this.maxFrames || this.stats.bytes + this.bitmapPool.incrementalBytes(packet) > this.maxBytes)) {
      let victim, victimRank = -1;
      for (const entry of this.cache) if (entry[0] !== this._protectedTick) {
        const rank = this._prefetchRanks?.get(entry[0]) ?? Infinity;
        if (!victim || rank > victimRank) { victim = entry; victimRank = rank; }
      }
      const incomingRank = this._prefetchRanks?.get(packet.tick) ?? Infinity;
      if (!victim || (Number.isFinite(victimRank) && incomingRank > victimRank)) {
        // The next exact tick must survive a sudden jump in media size. Future
        // speculative packets may be prepared again after that tick is consumed.
        closePacket(packet); this.stats.droppedPrefetchFrames++; this.stats.readyFrames = this.cache.size;
        this._trimQueuedPrefetch(); pending.resolve(); return;
      }
      const [tick, oldest] = victim; this.cache.delete(tick); this.bitmapPool.release(oldest);this.stats.bytes=this.bitmapPool.bytes;this.stats.bitmapResources=this.bitmapPool.resources.size;this.stats.evictions++;
    }
    try{this.bitmapPool.acquire(packet);}catch(error){closePacket(packet);pending.reject(error);this.onError?.(error);return;}
    this.cache.set(packet.tick, packet);this.stats.bytes=this.bitmapPool.bytes;this.stats.bitmapResources=this.bitmapPool.resources.size;this.stats.readyFrames = this.cache.size;
    this.stats.preparedFrames++; this.stats.compileMs += packet.compileMs; this.stats.lastCompileMs = packet.compileMs;
    this.stats.workerCache=packet.workerCache;this.stats.lastSharing=packet.sharing;this.stats.reusedGeometryObjects=packet.reusedGeometryObjects;
    this._trimQueuedPrefetch();
    pending.resolve(); this.onReady?.(packet);
  }
  _fail(error) {
    if (this.failure) return;
    this._mirrorAvailable = false;
    this.failure = error; this.stats.failure = error.message;
    this.planner.cancel(error);
    this._abortLoad(error);
    this.worker.terminate();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.stats.pendingFrames = 0; this.onError?.(error);
  }
  dispose() {
    if (this.disposed) return;
    this.setInteractionActive(false);
    this.disposed = true; this.invalidate(); this.worker.terminate(); this.report = null; this.entries = [];
  }
}
