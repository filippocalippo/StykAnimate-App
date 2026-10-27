/**
 * Opening a document on the engine (docs/engine/document.md, "Opening a document").
 *
 * Every way a document arrives goes through one entry: a file's bytes (Pivot, StykAnimate) or a document as
 * JSON (a new document, a recovery copy, an import the interface decoded). The engine decodes it, normalizes
 * it as the editor's load always did and converts it, on its workers (`openBytes`, `openJson`) or at once for
 * a small one (`openJsonNow`). The result is an `Opening`: the interface builds the editor's read view from
 * it in slices that leave the frame its time (`read`), and the session that edits the document starts from
 * the same tree (`startSession`). Nothing here validates or normalizes a document.
 */
import {restoreLifted} from '../document-lift.mjs';
import {messageError, restoreMessageError} from '../localized-error.mjs';
import {yieldLoadTask} from '../yield-task.mjs';

/** The engine the page opens its documents on (the app registers it after loading it; tests too). */
let registered = null;
export function useEngine(engine) { registered = engine; }
export function registeredEngine() { return registered; }

function engineOf(engine) {
  const found = engine ?? registered;
  if (!found) throw new Error('The engine has not been loaded: register it with useEngine().');
  return found;
}

const EMPTY = new Uint8Array(0);
const encoder = new TextEncoder();

/** The error an open raised, as the interface words it: a message key with its parameters where there is one. */
function openFailure(error) {
  let data;
  try { data = JSON.parse(error?.message); } catch { return error; }
  if (!data || typeof data !== 'object' || typeof data.message !== 'string') return error;
  if (data.code === 'cancelled') return messageError(new DOMException('', 'AbortError'), 'errors.editorLoad.importCancelled', {});
  const failure = restoreMessageError(new Error(data.message), data);
  if (data.code) failure.code = data.code;
  if (data.status) failure.status = data.status;
  failure.telemetryCode = data.code === 'out_of_memory' ? 'out_of_memory' : data.status >= 500 ? 'backend_unavailable' : data.status ? 'backend_rejected' : 'decode_failed';
  failure.telemetryStage = data.stage === 'prepare' ? 'prepare' : 'decode';
  return failure;
}

const optionsText = ({layerTimeline = false} = {}) => JSON.stringify({layerTimeline: Boolean(layerTimeline)});

/** The views already built for documents that are about to be loaded (`attach`, `prepareLoad`). */
const reads = new WeakMap();

/**
 * The editor's read view of an opened document: its report as JavaScript objects, built piece by piece from
 * the engine's tree, and the indexes the editor adopts with it.
 */
export class Opening {
  constructor(engine, handle) {
    this.engine = engine;
    this.handle = handle;
    this.meta = JSON.parse(handle.meta());
  }
  get name() { return this.meta.name; }
  get kind() { return this.meta.kind; }
  get version() { return this.meta.version; }
  /** Whether the document stored a frame draft when it was opened. */
  get savedDraft() { return this.meta.savedDraft; }
  get lineage() { return this.meta.lineage; }

