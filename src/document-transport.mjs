import {messageError} from './localized-error.mjs';
/** Lossless, byte-bounded native document snapshots with no full JSON/clone pass. */
const TABLES = new Set(['figure_types', 'keyframes', 'backgrounds']);
const ownSet = (object, key, value) => {
  if (key === '__proto__') Object.defineProperty(object, key, { value, writable: true, configurable: true, enumerable: true });
  else object[key] = value;
};
const keysOf = value => Array.isArray(value) ? null : value.property === 'pose' && Array.isArray(value.keys)
  ? ['property',...Object.keys(value).filter(key=>key!=='property'&&key!=='keys'),'keys'] : Object.keys(value);
const countOf = (value, keys) => keys ? keys.length : value.length;
const numericArray = value => Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'number');

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
  const { maxRecords = 1000, maxBytes = 256 * 1024, timeBudgetMs = 3, sharedFigures = false } = options;
  if (!Number.isInteger(maxRecords) || maxRecords < 1) throw messageError(new Error(''), "errors.documentTransport.documentTransportBatchSizeMustBeAPositive", {});
  if (!Number.isInteger(maxBytes) || maxBytes < 1024) throw messageError(new Error(''), "errors.documentTransport.documentTransportByteBudgetMustBeAtLeast", {});
  if (!report || typeof report !== 'object' || Array.isArray(report)) throw messageError(new Error(''), "errors.documentTransport.documentTransportRequiresADocumentRecord", {});
  yield { header: {} };
  const stack = [{ value: report, path: [], keys: Object.keys(report), index: 0 }];
  const poseSequences = new WeakMap();
  const figures = new WeakMap();
  const atomicLimit = Math.floor(maxBytes * .7), stringLength = Math.floor(maxBytes * .3);
  let operations = [], bytes = 64, started = performance.now();
  while (stack.length) {
    if (operations.length && (operations.length >= maxRecords || performance.now() - started >= timeBudgetMs)) {
      yield { operations, estimatedBytes: bytes }; operations = []; bytes = 64; started = performance.now();
    }
    const frame = stack.at(-1);
    if (frame.index >= countOf(frame.value, frame.keys)) { stack.pop(); continue; }
    const key = frame.keys ? frame.keys[frame.index++] : frame.index++;
    const value = frame.value[key]; const path = [...frame.path, key];
    const pathBytes = path.reduce((sum, part) => sum + (typeof part === 'string' ? part.length * 2 + 16 : 16), 64);
    // Preserve identity already present in the document, never merge merely
    // similar figures. Movie-clip libraries often reuse the same definitions.
    const figureEntry=sharedFigures&&path.at(-2)==='figure_types'&&value&&typeof value==='object'&&Object.hasOwn(value,'figure_type_id')&&Array.isArray(value.segments);
    if(figureEntry){
      const reference=figures.get(value);
      if(reference){
        if(reference.every((part,i)=>path[i]===part))throw messageError(new Error(''), "errors.documentTransport.cyclicMovieclipFigureReference", {});
        const size=pathBytes+reference.reduce((sum,part)=>sum+String(part).length*2+16,64);
        if(operations.length&&bytes+size>maxBytes){yield {operations,estimatedBytes:bytes};operations=[];bytes=64;started=performance.now();}
        operations.push({path,figureReference:reference});bytes+=size;continue;
      }
      figures.set(value,path);
    }
    if (key === 'keys' && frame.value.property === 'pose' && Array.isArray(value)) {
      const reference=poseSequences.get(value);
      if(reference){
        const size=pathBytes+reference.reduce((sum,part)=>sum+String(part).length*2+16,64);
        if(operations.length&&bytes+size>maxBytes){yield {operations,estimatedBytes:bytes};operations=[];bytes=64;started=performance.now();}
        operations.push({path,reference});bytes+=size;continue;
      }
      poseSequences.set(value,path);
    }
    // Visit channel records even when small so shared sequences survive ACK
    // boundaries instead of being cloned again for every connected member.
    const visitFigures=sharedFigures&&((key==='figure_types'&&Array.isArray(value))||
      (figureEntry&&value._styk?.movieclip)||(key==='_styk'&&value?.movieclip)||
      (key==='movieclip'&&value?.document)||(key==='document'&&Array.isArray(value?.figure_types)));
    const size = visitFigures || value?.property === 'pose' && Array.isArray(value.keys) ? atomicLimit + 1 : boundedSize(value, atomicLimit);
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
    } else if (numericArray(value)) {
      // Long numeric arrays (mesh positions, pose channels) travel in bounded
      // slices rather than as one operation per element.
      const per = Math.max(1, Math.floor(atomicLimit / 24));
      for (let offset = 0; offset < value.length; offset += per) {
        const part = value.slice(offset, offset + per), size = part.length * 24 + pathBytes;
        if (operations.length && bytes + size > maxBytes) { yield { operations, estimatedBytes: bytes }; operations = []; bytes = 64; }
        operations.push(offset ? { path, extend: part } : { path, value: part }); bytes += size;
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
    if (!report || !Array.isArray(chunk.operations)) throw messageError(new Error(''), "errors.documentTransport.invalidDocumentTransportOperations", {});
    for (const operation of chunk.operations) {
      const path = operation.path;
      if (!Array.isArray(path) || !path.length) throw messageError(new Error(''), "errors.documentTransport.invalidDocumentTransportPath", {});
      let parent = report;
      for (let i = 0; i < path.length - 1; i++) {
        if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, path[i])) throw messageError(new Error(''), "errors.documentTransport.documentTransportParentHasNotArrived", {});
        parent = parent[path[i]];
      }
      const key = path.at(-1);
      if (!parent || typeof parent !== 'object' || !['string', 'number'].includes(typeof key)) throw messageError(new Error(''), "errors.documentTransport.invalidDocumentTransportDestination", {});
      if(Object.hasOwn(operation,'figureReference')){
        const reference=operation.figureReference;
        if(path.at(-2)!=='figure_types'||!Number.isInteger(key)||!Array.isArray(reference)||reference.at(-2)!=='figure_types'||!Number.isInteger(reference.at(-1))||reference.every((part,i)=>path[i]===part))
          throw messageError(new Error(''), "errors.documentTransport.invalidDocumentFigureReference", {});
        let value=report;
        for(const part of reference){if(!value||typeof value!=='object'||!Object.hasOwn(value,part))throw messageError(new Error(''), "errors.documentTransport.documentFigureReferenceHasNotArrived", {});value=value[part];}
        if(!value||!Array.isArray(value.segments)||!Object.hasOwn(value,'figure_type_id'))throw messageError(new Error(''), "errors.documentTransport.documentReferenceRequiresAFigureDefinition", {});
        ownSet(parent,key,value);
      } else if (Object.hasOwn(operation, 'reference')) {
        if(!Array.isArray(operation.reference)||!operation.reference.length)throw messageError(new Error(''), "errors.documentTransport.invalidDocumentSequenceReference", {});
        let value=report;
        for(const part of operation.reference){
          if(!value||typeof value!=='object'||!Object.hasOwn(value,part))throw messageError(new Error(''), "errors.documentTransport.documentSequenceReferenceHasNotArrived", {});
          value=value[part];
        }
        if(!Array.isArray(value)||key!=='keys'||parent.property!=='pose')throw messageError(new Error(''), "errors.documentTransport.documentReferencesRequireAPoseKeySequence", {});
        ownSet(parent,key,value);
      } else if (Object.hasOwn(operation, 'extend')) {
        if (!Array.isArray(parent[key]) || !Array.isArray(operation.extend)) throw messageError(new Error(''), "errors.documentTransport.documentArrayFragmentsArrivedOutOfOrder", {});
        const target = parent[key];
        for (const item of operation.extend) target.push(item);
      } else if (Object.hasOwn(operation, 'append')) {
        if (!Object.hasOwn(parent, key) || typeof parent[key] !== 'string' || typeof operation.append !== 'string') throw messageError(new Error(''), "errors.documentTransport.documentStringFragmentsArrivedOutOfOrder", {});
        ownSet(parent, key, parent[key] + operation.append);
      } else ownSet(parent, key, operation.value);
    }
    return report;
  }
  // Read compatibility for the first table-batch protocol and profiling tools.
  if (!TABLES.has(chunk.table) || !Array.isArray(chunk.values)) throw messageError(new Error(''), "errors.documentTransport.invalidDocumentTransportTable", {});
  let target = report?.[chunk.table];
  if (chunk.nested) {
    if (!((chunk.table === 'figure_types' && chunk.nested === 'segments') || (chunk.table === 'keyframes' && chunk.nested === 'objects')))
      throw messageError(new Error(''), "errors.documentTransport.invalidDocumentTransportRecords", {});
    target = target?.[chunk.index]?.[chunk.nested];
  }
  if (!Array.isArray(target) || target.length !== chunk.offset) throw messageError(new Error(''), "errors.documentTransport.documentTransportChunksArrivedOutOfOrder", {});
  for (const value of chunk.values) target.push(value);
  return report;
}
