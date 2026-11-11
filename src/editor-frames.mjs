import {messageError} from './localized-error.mjs';
import {getFrameById} from './frame-ids.mjs';
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const validId = id => typeof id === 'string' && /^[a-z][a-z0-9-]{0,127}$/.test(id);

/** Validate persisted references before replacing the currently open document. */
export function validateFrameIdentities(report) {
  const iterator=validateFrameIdentitySteps(report);
  for (;;) {const step=iterator.next(); if (step.done) return step.value;}
}
function* validateFrameIdentitySteps(report) {
  const ids = new Set(); let next = 1;
  const sources = report._styk?.frameSources;
  if (sources !== undefined && (!sources || typeof sources !== 'object' || Array.isArray(sources))) throw messageError(new Error(''), "errors.editorFrames.invalidRetainedFrameSources", {});
  function* entries() {
    for (const frame of report.keyframes) yield [null,frame];
    for (const key in sources ?? {}) if (own(sources,key)) yield [key,sources[key]];
  }
  let work=0;
  for (const [key, frame] of entries()) {
    if (++work % 256 === 0) yield {phase:'identities', checked:work};
    const id = frame?._styk?.frameId;
    if (id === undefined && key === null) continue;
    if (!validId(id) || (key !== null && key !== id) || ids.has(id)) throw messageError(new Error(''), "errors.editorFrames.frameSourceIdentitiesMustBeValidAndUnique", {});
    ids.add(id);
    if (/^frame-[1-9]\d*$/.test(id)) {
      const number = Number(id.slice(6));
      if (!Number.isSafeInteger(number)) throw messageError(new Error(''), "errors.clipboardLegacyUpgrade.frameIdentityCapacityExceeded", {});
      next = Math.max(next, number + 1);
    }
  }
  return next;
}

export const editorFrameMethods = {
  getFrameById(id) { return getFrameById(this.report, id); },
};
