/**
 * The tables of the read view whose records the interface fetches from the engine's session when something reads them
 * (`report.keyframes`). The document is the session's: the view holds a record only while it is shown, in a cache bounded by
 * recency, so a document of hundreds of megabytes costs the interface the few records on screen.
 *
 * A table is an ordinary array to its readers (`Array.isArray`, `length`, indexing, `map`, `find`, `slice`, `for...of`, spread,
 * `JSON.stringify`, `structuredClone`): each index is a getter that fetches its record the first time and returns the same object
 * for as long as the table holds it. The elements have no setters: the view is changed by the session's patches, never in place
 * (src/engine/engine-patch.mjs builds the next table from the one before, copy-on-write, and the table it replaces is retired).
 *
 * What a reader needs without the record is the table's own: the identity of each (`positionOf`), which the open sends and a
 * patch keeps. A reader that walks every record fetches every record (and the cache gives the oldest back as it goes): the
 * walkers of the interface ask the session for what they need instead (docs/engine/document.md, "The read view").
 */

/** The identity of a record in each table, for finding it without fetching the others (`frameId`, `figure_type_id`). */
const IDENTITY = {
  keyframes: frame => frame?._styk?.frameId,
  figure_types: figure => figure?.figure_type_id,
};

/** The records a table holds at once. */
const LIMIT = 64;

const tables = new WeakMap();
/** The table behind `array`, or undefined for an ordinary array. */
export const tableOf = array => tables.get(array);

/** How many callers need every record to stay (`holdingAll`), and the tables that outgrew their limit meanwhile. */
let holding = 0;
const overfull = new Set();
/** Runs `read` without the tables giving records back: a read of the whole document (the tests' comparison of the view with the session's document). */
export function holdingAll(read) {
  holding++;
  try { return read(); } finally {
    if (--holding === 0) { for (const table of overfull) table.release(null); overfull.clear(); }
  }
}

class Table {
  /** `slots`: one `{record, id, used}` per index (`record` undefined until fetched). `records`: where records come from (`fetch(name, index)`). */
  constructor(name, slots, records, limit = LIMIT) {
    this.name = name; this.slots = slots; this.records = records; this.limit = limit;
    this.held = slots.reduce((count, slot) => count + (slot.record === undefined ? 0 : 1), 0);
    this.clock = 0; this.positions = null; this.retired = false;
    // What the cache cost, for the measurements of the open and of editing: `tableStats`.
    this.stats = {reads: 0, fetches: 0, fetchMs: 0};
    const array = new Array(slots.length);
    for (let index = 0; index < slots.length; index++) Object.defineProperty(array, index, {enumerable: true, configurable: true, get: () => this.read(index)});
    this.array = array;
    tables.set(array, this);
  }

  read(index) {
    const slot = this.slots[index];
    this.stats.reads++;
    if (slot.record === undefined) {
      if (this.retired) throw new Error(`The document changed since this ${this.name} table was read: read it again from the document.`);
      const started = performance.now();
      slot.record = this.records.fetch(this.name, index);
      this.stats.fetches++; this.stats.fetchMs += performance.now() - started;
      this.held++;
      if (this.held > this.limit) { if (holding === 0) this.release(slot); else overfull.add(this); }
    }
    slot.used = ++this.clock;
    return slot.record;
  }

  /** The record at `index` for a patch to copy: the one held; else (`strict` false) the session's; else the patch is wrong, as it names a record the call said the view lacks. */
  peek(index, strict) {
    const slot = this.slots[index];
    if (!slot) throw new Error(`The document patch steps into ${this.name}[${index}], which the table does not have.`);
    if (slot.record === undefined && strict) throw new Error(`The document patch changes ${this.name}[${index}], which the view has not fetched.`);
    return this.read(index);
  }

  /** Gives the oldest records back until the table holds three quarters of its limit (`keep` stays). */
  release(keep) {
    const held = this.slots.filter(slot => slot.record !== undefined && slot !== keep).sort((a, b) => a.used - b.used);
    for (const slot of held) {
      if (this.held <= this.limit * 0.75) break;
      slot.id = IDENTITY[this.name](slot.record);
      slot.record = undefined; this.held--;
    }
  }

  /** The indices of the records the table holds. */
  fetched() {
    const indices = [];
    this.slots.forEach((slot, index) => { if (slot.record !== undefined) indices.push(index); });
    return indices;
  }

  /** The index of the record with identity `id` (the last one with it for `last`, else the first), or -1. */
  positionOf(id, last = false) {
    if (id === undefined || id === null) return -1;
    if (!this.positions) {
      const identity = IDENTITY[this.name], positions = this.positions = {first: new Map(), last: new Map()};
      this.slots.forEach((slot, index) => {
        const key = slot.record === undefined ? slot.id : identity(slot.record);
        if (key === undefined || key === null) return;
        if (!positions.first.has(key)) positions.first.set(key, index);
        positions.last.set(key, index);
      });
    }
    return (last ? this.positions.last : this.positions.first).get(id) ?? -1;
  }

  /** Replaces the record at `index` (a patch sets it). */
  put(index, record) {
    const slot = this.slots[index];
    if (!slot) throw new Error(`The document patch sets ${this.name}[${index}], which the table does not have.`);
    if (slot.record === undefined) this.held++;
    slot.record = record; slot.used = ++this.clock; this.positions = null;
  }

  /** The table a patch makes of this one, to change in place: the same records, held or not. This table is retired (`retire`), as the
   * document no longer has it; a copy made to show a variation of the document leaves it in use. */
  copy(retire = true) {
    const next = new Table(this.name, this.slots.map(slot => ({...slot})), this.records, this.limit);
    next.clock = this.clock; next.stats = this.stats; this.retired ||= retire;
    return next.array;
  }

  /** The table of an `a` operation: each ref is the index of a record of this table (kept, held or not) or `{v}` (a record the patch carries, made by `make`). This table is retired, as with `copy`. */
  rebuild(refs, make, retire = true) {
    const identity = IDENTITY[this.name];
    const slots = refs.map(ref => {
      if (typeof ref === 'number') {
        if (!this.slots[ref]) throw new Error(`The document patch keeps ${this.name}[${ref}], which the table does not have.`);
        return {...this.slots[ref]};
      }
      const record = make(ref);
      return {record, id: identity(record), used: 0};
    });
    const next = new Table(this.name, slots, this.records, this.limit);
    next.clock = this.clock; next.stats = this.stats; this.retired ||= retire;
    return next.array;
  }
}

/**
 * A table of `count` records the session holds, to be fetched as `records.fetch(name, index)`, at most `limit` held at once. `ids`: the
 * identity of each, as the open sent them.
 */
export function lazyTable(name, count, ids, records, limit = LIMIT) {
  if (!Object.hasOwn(IDENTITY, name)) throw new Error(`The read view has no lazy table ${name}.`);
  return new Table(name, Array.from({length: count}, (_, index) => ({record: undefined, id: ids?.[index] ?? undefined, used: 0})), records, limit).array;
}

/** What the table `array` has read and fetched since the document opened (`reads`, `fetches`, `fetchMs`) and holds now. */
export function tableStats(array) {
  const table = tableOf(array);
  return table && {...table.stats, held: table.held, count: table.slots.length};
}

/** The records of each lazy table of `report` the view holds, for the session to tell a patch by (`{keyframes: [3, 4]}`). */
export function fetchedRecords(report) {
  const held = {};
  for (const name of Object.keys(IDENTITY)) {
    const table = tableOf(report?.[name]);
    if (table) held[name] = table.fetched();
  }
  return held;
}
