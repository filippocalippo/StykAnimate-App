import {copyField, copyRecord, defineLazyPayload, namesPayload, putField} from '../lazy-payload.mjs';

/**
 * Applies a document patch from the engine (styk-edit's `patch` module, D19) to the
 * editor's read view of the document, copy-on-write: every object and array on the path
 * to a change is replaced by a copy, everything else keeps its identity. The root object
 * itself is kept and changed in place, because the interface and the mirror hold it.
 *
 * Operations: `{p, v}` sets, `{p, x}` deletes, `{p, a}` rebuilds an array (a ref is an
 * index into the array before or `{v}`), `{p, o}` rebuilds an object (`[key]` keeps the
 * key's value before, `[key, value]` sets it). Assignment order reproduces the engine's
 * key order, which follows JavaScript's own rules.
 *
 * `payloads`: set when the patch names pictures by token (`S2P:`, an answer's `payloads` flag): a field that names one
 * becomes a lazy payload of the view (src/lazy-payload.mjs), and a string the engine escaped (`S2E:`) is restored. A
 * lazy payload a copy or a rebuild keeps stays unread.
 *
 * Returns the root keys the patch touched, in order.
 */
export function applyDocumentPatch(root, ops, payloads = null) {
  const fresh = new Set([root]);
  const touched = [];
  const own = (parent, key) => {
    const child = parent[key];
    if (child === null || typeof child !== 'object') throw new Error(`The document patch steps into ${typeof child} at ${String(key)}.`);
    if (fresh.has(child)) return child;
    const copy = Array.isArray(child) ? child.slice() : copyRecord(child);
    parent[key] = copy; fresh.add(copy);
    return copy;
  };
  /** A value the engine sent, as the view holds it: what it named by token is lazy, what it escaped is restored. */
  const received = value => payloads ? restoreNamed(value, payloads) : value;
  /** Sets `target[key]` to a value the engine sent. */
  const set = (target, key, value) => {
    if (payloads && namesPayload(value)) defineLazyPayload(target, key, value, payloads);
    else putField(target, key, received(value));
  };
  for (const op of ops) {
    const path = op.p;
    if (!path.length) {
      // The root keeps its identity: rebuild its keys in place.
      if (!op.o) throw new Error('The document patch replaces its root.');
      const before = copyRecord(root);
      for (const key of Object.keys(root)) delete root[key];
      for (const [key, ...value] of op.o) { if (value.length) set(root, key, value[0]); else copyField(root, before, key); }
      touched.push(...Object.keys(root));
      continue;
    }
    if (!touched.includes(path[0])) touched.push(path[0]);
    let parent = root;
    for (let at = 0; at < path.length - 1; at++) parent = own(parent, path[at]);
    const key = path.at(-1);
    if (Object.hasOwn(op, 'v')) set(parent, key, op.v);
    else if (op.x) delete parent[key];
    else if (op.a) {
      const before = parent[key];
      const next = op.a.map(ref => typeof ref === 'number' ? before[ref] : received(ref.v));
      parent[key] = next; fresh.add(next);
    } else if (op.o) {
      const before = parent[key], next = {};
      for (const [name, ...value] of op.o) { if (value.length) set(next, name, value[0]); else copyField(next, before, name); }
      parent[key] = next; fresh.add(next);
    } else throw new Error('The document patch has an operation it does not know.');
  }
  return touched;
}

/** `value`, which the engine sent, with its escaped strings restored and the payloads it names made lazy (in place: it is a fresh parse). */
function restoreNamed(value, payloads) {
  if (typeof value === 'string') return value.startsWith('S2E:') ? value.slice(4) : value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = restoreNamed(value[i], payloads);
    return value;
  }
  if (value && typeof value === 'object')
    for (const key of Object.keys(value)) {
      if (namesPayload(value[key])) defineLazyPayload(value, key, value[key], payloads);
      else putField(value, key, restoreNamed(value[key], payloads));
    }
  return value;
}
