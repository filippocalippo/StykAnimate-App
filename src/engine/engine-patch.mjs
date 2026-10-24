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
 * Returns the root keys the patch touched, in order.
 */
export function applyDocumentPatch(root, ops) {
  const fresh = new Set([root]);
  const touched = [];
  const own = (parent, key) => {
    const child = parent[key];
    if (child === null || typeof child !== 'object') throw new Error(`The document patch steps into ${typeof child} at ${String(key)}.`);
    if (fresh.has(child)) return child;
    const copy = Array.isArray(child) ? child.slice() : copyObject(child);
    parent[key] = copy; fresh.add(copy);
    return copy;
  };
  for (const op of ops) {
    const path = op.p;
    if (!path.length) {
      // The root keeps its identity: rebuild its keys in place.
      if (!op.o) throw new Error('The document patch replaces its root.');
      const before = {...root};
      for (const key of Object.keys(root)) delete root[key];
      for (const [key, ...value] of op.o) root[key] = value.length ? value[0] : before[key];
      touched.push(...Object.keys(root));
      continue;
    }
    if (!touched.includes(path[0])) touched.push(path[0]);
    let parent = root;
    for (let at = 0; at < path.length - 1; at++) parent = own(parent, path[at]);
    const key = path.at(-1);
    if (Object.hasOwn(op, 'v')) parent[key] = op.v;
    else if (op.x) delete parent[key];
    else if (op.a) {
      const before = parent[key];
      const next = op.a.map(ref => typeof ref === 'number' ? before[ref] : ref.v);
      parent[key] = next; fresh.add(next);
    } else if (op.o) {
      const before = parent[key], next = {};
      for (const [name, ...value] of op.o) next[name] = value.length ? value[0] : before[name];
      parent[key] = next; fresh.add(next);
    } else throw new Error('The document patch has an operation it does not know.');
  }
  return touched;
}

/** A shallow copy with the same keys in the same order (integer-like keys lead, as always). */
function copyObject(object) {
  const copy = {};
  for (const key of Object.keys(object)) copy[key] = object[key];
  return copy;
}
