/** Lossless, byte-bounded native document snapshots with no full JSON/clone pass. */
const TABLES = new Set(['figure_types', 'keyframes', 'backgrounds']);
const ownSet = (object, key, value) => {
  if (key === '__proto__') Object.defineProperty(object, key, { value, writable: true, configurable: true, enumerable: true });
  else object[key] = value;
};
const keysOf = value => Array.isArray(value) ? null : value.property === 'pose' && Array.isArray(value.keys)
  ? ['property',...Object.keys(value).filter(key=>key!=='property'&&key!=='keys'),'keys'] : Object.keys(value);
const countOf = (value, keys) => keys ? keys.length : value.length;

/** Stops scanning as soon as a subtree would exceed a single bounded packet. */
function boundedSize(value, limit) {
  const frames = []; let size = 0, current = value;
  for (;;) {
    if (typeof current === 'string') size += current.length * 2 + 16;
    else if (current !== null && typeof current === 'object') {
      const keys = keysOf(current); size += 32;
      frames.push({ value: current, keys, index: 0 });
    } else size += 16;
    if (size > limit) return size;
    let next = false;
    while (frames.length) {
      const frame = frames.at(-1);
      if (frame.index >= countOf(frame.value, frame.keys)) { frames.pop(); continue; }
      const key = frame.keys ? frame.keys[frame.index++] : frame.index++;
      size += typeof key === 'string' ? key.length * 2 + 16 : 8;
      current = frame.value[key]; next = true; break;
    }
    if (!next) return size;
  }
}

/**
 * Small subtrees travel intact; large arrays/records are traversed incrementally.
 * maxBytes includes estimated structured-clone metadata, rather than source JSON
 * size. Both traversal and sender cloning stay bounded between receiver ACKs.
 */
export function* documentChunks(report, options = 1000) {
  if (typeof options === 'number') options = { maxRecords: options };
  const { maxRecords = 1000, maxBytes = 256 * 1024, timeBudgetMs = 3, omitRuntimeSegments = false } = options;
  if (!Number.isInteger(maxRecords) || maxRecords < 1) throw new Error('Document transport batch size must be a positive integer.');
  if (!Number.isInteger(maxBytes) || maxBytes < 1024) throw new Error('Document transport byte budget must be at least 1024.');
  if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error('Document transport requires a document record.');
  yield { header: {} };
  const stack = [{ value: report, path: [], keys: Object.keys(report), index: 0 }];
  const poseSequences = new WeakMap();
  const atomicLimit = Math.floor(maxBytes * .7), stringLength = Math.floor(maxBytes * .3);
  let operations = [], bytes = 64, started = performance.now();
  while (stack.length) {
    if (operations.length && (operations.length >= maxRecords || performance.now() - started >= timeBudgetMs)) {
      yield { operations, estimatedBytes: bytes }; operations = []; bytes = 64; started = performance.now();
    }
    const frame = stack.at(-1);
    if (frame.index >= countOf(frame.value, frame.keys)) { stack.pop(); continue; }
    const key = frame.keys ? frame.keys[frame.index++] : frame.index++;
    let value = frame.value[key]; const path = [...frame.path, key];
    const poseObject = path[0] === 'keyframes' && path.length === 4 && path[2] === 'objects';
    if (omitRuntimeSegments && poseObject && value && Object.hasOwn(value, 'runtime_segments')) {
      const { runtime_segments, ...nativePose } = value; value = nativePose;
    }
    const pathBytes = path.reduce((sum, part) => sum + (typeof part === 'string' ? part.length * 2 + 16 : 16), 64);
    if (key === 'keys' && frame.value.property === 'pose' && Array.isArray(value)) {
      const reference=poseSequences.get(value);
      if(reference){
        const size=pathBytes+reference.reduce((sum,part)=>sum+String(part).length*2+16,64);
        if(operations.length&&bytes+size>maxBytes){yield {operations,estimatedBytes:bytes};operations=[];bytes=64;started=performance.now();}
        operations.push({path,reference});bytes+=size;continue;
      }
      poseSequences.set(value,path);
    }
    const visitPoses = omitRuntimeSegments && path[0] === 'keyframes' && (path.length <= 2 || (path.length === 3 && path[2] === 'objects'));
    // Visit channel records even when small so shared sequences survive ACK
    // boundaries instead of being cloned again for every connected member.
    const size = visitPoses || value?.property === 'pose' && Array.isArray(value.keys) ? atomicLimit + 1 : boundedSize(value, atomicLimit);
    if (size <= atomicLimit) {
      if (operations.length && bytes + size + pathBytes > maxBytes) {
        yield { operations, estimatedBytes: bytes }; operations = []; bytes = 64; started = performance.now();
      }
      operations.push({ path, value }); bytes += size + pathBytes;
    } else if (typeof value === 'string') {
      // Concatenation leaves an immutable string rope instead of a large final
      // join/copy in the receiver's message task. The native field stays a string.
      if (operations.length) { yield { operations, estimatedBytes: bytes }; operations = []; bytes = 64; }
      for (let offset = 0; offset < value.length; offset += stringLength) {
        const part = value.slice(offset, offset + stringLength);
        yield { operations: [{ path, [offset ? 'append' : 'value']: part }], estimatedBytes: part.length * 2 + pathBytes + 64 };
      }
      started = performance.now();
    } else {
      if (operations.length && bytes + pathBytes + 32 > maxBytes) {
        yield { operations, estimatedBytes: bytes }; operations = []; bytes = 64; started = performance.now();
      }
      operations.push({ path, value: Array.isArray(value) ? [] : {} }); bytes += pathBytes + 32;
      stack.push({ value, path, keys: keysOf(value), index: 0 });
    }
  }
  if (operations.length) yield { operations, estimatedBytes: bytes };
}

