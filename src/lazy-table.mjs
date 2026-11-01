/**
 * The tables of the read view whose records the interface fetches from the engine's session when something reads them
 * (`report.keyframes`, `report.figure_types`). The document is the session's: the view holds a record only while it is shown, in a cache bounded by
 * recency, so a document of hundreds of megabytes costs the interface the few records on screen.
 *
 * A table is an ordinary array to its readers (`Array.isArray`, `length`, indexing, `map`, `find`, `slice`, `for...of`, spread,
 * `JSON.stringify`, `structuredClone`): each index is a getter that fetches its record the first time and returns the same object
 * for as long as the table holds it. The elements have no setters: the view is changed by the session's patches, never in place
 * (src/engine/engine-patch.mjs builds the next table from the one before, copy-on-write, and the table it replaces is retired).
 *
 * What a reader needs without the record is the table's own: its row (`rows`), which the open sends and a patch keeps, and the identity
 * in it (`positionOf`). A reader that walks every record fetches every record (and the cache gives the oldest back as it goes): the
 * walkers of the interface ask the session for what they need instead (docs/engine/document.md, "The read view").
 */

/**
 * What a table knows of each record without fetching it: its row. A keyframe's is its identity (`frameId`). A figure type's is
 * `{id, name, cel, kind, segments, pictures}` (styk_edit::figure_row, which the open sends): enough to find a type by id, to list the
 * figures of the project, to find the drawing cels and to answer the questions the interface asks of every type. The row of a record
 * the table holds is read from the record, so it follows the record's changes; the row of one it does not is the open's, kept
 * through patches (a record the session replaces comes whole).
 */
const ROW = {
  keyframes: frameRow,
  figure_types: figureRow,
};
const IDENTITY = {keyframes: row => row.id, figure_types: row => row.id};

/** The row of a keyframe: its identity, background, colour override and length, and how many figures it holds (styk_edit::frame_row). */
export function frameRow(frame) {
  return {id: frame?._styk?.frameId ?? null, background: frame?.background_id ?? null, color: frame?._stykBackgroundColor ?? null, duration: frame?.duration_raw ?? null, figures: frame?.objects?.length ?? 0};
}

/** What the interface shows of the stored frame at `index` of `frames` (its background, colour override, length and figure count), read without fetching the record. */
export function frameSummary(frames, index) {
  const table = tableOf(frames);
  return table ? table.rowAt(index) : frameRow(frames[index]);
}

/** The row of a figure type (see `ROW`). */
export function figureRow(figure) {
  const kind = figure?._styk?.movieclip ? 'Movieclip' : figure?.text_assets?.length ? 'Text' : figure?.image_assets?.length ? 'Image' : 'Figure';
  const imageSegment = figure?.segments?.some?.(segment => segment.segment_type === 'image' || segment.segment_kind === 'image' || segment.primitive_code === 2);
  return {id: figure?.figure_type_id ?? null, name: figure?.name ?? null, cel: figure?._styk?.drawing?.celId ?? null, kind,
    segments: figure?.segment_count ?? figure?.segments?.length ?? null, pictures: Boolean(figure?.image_assets?.length || imageSegment)};
}

/** The records each table holds at once: a frame on show and the ones around it; the types a frame on show draws (a document of a few hundred types keeps all it has drawn: scrubbing across it would otherwise fetch and rebuild what hangs on a definition at every seek). */
const LIMITS = {keyframes: 64, figure_types: 1024, '_styk.frameSources': 64};

/**
 * Makes the tables created from now hold at most `limit` records, and gives records back even in verify mode (a test of the cache's
 * eviction: `holdAllRecords` would defeat it); the returned function puts things back.
 */
export function limitRecords(limit) {
  const before = {...LIMITS};
  for (const name of Object.keys(LIMITS)) LIMITS[name] = limit;
  evictingTests++;
  return () => { Object.assign(LIMITS, before); evictingTests--; };
}
let evictingTests = 0;