  /** Gives the document the Pivot file it was read from, as a saved native document carries its source (`_stykSource`). */
  attachSource(description, bytes) {
    if (!this.handle) throw new Error('This opening has been released.');
    try {
      this.engine.handle.admit_copy(bytes.byteLength);
      this.handle.attach_source(JSON.stringify(description), bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    } catch (error) { throw openFailure(error); }
  }

  /** Builds the report one piece at a time; every piece after the first is a step the caller may pause at. */
  * readSteps() {
    const {handle, meta} = this, shared = new Map(), sections = [{bytes: EMPTY, base: 0}, {bytes: EMPTY, base: 0}];
    if (!handle) throw new Error('This opening has been released.');
    const restore = part => {
      const skeleton = JSON.parse(part.skeleton);
      sections[0] = {bytes: part.arrays, base: part.arrays_base};
      sections[1] = {bytes: part.payloads, base: part.payloads_base};
      // Sequences the piece defines come first: its skeleton and later pieces name them.
      if (part.sequences) for (const {id, v} of JSON.parse(part.sequences)) shared.set(`S2R:${id}`, restoreLifted(v, sections, shared));
      part.free();
      return restoreLifted(skeleton, sections, shared);
    };
    const report = restore(handle.part(-1, 0));
    let work = 0;
    for (let at = 0; at < meta.splits.length; at++) {
      const split = meta.splits[at];
      let container = report;
      for (const key of split.path) container = container[key];
      if (split.keys) {
        for (let index = 0; index < split.keys.length; index++) {
          const key = split.keys[index], value = restore(handle.part(at, index));
          if (key === '__proto__') Object.defineProperty(container, key, {value, writable: true, configurable: true, enumerable: true});
          else container[key] = value;
          yield {phase: 'reading', checked: ++work};
        }
      } else {
        for (let index = 0; index < split.count; index++) {
          container.push(restore(handle.part(at, index)));
          yield {phase: 'reading', checked: ++work};
        }
      }
    }
    const indexes = meta.indexes;
    return {
      report, opening: this, nextFrameIdentity: indexes.nextFrameIdentity, nextUid: indexes.nextUid,
      layerUidCounts: new Map(indexes.layerUidCounts), layerSeenUids: new Set(indexes.layerSeenUids),
      layerGroups: new Map(indexes.layerGroups.map(([id, uids]) => [id, new Set(uids)])),
    };
  }

  /** The whole view at once. */
  readNow() {
    const steps = this.readSteps(), started = performance.now();
    let step;
    do { step = steps.next(); } while (!step.done);
    return {...step.value, timings: {started, preparedMs: performance.now() - started, slices: 1, workMs: performance.now() - started, phases: {}}};
  }

  /**
   * The whole view, in slices of `sliceMs` that leave the frame its time. `checkCurrent` throws to abandon it;
   * so does an aborted `signal`.
   */
  async read({sliceMs = 4, signal, onProgress, yieldControl = yieldLoadTask, checkCurrent = () => {}} = {}) {
    if (!Number.isFinite(sliceMs) || sliceMs <= 0 || sliceMs > 16) throw messageError(new Error(''), 'errors.editorLoad.importTimeSlicesMustBeGreaterThanZero', {});
    const check = () => {
      if (signal?.aborted) throw messageError(new DOMException('', 'AbortError'), 'errors.editorLoad.importCancelled', {});
      checkCurrent();
    };
    check();
    const steps = this.readSteps(), timings = {started: performance.now(), slices: 0, maxSliceMs: 0, workMs: 0, phases: {}};
    try {
      for (;;) {
        check();
        const started = performance.now();
        let step;
        do { step = steps.next(); } while (!step.done && performance.now() - started < sliceMs);
        const elapsed = performance.now() - started;
        timings.slices++; timings.maxSliceMs = Math.max(timings.maxSliceMs, elapsed); timings.workMs += elapsed;
        if (step.done) { check(); timings.preparedMs = performance.now() - timings.started; return {...step.value, timings}; }
        timings.phases[step.value.phase] = (timings.phases[step.value.phase] ?? 0) + elapsed;
        onProgress?.(step.value); check(); await yieldControl();
      }
    } finally { steps.return(); }
  }

  /**
   * The session that edits this document (`state`: the editor's options, view and counters), sharing the
   * tree. The opening has nothing left to give after it and releases the engine's copy of the handle.
   */
  startSession(state) {
    if (!this.handle) throw new Error('This opening has been released.');
    const session = this.handle.start_session(JSON.stringify(state));
    this.dispose();
    return session;
  }

  /** Lets the engine drop the opened document, unless a session keeps it. */
  dispose() {
    this.handle?.free();
    this.handle = null;
  }
}

/** Waits for the engine's worker to finish `job`; an aborted `signal` stops it at its next checkpoint. */
async function finish(engine, job, signal) {
  const stop = () => engine.handle.cancel_open(job);
  signal?.addEventListener('abort', stop, {once: true});
  try {
    for (;;) {
      const seen = engine.progressSeen();
      let opened;
      try { opened = engine.handle.take_opened_document(job); } catch (error) { throw openFailure(error); }
      if (opened !== undefined) return new Opening(engine, opened);
      await engine.whenProgress(seen);
    }
  } finally { signal?.removeEventListener('abort', stop); }
}

const bytesOf = value => value instanceof Uint8Array ? value : new Uint8Array(value);

/** Whether the engine has the memory to take a file of `size` bytes in and open it: the open error, else null. */
function memoryRefusal(engine, size) {
  try { engine.handle.admit_open(size); return null; } catch (error) { return openFailure(error); }
}

/**
 * Opens a file on the engine's workers. Resolves with the opening, or rejects with the error the open raised
 * (an AbortError when `signal` aborted it). The bytes are copied into the engine; the caller keeps its own.
 */
export function openBytes(bytes, filename, {engine, layerTimeline, signal} = {}) {
  engine = engineOf(engine);
  const refusal = memoryRefusal(engine, bytes.byteLength);
  if (refusal) return Promise.reject(refusal);
  const job = engine.handle.open_document(bytesOf(bytes), filename, 'file', optionsText({layerTimeline}));
  return finish(engine, job, signal);
}

const jsonBytes = document => encoder.encode(typeof document === 'string' ? document : JSON.stringify(document));

/** Opens a document given as JSON text or as an object, on the engine's workers. */
export function openJson(document, name, {engine, layerTimeline, signal} = {}) {
  engine = engineOf(engine);
  const text = jsonBytes(document), refusal = memoryRefusal(engine, text.byteLength);
  if (refusal) return Promise.reject(refusal);
  const job = engine.handle.open_document(text, name ?? 'Untitled animation', 'json', optionsText({layerTimeline}));
  return finish(engine, job, signal);
}

/** Opens a small document on this thread, at once: a new document, a tutorial's. */
function openJsonNow(document, name, {engine, layerTimeline} = {}) {
  engine = engineOf(engine);
  try { return new Opening(engine, engine.handle.open_document_now(jsonBytes(document), name ?? 'Untitled animation', 'json', optionsText({layerTimeline}))); }
  catch (error) { throw openFailure(error); }
}

/**
 * Whether the engine holds the document at `revision`: its session publishes every change at the editor's
 * revision, so nothing else brings the engine up to date. Revisions are unique across the documents of one
 * editor, so the revision alone says it is this document's. False while the engine is busy.
 */
export function holdsRevision(engine, revision) {
  return engine.handle.try_document_identity()?.[2] === revision;
}

/** Records the view built for `report`, which the editor's next load of it adopts as it is. */
export function attachRead(report, read) { reads.set(report, read); return report; }

const reportOf = document => document?.document ?? document?.report ?? document;

/**
 * What the editor adopts when it loads `document`: the view built for it when it came from the engine
 * (`attachRead`), else the view of the document opened now. `layerTimeline`: the editor gives its documents
 * a layer sheet.
 */
export async function prepareLoad(document, {layerTimeline, signal, onProgress, checkCurrent, sliceMs, yieldControl} = {}) {
  const report = reportOf(document), read = reads.get(report);
  if (read) return read;
  const opening = await openJson(report, undefined, {layerTimeline, signal});
  try { return await opening.read({signal, onProgress, checkCurrent, sliceMs, yieldControl}); }
  catch (error) { opening.dispose(); throw error; }
}

/** [`prepareLoad`] at once, on this thread. */
export function prepareLoadNow(document, {layerTimeline} = {}) {
  const report = reportOf(document), read = reads.get(report);
  if (read) return read;
  const opening = openJsonNow(report, undefined, {layerTimeline});
  try { return opening.readNow(); }
  catch (error) { opening.dispose(); throw error; }
}
