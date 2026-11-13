/**
 * A ranked list that holds still while its values move (developer build only). The live lists of the performance
 * tab are read four times a second; sorted afresh each time, two rows of nearly equal weight would swap on every read
 * and nobody could read either. Pure: no DOM.
 */

/**
 * The rows of `rows` ({key, value}) in an order that changes only when it must: rows keep the place they had in
 * `previous` (a list of keys) until one weighs more than `margin` (a share) above the row before it; a new row enters
 * at its weight; a row whose value is no longer above zero leaves. Returns {rows: the first `limit`, order: every key in
 * order, to pass back next time}.
 */
export function steadyOrder(previous, rows, {limit = 10, margin = .25} = {}) {
  const present = new Map();
  for (const row of rows) if (row.value > 0) present.set(row.key, row);
  const list = previous.filter(key => present.has(key)).map(key => present.get(key)), placed = new Set(list.map(row => row.key));
  for (const row of [...present.values()].filter(row => !placed.has(row.key)).sort((a, b) => b.value - a.value)) {
    const at = list.findIndex(other => row.value > other.value);
    list.splice(at < 0 ? list.length : at, 0, row);
  }
  // Neighbours swap only past the margin; repeated until nothing moves, so a row that grew a lot climbs all the way.
  for (let changed = true, passes = 0; changed && passes < list.length; passes++) {
    changed = false;
    for (let index = 1; index < list.length; index++) {
      if (list[index].value > list[index - 1].value * (1 + margin)) { [list[index - 1], list[index]] = [list[index], list[index - 1]]; changed = true; }
    }
  }
  return {rows: list.slice(0, limit), order: list.map(row => row.key)};
}
