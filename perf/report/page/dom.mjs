// The page's building blocks: elements made from plain values, the one tooltip, panels, tables, and charts that draw
// at their own width. Text always goes in as text, never parsed as markup: titles, function names and errors come from
// the app and the profiler.

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Appends children: nodes as they are, anything else as text; null, undefined and false are skipped. */
export function append(element, children) {
  for (const child of [children].flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child instanceof Node ? child : String(child));
  }
  return element;
}

/** Empties `element` and appends `children` (lists flattened, as `append`). */
export const fill = (element, ...children) => { element.replaceChildren(); return append(element, children); };

function make(element, props, children) {
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'text') element.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2), value);
    else element.setAttribute(key, value === true ? '' : String(value));
  }
  return append(element, children);
}
/** An HTML element: `h('td', {class: 'num'}, '12 ms')`. Properties starting with `on` are listeners (`onclick`). */
export const h = (tag, props, ...children) => make(document.createElement(tag), props, children);
/** An SVG element, the same way. */
export const s = (tag, props, ...children) => make(document.createElementNS(SVG_NS, tag), props, children);

/** A section of the page: a heading, a line saying what it shows, then its content. `id` is what the contents link to. */
export function panel(id, title, sub, ...children) {
  return h('section', {class: 'panel', id, 'aria-labelledby': `${id}-title`},
    h('header', {class: 'panel-head'}, h('h2', {id: `${id}-title`}, title), sub ? h('p', {class: 'sub'}, sub) : null), ...children);
}

/** A smaller heading inside a panel. */
export const subhead = (text, extra) => h('div', {class: 'subhead'}, h('h3', {}, text), extra ? h('span', {class: 'muted'}, extra) : null);

/**
 * A table: `columns` [{label, numeric}], `rows` lists of cells (nodes or text). With `limit`, the first rows show and a
 * button shows the rest. Wide tables scroll inside their own box, never the page.
 */
export function table(columns, rows, {limit = Infinity, caption = null, className = ''} = {}) {
  const body = h('tbody');
  const draw = count => body.replaceChildren(...rows.slice(0, count).map(cells => h('tr', {}, cells.map((cell, index) => h('td', {class: columns[index]?.numeric ? 'num' : null}, cell)))));
  draw(limit);
  const more = rows.length > limit ? h('button', {class: 'more', type: 'button', onclick: event => { draw(rows.length); event.currentTarget.remove(); }}, `Show all ${rows.length} rows`) : null;
  return h('div', {class: `table-block ${className}`},
    h('div', {class: 'table-wrap'}, h('table', {style: `--columns:${columns.length}`}, caption ? h('caption', {}, caption) : null,
      h('thead', {}, h('tr', {}, columns.map(column => h('th', {class: column.numeric ? 'num' : null, scope: 'col'}, column.label)))), body)), more);
}

/** A row of label and value pairs: the small facts above a chart. */
export const facts = list => h('dl', {class: 'facts'}, list.filter(Boolean).map(([label, value]) => h('div', {}, h('dt', {}, label), h('dd', {}, value))));

/** A table of a chart's values, shown on request: every value a chart draws can be read without pointing at it. */
export function tableView(label, build) {
  const details = h('details', {class: 'table-view'}, h('summary', {}, label));
  details.addEventListener('toggle', () => { if (details.open && details.childElementCount === 1) details.append(build()); });
  return details;
}

let tip = null;
/**
 * Shows the tooltip near (x, y) in window pixels: a title, then rows of {value, label, swatch}, the value first because
 * the reader already knows the series and wants the number.
 */
export function showTip(x, y, title, rows) {
  tip ??= document.getElementById('tooltip');
  tip.replaceChildren(h('div', {class: 'tip-title'}, title), ...rows.map(row => h('div', {class: 'tip-row'},
    row.swatch ? h('span', {class: `key ${row.swatch}`}) : null, h('strong', {}, row.value), h('span', {}, row.label))));
  tip.hidden = false;
  const box = tip.getBoundingClientRect(), margin = 12;
  const left = x + margin + box.width > innerWidth ? Math.max(4, x - margin - box.width) : x + margin;
  const top = y + margin + box.height > innerHeight ? Math.max(4, y - margin - box.height) : y + margin;
  tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}
export function hideTip() { (tip ??= document.getElementById('tooltip')).hidden = true; }

const observer = new ResizeObserver(entries => { for (const entry of entries) entry.target.redraw?.(); });
/**
 * A chart's box: `draw(width)` returns the drawing for the box's width, and runs again when the width changes (a
 * resized window, a narrow phone), so text in a chart keeps its size instead of scaling with the picture.
 */
export function chart(className, draw) {
  const box = h('div', {class: `chart ${className}`});
  let width = 0;
  box.redraw = () => {
    const next = Math.floor(box.clientWidth);
    if (!next || next === width) return;
    width = next;
    box.replaceChildren(draw(width));
  };
  observer.observe(box);
  return box;
}
/** Stops redrawing the charts under `root` before it is emptied. */
export function release(root) { for (const box of root.querySelectorAll('.chart')) observer.unobserve(box); }

/** Numbers as text in the page's one style: grouped thousands, at most `digits` decimals. */
export const number = (value, digits = 1) => (Number.isFinite(value) ? value.toLocaleString('en', {maximumFractionDigits: digits, minimumFractionDigits: 0}) : '–');
export const ms = (value, digits = 1) => (Number.isFinite(value) ? `${number(value, digits)} ms` : '–');
export const mb = value => (Number.isFinite(value) ? `${number(value, value >= 100 ? 0 : 1)} MB` : '–');
export const percent = (part, whole) => (whole > 0 && Number.isFinite(part) ? `${Math.round(part / whole * 100)}%` : '–');
/** `styleRecalculations` as "style recalculations": a key of a result as words. */
export const words = key => String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[._-]+/g, ' ').toLowerCase();
export const capital = text => (text ? text.charAt(0).toUpperCase() + text.slice(1) : text);
