import {documentChunks, applyDocumentChunk} from './document-transport.mjs';

export const MIGRATION_TRANSFER_BYTES = 128 * 1024 * 1024;
export const PLANNING_TRANSFER_BYTES = MIGRATION_TRANSFER_BYTES;
const CHUNK_BYTES = 64 * 1024;
const aborted = message => Object.assign(new Error(message), {name: 'AbortError'});
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const jobs = Object.freeze({
  migration: {message: 'plan-layer-migration', label: 'Layer migration'},
  inbetween: {message: 'plan-insert-inbetween', label: 'Insert inbetween'},
});

function channelDelta(beforeAnimation, afterAnimation) {
  const before = new Map((beforeAnimation?.channels || []).map(channel => [channel.id, channel]));
  const after = new Map(afterAnimation.channels.map(channel => [channel.id, channel]));
  const channelUpdates = [];
  for (const channel of after.values()) if (before.get(channel.id) !== channel) channelUpdates.push({id: channel.id, channel});
  for (const id of before.keys()) if (!after.has(id)) channelUpdates.push({id, channel: null});
  return {channelUpdates, channelOrder: [...after.keys()], nextKeyId: afterAnimation.nextKeyId};
}

/** Preserve unchanged channel references and send each new source asset once. */
export function migrationPlanPayload(plan) {
  if (!plan) return {plan: null};
  return {plan: {version: 1, ...channelDelta(plan.beforeAnimation, plan.afterAnimation),
    frameSources: plan.frameSources, nextFrameIdentity: plan.nextFrameIdentity, sampledTicks: plan.sampledTicks,
    affectedLayerIds: plan.affectedLayerIds, hadFrameSourceTable: plan.hadFrameSourceTable,
    ...(plan.sourceBytes !== undefined ? {sourceBytes: plan.sourceBytes} : {})}};
}

/** Only captured editable frames cross the wire; evaluated pose graphs stay in the worker. */
export function inbetweenPlanPayload(plan) {
  if (!plan) throw new Error('Invalid insert inbetween plan.');
  const entries = plan.entries.map(entry => {
    const {index, insertedIndex, originalTick, tick, ratio, sourceIndex, sampleRatio, duration,
      cumulativeDuration, sourceTick, frame, sourceId} = entry;
    return {index, insertedIndex, originalTick, tick, ratio, sourceIndex, sampleRatio, duration,
      cumulativeDuration, sourceTick, frame, ...(sourceId === undefined ? {} : {sourceId})};
  });
  return {plan: {version: 1, entries, skippedIndices: plan.skippedIndices, nextFrameIdentity: plan.nextFrameIdentity,
    animation: plan.animation ? {...channelDelta(plan.animation.before, plan.animation.after), sources: plan.animation.sources} : null}};
}

function validCompletedPlan(kind, plan) {
  if (kind === 'migration') return plan === null || plan?.version === 1 && Array.isArray(plan.channelUpdates) && Array.isArray(plan.channelOrder);
  return plan?.version === 1 && Array.isArray(plan.entries) && Array.isArray(plan.skippedIndices) &&
    Number.isSafeInteger(plan.nextFrameIdentity) && plan.nextFrameIdentity >= 1 &&
    plan.entries.every(entry => entry && !Object.hasOwn(entry, 'pose') && entry.frame && Array.isArray(entry.frame.objects)) &&
    (plan.animation === null || plan.animation && Array.isArray(plan.animation.channelUpdates) &&
      Array.isArray(plan.animation.channelOrder) && Array.isArray(plan.animation.sources) &&
      !Object.hasOwn(plan.animation, 'before') && !Object.hasOwn(plan.animation, 'patch'));
}

