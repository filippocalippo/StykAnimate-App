/**
 * The DOM pieces every tab of the developer panel builds from (developer build only): elements, buttons, numbers as
 * text, static and live tables, a ranked list with bars, a canvas that knows its size, and a file download.
 *
 * The live pieces are built once and only their text changes afterwards: a panel that refreshes four times a second
 * while a person drags must not rebuild its tables, or its own layouts show up as late frames in the chart it draws.
 */

export const element = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
};
export const button = (label, onclick, title = '') => element('button', {className: 'dt-button', textContent: label, onclick, title, type: 'button'});

/** A number as text: integers as they are, others with `digits` decimals; '–' for nothing. */
export const format = (value, digits = 2) => (value === null || value === undefined || Number.isNaN(value) ? '–' : typeof value === 'number' ? (Number.isInteger(value) ? String(value) : value.toFixed(digits)) : String(value));
export const megabytes = bytes => (Number.isFinite(bytes) && bytes >= 0 ? `${(bytes / 1048576).toFixed(1)} MB` : '–');
export const milliseconds = (value, digits = 1) => (Number.isFinite(value) ? `${value.toFixed(digits)} ms` : '–');
export const percent = share => (Number.isFinite(share) ? `${Math.round(share * 100)}%` : '–');

/** Sets a node's text only when it changed: an unchanged text costs no style or layout. */
export function setText(node, text) {
  if (node.dtText !== text) { node.dtText = text; node.textContent = text; }
}

/** A table built once, for the tabs that rebuild on demand (the inspector, the parameters). */
export const table = (head, rows, numeric = []) => element('table', {},
  element('thead', {}, element('tr', {}, ...head.map((name, i) => element('th', {textContent: name, className: numeric.includes(i) ? 'num' : ''})))),
  element('tbody', {}, ...rows.map(row => element('tr', {}, ...row.map((cell, i) => (cell instanceof Node ? element('td', {}, cell) : element('td', {textContent: format(cell), className: numeric.includes(i) ? 'num' : ''})))))));

/**
 * A table whose rows are kept by key: `update(rows)` ({key, cells}) adds and removes rows as keys come and go and sets
 * only the cells whose text changed. Cells are text (numbers through `format`).
 */
export function liveTable(head, {numeric = []} = {}) {
  const body = element('tbody'), rows = new Map();
  const root = element('table', {}, element('thead', {}, element('tr', {}, ...head.map((name, i) => element('th', {textContent: name, className: numeric.includes(i) ? 'num' : ''})))), body);
  return {
    element: root,
    update(list) {
      const seen = new Set();
      let previous = null;
      for (const {key, cells} of list) {
        seen.add(key);
        let row = rows.get(key);
        if (!row) rows.set(key, row = element('tr', {}, ...cells.map((_, i) => element('td', {className: numeric.includes(i) ? 'num' : ''}))));
        cells.forEach((cell, i) => setText(row.children[i], typeof cell === 'string' ? cell : format(cell)));
        // Keeps the list's order with as few moves as the order needs.
        if ((previous ? previous.nextSibling : body.firstChild) !== row) body.insertBefore(row, previous ? previous.nextSibling : body.firstChild);
        previous = row;
      }
      for (const [key, row] of rows) if (!seen.has(key)) { row.remove(); rows.delete(key); }
    },
  };
}

/**
 * A ranked list: `limit` rows built once, each a name with a bar of `share` (0 to 1) behind it, then the numbers of
 * `head` (`titles` explains each heading on hover). The bar is drawn with a transform, so it never lays out, and sits
 * behind the name so a narrow panel keeps its room for the name. `update(rows)`: [{name, title, share, cells}], at
 * most `limit`.
 */
export function rankedList(head, {limit = 10, empty = 'Nothing yet.', titles = []} = {}) {
  const body = element('tbody'), rows = [];
  for (let index = 0; index < limit; index++) {
    const fill = element('div', {className: 'dt-bar-fill'}), label = element('span', {className: 'dt-label'}), name = element('td', {className: 'dt-name'}, fill, label);
    const numbers = head.slice(1).map(() => element('td', {className: 'num'}));
    const row = element('tr', {hidden: true}, name, ...numbers);
    rows.push({row, name, label, fill, numbers});
    body.append(row);
  }
  const none = element('div', {className: 'dt-dim dt-empty', textContent: empty});
  const root = element('div', {}, element('table', {className: 'dt-ranked'},
    element('colgroup', {}, element('col'), ...head.slice(1).map(() => element('col', {className: 'dt-col-num'}))),
    element('thead', {}, element('tr', {}, ...head.map((text, i) => element('th', {textContent: text, title: titles[i] ?? '', className: i > 0 ? 'num' : ''})))), body), none);
  return {
    element: root,
    update(list) {
      rows.forEach((slot, index) => {
        const item = list[index];
        if (slot.row.hidden !== !item) slot.row.hidden = !item;
        if (!item) return;
        setText(slot.label, item.name);
        if (slot.name.title !== (item.title ?? item.name)) slot.name.title = item.title ?? item.name;
        const scale = `scaleX(${Math.max(0, Math.min(1, item.share || 0)).toFixed(3)})`;
        if (slot.fill.style.transform !== scale) slot.fill.style.transform = scale;
        item.cells.forEach((cell, i) => setText(slot.numbers[i], typeof cell === 'string' ? cell : format(cell)));
      });
      if (none.hidden !== list.length > 0) none.hidden = list.length > 0;
    },
  };
}

