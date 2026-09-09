import { SHAPE, SHAPE_BYTES, SHAPE_FLOATS } from './renderer-geometry.mjs';

// The staging memory is bounded independently of the scene size. writeBuffer
// snapshots each range before the next batch reuses the same backing store.
export const SHAPE_UPLOAD_RECORDS = 8192;

/** Upload an ordered, contiguous retained layout without per-object buffers. */
export function* uploadShapeLayoutSteps(queue, buffer, entries, staging) {
  const records = Math.floor(staging.length / SHAPE_FLOATS);
  if (!records) throw new RangeError('Shape upload staging must hold at least one record.');
  let batchStart = 0, used = 0, bytes = 0, calls = 0;
  const flush = () => {
    if (!used) return;
    const byteLength = used * SHAPE_BYTES;
    queue.writeBuffer(buffer, batchStart * SHAPE_BYTES, staging.buffer, staging.byteOffset, byteLength);
    bytes += byteLength; calls++; batchStart += used; used = 0;
  };
  for (const entry of entries) {
    if (entry.offset !== batchStart + used || entry.count > entry.capacity || entry.data.length !== entry.count * SHAPE_FLOATS)
      throw new RangeError('Shape upload layout must be contiguous and match its primitive data.');
    let local = 0;
    while (local < entry.capacity) {
      const count = Math.min(records - used, entry.capacity - local), begin = used * SHAPE_FLOATS;
      const live = Math.max(0, Math.min(count, entry.count - local));
      if (live) staging.set(entry.data.subarray(local * SHAPE_FLOATS, (local + live) * SHAPE_FLOATS), begin);
      if (live < count) {
        staging.fill(0, begin + live * SHAPE_FLOATS, begin + count * SHAPE_FLOATS);
        for (let i = live; i < count; i++) staging[begin + i * SHAPE_FLOATS + 20] = SHAPE.DISABLED;
      }
      used += count; local += count;
      if (used === records) {flush(); yield {phase: 'GPU upload', bytes, calls};}
    }
  }
  flush(); return {bytes, calls};
}

export function uploadShapeLayout(queue, buffer, entries, staging) {
  const steps = uploadShapeLayoutSteps(queue, buffer, entries, staging);
  for (;;) {const step = steps.next(); if (step.done) return step.value;}
}