const tables = new WeakMap();
/** The table behind `array`, or undefined for an ordinary array. */
export const tableOf = array => tables.get(array);

/** How many callers need every record to stay (`holdingAll`), and the tables that outgrew their limit meanwhile. */
let holding = 0;
const overfull = new Set();
/**
 * Keeps every record the tables fetch until the returned function is called: the tests' verify mode (src/engine/engine-owner.mjs) compares the
 * view with the session's document, and a record written in place that the table gave back before the comparison would not show.
 */
export function holdAllRecords() {
  if (evictingTests) return () => {};
  holding++;
  let held = true;
  return () => { if (held) { held = false; if (--holding === 0) trim(); } };
}
const trim = () => { for (const table of overfull) table.release(null); overfull.clear(); };

/** Runs `read` without the tables giving records back: a read of the whole document (the tests' comparison of the view with the session's document). */
export function holdingAll(read) {
  holding++;
  try { return read(); } finally {
    if (--holding === 0) trim();
  }
}

class Table {
  /** `slots`: one `{record, row, used}` per index (`record` undefined until fetched). `records`: where records come from (`fetch(name, index)`). */
  constructor(name, slots, records, limit = LIMITS[name]) {
    this.name = name; this.slots = slots; this.records = records; this.limit = limit;
    this.held = slots.reduce((count, slot) => count + (slot.record === undefined ? 0 : 1), 0);
    this.clock = 0; this.positions = null; this.retired = false;
    const array = new Array(slots.length);
    for (let index = 0; index < slots.length; index++) Object.defineProperty(array, index, {enumerable: true, configurable: true, get: () => this.read(index)});
    this.array = array;
    tables.set(array, this);
  }

  read(index) {
    const slot = this.slots[index];
    if (slot.record === undefined) {
      // A record given back that something else still holds is the record: the same object, so what is keyed by it stays valid.
      const revived = slot.weak?.deref();
      if (revived === undefined && this.retired) throw new Error(`The document changed since this ${this.name} table was read: read it again from the document.`);
      slot.record = revived ?? this.records.fetch(this.name, index);
      slot.weak = undefined;
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
      slot.row = ROW[this.name](slot.record);
      slot.weak = new WeakRef(slot.record);
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
      const positions = this.positions = {first: new Map(), last: new Map()};
      this.rows().forEach((row, index) => {
        const key = IDENTITY[this.name](row);
        if (key === undefined || key === null) return;
        if (!positions.first.has(key)) positions.first.set(key, index);
        positions.last.set(key, index);
      });
    }
    return (last ? this.positions.last : this.positions.first).get(id) ?? -1;
  }

  /** Makes the record at `index` one the view does not hold, with the row the session sent (a patch replaced it and sent no record). On a copy the patch owns. */
  setUnfetched(index, row) {
    const slot = this.slots[index];
    if (!slot) throw new Error(`The document patch sets ${this.name}[${index}], which the table does not have.`);
    if (slot.record !== undefined) this.held--;
    slot.record = undefined; slot.weak = undefined; slot.row = row; slot.used = 0; this.positions = null;
  }

  /** The row of the record at `index`, without fetching it. */
  rowAt(index) {
    const slot = this.slots[index];
    if (!slot) return ROW[this.name](undefined);
    return slot.record === undefined ? slot.row : ROW[this.name](slot.record);
  }

  /** The row of every record, in order, without fetching any. */
  rows() {
    const row = ROW[this.name];
    return this.slots.map(slot => slot.record === undefined ? slot.row : row(slot.record));
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
    // A copy that is not the document's holds records the session does not have (a variation to show): they cannot be given back.
    const next = new Table(this.name, this.slots.map(slot => ({...slot})), this.records, retire ? this.limit : Infinity);
    next.clock = this.clock; this.retired ||= retire;
    return next.array;
  }