/**
 * Named values in a grid that wraps to the width it has (the jobs tab's single-row facts): `update(values)` sets each
 * value, in the order of `labels`, as text (numbers through `format`).
 */
export function facts(labels) {
  const values = labels.map(() => element('span', {className: 'dt-fact-value'}));
  const root = element('div', {className: 'dt-facts'}, ...labels.map((label, i) => element('div', {className: 'dt-fact'}, element('span', {className: 'dt-dim', textContent: label}), values[i])));
  return {element: root, update(list) { list.forEach((value, i) => setText(values[i], typeof value === 'string' ? value : format(value))); }};
}

/** A small labelled number (a tile): `update(value, sub, mark)`; `mark` is a grade word shown beside the value. */
export function tile(label, title = '') {
  const value = element('div', {className: 'dt-tile-value'}), mark = element('span', {className: 'dt-grade'}), sub = element('div', {className: 'dt-tile-sub dt-dim'});
  const root = element('div', {className: 'dt-tile', title}, element('div', {className: 'dt-tile-label dt-dim', textContent: label}), element('div', {className: 'dt-tile-row'}, value, mark), sub);
  return {
    element: root,
    update(text, subText = '', grade = null) {
      setText(value, text); setText(sub, subText); setText(mark, grade ?? '');
      if (mark.dataset.grade !== (grade ?? '')) mark.dataset.grade = grade ?? '';
    },
  };
}

/**
 * A canvas whose drawing buffer follows its size on screen at the display's pixel ratio. The size is read by a
 * ResizeObserver (after layout, so a refresh never forces one); `draw(context, width, height)` runs on each change of
 * size and whenever `redraw()` is called. Returns {canvas, redraw}.
 */
export function sizedCanvas(className, draw) {
  const canvas = element('canvas', {className});
  let width = 0, height = 0;
  const redraw = () => {
    if (!width || !height) return;
    const ratio = globalThis.devicePixelRatio || 1, pixelsWide = Math.round(width * ratio), pixelsHigh = Math.round(height * ratio);
    if (canvas.width !== pixelsWide || canvas.height !== pixelsHigh) { canvas.width = pixelsWide; canvas.height = pixelsHigh; }
    const context = canvas.getContext('2d');
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    draw(context, width, height);
  };
  new ResizeObserver(entries => {
    const box = entries.at(-1).contentRect;
    if (box.width === width && box.height === height) return;
    width = box.width; height = box.height;
    redraw();
  }).observe(canvas);
  return {canvas, redraw, size: () => ({width, height})};
}

export function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], {type: 'application/json'}));
  const link = element('a', {href: url, download: name});
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** A file name stamped with the time: `StykAnimate-<what>-2026-11-13T10-00-00-000Z.json`. */
export const stamped = what => `StykAnimate-${what}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

/**
 * Lets the header move the floating panel (a bare page; docked, the dock host moves it). The tools listen through
 * handler properties (`onpointermove`), never `addEventListener`: the early script times every listener added that way
 * as the app's input handling (`on pointermove (canvas)`), and the tools' own would be counted as the app's.
 */
export function dragBy(handle, panel) {
  handle.onpointerdown = event => {
    if (event.target !== handle && !event.target.classList?.contains('dt-mark')) return;
    const rect = panel.getBoundingClientRect(), dx = event.clientX - rect.left, dy = event.clientY - rect.top;
    handle.setPointerCapture(event.pointerId);
    handle.onpointermove = moved => { panel.style.left = `${Math.max(0, moved.clientX - dx)}px`; panel.style.top = `${Math.max(0, moved.clientY - dy)}px`; panel.style.right = 'auto'; panel.style.bottom = 'auto'; };
    handle.onpointerup = handle.onpointercancel = () => { handle.onpointermove = null; handle.onpointerup = null; handle.onpointercancel = null; };
  };
}
