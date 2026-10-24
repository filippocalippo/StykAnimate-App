/**
 * The editor's background planning jobs (layer moves and inserted in-betweens) on the
 * engine's worker threads (docs/engine/threading.md, "Prepared samples and layer planning").
 *
 * A job is read-only: the engine plans against the document its mirror holds, so a request
 * carries only ids, a ratio and the editor's next identity, and the plan comes back in
 * bounded packets that each wait for an acknowledgement. The editor stages the plan and
 * publishes it; nothing here changes a document. What the engine does not plan (it answers
 * `EngineUnported`), or cannot (no worker threads), is planned on the interface in short
 * slices by the editor's own planners, the oracle the engine's plans are recorded against.
 */
import {applyDocumentChunk} from '../document-transport.mjs';
import {messageError, restoreMessageError} from '../localized-error.mjs';
import {planLayerMembershipMigrationSteps, migrationPlanPayload} from '../editor-layer-migration.mjs';
import {planInsertInbetweenSteps} from '../editor-inbetween.mjs';
import {inbetweenPlanWire} from '../editor-inbetween-async.mjs';

const KINDS = Object.freeze({
  layers: Object.freeze({what: 'Layer migration', noun: 'layer planning', method: 'plan_layers', nullable: true,
    cancelled: () => new DOMException('Layer migration was cancelled.', 'AbortError'),
    stale: () => new Error('The document changed while layer migration was prepared.')}),
  inbetweens: Object.freeze({what: 'Inbetween insertion', noun: 'inbetween planning', method: 'plan_inbetweens', nullable: false,
    cancelled: () => new DOMException('Inbetween insertion cancelled.', 'AbortError'),
    stale: () => new DOMException('The animation changed while inbetweens were prepared.', 'AbortError')}),
});
const pause = () => new Promise(resolve => setTimeout(resolve, 0));
/** A plan the engine does not make (here or in its answer): the host plans it itself. */
const unported = reason => Object.assign(new Error(reason), {name: 'EngineUnported'});

/** The error the host sees for one the engine's job raised: retired jobs read as the editor
 * words them, refusals carry the editor's message key. */
function failure(error, kind, signal) {
  if (error?.name === 'EngineUnported') return error;
  // Cancelled, replaced by a newer document or timed out: all retire the job as aborted.
  if (error?.name === 'AbortError') return signal?.aborted ? KINDS[kind].cancelled() : KINDS[kind].stale();
  // A refusal that names a value (`Unlock {name} before editing it`) carries its JSON after the key.
  const text = String(error?.message ?? ''), at = text.indexOf('\u001f');
  if (at === -1) return restoreMessageError(error, {messageKey: text});
  let messageParams;
  try { messageParams = JSON.parse(text.slice(at + 1)); } catch { messageParams = undefined; }
  return restoreMessageError(error, {messageKey: text.slice(0, at), messageParams});
}

/** Whether the engine's worker threads can run this kind of job. */
function available(kind, engine) {
  const {what, noun, method} = KINDS[kind];
  if (!engine?.threaded || !engine.workers) throw unported(`${what} requires background engine workers.`);
  if (typeof engine.handle?.[method] !== 'function') throw unported(`The engine ${noun} protocol is unavailable.`);
}

/** Starts a job, once the worker that is still disposing the previous one is done. */
async function start(engine, kind, revision, request) {
  for (let attempt = 0; ; attempt++) {
    const seen = engine.progressSeen();
    try { return engine.handle[KINDS[kind].method](revision, JSON.stringify(request)); }
    catch (error) {
      if (attempt >= 40 || !/planner is busy/.test(error?.message ?? '')) throw error;
      await Promise.race([engine.whenProgress(seen), new Promise(resolve => setTimeout(resolve, 25))]);
    }
  }
}

/**
 * Runs one job to its plan. The caller waits for its mirror acknowledgement before passing
 * `revision`. `isCurrent` says whether the editor still holds the document the job started
 * for; the engine retires the job itself when its mirror moves on.
 */