/** Receives reverse ACK chunks into unpublished staging owned by one request. */
export class PlaybackPlanner {
  constructor(owner) {this.owner = owner; this.pending = null; this.nextId = 1;}
  planLayerMigration(request, options) {return this._plan('migration', request, options);}
  planInsertInbetweens(request, options) {return this._plan('inbetween', request, options);}
  async _plan(kind, request, {signal, onProgress} = {}) {
    const {message, label} = jobs[kind];
    const owner = this.owner, revision = owner.revision;
    if (owner.disposed || !owner.report) throw new Error(`Load a document before ${label.toLowerCase()} planning.`);
    if (owner.failure) throw owner.failure;
    if (signal?.aborted) throw aborted(`${label} was cancelled.`);
    await owner._loadWorker();
    if (owner.disposed || owner.revision !== revision || signal?.aborted) throw aborted(`${label} was superseded.`);
    if (this.pending) throw new Error('A background operation is already being planned.');
    const jobId = this.nextId++;
    return new Promise((resolve, reject) => {
      const cancel = () => this.cancel(aborted(`${label} was cancelled.`));
      const timer = owner.timeoutMs > 0 ? setTimeout(() => this.cancel(new Error(`${label} planning timed out.`)), owner.timeoutMs) : null;
      this.pending = {kind, label, jobId, revision, resolve, reject, signal, cancel, timer, onProgress, staging: null, sequence: 0, bytes: 0, maxTaskMs: 0};
      signal?.addEventListener('abort', cancel, {once: true});
      try {owner.worker.postMessage({type: message, revision, jobId, request, maxBytes: PLANNING_TRANSFER_BYTES});}
      catch (error) {this.cancel(error);}
    });
  }
  _finish(error, value) {
    const job = this.pending; if (!job) return;
    this.pending = null; clearTimeout(job.timer); job.signal?.removeEventListener('abort', job.cancel);
    job.staging = null;
    if (error) job.reject(error); else job.resolve(value);
  }
  cancel(error = aborted('Background planning was superseded.')) {
    const job = this.pending; if (!job) return;
    try {if (!this.owner.disposed) this.owner.worker.postMessage({type: `${job.kind}-cancel`, revision: job.revision, jobId: job.jobId});} catch {}
    this._finish(error);
  }
  receive(message) {
    if (!message.type?.startsWith('migration-') && !message.type?.startsWith('inbetween-')) return false;
    const job = this.pending;
    if (!job || !message.type.startsWith(`${job.kind}-`) || message.jobId !== job.jobId || message.revision !== job.revision) return true;
    try {
      if (message.type === `${job.kind}-progress`) job.onProgress?.(message.progress);
      else if (message.type === `${job.kind}-chunk`) {
        const start = performance.now(), bytes = message.chunk?.estimatedBytes ?? 0;
        if (message.sequence !== job.sequence || bytes < 0 || bytes > CHUNK_BYTES || !Number.isFinite(bytes) || job.bytes + bytes > PLANNING_TRANSFER_BYTES)
          throw new Error(`Invalid or oversized ${job.label.toLowerCase()} transfer.`);
        if ((job.sequence === 0) !== Boolean(message.chunk?.header)) throw new Error(`${job.label} chunks arrived out of order.`);
        job.staging = applyDocumentChunk(job.staging, message.chunk); job.bytes += bytes; job.sequence++;
        job.maxTaskMs = Math.max(job.maxTaskMs, performance.now() - start);
        this.owner.worker.postMessage({type: `${job.kind}-ack`, revision: job.revision, jobId: job.jobId, sequence: message.sequence});
      } else if (message.type === `${job.kind}-complete`) {
        if (!job.staging || message.sequence !== job.sequence) throw new Error(`${job.label} completed before all its chunks.`);
        const plan = job.staging.plan;
        if (!validCompletedPlan(job.kind, plan)) throw new Error(`Invalid completed ${job.label.toLowerCase()} plan.`);
        Object.assign(this.owner.stats, {[`${job.kind}Bytes`]: job.bytes, [`${job.kind}Chunks`]: job.sequence, [`${job.kind}ReceiveMaxTaskMs`]: job.maxTaskMs});
        this._finish(null, plan);
      } else if (message.type === `${job.kind}-error`) this._finish(Object.assign(new Error(message.message), {name: message.name || 'Error'}));
    } catch (error) {this.cancel(error);}
    return true;
  }
}

