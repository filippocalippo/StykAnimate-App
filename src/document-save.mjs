/** Manual saves and recovery deadlines belong to the document lifetime, not history. */
export function documentCheckpoint(editor, token, epoch) {
  return { report: editor.report, token, revision: editor.revision, epoch };
}

function sameDocumentCheckpoint(a, b) {
  return Boolean(a && b && a.report === b.report && a.token === b.token &&
    a.revision === b.revision && a.epoch === b.epoch);
}

export function matchesDocumentCheckpoint(checkpoint, editor, token, { saved = false, epoch } = {}) {
  return sameDocumentCheckpoint(checkpoint, documentCheckpoint(editor, token, epoch)) && (!saved || !editor.dirty);
}

/** Includes destination selection: repeated input cannot open another picker or writer. */
export class DocumentSave {
  active = null;

  run(request, operation) {
    if (this.active) return request.saveAs === this.active.request.saveAs &&
      sameDocumentCheckpoint(request, this.active.request) ? this.active.promise : Promise.resolve(false);
    let resolve, reject;
    const promise = new Promise((success, failure) => { resolve = success; reject = failure; });
    const active = this.active = { request, promise };
    // Register before invoking the operation, while still invoking the picker in
    // the original input task with its transient browser activation.
    try {
      const settled = () => { if (this.active === active) this.active = null; };
      Promise.resolve(operation()).then(value => { settled(); resolve(value); }, error => { settled(); reject(error); });
    } catch (error) { this.active = null; reject(error); }
    return promise;
  }
}

/** Edits retain a maximum wait, while busy/failed attempts retain a retry floor. */
export class RecoveryDeadline {
  constructor({ now = () => performance.now() } = {}) { this.now = now; this.reset(); }

  reset() { this.document = null; this.pendingSince = null; this.retryAt = 0; }

  delay(document, interval, requested = interval) {
    const now = this.now();
    if (this.document !== document) { this.reset(); this.document = document; }
    this.pendingSince ??= now;
    if (requested === 0) this.retryAt = 0;
    const deadline = this.pendingSince + Math.max(interval, Math.min(60000, interval * 3));
    return Math.max(0, this.retryAt - now, Math.min(requested, deadline - now));
  }

  retryAfter(delay) { this.retryAt = this.now() + delay; }
}
