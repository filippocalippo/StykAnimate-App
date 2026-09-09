/**
 * Transient polygon connections; committing/cancelling remains the caller's job.
 *
 * Accepts a figure definition {segments}, or evaluated geometry {fig, joints}.
 * Topology is copied once; neither the definition nor its poses are changed.
 * Initial handles form a baseline without undo history. The handles getter
 * returns a copy, without a duplicated closing vertex. Complete means the first
 * handle was explicitly clicked again; callers may also finish any >=3 handles.
 *
 * Pivot 5.2 polygon_fill.htm specifies shortest segment chains and grouped undo.
 * Native 0xB08196 uses VertexPath; 0xB081DD skips already-selected intermediate
 * vertices; 0xB0826F stores the connection group's count. Closure is checked
 * before Ctrl routing at 0xB08143. BFS matches the unique path in a valid tree.
 */
export class PolygonDraft {
  #adjacency = new Map();
  #handles = [];
  #selected = new Set();
  #undo = [];
  #redo = [];
  #complete = false;

  constructor(graph, {handles = []} = {}) {
    const segments = graph?.fig?.segments ?? graph?.segments;
    if (!Array.isArray(segments)) throw new TypeError('A polygon draft needs figure segments.');
    const validId = id => Number.isSafeInteger(id) && id >= 0;
    this.#adjacency.set(0, []);
    const edges = [];
    for (const segment of segments) {
      const from = segment?.parent_id, to = segment?.segment_id;
      if (!validId(from) || !validId(to)) throw new TypeError('Polygon handle IDs must be nonnegative integers.');
      if (!this.#adjacency.has(to)) this.#adjacency.set(to, []);
      edges.push([from, to]);
    }
    for (const [from, to] of edges) {
      if (!this.#adjacency.has(from)) throw new TypeError('A polygon segment refers to a missing parent handle.');
      this.#adjacency.get(from).push(to);
      this.#adjacency.get(to).push(from);
    }
    if (!Array.isArray(handles)) throw new TypeError('Polygon draft handles must be an array.');
    for (let i = 0; i < handles.length; i++) {
      const id = handles[i];
      if (i === handles.length - 1 && this.#handles.length >= 3 && id === this.#handles[0]) {
        this.#complete = true;
      } else {
        if (!this.#adjacency.has(id) || this.#selected.has(id))
          throw new TypeError('Polygon draft handles must be distinct existing handles.');
        this.#handles.push(id);
        this.#selected.add(id);
      }
    }
  }

  get handles() { return this.#handles.slice(); }
  get complete() { return this.#complete; }
  get canUndo() { return this.#undo.length > 0; }
  get canRedo() { return this.#redo.length > 0; }

  /** Append a connection, or mark closure. Failed/repeated input changes nothing. */
  append(handle, {chain = false} = {}) {
    if (this.#complete || !this.#adjacency.has(handle)) return false;
    if (this.#handles.length >= 3 && handle === this.#handles[0]) {
      this.#record([], true);
      return true;
    }
    if (this.#selected.has(handle)) return false;
    let added;
    if (chain && this.#handles.length) {
      const path = this.#shortestPath(this.#handles.at(-1), handle);
      if (!path) return false;
      // Native skips earlier connections on the route; it does not repeat them
      // or search for a longer alternative route around them.
      added = path.filter(id => !this.#selected.has(id));
    } else added = [handle];
    this.#record(added, false);
    return true;
  }

  /** Undo exactly one click, including every connection added by its Ctrl chain. */
  undo() {
    const action = this.#undo.pop();
    if (!action) return false;
    if (action.complete) this.#complete = false;
    else {
      this.#handles.length -= action.added.length;
      for (const id of action.added) this.#selected.delete(id);
    }
    this.#redo.push(action);
    return true;
  }

  redo() {
    const action = this.#redo.pop();
    if (!action) return false;
    this.#apply(action);
    this.#undo.push(action);
    return true;
  }

  #record(added, complete) {
    const action = {added, complete};
    this.#apply(action);
    this.#undo.push(action);
    this.#redo.length = 0;
  }

  #apply(action) {
    for (const id of action.added) {
      this.#handles.push(id);
      this.#selected.add(id);
    }
    this.#complete = action.complete;
  }

  // O(V + E) work and storage, independent of numeric IDs and tree depth.
  #shortestPath(start, end) {
    const queue = [start], previous = new Map([[start, start]]);
    for (let head = 0; head < queue.length; head++) {
      const current = queue[head];
      for (const next of this.#adjacency.get(current)) {
        if (previous.has(next)) continue;
        previous.set(next, current);
        if (next === end) {
          const path = [end];
          for (let id = end; id !== start;) {
            id = previous.get(id);
            path.push(id);
          }
          return path.reverse();
        }
        queue.push(next);
      }
    }
    return null;
  }
}