  /** A table like this one with `extra` records after them; this table stays in use. */
  extended(extra) {
    const row = ROW[this.name];
    const next = new Table(this.name, [...this.slots.map(slot => ({...slot})), ...extra.map(record => ({record, row: row(record), used: 0}))], this.records, Infinity);
    next.clock = this.clock;
    return next.array;
  }

  /** The table of an `a` operation: each ref is the index of a record of this table (kept, held or not) or `{v}` (a record the patch carries, made by `make`). This table is retired, as with `copy`. */
  rebuild(refs, make, retire = true) {
    const row = ROW[this.name];
    const slots = refs.map(ref => {
      if (typeof ref === 'number') {
        if (!this.slots[ref]) throw new Error(`The document patch keeps ${this.name}[${ref}], which the table does not have.`);
        return {...this.slots[ref]};
      }
      // A record the session did not send (`lz`): the view holds its row alone, and fetches it when it is read.
      if (Object.hasOwn(ref, 'lz')) return {record: undefined, row: ref.lz, used: 0};
      const record = make(ref);
      return {record, row: row(record), used: 0};
    });
    const next = new Table(this.name, slots, this.records, retire ? this.limit : Infinity);
    next.clock = this.clock; this.retired ||= retire;
    return next.array;
  }
}

/**
 * A table of records by key (`report._styk.frameSources`): an object to its readers (`Object.keys`, `Object.hasOwn`, `Object.values`, indexing by
 * key, `JSON.stringify`, `structuredClone`) whose entries are getters that fetch their record the first time, as a `Table`'s. A patch gives
 * it keys without records (`lz`): the entries it never held are the session's to answer.
 */
class KeyedTable {
  /** `slots`: a Map from key to `{record, used}`, in the order of the object. */
  constructor(name, slots, records, limit = LIMITS[name]) {
    this.name = name; this.slots = slots; this.records = records; this.limit = limit;
    this.held = 0; for (const slot of slots.values()) if (slot.record !== undefined) this.held++;
    this.clock = 0; this.retired = false;
    const object = {};
    for (const key of slots.keys()) Object.defineProperty(object, key, {enumerable: true, configurable: true, get: () => this.read(key)});
    this.array = object;
    tables.set(object, this);
  }

  read(key) {
    const slot = this.slots.get(key);
    if (slot.record === undefined) {
      const revived = slot.weak?.deref();
      if (revived === undefined && this.retired) throw new Error(`The document changed since this ${this.name} table was read: read it again from the document.`);
      slot.record = revived ?? this.records.fetch(this.name, key);
      slot.weak = undefined;
      this.held++;
      if (this.held > this.limit) { if (holding === 0) this.release(slot); else overfull.add(this); }
    }
    slot.used = ++this.clock;
    return slot.record;
  }

  peek(key, strict) {
    const slot = this.slots.get(key);
    if (!slot) throw new Error(`The document patch steps into ${this.name}[${key}], which the table does not have.`);
    if (slot.record === undefined && strict) throw new Error(`The document patch changes ${this.name}[${key}], which the view has not fetched.`);
    return this.read(key);
  }

  release(keep) {
    const held = [...this.slots.values()].filter(slot => slot.record !== undefined && slot !== keep).sort((a, b) => a.used - b.used);
    for (const slot of held) {
      if (this.held <= this.limit * 0.75) break;
      slot.weak = new WeakRef(slot.record);
      slot.record = undefined; this.held--;
    }
  }

  /** The keys of the records the table holds. */
  fetched() {
    return [...this.slots].filter(([, slot]) => slot.record !== undefined).map(([key]) => key);
  }

  /** Sets the record under `key` (a patch sets it); a new key joins the object after the others. */
  put(key, record) {
    let slot = this.slots.get(key);
    if (!slot) {
      this.slots.set(key, slot = {record: undefined, used: 0});
      Object.defineProperty(this.array, key, {enumerable: true, configurable: true, get: () => this.read(key)});
    }
    if (slot.record === undefined) this.held++;
    slot.record = record; slot.used = ++this.clock;
  }

