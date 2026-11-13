/**
 * Which parts of the interface were rewritten during a stretch of time (developer build only; docs/DEVTOOLS.md).
 *
 * Every write to the page (a text, a style, a class, a child added) makes the browser recalculate style, lay out,
 * paint and rasterize some of it again, on the interface thread and in the graphics process. A profile shows that
 * cost under the browser's own names; this says which elements caused it: per element, how many times its attributes,
 * its text and its children were written, and how many of those writes put back the value that was already there
 * (`unchanged`: the browser repaints nothing for them, but the code that made them ran for nothing). An element
 * rewritten on every frame of a drag or of playback is work a quiet interface would not do.
 *
 * It observes the whole document while it runs, which costs a little per write, so a capture asks for it only in the
 * pass that explains (`trace.start {writes: true}`), never in a timed one.
 */

/** Elements kept apart, most written first; writes to more elements than this are only counted in the total. */
const KEPT = 400;

/**
 * A short, stable name for an element: its id, or the nearest ancestor's id with the element's own tag and first
 * classes (`#timeline div.sheet-playhead`), so the same element reads the same on every write.
 */
export function elementName(element) {
  if (!element || element.nodeType !== 1) return '(text)';
  if (element.id) return `#${element.id}`;
  const classes = typeof element.className === 'string' ? element.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
  const own = [element.localName, ...classes].join('.');
  for (let ancestor = element.parentElement, depth = 0; ancestor && depth < 12; ancestor = ancestor.parentElement, depth++) if (ancestor.id) return `#${ancestor.id} ${own}`;
  return own;
}

/**
 * Whether each of a batch of mutation records left its value as it was. Records come in the order the writes
 * happened and carry the value before; the value after a write is the value before the next write to the same
 * attribute (or text), or what the element holds now. Returns a parallel array of booleans.
 */
export function unchangedWrites(records) {
  const after = new Map(), same = new Array(records.length).fill(false);
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index];
    if (record.type === 'childList') continue;
    let byName = after.get(record.target);
    if (!byName) after.set(record.target, byName = new Map());
    const name = record.type === 'attributes' ? record.attributeName : '';
    const later = byName.has(name) ? byName.get(name) : record.type === 'attributes' ? record.target.getAttribute(name) : record.target.data;
    same[index] = record.oldValue === later;
    byName.set(name, record.oldValue);
  }
  return same;
}

/**
 * Starts observing `root`'s subtree. Returns {stop()}: stop ends it and resolves the tally
 * {writes, unchanged, elements, rows: [{element, attributes, text, children, unchanged, names, nodes}]}, heaviest
 * first. `names` lists the attributes written on that element (`style`, `class`, `aria-valuenow`); `nodes` how many
 * elements share the name (the rows of a list).
 */
export function recordWrites(root = document.documentElement) {
  const byElement = new Map();
  let writes = 0, unchanged = 0;
  const tally = (records) => {
    const same = unchangedWrites(records);
    records.forEach((record, index) => {
      // A text node's change belongs to the element that shows it.
      const element = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      // The tools' own panel and overlay rewrite themselves while they are open: not the app's cost.
      if (element?.closest?.('#styk-devtools, #styk-devtools-overlay')) return;
      writes++;
      if (same[index]) unchanged++;
      let row = byElement.get(element);
      if (!row) {
        if (byElement.size >= KEPT) return;
        byElement.set(element, row = {attributes: 0, text: 0, children: 0, unchanged: 0, names: new Set()});
      }
      if (same[index]) row.unchanged++;
      if (record.type === 'attributes') { row.attributes++; row.names.add(record.attributeName); }
      else if (record.type === 'characterData') row.text++;
      else row.children++;
    });
  };
  const observer = new MutationObserver(tally);
  observer.observe(root, {subtree: true, childList: true, attributes: true, characterData: true, attributeOldValue: true, characterDataOldValue: true});
  return {
    stop() {
      tally(observer.takeRecords());
      observer.disconnect();
      // Elements that share a name are added up: the name is what a person can act on.
      const byName = new Map();
      for (const [element, row] of byElement) {
        const name = elementName(element), kept = byName.get(name) ?? {element: name, attributes: 0, text: 0, children: 0, unchanged: 0, names: new Set(), nodes: 0};
        kept.attributes += row.attributes; kept.text += row.text; kept.children += row.children; kept.unchanged += row.unchanged; kept.nodes++;
        for (const attribute of row.names) kept.names.add(attribute);
        byName.set(name, kept);
      }
      const total = row => row.attributes + row.text + row.children;
      const rows = [...byName.values()].map(row => ({...row, names: [...row.names].sort().slice(0, 6)})).sort((a, b) => total(b) - total(a));
      return {writes, unchanged, elements: byElement.size, rows: rows.slice(0, 30)};
    },
  };
}