export function applyDocumentChunk(report, chunk) {
  if (chunk.header) return chunk.header;
  if (chunk.operations) {
    if (!report || !Array.isArray(chunk.operations)) throw new Error('Invalid document transport operations.');
    for (const operation of chunk.operations) {
      const path = operation.path;
      if (!Array.isArray(path) || !path.length) throw new Error('Invalid document transport path.');
      let parent = report;
      for (let i = 0; i < path.length - 1; i++) {
        if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, path[i])) throw new Error('Document transport parent has not arrived.');
        parent = parent[path[i]];
      }
      const key = path.at(-1);
      if (!parent || typeof parent !== 'object' || !['string', 'number'].includes(typeof key)) throw new Error('Invalid document transport destination.');
      if (Object.hasOwn(operation, 'reference')) {
        if(!Array.isArray(operation.reference)||!operation.reference.length)throw new Error('Invalid document sequence reference.');
        let value=report;
        for(const part of operation.reference){
          if(!value||typeof value!=='object'||!Object.hasOwn(value,part))throw new Error('Document sequence reference has not arrived.');
          value=value[part];
        }
        if(!Array.isArray(value)||key!=='keys'||parent.property!=='pose')throw new Error('Document references require a pose key sequence.');
        ownSet(parent,key,value);
      } else if (Object.hasOwn(operation, 'append')) {
        if (!Object.hasOwn(parent, key) || typeof parent[key] !== 'string' || typeof operation.append !== 'string') throw new Error('Document string fragments arrived out of order.');
        ownSet(parent, key, parent[key] + operation.append);
      } else ownSet(parent, key, operation.value);
    }
    return report;
  }
  // Read compatibility for the first table-batch protocol and profiling tools.
  if (!TABLES.has(chunk.table) || !Array.isArray(chunk.values)) throw new Error('Invalid document transport table.');
  let target = report?.[chunk.table];
  if (chunk.nested) {
    if (!((chunk.table === 'figure_types' && chunk.nested === 'segments') || (chunk.table === 'keyframes' && chunk.nested === 'objects')))
      throw new Error('Invalid document transport records.');
    target = target?.[chunk.index]?.[chunk.nested];
  }
  if (!Array.isArray(target) || target.length !== chunk.offset) throw new Error('Document transport chunks arrived out of order.');
  for (const value of chunk.values) target.push(value);
  return report;
}