/** A read-only job against the worker's current acknowledged document mirror. */
export class LayerMigrationService {
  constructor({snapshot, postMessage, onIdle, planner, inbetweenPlanner}) {Object.assign(this, {snapshot, postMessage, onIdle, planner, inbetweenPlanner}); this.active = null;}
  get busy() {return Boolean(this.active);}
  cancel() {
    const job = this.active; if (!job) return;
    this.active = null; job.cancelled = true; job.ack?.reject(aborted(`${job.label} was superseded.`));
    queueMicrotask(() => this.onIdle?.());
  }
  receive(message) {
    const kind = message.type === jobs.migration.message ? 'migration' : message.type === jobs.inbetween.message ? 'inbetween' : null;
    if (kind) {
      const snapshot = this.snapshot();
      if (snapshot?.revision !== message.revision) return true;
      if (this.active) {this.postMessage({type: `${kind}-error`, revision: message.revision, jobId: message.jobId, message: 'A background operation is already being planned.'}); return true;}
      const maximum = message.maxBytes ?? PLANNING_TRANSFER_BYTES;
      if (!Number.isSafeInteger(maximum) || maximum <= 0) {
        this.postMessage({type: `${kind}-error`, revision: message.revision, jobId: message.jobId, message: 'Invalid background planning result budget.'}); return true;
      }
      const job = {kind, label: jobs[kind].label, snapshot, revision: message.revision, jobId: message.jobId,
        request: message.request, maxBytes: Math.min(maximum, PLANNING_TRANSFER_BYTES)};
      this.active = job; void this.run(job); return true;
    }
    if (['migration-cancel', 'migration-ack', 'inbetween-cancel', 'inbetween-ack'].includes(message.type)) {
      const job = this.active;
      if (!job || !message.type.startsWith(`${job.kind}-`) || job.revision !== message.revision || job.jobId !== message.jobId) return true;
      if (message.type === `${job.kind}-cancel`) this.cancel();
      else if (job.ack?.sequence === message.sequence) {const ack = job.ack; job.ack = null; ack.resolve();}
      return true;
    }
    return false;
  }
  async run(job) {
    let iterator;
    const current = () => {if (job.cancelled || this.active !== job || this.snapshot() !== job.snapshot) throw aborted(`${job.label} was superseded.`);};
    const send = (suffix, details = {}) => this.postMessage({type: `${job.kind}-${suffix}`, revision: job.revision, jobId: job.jobId, ...details});
    try {
      const planner = job.kind === 'migration'
        ? this.planner || (await import('./editor-layer-migration.mjs')).planLayerMembershipMigrationSteps
        : this.inbetweenPlanner || (await import('./editor-inbetween.mjs')).planInsertInbetweenSteps;
      current();
      const {uids, targetLayerId, deletedLayerId, ratio, indices, nextFrameIdentity} = job.request;
      const editor = {report: job.snapshot.report, _nextFrameIdentity: nextFrameIdentity};
      iterator = job.kind === 'migration' ? planner(editor, uids, targetLayerId,
        {deletedLayerId, worker: true, maxSourceBytes: job.maxBytes}) : planner(editor, ratio, indices);
      let plan;
      for (;;) {current(); const next = iterator.next(); if (next.done) {plan = next.value; break;}
        send('progress', {progress: next.value}); await tick();}
      const payload = job.kind === 'migration' ? migrationPlanPayload(plan) : inbetweenPlanPayload(plan);
      plan = null; // Evaluated inbetween poses and history references stay off the transfer lifetime.
      const chunks = documentChunks(payload, {maxBytes: CHUNK_BYTES, maxRecords: 128, timeBudgetMs: 2});
      let sequence = 0, bytes = 0;
      for (;;) {
        current(); const next = chunks.next(); if (next.done) break;
        bytes += next.value.estimatedBytes || 0;
        if (bytes > job.maxBytes) throw new Error(`${job.label} exceeds the 128 MiB result budget.`);
        const acknowledged = new Promise((resolve, reject) => {job.ack = {sequence, resolve, reject};});
        send('chunk', {sequence: sequence++, chunk: next.value}); await acknowledged;
      }
      current(); send('complete', {sequence});
    } catch (error) {if (!job.cancelled && this.active === job) send('error', {message: error.message, name: error.name});}
    finally {
      try {iterator?.return?.();} catch {}
      if (this.active === job) {this.active = null; this.onIdle?.();}
    }
  }
}

export {LayerMigrationService as PlaybackPlanningService};