  /** The table a patch makes of this one with `entries` applied, in the order they give: `[key]` keeps the entry, `[key, record]` sets it, `[key, null, 1]` is one the view does not hold. This table is retired as `Table.copy` retires its own. */
  rebuild(entries, make, retire = true) {
    const slots = new Map();
    for (const [key, ...value] of entries) {
      if (value.length === 0) {
        const kept = this.slots.get(key);
        if (!kept) throw new Error(`The document patch keeps ${this.name}[${key}], which the table does not have.`);
        slots.set(key, {...kept});
      } else if (value[1] === 1) slots.set(key, {record: undefined, used: 0});
      else slots.set(key, {record: make(value[0]), used: 0});
    }
    const next = new KeyedTable(this.name, slots, this.records, retire ? this.limit : Infinity);
    next.clock = this.clock; this.retired ||= retire;
    return next.array;
  }

  /** Makes the entry `key` one the view does not hold (a patch says the session changed it, or added it, and sends no record). On a copy the patch owns. */
  setUnfetched(key, ignored) {
    void ignored;
    const slot = this.slots.get(key);
    if (slot) { if (slot.record !== undefined) this.held--; slot.record = undefined; slot.weak = undefined; return; }
    this.slots.set(key, {record: undefined, used: 0});
    Object.defineProperty(this.array, key, {enumerable: true, configurable: true, get: () => this.read(key)});
  }

  /** Takes the entry `key` away (a patch deletes it). On a copy the patch owns. */
  remove(key) {
    const slot = this.slots.get(key);
    if (!slot) return;
    if (slot.record !== undefined) this.held--;
    this.slots.delete(key); delete this.array[key];
  }

  /** A copy to change in place (`own` of a patch); this table is retired when the document no longer has it. */
  copy(retire = true) {
    const next = new KeyedTable(this.name, new Map([...this.slots].map(([key, slot]) => [key, {...slot}])), this.records, retire ? this.limit : Infinity);
    next.clock = this.clock; this.retired ||= retire;
    return next.array;
  }
}

/** A table of records by key holding `keys` (as an `lz` operation or the open names them), none fetched yet. */
export function lazyKeyedTable(name, keys, records) {
  return new KeyedTable(name, new Map(keys.map(key => [key, {record: undefined, used: 0}])), records).array;
}

/**
 * A table of `count` records the session holds, to be fetched as `records.fetch(name, index)`, at most `limit` held at once. `ids`: the
 * row of each, as the open sent them.
 */
export function lazyTable(name, count, rows, records, limit = LIMITS[name]) {
  if (!Object.hasOwn(ROW, name)) throw new Error(`The read view has no lazy table ${name}.`);
  return new Table(name, Array.from({length: count}, (_, index) => ({record: undefined, row: rows?.[index] ?? null, used: 0})), records, limit).array;
}

/** The table of the figure types `figures` and `extra` after them, which the document does not hold: a variation to show (a drawing's first stroke), the lazy records shared. */
export function withRecords(figures, extra) {
  const table = tableOf(figures);
  if (!table) return [...figures, ...extra];
  return table.extended(extra);
}

/** The records of each lazy table of `report` the view holds, for the session to tell a patch by (`{keyframes: [3, 4]}`). */
export function fetchedRecords(report) {
  const held = {};
  for (const name of Object.keys(ROW)) {
    const table = tableOf(report?.[name]);
    if (table) held[name] = table.fetched();
  }
  // The pose sources are keys the view can always take without their records: none held is a table the patch may make.
  if (recordsOf(report)) held['_styk.frameSources'] = tableOf(report?._styk?.frameSources)?.fetched() ?? [];
  return held;
}

const sources = new WeakMap();
/** Where the records of the lazy tables of `report` come from, for the tables a patch makes (`lz`). */
export const recordsOf = report => sources.get(report);
/** Records where the records of `report`'s tables come from. */
export const useRecords = (report, records) => sources.set(report, records);