async function plan(kind, engine, revision, request, {signal, onProgress, isCurrent = () => true} = {}) {
  const {noun, nullable, cancelled, stale} = KINDS[kind];
  const check = () => { if (signal?.aborted) throw cancelled(); if (!isCurrent()) throw stale(); };
  check();
  let job;
  try { job = await start(engine, kind, revision, request); } catch (error) { throw failure(error, kind, signal); }
  const cancel = () => job.cancel();
  signal?.addEventListener('abort', cancel, {once: true});
  let payload;
  try {
    for (;;) {
      check();
      const seen = engine.progressSeen();
      let packet;
      try { packet = job.take(); } catch (error) { throw failure(error, kind, signal); }
      if (packet === undefined || packet === null) {
        await Promise.race([engine.whenProgress(seen), new Promise(resolve => setTimeout(resolve, 32))]);
        continue;
      }
      if (packet.length > 64 * 1024 + 2048) throw new Error(`The engine ${noun} packet exceeds its budget.`);
      const result = JSON.parse(packet);
      if (result.progress) onProgress?.(result.progress);
      check();
      if (result.chunk) {
        if (!Number.isInteger(result.sequence) || result.sequence < 0 || result.sequence > 0xffffffff)
          throw new Error(`The engine returned an invalid ${noun} packet sequence.`);
        payload = applyDocumentChunk(payload, result.chunk);
        // Yield even when a fast worker is ready. Each UI task consumes one
        // bounded packet, including a dense single figure or channel.
        await pause(); check();
        for (;;) {
          let acknowledged;
          try { acknowledged = job.ack(result.sequence); } catch (error) { throw failure(error, kind, signal); }
          if (acknowledged) break;
          const before = engine.progressSeen(); await engine.whenProgress(before); check();
        }
      }
      if (result.done) {
        if (!payload || !Object.hasOwn(payload, 'plan')) throw new Error(`The engine returned an invalid ${noun} payload.`);
        const planned = payload.plan;
        if (planned === null ? !nullable : typeof planned !== 'object') throw new Error(`The engine returned an invalid ${noun} payload.`);
        check(); return planned;
      }
    }
  } finally {
    signal?.removeEventListener('abort', cancel);
    job.cancel(); job.free();
  }
}

/**
 * Layer-move plan from the acknowledged engine mirror: `{uids, targetLayerId, nextFrameIdentity,
 * deletedLayerId?}`, answered as the editor's migration wire (`migrationPlanPayload(...).plan`).
 */
export async function planEngineLayerMigration(engine, revision, request, options) {
  available('layers', engine);
  // This contains IDs only. The engine already owns the acknowledged document.
  const {uids, targetLayerId, nextFrameIdentity, deletedLayerId} = request;
  if (!Array.isArray(uids) || uids.length > 10_000 || uids.some(uid => !Number.isInteger(uid) || uid < 1 || uid > 0xffffffff) ||
      typeof targetLayerId !== 'string' || targetLayerId.length > 128 ||
      deletedLayerId !== undefined && (typeof deletedLayerId !== 'string' || deletedLayerId.length > 128) ||
      !Number.isSafeInteger(nextFrameIdentity) || nextFrameIdentity < 1)
    throw new Error('Invalid layer planning ID request.');
  const params = {uids, targetLayerId, nextFrameIdentity, ...(deletedLayerId === undefined ? {} : {deletedLayerId})};
  return plan('layers', engine, revision, params, options);
}

/**
 * In-between plan from the acknowledged engine mirror: `{ratio, indices, nextFrameIdentity}`
 * (the editor's ordered, distinct source keys), answered as the editor's in-between wire
 * (`inbetweenPlanWire`).
 */
export async function planEngineInbetweens(engine, revision, request, options) {
  available('inbetweens', engine);
  const {ratio, indices, nextFrameIdentity} = request;
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0 || ratio > 1)
    throw messageError(new Error(''), "errors.editorInbetweenAsync.chooseAnInterpolationRatioFromZeroToOne", {});
  if (!Array.isArray(indices) || indices.length > 100_000 || indices.some(index => !Number.isInteger(index) || index < 0 || index > 100_000) ||
      !Number.isSafeInteger(nextFrameIdentity) || nextFrameIdentity < 1)
    throw new Error('Invalid inbetween planning request.');
  return plan('inbetweens', engine, revision, {ratio, indices, nextFrameIdentity}, options);
}

/**
 * The same plans by the editor's own planners, on the interface thread in slices of a few
 * milliseconds: for a document the engine does not plan and for a host without worker threads.
 * `report` is the editor's document; the editor checks it again before it publishes.
 */
export async function planOnInterface(kind, report, request, {signal, onProgress, isCurrent = () => true} = {}) {
  const {cancelled, stale} = KINDS[kind];
  const editor = {report, _nextFrameIdentity: request.nextFrameIdentity};
  const steps = kind === 'layers'
    ? planLayerMembershipMigrationSteps(editor, request.uids, request.targetLayerId, {deletedLayerId: request.deletedLayerId, worker: true})
    : planInsertInbetweenSteps(editor, request.ratio, request.indices);
  try {
    let sliceStart = performance.now();
    for (;;) {
      if (signal?.aborted) throw cancelled();
      if (!isCurrent()) throw stale();
      const step = steps.next();
      if (step.done) return kind === 'layers' ? migrationPlanPayload(step.value).plan : inbetweenPlanWire(step.value);
      onProgress?.(step.value);
      if (performance.now() - sliceStart >= 4) { await pause(); sliceStart = performance.now(); }
    }
  } finally { steps.return(); }
}

/** Whether `error` says the engine does not plan this (and the interface should). */
export const isUnported = error => error?.name === 'EngineUnported';
